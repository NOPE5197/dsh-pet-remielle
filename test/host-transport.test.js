import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, applyCompletionAck, Config, CONFIG_PATCH_FIELDS, createCompletionAckHandler, createCurrentSessionStore, createPendingActionStore, createSessionCurrentHandler, createSessionOpenHandler, createSettingsScope, createStreamHub, createStateSnapshot, createThemeHandler, defaults, dropSubagentCompletions, normalizeHostTheme, publicConfig, readSessionTitle, streamClientOf } from '../src/index.js'
import { DEFAULT_PET_ID, PET_ID_RE } from '../src/pets.js'
import { PetMessageKind, PetState, createMessage } from '../src/protocol.js'

function snapshotWith({ latest, pulse = null, config = {}, petId, getStates, getCompletions, getCurrent }) {
  return createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: () => config,
    getPetId: () => petId,
    getStates,
    getCompletions,
    getCurrent,
  })()
}

function responseRecorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body = '') { this.body = String(body) },
  }
}

function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function stubStreamRes() {
  const writes = []
  const res = {
    writes,
    write(chunk) { writes.push(String(chunk)); return true },
    end() {},
    on() { return res },
  }
  return res
}

function routeHarness() {
  const routes = new Map()
  const cleanups = []
  const webServer = {
    port: 3080,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const httpCtx = {
    webServer,
    get() { return undefined },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const ctx = {
    logger: { error() {}, warn() {} },
    inject(names, callback) {
      if (names.length === 1 && names[0] === 'settings') callback(ctx)
      else if (names.length === 1 && names[0] === 'webServer') callback(httpCtx)
    },
    on() { return () => {} },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  apply(ctx)
  return {
    routes,
    close() { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

const idle = createMessage(PetMessageKind.STATE, {
  sessionId: 's1',
  state: PetState.IDLE,
  mood: '06',
  phase: 'turn-end',
  message: 'Job finished, not bad~',
  detail: 's1 · Turn complete',
})

test('local POST endpoints reject bad method and unusable session ids', async () => {
  const cases = [
    {
      name: 'completion/ack',
      handler: createCompletionAckHandler({ acknowledge: () => assert.fail('must not acknowledge') }),
      badBody: {},
    },
    {
      name: 'session/open',
      handler: createSessionOpenHandler({ notify: () => assert.fail('must not notify') }),
      badBody: {},
    },
    {
      name: 'session/current',
      handler: createSessionCurrentHandler({ accept: (id) => assert.fail(`must not store ${id}`) }),
      badBody: { sessionId: 42 },
    },
  ]
  for (const { name, handler, badBody } of cases) {
    const wrongMethod = responseRecorder()
    await handler(request('GET'), wrongMethod)
    assert.equal(wrongMethod.status, 405, `${name} should reject non-POST`)
    const missing = responseRecorder()
    await handler(request('POST', badBody), missing)
    assert.equal(missing.status, 400, `${name} should reject an unusable sessionId`)
  }
})

test('desktop session open notifies the browser client and reports delivery', async () => {
  const notified = []
  const handler = createSessionOpenHandler({
    notify: (payload) => { notified.push(payload); return 1 },
  })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: true }), res)
  assert.equal(res.status, 200)
  assert.equal(notified.length, 1)
  assert.equal(notified[0].kind, 'session-action')
  assert.equal(notified[0].sessionId, 's1')
  assert.equal(notified[0].approve, true)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.delivered, true)

  // Completion-card click: `completed` must be passed through to the web client
  // (it decides whether to acknowledge along with it)
  const completedRes = responseRecorder()
  await handler(request('POST', { sessionId: 's1c', approve: false, completed: true }), completedRes)
  assert.equal(notified[1].kind, 'session-action')
  assert.equal(notified[1].sessionId, 's1c')
  assert.equal(notified[1].approve, false)
  assert.equal(notified[1].completed, true)

  // With no web client subscribed (notify returns 0): still 200, but
  // delivered=false
  const silentHandler = createSessionOpenHandler({ notify: () => 0 })
  const silentRes = responseRecorder()
  await silentHandler(request('POST', { sessionId: 's2', approve: true }), silentRes)
  assert.equal(silentRes.status, 200)
  const silentBody = JSON.parse(silentRes.body)
  assert.equal(silentBody.ok, true)
  assert.equal(silentBody.delivered, false)
})

test('undelivered session-action is stashed, delivered ones are not, latest wins', async () => {
  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({
    notify: () => 0,
    onUndelivered: (action) => store.stash(action),
  })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: false, completed: true }), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).delivered, false)
  // The whole action is stashed: the SSE subscriber sends it unchanged after
  // take(), so the web client's applySnapshot can consume it directly
  assert.deepEqual(store.take(), {
    protocolVersion: 1,
    kind: 'session-action',
    sessionId: 's1',
    approve: false,
    completed: true,
  })
  // take also clears: never replayed twice
  assert.equal(store.take(), null)

  // Delivered actions are not stashed; only the newest undelivered action is kept
  const stashed = []
  const deliveredHandler = createSessionOpenHandler({ notify: () => 2, onUndelivered: (a) => stashed.push(a) })
  await deliveredHandler(request('POST', { sessionId: 's1' }), responseRecorder())
  assert.equal(stashed.length, 0)
  await handler(request('POST', { sessionId: 'old' }), responseRecorder())
  await handler(request('POST', { sessionId: 'new' }), responseRecorder())
  assert.equal(store.take().sessionId, 'new')

  // Approvals are highly time-sensitive: they are not stashed, so a long offline
  // spell of the web client followed by a reconnect handshake cannot auto-approve
  // a stale request
  const approvalRes = responseRecorder()
  await handler(request('POST', { sessionId: 's1', approve: true }), approvalRes)
  assert.equal(approvalRes.status, 200)
  assert.equal(JSON.parse(approvalRes.body).delivered, false)
  assert.equal(store.take(), null)
})

