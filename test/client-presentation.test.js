import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cardHeightOf } from './helpers/card-height.mjs'
import { CLIENT_CORE, base, createHarness } from './helpers/client-harness.mjs'
// What zoom and mirroring end up doing on the DOM.
// The arithmetic of the zoom rule (sync / fixed modes) is covered directly against the pure
// function bubbleZoomOf by test/pet-tip.test.js; this case only verifies that mountPet really
// writes the result onto the element style. The mirroring part is unique to this case:
// mirroring is only allowed to affect the sticker, the bubble container must not flip with it.
test('pet visuals: pet size, mirror and bubble zoom reach the DOM', () => {
  const sized = createHarness()
  sized.send({ ...base, scale: 0.75 })
  const bubble = sized.elements.find((node) => String(node.className).includes('rm2-pet-bubble') && !String(node.className).includes('rm2-pet-bubbles'))
  assert.equal(bubble.style.zoom, '0.75')
  assert.equal(sized.elements.find((node) => node.className === 'rm2-pet-bubbles').style.zoom, '0.75')

  // Mirroring only affects the sticker; it must not flip the bubble container as well
  const mirrored = createHarness()
  mirrored.send({ ...base, mirror: true })
  assert.equal(mirrored.elements.find((node) => node.tag === 'img').style.transform, 'scaleX(-1)')
  assert.equal(mirrored.elements.find((node) => node.className === 'rm2-pet-bubbles').style.transform, undefined)
  mirrored.send({ ...base, mirror: false })
  assert.equal(mirrored.elements.find((node) => node.tag === 'img').style.transform, '')
})

test('multi-session deck renders an inert backboard with a dynamic click target', () => {
  const harness = createHarness('first')
  const sessions = [
    { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: 'Still working on the task', detail: '.dsh · Using tools', updatedAt: 3 },
    { sessionId: 'second', state: 'THINKING', phase: 'think', message: 'Let me think about the best solution', detail: '.dsh · Analyzing', updatedAt: 2 },
    { sessionId: 'third', state: 'THINKING', phase: 'think', message: 'Checking the remaining problems', detail: '.dsh · Checking', updatedAt: 1 },
  ]
  const hasCard = (t) => harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === t)
  harness.send({ ...base, sessions })
  // A refresh of the top layer must not affect the backboard: +N stays, and the second layer
  // never renders the 2nd-ranked session's text/icon.
  harness.send({ ...base, sessions: [{ ...sessions[0], message: 'Reading the file' }, sessions[1], sessions[2]] })

  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, 'backboard card should exist')
  const writes = harness.styleWrites.filter(({ element, key }) => element === backboard && key === 'marginTop')
  assert.ok(writes.length >= 1)
  const lift = Math.abs(Number.parseInt(writes.at(-1).value, 10))
  // The real card height lives in the CSS (the stub's offsetHeight is only an approximation),
  // so it is parsed from the source file: if the card height changes without the lift amount
  // following, the backboard shows too much or is covered completely — that is a layout
  // invariant, not a purely derived styling assertion. The parser has been extracted to
  // test/helpers/card-height.mjs and is shared by both clients.
  const cardHeight = cardHeightOf(readFileSync(CLIENT_CORE, 'utf8'))
  assert.equal(lift, 80, 'the second layer should be lifted by the shared STACK_LIFT_PX constant (uniqueness is checked by the desktop-window test)')
  assert.equal(cardHeight, 91)
  assert.ok(
    Math.abs((cardHeight - lift) * 0.75 - 8) <= 0.5,
    `the 75% step should expose about 8px, actually ${(cardHeight - lift) * 0.75}px`,
  )
  assert.equal(backboard.children.find((node) => node.className === 'rm2-pet-bubble-stack-count').textContent, '+2')
  assert.equal(hasCard('Let me think about the best solution'), false)
  assert.equal(hasCard('Checking the remaining problems'), false)
  assert.equal(backboard.dataset.rm2Tip, 'Click to jump here and take a look~')
  harness.send({
    ...base,
    sessions: [
      sessions[0],
      { ...sessions[1], project: 'dsh-pet-remielle', title: 'Reviewing tooltip colors and overflow' },
      sessions[2],
    ],
  })
  harness.flushTitleTimers()
  assert.equal(backboard.dataset.rm2Tip, 'Click to look at dsh-pet-remielle · Reviewing tooltip colors and overflow~')
  // Clicking the backboard: the 2nd rank (second) is resolved dynamically from this frame's
  // ordering and jumped to.
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])
  // After a same-tier rotation (third streams out a larger updatedAt), the same backboard's
  // jump target follows the ordering.
  // First reset the current session back to first: the previous jump made second the current
  // session and it took the top layer.
  harness.select('first')
  harness.send({ ...base, sessions: [sessions[0], sessions[1], { ...sessions[2], updatedAt: 5 }] })
  harness.flushTitleTimers()
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second', 'third'])
})

