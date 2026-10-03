import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base, createHarness } from './helpers/client-harness.mjs'
test('completion card waits for confirmed selection before acknowledgement', async () => {
  const harness = createHarness('other', false)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
    }],
  })
  harness.click(harness.card('Task complete'))
  assert.deepEqual(harness.opened, ['done'])
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)
  harness.select('done')
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'done' })))
})

// Keep/drop rules for "current session vs background session" cards: an ERROR on the session
// being viewed is dropped right away, while a background ERROR / WAITING keeps its attention
// state until that session is opened.
test('cards of the viewed session are dropped while background cards stay in attention', () => {
  const error = {
    sessionId: 'err',
    state: 'ERROR',
    message: 'That task hit a snag~',
    detail: 'dsh-pet-remielle · Needs attention',
    attention: true,
    updatedAt: 1,
  }
  const viewed = createHarness('err')
  viewed.send({ ...base, message: 'Remielle is idling~', sessions: [error] })
  assert.equal(
    viewed.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === 'That task hit a snag~'),
    false,
    'the session being viewed must no longer have an ERROR card on top',
  )

  const background = createHarness('other')
  background.send({ ...base, sessions: [error] })
  const errorCard = background.card('That task hit a snag~')
  assert.ok(errorCard.className.includes('attention'))
  background.select('err')
  // The node may still be in harness.elements, but it has been detached from the deck's
  // parent node.
  assert.equal(errorCard.parentNode.children.includes(errorCard), false)
})

test('a visible but unfocused window waits to acknowledge until focus returns', async () => {
  const harness = createHarness('watched')
  const completed = {
    ...base,
    sessions: [{
      sessionId: 'completion:watched',
      targetSessionId: 'watched',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
    }],
  }
  harness.setFocus(false)
  harness.send(completed)
  await Promise.resolve()
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)

  harness.setFocus(true)
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
})

test('an older host without layout still auto-acknowledges a foreground completion', async () => {
  const harness = createHarness('watched', true, [], false, false)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:watched',
      targetSessionId: 'watched',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
    }],
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'watched' })))
})


test('background waiting card stays in attention', () => {
  const harness = createHarness('ask')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'ask',
      state: 'WAITING',
      phase: 'ask',
      message: 'Need you to confirm something~',
      detail: 'Waiting for answer',
      ask: true,
      attention: true,
      updatedAt: 1,
    }],
  })
  assert.ok(harness.card('Need you to confirm something~').className.includes('attention'), 'the question card must stay on top')
})

test('plan review card renders with its own tooltip and opens without auto-approving', () => {
  const harness = createHarness('plan')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'plan',
      state: 'WAITING',
      phase: 'plan-review',
      message: 'Plan review',
      detail: 'dsh-pet-remielle · Plan review · Swapping the reasoning panel material',
      planReview: true,
      attention: true,
      updatedAt: 1,
    }],
  })
  const card = harness.card('Plan review')
  // Plan review has no dedicated class name: neither the approval nor the plan-review token
  // has a CSS rule consuming it on either client, so it was removed from classNameOf. It is
  // distinguished from the approval card by the attention styling, its own tooltip copy and
  // "does not click allow-once by itself".
  assert.equal(card.className.includes('attention'), true)
  assert.equal(card.className.includes('approval'), false)
  assert.equal(card.className.includes('plan-review'), false, 'the plan-review class name has no styling consumer and must not come back')
  assert.match(card.dataset.rm2Tip, /Plan review: Swapping the reasoning panel material — click to open Approve \/ Request changes/)
  harness.click(card)
  assert.deepEqual(harness.opened, ['plan'])
  assert.equal(harness.allowClicks.length, 0)
})

test('current conversation completion is acknowledged without a green reminder', async () => {
  const harness = createHarness('done')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
      pulseUntil: Date.now() + 5000,
    }],
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
  assert.equal(harness.card('Task complete').className.includes(' completed'), false)
})

