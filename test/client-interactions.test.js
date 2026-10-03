import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CLIENT_CORE, STATUS_COPY, base, createHarness } from './helpers/client-harness.mjs'
// Clearing the reported state on unload (pagehide/beforeunload + sendBeacon/keepalive) is
// verified behaviorally by the 'unloading clears the reported current session…' case below,
// which really dispatches the window events — four static assertions against the lib artifact
// used to live here (grep addEventListener('pagehide'… and keepalive), covering the same
// ground while being more prone to false positives.
test('current-session uplink fires on mount and on select', () => {
  const harness = createHarness()
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  // The current session is reported at mount time (fire-and-forget; the host hands it back
  // with the next snapshot)
  assert.ok(currentPosts().length >= 1, 'mount should report the current session')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'other')
  // It is reported again when the session changes
  harness.select('ws9')
  assert.ok(currentPosts().length >= 2, 'selecting a session should re-report')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'ws9')
})

test('hidden tab does not overwrite the reported current session until it becomes visible', () => {
  const harness = createHarness('other')
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.setVisibility('hidden')
  harness.select('background')
  assert.equal(currentPosts().length, initialCount, 'hidden tab must not report its selection')

  harness.setVisibility('visible')
  assert.equal(currentPosts().length, initialCount + 1, 'becoming visible re-reports the local selection')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'background')
})

test('a focus event while hidden does not restore the current-session report', () => {
  const harness = createHarness('other')
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.setVisibility('hidden')
  harness.setFocus(false)
  harness.select('background')
  harness.setFocus(true)

  assert.equal(currentPosts().length, initialCount, 'hidden focus must not report a session')
  harness.setVisibility('visible')
  assert.equal(currentPosts().length, initialCount + 1, 'the visible transition reports the local session')
})

test('missing layout service keeps current-session reporting usable on older hosts', () => {
  const harness = createHarness('other', true, [], false, false)
  const currentPosts = () => harness.fetches.filter(({ url }) => String(url).endsWith('/plugins/dsh-pet-remielle/session/current'))
  const initialCount = currentPosts().length

  harness.select('background')
  assert.equal(currentPosts().length, initialCount + 1, 'missing optional layout must not disable session reporting')
  assert.equal(JSON.parse(currentPosts().at(-1).options.body).sessionId, 'background')
})

test('active global panel keeps the retained session completion unacknowledged', async () => {
  const harness = createHarness('watched', true, {
    watched: { id: 'watched', retainedBy: { mainView: 1 } },
  }, true)
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

  harness.setPanelActive(true)
  harness.send(completed)
  await Promise.resolve()
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)
  harness.card('Task complete')

  harness.setPanelActive(false)
  harness.send(completed)
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')))
})

// "There is only one completion card" does not mean "the user is looking at it". When the host
// gives no current session (page just loaded, tabs overwriting each other), a wrong guess
// silently swallows an unseen reminder, so it is better left to a manual click.
//
// This case pins the "do not guess" behavior as a whole and **does not distinguish** the
// `if (!target) return` guard inside ackCurrentSessionCompletion: swapping the fixture for
// undefined (which triggers createHarness's default 'other') is green too, because "no
// current session" and "a current session that does not match" both send no ack. That guard
// also cannot be pinned by a behavioral assertion on its own — the only way to create a
// difference is to make the completion card have no target either (the entry has neither
// targetSessionId nor sessionId, so targetSessionOf returns undefined), but then
// acknowledgeCompletion(undefined) is stopped by its own leading `if (!sessionId) return`,
// so deleting the guard stays green (measured). In other words both guards behave
// equivalently on every reachable path, the latter is redundant insurance for the former and
// needs no test protection.
test('a lone completion card stays unacknowledged while the viewed session is unknown', async () => {
  const harness = createHarness(null, false, [], true)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:elsewhere',
      targetSessionId: 'elsewhere',
      state: 'SUCCESS',
      message: 'Task complete',
      detail: 'Result',
      completed: true,
      completionNotification: true,
    }],
  })
  await Promise.resolve()
  assert.equal(
    harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')),
    false,
    'must not acknowledge the only completion card on the user\'s behalf when it is unknown which session they are viewing',
  )
  // The reminder is still there: this case only constrains the automatic acknowledgement and
  // does not affect the deck's normal display
  harness.card('Task complete')
})

// A desktop bubble click must go through the host's navigation: both DSH 0.1.7's
// uiWorkspace.openSession and the legacy ctx.sessions.open have to open the session, and
// neither may carry any "allow once" side effect.
test('desktop bubble click opens its conversation on both navigation paths', () => {
  for (const modern of [false, true]) {
    const harness = createHarness('other', true, [], modern)
    harness.send({ ...base, desktopActive: true, sessions: [] })
    harness.send({ kind: 'session-action', sessionId: 'desk-9', approve: false })
    assert.ok(harness.opened.includes('desk-9'), `should open the session (uiWorkspace=${modern})`)
    assert.deepEqual(harness.allowClicks, [])
  }
})