test('modern workspace navigation promotes the clicked lower bubble', () => {
  const harness = createHarness('first', true, {}, true)
  const sessions = [
    { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: 'First conversation', detail: '.dsh · In progress', updatedAt: 3 },
    { sessionId: 'second', state: 'WORKING', phase: 'tool-call', message: 'Second conversation', detail: '.dsh · In progress', updatedAt: 2 },
  ]
  harness.send({ ...base, sessions })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard)
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])
  assert.match(harness.card('Second conversation').className, /\btop\b/)
})

// Backboard tip: the click target and the copy must update as a pair, and the title is
// preferably completed from the host's session list.
test('backboard tip stays paired with its click target', () => {
  const harness = createHarness('first')
  const mk = (id, updatedAt, title) => ({ sessionId: id, state: 'WORKING', phase: 'tool-call', message: `${id} message`, title, updatedAt })
  harness.send({ ...base, sessions: [mk('first', 30, 'First conversation'), mk('second', 20, 'Second conversation')] })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard)
  assert.equal(backboard.dataset.rm2Tip, 'Click to look at Second conversation~')

  harness.send({ ...base, sessions: [mk('first', 10, 'First conversation'), mk('third', 40, 'Third conversation')] })
  // The new ordering enters the debounce first, so the backboard tip and the click target
  // still hold the previous pair.
  assert.equal(backboard.dataset.rm2Tip, 'Click to look at Second conversation~')
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second'])

  harness.flushTitleTimers()
  assert.equal(backboard.dataset.rm2Tip, 'Click to look at Third conversation~')
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['second', 'third'])
})

test('backboard tip fills conversation title from sessions.list when snapshot omits it', () => {
  const harness = createHarness('first', true, {
    second: { id: 'second', title: 'Reviewing tooltip colors and overflow', cwd: 'C:\\work\\dsh-pet-remielle' },
  })
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'first', state: 'WORKING', phase: 'tool-call', message: 'Still working on the task', detail: '.dsh · Using tools', updatedAt: 3, project: 'other' },
      { sessionId: 'second', state: 'THINKING', phase: 'think', message: 'Let me think about the best solution', detail: '.dsh · Analyzing', updatedAt: 2, project: 'dsh-pet-remielle' },
    ],
  })
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, 'backboard card should exist')
  assert.equal(backboard.dataset.rm2Tip, 'Click to look at dsh-pet-remielle · Reviewing tooltip colors and overflow~')
})

test('title clipping ignores long detail text for short approval titles', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: 'Have a look please~',
      detail: '.dsh · detail text that is long enough and does decide the shared card width, used to verify that a short title is not misjudged as needing an ellipsis',
      approval: true,
      attention: true,
    }],
  })
  assert.equal(harness.card('Have a look please~').className.includes('title-clipped'), false)

  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: 'an approval title that really is long enough to exceed the card inner width and must be truncated',
      detail: '.dsh · Approval stage',
      approval: true,
      attention: true,
    }],
  })
  assert.equal(harness.card('an approval title that really is long enough to exceed the card inner width and must be truncated').className.includes('title-clipped'), true)
})