// Only a foreground tab that is "watching" the current session may auto-acknowledge a
// completion reminder; having the desktop window open does not count, and neither does a
// hidden tab — otherwise completion cards would vanish while the user was not looking.
test('completion is auto-acknowledged only by a foreground tab viewing that session', async () => {
  for (const [label, desktopActive] of [['a normal tab', false], ['the desktop window present', true]]) {
    const harness = createHarness('watched')
    harness.setVisibility('hidden')
    const completed = {
      ...base,
      desktopActive,
      sessions: [{
        sessionId: 'completion:watched',
        targetSessionId: 'watched',
        state: 'SUCCESS',
        message: 'Task complete',
        detail: 'Result',
        completed: true,
        completionNotification: true,
      }],
    }
    harness.send(completed)
    await Promise.resolve()
    assert.equal(
      harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')),
      false,
      `${label}: a hidden tab must not auto-acknowledge`,
    )
    // The reminder really is still on the deck; with the desktop window present the web
    // client no longer renders this card again (the desktop pet window shows it), but it
    // still must not auto-acknowledge.
    if (!desktopActive) harness.card('Task complete')

    harness.setVisibility('visible')
    harness.send(completed)
    await Promise.resolve()
    assert.ok(
      harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'watched' })),
      `${label}: auto-acknowledged only after switching back to a visible tab`,
    )
  }
})

// Title throttling: the chunk-by-chunk copy for the same sticker must stay put (otherwise it
// would flip on every chunk), while a sticker change updates immediately.
test('bubble title holds while the mood is unchanged and updates when it changes', () => {
  const held = createHarness('s1')
  const thinking = (message) => ({
    sessionId: 's1',
    state: 'THINKING',
    mood: '04',
    phase: 'think',
    message,
    detail: '.dsh · Reasoning',
    updatedAt: 2,
  })
  held.send({ ...base, sessions: [thinking('Let me think about the best solution')] })
  held.send({ ...base, sessions: [thinking('Putting the ideas together, one moment~')] })
  held.card('Let me think about the best solution')
  assert.equal(held.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === 'Putting the ideas together, one moment~'), false)
  held.flushTitleTimers()
  held.card('Putting the ideas together, one moment~')

  const swapped = createHarness('s1')
  swapped.send({ ...base, sessions: [thinking('Let me think about the best solution')] })
  swapped.send({
    ...base,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      mood: '02',
      phase: 'tool-call',
      message: 'Editing this part right now',
      detail: '.dsh · Executing',
      updatedAt: 3,
    }],
  })
  swapped.card('Editing this part right now')
})

test('expired reminder for the current conversation disappears immediately', async () => {
  const harness = createHarness('done')
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:done',
      targetSessionId: 'done',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
    }],
  })
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === 'Task complete'), false)
})

test('desktop approval clicks only the panel inside the current DSH conversation root', () => {
  const harness = createHarness('other', true, [], true)
  harness.send({ ...base, desktopActive: true, sessions: [] })
  harness.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  assert.deepEqual(harness.opened, ['desk-2'])
  harness.flushTitleTimers()
  assert.deepEqual(harness.allowClicks, ['allow'])
})

// The document-level fallback branch of approvalPanels: when the page has no
// [data-conversation-session] scope (old hosts), only exactly one approval panel is
// auto-clicked for allow-once — with several approval panels on the page it prefers to do
// nothing, because clicking the wrong conversation's approval is worse than not clicking.
// This gate was never reached by the tests before (the harness always provides a scope, so
// the document-level branch was dead code).
test('unscoped page refuses auto allow-once unless exactly one panel exists', () => {
  const single = createHarness('other', true, [], true)
  single.setApprovalDom({ scopedRoots: [], loosePanels: [single.panel] })
  single.send({ ...base, desktopActive: true, sessions: [] })
  single.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  single.flushTitleTimers()
  assert.deepEqual(single.allowClicks, ['allow'], 'with a single panel it is clicked automatically as usual')

  const many = createHarness('other', true, [], true)
  many.setApprovalDom({ scopedRoots: [], loosePanels: [many.panel, many.otherPanel] })
  many.send({ ...base, desktopActive: true, sessions: [] })
  many.send({ kind: 'session-action', sessionId: 'desk-2', approve: true })
  many.flushTitleTimers()
  assert.deepEqual(many.allowClicks, [], 'with several approval panels nothing may be clicked automatically')
})

