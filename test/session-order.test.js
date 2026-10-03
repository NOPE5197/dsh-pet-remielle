/**
 * Card-deck ordering shared by both clients (src/session-order.cjs).
 *
 * The desktop floating window (pet-view.html) and the web client (client.core.js)
 * both call this one implementation, and host index.js uses compareSessions via
 * createRequire to sort its snapshot. This file had no direct unit tests before —
 * the hysteresis algorithm was only covered indirectly by host-snapshot, even
 * though it is the part most easily broken (a broken version shows up as the
 * stacked-card width jittering at high frequency, which is very hard to locate).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { beforeEach, test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  orderSessions, compareSessions,
  attentionOf, completionOf, targetSessionOf, approvalOf, planReviewOf,
} = require('../src/session-order.cjs')

/** lastTopIds is module-level state (used by the hysteresis); it must be cleared between cases or the order depends on them. */
function resetHysteresis() {
  orderSessions([], null)
}

function s(over) {
  return { sessionId: 's', state: 'THINKING', updatedAt: 0, ...over }
}

beforeEach(resetHysteresis)

test('tier priority: approval > plan review > ask > completion > attention > plain', () => {
  const sessions = [
    s({ sessionId: 'plain' }),
    s({ sessionId: 'attn', state: 'ERROR' }),
    s({ sessionId: 'done', completionNotification: true }),
    s({ sessionId: 'ask', ask: true }),
    s({ sessionId: 'plan', planReview: true }),
    s({ sessionId: 'appr', approval: true }),
  ]
  const order = orderSessions(sessions, null).map((e) => e.sessionId)
  assert.deepEqual(order, ['appr', 'plan', 'ask', 'done', 'attn', 'plain'])
})

test('within one tier: current session wins, then state rank, then recency', () => {
  const sessions = [
    s({ sessionId: 'old-idle', state: 'IDLE', updatedAt: 900 }),
    s({ sessionId: 'new-idle', state: 'IDLE', updatedAt: 950 }),
    s({ sessionId: 'busy', state: 'WORKING', updatedAt: 10 }),
    s({ sessionId: 'current-idle', state: 'IDLE', updatedAt: 1 }),
  ]
  const order = orderSessions(sessions, 'current-idle').map((e) => e.sessionId)
  // The current session outranks stateRank; after that WORKING > IDLE; within the
  // same rank the newer updatedAt comes first
  assert.deepEqual(order, ['current-idle', 'busy', 'new-idle', 'old-idle'])
})

test('compareSessions is pure: no hysteresis, no state mutation', () => {
  const a = s({ sessionId: 'a', approval: true })
  const b = s({ sessionId: 'b' })
  assert.ok(compareSessions(a, b, null) < 0, 'an approval session should rank first')
  assert.ok(compareSessions(b, a, null) > 0, 'the comparator should be antisymmetric')
  // compareSessions must not be affected by the hysteresis: repeated calls give
  // the same result
  const first = compareSessions(b, a, null)
  for (let i = 0; i < 5; i++) assert.equal(compareSessions(b, a, null), first)
  assert.equal(orderSessions([a, b], null).length, 2, 'the input array is not modified')
})