test('approval bubble tooltip shows the second-line request detail', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'approval',
      state: 'WAITING',
      phase: 'approval',
      message: 'Need you to confirm something~',
      detail: '  • Read workspace files and run the install',
      approval: true,
      attention: true,
    }],
  })
  // The hover tip is the hand-drawn overlay: the text lives in dataset.rm2Tip (normalized
  // with the same leading bullet as the second line), and the native title is emptied to
  // avoid a double tooltip
  const approvalCard = harness.card('Need you to confirm something~')
  assert.equal(approvalCard.dataset.rm2Tip, '· Read workspace files and run the install')
  assert.equal(approvalCard.title, '')
})

test('web pet tip follows dark theme and stays inside the viewport', () => {
  // Wiring guard: the web client uses the shared pet-tip module, with the dark styles hung
  // off the host's theme attribute.
  // The layout algorithm itself is covered by layoutPetTip in test/pet-tip.test.js; here we
  // only check that both ends are wired up.
  const core = readFileSync(CLIENT_CORE, 'utf8')
  assert.match(core, /body\[data-ds-dark-theme\] \.rm2-pet-tip/)
  assert.match(core, /__tip\.layoutPetTip\(petTip, anchor/)
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      phase: 'output',
      message: 'Writing the answer out',
      detail: 'dsh-pet-remielle · Responding',
    }],
  })
  const card = harness.card('Writing the answer out')
  card.getBoundingClientRect = () => ({ left: 1100, top: 8, width: 180, height: 68, right: 1280, bottom: 76 })
  const enter = card.listeners.get('mouseenter')?.[0]
  assert.ok(enter, 'missing mouseenter listener')
  enter()
  const tip = harness.elements.find((node) => node.className === 'rm2-pet-tip')
  assert.ok(tip, 'missing .rm2-pet-tip')
  assert.equal(tip.textContent, 'Click to jump here and take a look~')
  // The viewport clamp itself is asserted directly against layoutPetTip in
  // test/pet-tip.test.js (offsetWidth/offsetHeight injected explicitly, covering the 24px
  // halo, the 420px maxWidth and four wrapping scenarios).
  // Here the stub's offsetWidth (=text length ×12) / offsetHeight (=68) are used to recompute
  // it, which yields the stub's own numbers rather than the real layout — a check of the same
  // magnitude was already done there and is stronger, so it is not repeated.
  // Only the one thing directly related to the DOM wiring is kept here: the tip overlay is
  // the hand-drawn node and short copy is not broken into words.
  assert.equal(tip.style.whiteSpace, 'nowrap')
})

test('pet dock grabbing cursor survives snapshot refresh until pointerup', () => {
  const harness = createHarness()
  harness.send({ ...base, sessions: [] })
  const dock = harness.elements.find((node) => String(node.style.cssText || '').includes('cursor:grab'))
  assert.ok(dock, 'missing pet dock')
  const down = dock.listeners.get('pointerdown')?.[0]
  assert.ok(down, 'missing dock pointerdown')
  down({ button: 0, clientX: 20, clientY: 20, preventDefault() {} })
  assert.equal(dock.style.cursor, 'grabbing')
  harness.send({ ...base, mood: '01', sessions: [] })
  assert.equal(dock.style.cursor, 'grabbing', 'snapshot must not reset grabbing while held')
  harness.dispatchWindowEvent('pointerup')
  assert.equal(dock.style.cursor, 'grab')
})

test('question and error action symbols open their own conversations', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    sessions: [
      { sessionId: 'question', state: 'WAITING', phase: 'ask', message: 'Waiting for answer', detail: 'Question', attention: true, updatedAt: 2 },
      { sessionId: 'error', state: 'ERROR', phase: 'tool-error', message: 'Needs attention', detail: 'Error', attention: true, updatedAt: 1 },
    ],
  })
  const questionAction = harness.card('Waiting for answer').children[0].children.find((node) => node.className === 'rm2-pet-bubble-action')
  harness.click(questionAction)
  assert.deepEqual(harness.opened, ['question'])
  // The ERROR card (a lower stateRank than WAITING) sorts second and falls into the fake
  // backboard: no real card, no icon, and clicking the backboard jumps to it dynamically.
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === 'Needs attention'), false)
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  harness.click(backboard)
  assert.deepEqual(harness.opened, ['question', 'error'])
})
