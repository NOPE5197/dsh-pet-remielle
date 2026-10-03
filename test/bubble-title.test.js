/**
 * Shared bubble-card presentation layer (one implementation for both the web and
 * desktop clients, see src/bubble-title.cjs).
 *
 * This copy used to be written twice, once in client.core.js and once in
 * pet-view.html, and the "plan review" tip repeating the project name that a
 * review caught was the result of those two copies drifting apart. Asserting the
 * pure functions directly here pins the copy and the class names without needing
 * a whole DOM stub.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const card = require('../src/bubble-title.cjs')

test('plan summary is taken after the marker, never the project prefix', () => {
  assert.equal(card.planSummaryOf('· dsh-pet-remielle · Plan review · Swapping the reasoning panel material'), 'Swapping the reasoning panel material')
  assert.equal(card.planSummaryOf('· Plan review · Swapping the reasoning panel material'), 'Swapping the reasoning panel material')
  assert.equal(card.planSummaryOf('· dsh-pet-remielle · Executing'), '')
  assert.equal(card.planSummaryOf(''), '')
})

test('card tip copy picks one branch per state', () => {
  assert.equal(card.tipTextOf({ planReview: true, planSummary: 'Swapping the reasoning panel material' }), 'Plan review: Swapping the reasoning panel material — click to open Approve / Request changes')
  assert.equal(card.tipTextOf({ planReview: true }), 'Plan review — click to open Approve / Request changes')
  assert.equal(card.tipTextOf({ approval: true, detailShown: '· workspace · rm -rf /' }), '· workspace · rm -rf /')
  assert.equal(card.tipTextOf({ completed: true }), 'All done~ Click to see the result')
  assert.equal(card.tipTextOf({ attention: true }), 'Your turn — click here to handle it')
  assert.equal(card.tipTextOf({}), 'Click to jump here and take a look~')
  // The idle placeholder card must not fall into the "Click to jump here and take
  // a look~" fallback copy.
  assert.equal(card.tipTextOf({ idlePlaceholder: true, attention: true }), '')
})

test('card class list and row width stay inside the deck limits', () => {
  assert.equal(card.classNameOf({ completed: true }, 0), 'rm2-pet-bubble top completed')
  assert.equal(card.classNameOf({ planReview: true, summaryCount: 2 }, 1), 'rm2-pet-bubble summary-backboard')
  assert.equal(card.bubbleRowWidth(10), 277, 'narrow copy falls back to the minimum width')
  assert.equal(card.bubbleRowWidth(3000), 440, 'over-wide copy is clamped to the ceiling')
})

// Once the measure node has been created while body does not exist yet, it has to be
// re-mounted as soon as body shows up. Otherwise the element stays cached and
// offsetWidth is always 0, so every card width silently collapses to BUBBLE_MIN_W.
test('the measure node attaches once the body exists, and only once', () => {
  const appended = []
  const body = {
    appendChild(node) {
      appended.push(node)
      node.parentNode = body
      return node
    },
  }
  const withBody = globalThis.document
  let current = null
  globalThis.document = {
    get body() { return current },
    createElement: () => ({ style: {}, parentNode: null }),
  }
  try {
    current = null
    assert.equal(card.ensureMeasureEl().parentNode, null, 'no mount and no throw while body is missing')

    current = body
    const el = card.ensureMeasureEl()
    assert.equal(el.parentNode, body, 'must re-mount once body exists, otherwise offsetWidth stays 0')

    card.ensureMeasureEl()
    card.ensureMeasureEl()
    assert.equal(appended.length, 1, `repeated mounting accumulates stray nodes (happened ${appended.length} times)`)
  } finally {
    globalThis.document = withBody
  }
})