test('desktop completion-card click opens the conversation and acknowledges', async () => {
  const harness = createHarness()
  harness.send({ kind: 'session-action', sessionId: 'done-9', approve: false, completed: true })
  assert.ok(harness.opened.includes('done-9'), 'should open the completed session')
  assert.deepEqual(harness.allowClicks, [])
  await Promise.resolve()
  assert.ok(harness.fetches.some(({ url, options }) => String(url).endsWith('/completion/ack') && options.body === JSON.stringify({ sessionId: 'done-9' })))
})

test('the inline SUCCESS_COPY_POOL matches the success pool in status-copy.js verbatim (drift guard)', () => {
  // The web bundle does not include the status-copy module, so client.core.js inlines the
  // success copy pool; both places have to be maintained in sync, and this statically asserts
  // that they match so a later one-sided change cannot cause drift.
  const core = readFileSync(CLIENT_CORE, 'utf8')
  const copySource = readFileSync(STATUS_COPY, 'utf8')
  // Extract every single-quoted string from the source literal, giving an array of strings
  const parsePool = (literal) => {
    const items = [...literal.matchAll(/'([^']*)'/g)].map((match) => match[1])
    assert.ok(items.length >= 1, `the copy pool must not be empty: ${literal}`)
    return items
  }
  const inlineMatch = core.match(/\bSUCCESS_COPY_POOL\s*=\s*(\[[^\]]*\])/)
  assert.ok(inlineMatch, 'client.core.js must contain an inline SUCCESS_COPY_POOL literal')
  const statusMatch = copySource.match(/\bsuccess:\s*(\[[^\]]*\])/)
  assert.ok(statusMatch, 'status-copy.js must contain a success pool literal')
  assert.deepEqual(parsePool(inlineMatch[1]), parsePool(statusMatch[1]))
})

// The concatenation order (__rm2SessionOrder / __rm2PetTip / __rm2GifFrame / __rm2BubbleTitle /
// __rm2Markdown must come before mountPet) moved to scripts/build-client.mjs as a build-time
// hard assertion: a wrong order fails the build outright and the artifact is never written,
// which is earlier and more reliable than testing artifact strings afterwards.
//
// A "concatenation order" unit test used to live here; it was deleted without a replacement —
// the consumer-side fail-early guards (throw new Error('__rm2X is missing ...')) fire as soon
// as the real bundle is loaded, and the fact that this file's 38 cases run at all already
// proves the guards were not triggered by mistake.

test('unloading clears the reported current session via beacon or keepalive fetch (behavioral)', async () => {
  // sendBeacon available: pagehide clears the report through sendBeacon
  const harness = createHarness()
  harness.select('ws9')
  harness.dispatchWindowEvent('pagehide')
  assert.equal(harness.beacons.length, 1)
  assert.equal(JSON.parse(harness.beacons[0].body).sessionId, '')
  assert.ok(String(harness.beacons[0].url).endsWith('/plugins/dsh-pet-remielle/session/current'))

  // beforeunload clears it too (clearing twice has no side effect)
  harness.select('ws8')
  harness.dispatchWindowEvent('beforeunload')
  assert.equal(harness.beacons.length, 2)
  assert.equal(JSON.parse(harness.beacons[1].body).sessionId, '')

  // sendBeacon unavailable: fall back to a keepalive fetch
  harness.navigator.sendBeacon = undefined
  harness.select('ws7')
  const before = harness.fetches.length
  harness.dispatchWindowEvent('pagehide')
  const fallback = harness.fetches.slice(before).find(({ url, options }) =>
    String(url).endsWith('/session/current') && options.keepalive === true)
  assert.ok(fallback, 'should fall back to keepalive fetch when sendBeacon is unavailable')
  assert.equal(JSON.parse(fallback.options.body).sessionId, '')
})

test('disposed client ignores later focus and visibility events', async () => {
  const harness = createHarness('old-session')
  harness.setFocus(false)
  harness.send({
    ...base,
    sessions: [{
      sessionId: 'completion:old-session',
      targetSessionId: 'old-session',
      state: 'SUCCESS',
      message: 'Task complete',
      completed: true,
      completionNotification: true,
    }],
  })
  assert.equal(harness.fetches.some(({ url }) => String(url).endsWith('/completion/ack')), false)

  harness.dispose()
  harness.select('new-session')
  harness.fetches.length = 0
  harness.setFocus(true)
  harness.setVisibility('visible')
  await Promise.resolve()

  const staleRequests = harness.fetches.filter(({ url, options }) => {
    if (!/session\/current|completion\/ack/.test(String(url))) return false
    return JSON.parse(options.body).sessionId === 'old-session'
  })
  assert.equal(staleRequests.length, 0, 'disposed client must not report or acknowledge its old session')
})