test('hysteresis keeps the top two stable when they are exactly equal rank', () => {
  // Two sessions with the same tier, same current flag and same stateRank differ
  // only in updatedAt.
  // updatedAt is refreshed by every streaming chunk, so sorting by it alone would
  // make the stacked card swap its main card back and forth and jitter in width.
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  const first = orderSessions([mk('x', 100), mk('y', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(first, ['y', 'x'], 'the first pass goes by updatedAt: the newer session y is first')

  // The second pass: x's updatedAt rises to 300 (a pure sort would flip to x
  // first) — the hysteresis must keep y first
  const second = orderSessions([mk('x', 300), mk('y', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(second, ['y', 'x'], 'with exactly equal rank the top two must not swap because of updatedAt jitter')
})

test('hysteresis never blocks a real tier change', () => {
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  orderSessions([mk('y', 200), mk('x', 100)], null)
  // x receives an approval — a tier change must move up immediately and must not
  // be pushed back down by the hysteresis
  const after = orderSessions([{ ...mk('x', 100), approval: true }, mk('y', 200)], null).map((e) => e.sessionId)
  assert.equal(after[0], 'x', 'an approval jumping the queue must beat the hysteresis')

  // The hysteresis only fires on "exactly reversed order": when the top two are
  // already right they must not be shuffled
  resetHysteresis()
  const stable = orderSessions([mk('a', 900), mk('b', 100)], null).map((e) => e.sessionId)
  assert.deepEqual(stable, ['a', 'b'], 'an already correct top two must not be swapped by the hysteresis')
})

test('hysteresis only ever touches the top two', () => {
  const mk = (id, updatedAt) => s({ sessionId: id, state: 'WORKING', updatedAt })
  // First establish top2 = [b, a]
  orderSessions([mk('b', 300), mk('a', 200), mk('c', 100)], null)
  // a's updatedAt rises past b's: a pure sort would flip the top two to [a, b],
  // the hysteresis should swap it back to [b, a]; the third entry c is out of the
  // swap range and stays third per the comparator.
  const held = orderSessions([mk('a', 300), mk('b', 200), mk('c', 100)], null).map((e) => e.sessionId)
  assert.deepEqual(held, ['b', 'a', 'c'], 'the hysteresis only swaps the top two and the third is left alone')

  // The other way round: when the third entry's updatedAt rises enough to break
  // into the top two, the "top two are exactly reversed" precondition no longer
  // holds, so the hysteresis must yield to the comparator — c goes straight to
  // first.
  const displaced = orderSessions([mk('a', 300), mk('b', 200), mk('c', 900)], null).map((e) => e.sessionId)
  assert.deepEqual(displaced, ['c', 'a', 'b'], 'the hysteresis must yield when the ranking really changes')
})

test('hysteresis keys on targetSessionId when present', () => {
  const mk = (id, target, updatedAt) => ({ sessionId: id, targetSessionId: target, state: 'WORKING', updatedAt })
  const first = orderSessions([mk('c1', 'T', 100), mk('c2', 'U', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(first, ['c2', 'c1'])
  // Two sub-sessions swapping must not make cards with different targets count
  // as the same one
  const second = orderSessions([mk('c1', 'T', 900), mk('c2', 'U', 200)], null).map((e) => e.sessionId)
  assert.deepEqual(second, ['c2', 'c1'], 'the hysteresis should remember by targetSessionId')
})

test('empty and single-entry decks are returned untouched', () => {
  assert.deepEqual(orderSessions([], null), [])
  assert.deepEqual(orderSessions([s({ sessionId: 'only' })], null).map((e) => e.sessionId), ['only'])
  assert.deepEqual(orderSessions([s({ sessionId: 'only' })], 'only').map((e) => e.sessionId), ['only'])
})

test('entry predicates follow the documented flags', () => {
  assert.equal(attentionOf({ attention: true }), true)
  assert.equal(attentionOf({ state: 'WAITING' }), true, 'WAITING is attention without an explicit flag')
  assert.equal(attentionOf({ state: 'ERROR' }), true, 'ERROR is attention')
  assert.equal(attentionOf({ state: 'WORKING' }), false)
  assert.equal(completionOf({ completionNotification: true }), true)
  assert.equal(completionOf({ completionNotification: 'yes' }), false, 'strict === true required, a string does not count')
  assert.equal(approvalOf({ approval: 1 }), false, 'strict === true required')
  assert.equal(planReviewOf({ planReview: true }), true)
  // targetSessionId fallback: a sub-session's card points at the real session
  assert.equal(targetSessionOf({ sessionId: 'sub-1' }), 'sub-1')
  assert.equal(targetSessionOf({ sessionId: 'sub-1', targetSessionId: 'real' }), 'real')
})