// The desktop pet window's SSE subscription must not count as "a web page is
// online": otherwise it would push clicked actions to delivered and the web
// client would never receive the replay afterwards. All three angles (subscription
// identification, hub counting, end to end) are asserted together.
test('pet-window subscribers never count as delivered web clients', async () => {
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=pet'), 'pet')
  // The web client replays as usual without the parameter (or with another value)
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream'), 'web')
  assert.equal(streamClientOf('/plugins/dsh-pet-remielle/stream?client=web'), 'web')
  // A malformed url falls back to a web subscriber
  assert.equal(streamClientOf(undefined), 'web')

  const hub = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const pet = stubStreamRes()
  hub.add(pet, { client: 'pet' })
  hub.add(stubStreamRes())
  assert.equal(hub.size, 2)
  assert.equal(hub.notify({ kind: 'session-action', sessionId: 's1' }), 1)
  // The pet window still receives the frame (its page ignores frames carrying a
  // kind by itself), but it is not counted
  assert.ok(pet.writes.join('').includes('"sessionId":"s1"'))
  assert.equal(hub.notify({ kind: 'session-action' }), 1)
  hub.close()

  // End to end: with only the pet window online, delivered=false and the action
  // must go into the stash instead of being pushed to delivered
  const petOnly = createStreamHub({ serve: () => ({ state: 'IDLE' }) })
  const store = createPendingActionStore()
  const handler = createSessionOpenHandler({
    notify: (payload) => petOnly.notify(payload),
    onUndelivered: (action) => store.stash(action),
  })
  petOnly.add(stubStreamRes(), { client: 'pet' })
  const res = responseRecorder()
  await handler(request('POST', { sessionId: 's9', approve: false }), res)
  assert.equal(JSON.parse(res.body).delivered, false)
  assert.equal(store.take()?.sessionId, 's9')
  petOnly.close()
})

