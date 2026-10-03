import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base, createHarness } from './helpers/client-harness.mjs'
test('deck order puts approval above ask above completion', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'done', state: 'SUCCESS', message: 'Task complete', detail: 'Result', completed: true, completionNotification: true, updatedAt: 3 },
      { sessionId: 'ask-1', state: 'WAITING', phase: 'ask', message: 'Waiting for answer', detail: 'Question', ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'plan-1', state: 'WAITING', phase: 'plan-review', message: 'Plan review', detail: 'Plan review · Plan', planReview: true, attention: true, updatedAt: 1 },
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: 'Waiting for approval', detail: 'Approval', approval: true, attention: true, updatedAt: 1 },
    ],
  })
  const titles = harness.elements
    .filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent)
    .map((node) => node.textContent)
  // The deck only renders first-layer real cards: approval leads, while plan/ask/completion
  // are all folded into the fake backboard's +N.
  assert.deepEqual(titles, ['Waiting for approval'])
})

test('plan review outranks ask and completion when no tool approval is pending', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'done', state: 'SUCCESS', message: 'Task complete', detail: 'Result', completed: true, completionNotification: true, updatedAt: 3 },
      { sessionId: 'ask-1', state: 'WAITING', phase: 'ask', message: 'Waiting for answer', detail: 'Question', ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'plan-1', state: 'WAITING', phase: 'plan-review', message: 'Plan review', detail: 'Plan review · Plan', planReview: true, attention: true, updatedAt: 1 },
    ],
  })
  const titles = harness.elements
    .filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent)
    .map((node) => node.textContent)
  assert.deepEqual(titles, ['Plan review'])
})

test('same-tier streaming sessions keep the top card stable (no width flapping)', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} message`, detail: '', updatedAt })
  // The visual order is decided by style.order (the DOM order is unchanged), so the card
  // node's order value is what gets asserted.
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  const titleCount = (t) => harness.elements.filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t).length
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 5)] })
  const topNode = harness.card('w1 message')
  assert.equal(lastOrder(topNode), 0, 'w1 starts on top')
  // w2's chunk streams out a larger updatedAt, but the two are exactly same-tier: the top
  // layer keeps w1 and the width stops flapping.
  harness.send({ ...base, sessions: [mk('w1', 10), mk('w2', 20)] })
  harness.send({ ...base, sessions: [mk('w1', 40), mk('w2', 30)] })
  // If the hysteresis failed, w1 would drop to the second layer and be destroyed and rebuilt
  // (two title nodes would appear).
  assert.equal(titleCount('w1 message'), 1, 'top card is never unmounted by same-tier rotation')
  assert.equal(lastOrder(topNode), 0, 'hysteresis keeps w1 on top')
  // A tier change (approval) is not affected by the hysteresis and comes up as usual; w1
  // gives up the top layer.
  harness.send({
    ...base,
    sessions: [mk('w1', 50), { sessionId: 'w2', state: 'WAITING', phase: 'approval', message: 'Waiting for approval', approval: true, attention: true, updatedAt: 60 }],
  })
  assert.equal(lastOrder(harness.card('Waiting for approval')), 0, 'tier change overrides hysteresis')
})

test('deck keeps one real top card plus the backboard across three streaming sessions', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} message`, detail: '', updatedAt })
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  const titleCount = (t) => harness.elements.filter((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t).length
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50), mk('w3', 10)] })
  assert.equal(lastOrder(harness.card('w1 message')), 0, 'w1 leads initially')
  // Three WORKING sessions present and the top two alternately refresh their updatedAt: the
  // hysteresis keeps w1 on the top layer.
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150), mk('w3', 10)] })
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 150), mk('w3', 10)] })
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 10)] })
  assert.equal(lastOrder(harness.card('w1 message')), 0, 'top-2 hysteresis keeps w1 on top')
  assert.equal(titleCount('w1 message'), 1, 'rotation never unmounts and rebuilds the top card')
  // The third session streams out a larger updatedAt: a new session takes over the top layer
  // as usual (the hysteresis only locks mutually inverted adjacent pairs).
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 300), mk('w3', 400)] })
  assert.equal(lastOrder(harness.card('w3 message')), 0, 'a third same-tier session may take over the top')
  // Then the new top two alternately refresh and the top layer stays stable too (w1 has been
  // folded into the backboard's +N).
  harness.send({ ...base, sessions: [mk('w1', 200), mk('w2', 500), mk('w3', 400)] })
  assert.equal(lastOrder(harness.card('w3 message')), 0, 'new top stays stable too')
})

test('approval tier change still surfaces above a stabilized deck', () => {
  const harness = createHarness()
  const mk = (id, updatedAt) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} message`, detail: '', updatedAt })
  const lastOrder = (node) => {
    let last = Infinity
    for (const w of harness.styleWrites) {
      if (w.element === node && w.key === 'order') last = Number(w.value)
    }
    return last
  }
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 50)] })
  harness.send({ ...base, sessions: [mk('w1', 100), mk('w2', 150)] })
  assert.equal(lastOrder(harness.card('w1 message')), 0, 'deck is stabilized by top-2 hysteresis')
  // A tier change (WAITING+approval) is not affected by the hysteresis and surfaces in first
  // place as usual.
  harness.send({
    ...base,
    sessions: [
      mk('w1', 100),
      { sessionId: 'appr-1', state: 'WAITING', phase: 'approval', message: 'Waiting for approval', approval: true, attention: true, updatedAt: 60 },
    ],
  })
  assert.equal(lastOrder(harness.card('Waiting for approval')), 0, 'tier change overrides top-2 hysteresis')
})

test('single-session deck renders no backboard', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{ sessionId: 'only', state: 'WORKING', phase: 'tool-call', message: 'Working on its own', detail: '', updatedAt: 1 }],
  })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.equal(backboard, undefined, 'no backboard for a single session')
  harness.click(harness.card('Working on its own'))
  assert.deepEqual(harness.opened, ['only'])
})
