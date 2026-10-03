import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const tip = require('../src/pet-tip.cjs')

test('dot tip copy follows the bubble page', () => {
  assert.equal(tip.dotTipText(0), 'Click to see the balance~')
  assert.equal(tip.dotTipText(1), 'Click to go back to status~')
})

test('backboard tip joins workspace and conversation title without brackets', () => {
  assert.equal(tip.backboardTipText('dsh-pet-remielle', 'Reviewing tooltip colors and overflow'), 'Click to look at dsh-pet-remielle · Reviewing tooltip colors and overflow~')
  assert.equal(tip.backboardTipText('dsh-pet-remielle', ''), 'Click to look at dsh-pet-remielle~')
  assert.equal(tip.backboardTipText('', 'Reviewing tooltip colors and overflow'), 'Click to look at Reviewing tooltip colors and overflow~')
  assert.equal(tip.backboardTipText('same', 'same'), 'Click to look at same~')
  assert.equal(tip.backboardTipText('', ''), 'Click to jump here and take a look~')
})

test('backboard stabilizer debounces paired target and tip without stale commits', () => {
  const timers = new Map()
  let nextTimer = 0
  const committed = []
  const schedule = (listener) => {
    const id = ++nextTimer
    timers.set(id, listener)
    return id
  }
  const cancel = (id) => timers.delete(id)
  const flush = () => {
    const queued = [...timers.values()]
    timers.clear()
    for (const listener of queued) listener()
  }
  const stabilizer = tip.createBackboardStabilizer(
    (target, text) => committed.push({ target, text }),
    400,
    schedule,
    cancel,
  )

  stabilizer.update('A', 'Tip A')
  stabilizer.update('B', 'Tip B')
  stabilizer.update('A', 'Tip A')
  flush()
  assert.deepEqual(committed, [{ target: 'A', text: 'Tip A' }])
  assert.equal(stabilizer.target(), 'A')
  assert.equal(stabilizer.tip(), 'Tip A')

  stabilizer.update('B', 'Tip B')
  stabilizer.update('C', 'Tip C')
  flush()
  assert.deepEqual(committed, [
    { target: 'A', text: 'Tip A' },
    { target: 'C', text: 'Tip C' },
  ])
})

test('desktop idle action opens DSH only when the bridge exposes it', () => {
  let calls = 0
  assert.equal(tip.openIdleDshPage({ openDshPage() { calls += 1 } }), true)
  assert.equal(calls, 1)
  assert.equal(tip.openIdleDshPage({}), false)
  assert.equal(tip.openIdleDshPage(null), false)
})

test('bubbleZoomOf honours the sync/fixed modes and clamps malformed input', () => {
  // The default (missing field) falls back to the old rule zoom = scale, matching 0.3.6; an explicit sync switch (true) equals a missing field
  assert.equal(tip.bubbleZoomOf({ scale: 1.2 }), 1.2)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleRatio: 1 }), 1.5)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleRatio: 0.8 }), 1.2)
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleRatio: 2 }), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 1.5, bubbleScaleSync: true, bubbleScaleRatio: 0.8 }), 1.2)
  // Fixed mode ignores the pet scale; a missing fixed field falls back to 1 (the base size) and never borrows scale
  assert.equal(tip.bubbleZoomOf({ scale: 1.8, bubbleScaleSync: false, bubbleFixedSize: 0.8 }), 0.8)
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleSync: false, bubbleFixedSize: 1.5 }), 1.5)
  assert.equal(tip.bubbleZoomOf({ scale: 1.8, bubbleScaleSync: false }), 1)
  // Malformed snapshots and the min/max clamps
  assert.equal(tip.bubbleZoomOf(null), 1)
  assert.equal(tip.bubbleZoomOf({}), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 'abc' }), 1)
  assert.equal(tip.bubbleZoomOf({ scale: 2, bubbleScaleRatio: 2 }), 3) // 4 → clamped to the ceiling 3
  assert.equal(tip.bubbleZoomOf({ scale: 0.5, bubbleScaleRatio: 0.5 }), 0.3) // 0.25 → clamped to the floor 0.3
  assert.equal(tip.bubbleZoomOf({ scale: 1, bubbleScaleSync: false, bubbleFixedSize: 99 }), 3)
  assert.equal(tip.bubbleZoomOf({ scale: 1, bubbleScaleSync: false, bubbleFixedSize: 'x' }), 1)
})