// The desktop window learns "which session are you looking at" from
// currentSessionId in the host snapshot. Repeated reports from the same tab do not
// broadcast; different tabs are stored independently, a hidden tab's clear cannot
// wipe the visible tab, and stale entries must also expire.
test('session current uplink tracks changes per browser tab and expires stale reports', async () => {
  let now = 1000
  let stored = ''
  const seen = []
  const store = createCurrentSessionStore({ ttlMs: 100, now: () => now })
  const handler = createSessionCurrentHandler({
    store,
    accept: (id, meta) => { stored = id; seen.push([id, meta.clientId, meta.changed]) },
  })
  for (const [sessionId, clientId] of [['s1', 'tab-a'], ['s1', 'tab-a'], ['s2', 'tab-b']]) {
    const res = responseRecorder()
    await handler(request('POST', { sessionId, clientId }), res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
  }
  now += 50
  await handler(request('POST', { sessionId: '', clientId: 'tab-a' }), responseRecorder())
  assert.equal(stored, '')
  assert.equal(store.current(), 's2', "a hidden tab's clear must not wipe the visible tab")
  assert.deepEqual(seen, [
    ['s1', 'tab-a', true],
    ['s1', 'tab-a', false],
    ['s2', 'tab-b', true],
    ['', 'tab-a', true],
  ])
  now += 51
  assert.equal(store.current(), '', 'an expired tab must not stay the current session')
})

test('bubble-title route serves the real shared script handler', async () => {
  const harness = routeHarness()
  try {
    const handler = harness.routes.get('/plugins/dsh-pet-remielle/bubble-title.js')
    assert.equal(typeof handler, 'function')
    const res = responseRecorder()
    await handler(request('GET'), res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^application\/javascript/)
    assert.match(res.body, /__rm2BubbleTitle/)
  } finally {
    harness.close()
  }
})

// The desktop floating window is a separate window and cannot read the host
// page's body[data-ds-dark-theme] — its dark-mode switch depends entirely on the
// hostTheme reported by the web client. The normalization function is the only
// entry point of this chain: a casing typo like 'Dark' must raise an error here,
// otherwise it would quietly make the two clients' colors inconsistent (nearly
// invisible without comparing screen by screen).
test('host theme normalization accepts only dark/light and clears on empty', () => {
  assert.equal(normalizeHostTheme('dark'), 'dark')
  assert.equal(normalizeHostTheme('light'), 'light')
  assert.equal(normalizeHostTheme(''), '')
  assert.equal(normalizeHostTheme(undefined), '')
  assert.equal(normalizeHostTheme(null), '')
  assert.throws(() => normalizeHostTheme('Dark'), /theme/)
  assert.throws(() => normalizeHostTheme(true), /theme/)
})

test('theme uplink stores, clears, reports real changes and rejects bad input', async () => {
  const seen = []
  const handler = createThemeHandler({ accept: (theme, meta) => seen.push([theme, meta.changed]) })
  for (const theme of ['dark', 'dark', 'light', '', '']) {
    const res = responseRecorder()
    await handler(request('POST', { theme }), res)
    assert.equal(res.status, 200)
  }
  assert.deepEqual(seen, [
    ['dark', true],  // first report: going from "unknown" to dark is a change too
    ['dark', false], // heartbeat renewal reporting the same value: no broadcast
    ['light', true],
    ['', true],      // clear (page closed): the desktop window must fall back to the system theme at once, which is a real change
    ['', false],
  ])

  let stored = 'untouched'
  const strict = createThemeHandler({ accept: (theme) => { stored = theme } })
  const bad = responseRecorder()
  await strict(request('POST', { theme: 'Dark' }), bad)
  assert.equal(bad.status, 400)
  assert.equal(stored, 'untouched')
  const wrongMethod = responseRecorder()
  await strict(request('GET'), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('theme uplink clears only the reporting browser tab', async () => {
  const seen = []
  const handler = createThemeHandler({ accept: (theme, meta) => seen.push([theme, meta.changed, meta.clientId]) })
  const post = (clientId, theme) => handler(request('POST', { clientId, theme }), responseRecorder())

  await post('tab-a', 'dark')
  await post('tab-b', 'dark')
  await post('tab-a', '')
  await post('tab-b', '')

  assert.deepEqual(seen, [
    ['dark', true, 'tab-a'],
    ['dark', false, 'tab-b'],
    ['dark', false, 'tab-a'],
    ['', true, 'tab-b'],
  ])
})

// hostTheme / currentSessionId reported by the web client are both "send only
// when set" fields: after clearing, the field must be absent (rather than an empty
// string), and the desktop window falls back to the system theme / drops "which
// session is being viewed" accordingly.
test('snapshot carries reported host theme and current session only when set', () => {
  const withReports = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getTheme: () => 'dark',
    getCurrent: () => 's1',
  })()
  assert.equal(withReports.hostTheme, 'dark')
  assert.equal(withReports.currentSessionId, 's1')

  // No web client online / expired report: the fields are absent
  const unset = snapshotWith({ latest: idle })
  assert.equal(unset.hostTheme, undefined)
  assert.equal('hostTheme' in JSON.parse(JSON.stringify(unset)), false)
  assert.equal(unset.currentSessionId, undefined)

  // An empty string (the cleared state) likewise falls back to absent
  const cleared = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getCurrent: () => '',
  })()
  assert.equal(cleared.currentSessionId, undefined)
  assert.equal('currentSessionId' in JSON.parse(JSON.stringify(cleared)), false)
})