test('same session live work hides its own completion reminder', () => {
  const harness = createHarness('s1', true, {
    s1: { id: 's1', title: 'Migrate the PR into desktop floating mode', running: true, completed: true, updatedAt: 9 },
  })
  harness.send({
    ...base,
    sessions: [
      { sessionId: 's1', state: 'WORKING', message: 'Still working on the task', detail: 'dsh-pet-remielle · Executing', updatedAt: 9 },
      {
        sessionId: 'completion:s1',
        targetSessionId: 's1',
        state: 'SUCCESS',
        message: 'This round went smoothly',
        detail: 'dsh-pet-remielle · Turn complete',
        completed: true,
        completionNotification: true,
        updatedAt: 8,
      },
    ],
  })
  harness.card('Still working on the task')
  assert.equal(harness.elements.some((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === 'This round went smoothly~'), false)
})

test('sidebar green-dot session (completed) is surfaced as a clickable completion card', () => {
  const harness = createHarness('current', true, {
    ws2: { id: 'ws2', displayTitle: 'Plugin icon clashes with the palette', completed: true, cwd: 'C:\\xx\\.dsh', updatedAt: 5 },
    ws1: { id: 'ws1', title: 'Still running', running: true, completed: false, updatedAt: 4 },
  })
  harness.send({ ...base, sessions: [] })
  // The synthesized card title uses the fixed success copy pool (no leaking of the session's
  // first user message displayTitle).
  const completionTitles = ['That task is done~', 'This round went smoothly~', 'Job finished, not bad~']
  const card = harness.elements.find((node) => node.className === 'rm2-pet-bubble-title' && completionTitles.includes(node.textContent))
  assert.ok(card, 'missing sidebar completed completion card')
  const bubbleCard = card.parentNode.parentNode
  bubbleCard.listeners.get('click')[0]({ preventDefault() {}, stopPropagation() {} })
  assert.ok(harness.opened.includes('ws2'), 'clicking should open the completed session')
})

test('subagent sessions never become synthesized completion cards, fork sessions still do', () => {
  const harness = createHarness('current', true, {
    // Sub-session: the DSH list row carries origin=subagent. The host ignores it entirely
    // when includeSubagents=false, so the web client must not synthesize one either —
    // otherwise sub-agent completion reminders show up even with the switch off.
    child: { id: 'child', title: 'Probe task', completed: true, cwd: 'C:\\xx\\dsh-pet-remielle', origin: 'subagent', parentId: 'parent', updatedAt: 6 },
    // Fork session: carries only parentId, no origin. It is not a sub-agent, and when it is
    // interrupted/stopped the host does not generate a completion card (only a clean finish
    // is queued), so the web fallback is the only reminder source in that case and must not
    // be skipped along with the sub-agents.
    forked: { id: 'forked', title: 'Session forked from another one', completed: true, cwd: 'C:\\xx\\dsh-pet-remielle', parentId: 'parent', updatedAt: 5 },
    // Control: an ordinary session's green dot must still become a card (guards against
    // over-filtering).
    plain: { id: 'plain', title: 'Ordinary session', completed: true, cwd: 'C:\\xx\\.dsh', updatedAt: 4 },
  })
  harness.send({ ...base, sessions: [] })
  // The deck only renders titles for top-layer cards and degrades the rest into the +N
  // backboard, so "how many cards were synthesized" has to be read from the backboard count:
  // child is filtered → only forked + plain remain → backboard +1 (a missing filter would make
  // it +2).
  const backboard = harness.elements.find((node) => String(node.className).includes('backboard'))
  assert.ok(backboard, 'two synthesized cards should produce one backboard')
  const stackCount = backboard.children.find((node) => node.className === 'rm2-pet-bubble-stack-count')
  assert.equal(stackCount.textContent, '+1')
  // The top card should be forked, which has the largest updatedAt (child was not
  // synthesized); with a missing filter the top card would become child.
  const completionTitles = ['That task is done~', 'This round went smoothly~', 'Job finished, not bad~']
  const topTitle = harness.elements.find(
    (node) => node.className === 'rm2-pet-bubble-title' && completionTitles.includes(node.textContent),
  )
  assert.ok(topTitle, 'missing synthesized completion card')
  topTitle.parentNode.parentNode.listeners.get('click')[0]({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(harness.opened, ['forked'])
})

test('bubble area swallows pet interactions (click/dblclick/pointerdown/mousedown)', () => {
  const harness = createHarness()
  // Both the status-page deck (rm2-pet-bubbles) and the balance-page single bubble
  // (rm2-pet-bubble top) must intercept these: otherwise the events bubble up to the dock
  // and trigger a random reaction / double-click drawing / press-drag.
  for (const className of ['rm2-pet-bubble top', 'rm2-pet-bubbles']) {
    const el = harness.elements.find((node) => node.className === className)
    assert.ok(el, `missing element ${className}`)
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      const listeners = el.listeners.get(type) ?? []
      assert.ok(listeners.length >= 1, `${className} is missing a ${type} blocker`)
      let stopped = false
      listeners[listeners.length - 1]({ stopPropagation() { stopped = true } })
      assert.ok(stopped, `${className} ${type} blocker does not stop propagation`)
    }
  }
})

test('bubble hover uses the default cursor and wheel flips pages instead of scaling', () => {
  const harness = createHarness()
  // "the bubble area does not inherit the dock's grab cursor" used to be asserted against
  // `cursor:default` inside the CSS text and was removed: pointer shape is a visual detail, so
  // rewriting it as `cursor: default` (with several spaces) would fail for no real reason, and
  // that is not a behavioral contract — such checks belong to manual acceptance. The
  // assertions below all cover observable behavior instead.
  const balanceBubble = harness.elements.find((node) => node.className === 'rm2-pet-bubble top')
  const pageDot = harness.elements.find((node) => node.className === 'rm2-bubble-dot')
  assert.equal(balanceBubble.title, '', 'balance bubble must not inherit dock title')
  assert.equal(pageDot.title, '', 'page-switch dot must not inherit dock title')
  assert.equal(pageDot.dataset.rm2Tip, 'Click to see the balance~')
  harness.send({ ...base, sessions: [] })
  // Wheel paging: both bubble containers must catch the wheel (stopPropagation, not bubbling
  // up to the dock to scale), and the containers must be hit-testable (pointer-events:auto),
  // so a wheel over the gap between cards no longer passes through.
  for (const className of ['rm2-pet-bubble top', 'rm2-pet-bubbles']) {
    const el = harness.elements.find((node) => node.className === className)
    assert.ok(el, `missing element ${className}`)
    assert.equal(el.style.pointerEvents, 'auto', `${className} should be hit-testable while shown`)
    const wheel = el.listeners.get('wheel')?.[0]
    assert.ok(wheel, `${className} is missing a wheel handler`)
    let stopped = false
    let prevented = false
    wheel({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert.ok(stopped && prevented, `${className} wheel handler must capture the event`)
  }
})

test('page-switch dot overlay tip follows the page and restores the card tip', () => {
  const harness = createHarness()
  harness.send({
    ...base,
    showBubble: true,
    showBubbleStatus: true,
    showBubbleUsage: true,
    sessions: [{
      sessionId: 's1',
      state: 'WORKING',
      phase: 'output',
      message: 'Writing the answer out',
      detail: 'dsh-pet-remielle · Responding',
    }],
  })
  const pageDot = harness.elements.find((node) => node.className === 'rm2-bubble-dot')
  const card = harness.card('Writing the answer out')
  assert.equal(pageDot.title, '')
  assert.equal(pageDot.dataset.rm2Tip, 'Click to see the balance~')
  const enter = pageDot.listeners.get('mouseenter')?.[0]
  const leave = pageDot.listeners.get('mouseleave')?.[0]
  assert.ok(enter && leave, 'missing switch-dot hover listeners')
  enter({ stopPropagation() {} })
  const tip = harness.elements.find((node) => node.className === 'rm2-pet-tip')
  assert.ok(tip, 'missing .rm2-pet-tip')
  assert.equal(tip.textContent, 'Click to see the balance~')
  leave({ relatedTarget: card })
  assert.equal(tip.textContent, 'Click to jump here and take a look~')
  leave({})
  assert.equal(tip.style.display, 'none')
  harness.click(pageDot)
  assert.equal(pageDot.dataset.rm2Tip, 'Click to go back to status~')
  assert.equal(pageDot.title, '')
})