test('applyDotTip writes overlay text and clears native title', () => {
  const dot = { dataset: {}, title: 'Switch to balance' }
  const shown = []
  tip.applyDotTip(dot, 0, null, (anchor) => shown.push(anchor))
  assert.equal(dot.dataset.rm2Tip, 'Click to see the balance~')
  assert.equal(dot.title, '')
  assert.deepEqual(shown, [])
  tip.applyDotTip(dot, 1, dot, (anchor) => shown.push(anchor))
  assert.equal(dot.dataset.rm2Tip, 'Click to go back to status~')
  assert.deepEqual(shown, [dot])
})

test('onDotLeave keeps, restores the card, or hides', () => {
  const dot = { dataset: { rm2Tip: 'Click to see the balance~' } }
  const dots = { parentNode: null }
  const card = {
    dataset: { rm2Tip: 'Click to jump here and take a look~' },
    contains(node) { return node === card },
  }
  dots.parentNode = card
  const shown = []
  const hidden = []
  const show = (anchor) => shown.push(anchor)
  const hide = () => hidden.push(true)

  tip.onDotLeave({ relatedTarget: dots }, dot, dots, show, hide)
  assert.deepEqual(shown, [])
  assert.deepEqual(hidden, [])
  tip.onDotLeave({ relatedTarget: dot }, dot, dots, show, hide)
  assert.deepEqual(shown, [])
  assert.deepEqual(hidden, [])

  tip.onDotLeave({ relatedTarget: card }, dot, dots, show, hide)
  assert.deepEqual(shown, [card])
  assert.deepEqual(hidden, [])

  tip.onDotLeave({}, dot, dots, show, hide)
  assert.deepEqual(hidden, [true])
})

// Overlay placement and wrapping: measure the natural width on one line first, and
// wrap only when it exceeds the visible maxW or the copy carries its own newlines;
// the box always stays clamped inside the visible area with a 24px halo.
test('layoutPetTip clamps into the visible area and only wraps when needed', () => {
  const at = (left, top) => ({ getBoundingClientRect: () => ({ left, width: 180, top, bottom: top + 68 }) })
  const place = (text, offsetWidth, offsetHeight, anchor) => {
    const petTip = { style: {}, offsetWidth, offsetHeight, textContent: text }
    tip.layoutPetTip(petTip, anchor, 0, 0, 1280, 800)
    return petTip
  }

  // Short copy near the right edge: grows to the visible width ceiling, does not break
  // words, and slides wholly inside the halo
  const edge = place('Click to see the balance~', 200, 40, at(1100, 8))
  assert.equal(Number.parseFloat(edge.style.maxWidth), 420)
  assert.equal(edge.style.whiteSpace, 'nowrap')
  assert.equal(edge.style.wordBreak, 'normal')
  const left = Number.parseFloat(edge.style.left)
  const top = Number.parseFloat(edge.style.top)
  assert.ok(left >= 24, `left ${left}`)
  assert.ok(left + 200 <= 1280 - 24, `right ${left + 200}`)
  assert.ok(top >= 24, `top ${top}`)
  assert.ok(top + 40 <= 800 - 24, `bottom ${top + 40}`)

  // A long backboard line that does fit also stays on one line
  const backboard = place('Click to look at dsh-pet-remielle · Reviewing tooltip colors and overflow~', 360, 40, at(100, 80))
  assert.equal(backboard.style.whiteSpace, 'nowrap')
  assert.equal(backboard.style.wordBreak, 'normal')

  // A full approval request past maxW: wraps and allows any break point
  const wide = place('Workspace · ' + 'Full approval request text'.repeat(8), 500, 80, at(100, 80))
  assert.equal(wide.style.whiteSpace, 'pre-wrap')
  assert.equal(wide.style.wordBreak, 'break-all')

  // Copy that carries its own newlines: wraps immediately, without waiting for the
  // width to overflow
  const multiline = place('first line\nsecond line', 100, 80, at(100, 80))
  assert.equal(multiline.style.whiteSpace, 'pre-wrap')
  assert.equal(multiline.style.wordBreak, 'break-all')
})
