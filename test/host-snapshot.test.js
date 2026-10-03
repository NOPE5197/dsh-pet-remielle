import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, applyCompletionAck, clientConfig, Config, CONFIG_PATCH_FIELDS, createCompletionAckHandler, createConfigHandler, createCurrentSessionStore, createPendingActionStore, createSessionCurrentHandler, createSessionOpenHandler, createSettingsScope, createStreamHub, createStateSnapshot, createThemeHandler, defaults, dropSubagentCompletions, normalizeHostTheme, publicConfig, readSessionTitle, streamClientOf } from '../src/index.js'
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

test('snapshot fills session title from getSessionTitle when missing', () => {
  const snapshot = createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getStates: () => [{
      sessionId: 's1',
      state: PetState.THINKING,
      mood: '04',
      message: 'Let me think about the optimal solution',
      project: 'dsh-pet-remielle',
      updatedAt: 1,
    }],
    getSessionTitle: (sessionId) => sessionId === 's1' ? 'Review tooltip colors and overflow issues' : undefined,
  })()
  assert.equal(snapshot.sessions[0].title, 'Review tooltip colors and overflow issues')
  assert.equal(snapshot.sessions[0].project, 'dsh-pet-remielle')
})

// The snapshot's top-level fields: config, desktop window state, pet id and the
// web subscriber count are all settled here. Defaults and overrides are
// asserted together so they do not spread across a dozen one-line cases.
test('snapshot top-level fields follow config, desktop state and pet registry', () => {
  const full = snapshotWith({
    latest: idle,
    config: { enabled: true, scale: 1.25, opacity: 0.8, locked: true, desktopMode: true },
    petId: 'cirno',
  })
  assert.equal(full.enabled, true)
  assert.equal(full.scale, 1.25)
  assert.equal(full.opacity, 0.8)
  assert.equal(full.locked, true)
  assert.equal(full.bubble, true)
  // Clients uniformly read the showBubble alias; the top-level updatedAt feeds
  // the idle placeholder card
  assert.equal(full.showBubble, true)
  assert.equal(typeof full.updatedAt, 'number')
  assert.equal(full.desktopActive, false)
  assert.equal(full.desktopMode, true)
  assert.equal(full.petId, 'cirno')

  const bare = snapshotWith({ latest: idle })
  assert.equal(bare.enabled, true)
  assert.equal(bare.scale, 1)
  assert.equal(bare.opacity, 1)
  assert.equal(bare.locked, false)
  assert.equal(bare.bubble, true)
  assert.equal(bare.petId, DEFAULT_PET_ID)

  assert.equal(snapshotWith({ latest: idle, config: { enabled: false } }).enabled, false)
  // The host only reports desktopActive while the desktop window is open
  assert.equal(createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => undefined,
    getDesktopActive: () => true,
  })().desktopActive, true)
  // With no web client online / an expired report the default must be 0, not
  // undefined
  assert.equal(createStateSnapshot({
    getLatest: () => idle,
    getPulse: () => null,
    getConfig: () => ({}),
    getPetId: () => DEFAULT_PET_ID,
    getWebClients: () => 3,
  })().webClients, 3)
  assert.equal(bare.webClients, 0)
})

// Neither the snapshot nor /config may echo the token in plain text; the
// settings page only gets the configured flag, and updates are still written
// through PATCH.
test('state snapshot never carries platformToken', () => {
  const snapshot = snapshotWith({ latest: idle, config: { platformToken: 'sk-must-not-leak' }, petId: DEFAULT_PET_ID })
  assert.equal('platformToken' in snapshot, false)
  assert.equal(JSON.stringify(snapshot).includes('sk-must-not-leak'), false, 'the serialized snapshot must not contain the token in plain text')
  assert.equal(publicConfig({ platformToken: 'sk-ok' }).platformToken, 'sk-ok')
  assert.equal(clientConfig({ platformToken: 'sk-ok' }).platformTokenConfigured, true)
  assert.equal('platformToken' in clientConfig({ platformToken: 'sk-ok' }), false)
})

test('config route keeps platformToken write-only while preserving patch updates', async () => {
  const updates = []
  const settings = {
    get: () => ({ enabled: true, platformToken: 'sk-never-echo' }),
    update: async (patch) => { updates.push(patch) },
  }
  const handler = createConfigHandler(settings)
  const get = responseRecorder()
  await handler(request('GET'), get)
  const got = JSON.parse(get.body)
  assert.equal(get.status, 200)
  assert.equal(got.platformTokenConfigured, true)
  assert.equal('platformToken' in got, false)
  assert.equal(JSON.stringify(got).includes('sk-never-echo'), false)

  const patch = responseRecorder()
  await handler(request('PATCH', { platformToken: 'sk-replaced' }), patch)
  const updated = JSON.parse(patch.body)
  assert.deepEqual(updates, [{ platformToken: 'sk-replaced' }])
  assert.equal(updated.platformTokenConfigured, true)
  assert.equal('platformToken' in updated, false)

  const remoteHost = responseRecorder()
  const remoteRequest = request('GET')
  remoteRequest.headers.host = 'evil.example:3080'
  await handler(remoteRequest, remoteHost)
  assert.equal(remoteHost.status, 403)
})

test('snapshot exposes showBubble=false and pulse expiry', () => {
  const pulse = {
    ...createMessage(PetMessageKind.PULSE, {
      sessionId: 's1',
      state: PetState.SUCCESS,
      mood: '03',
      ttlMs: 5000,
      resumeState: PetState.IDLE,
      resumeMood: '06',
      resumeMessage: 'On standby',
      resumeDetail: 'DSH',
      message: 'Success',
      detail: 's1 · Turn complete',
    }),
    until: Date.now() + 5000,
  }
  const snapshot = snapshotWith({
    latest: idle,
    pulse,
    config: { showBubble: false },
  })
  assert.equal(snapshot.bubble, false)
  assert.ok(snapshot.pulseUntil > Date.now())
  const settled = snapshotWith({ latest: idle, config: { showBubble: false } })
  assert.equal(settled.pulseUntil, 0)
  // The pet id comes from the registry and must not drift with the pulse overlay
  assert.equal(snapshotWith({
    latest: idle,
    pulse: createMessage(PetMessageKind.PULSE, { sessionId: 's1', state: PetState.SUCCESS, mood: '03', ttlMs: 5000 }),
    petId: 'remielle',
  }).petId, 'remielle')
})

test('active pulse overlay wins over durable state', () => {
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    message: 'That task is done~',
    detail: 's1 · Turn complete',
  })
  const snapshot = snapshotWith({
    latest: idle,
    pulse: { ...pulse, until: Date.now() + 4000 },
  })
  assert.equal(snapshot.state, PetState.SUCCESS)
  assert.equal(snapshot.mood, '03')
  assert.equal(snapshot.message, 'That task is done~')
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.sessions[0].sessionId, 's1')
  assert.equal(snapshot.sessions[0].state, PetState.SUCCESS)

  // After it expires it falls back to the durable state, leaving no session card
  const expired = snapshotWith({ latest: idle, pulse: { ...pulse, until: Date.now() - 1000 } })
  assert.equal(expired.state, PetState.IDLE)
  assert.equal(expired.mood, '06')
  assert.deepEqual(expired.sessions, [])
})

/**
 * The ordering of the snapshot's sessions[].
 *
 * Division of labour: the priority table itself is defined in exactly one place,
 * test/session-order.test.js (which tests compareSessions directly). This is a
 * **wiring guard** — the inputs are deliberately laid out as think/cur/plan/ask/
 * appr, and the assertions prove createStateSnapshot really did sort with the
 * shared comparator (no sorting at all would fail), rather than restating the
 * rules. It also exclusively covers one thing the session-order unit test cannot
 * reach: a completion notification gets a `completion:` prefix when it enters
 * sessions[] and ranks ahead of attention.
 */
test('snapshot sessions follow session-order: approval > plan review > ask > completion > current > recency', () => {
  const snapshot = snapshotWith({
    latest: idle,
    getCurrent: () => 'cur',
    getStates: () => [
      { sessionId: 'think', state: PetState.THINKING, attention: false, updatedAt: 9 },
      { sessionId: 'cur', state: PetState.WORKING, attention: false, updatedAt: 1 },
      { sessionId: 'plan', state: PetState.WAITING, planReview: true, attention: true, updatedAt: 4 },
      { sessionId: 'ask', state: PetState.WAITING, ask: true, attention: true, updatedAt: 2 },
      { sessionId: 'appr', state: PetState.WAITING, approval: true, attention: true, updatedAt: 3 },
    ],
    getCompletions: () => [{
      sessionId: 'done',
      message: 'Task complete',
      detail: 'Task complete',
      phase: 'turn-end',
      updatedAt: 8,
    }],
  })
  assert.deepEqual(snapshot.sessions.map((entry) => entry.sessionId), [
    'appr',
    'plan',
    'ask',
    'completion:done',
    'cur',
    'think',
  ])
})

test('snapshot sessions[] mirrors tracked sessions, pulses and completions', () => {
  // Default: with no states it is an empty array (the client distinguishes
  // "no session" from "empty snapshot" by whether the array exists)
  assert.deepEqual(snapshotWith({ latest: idle }).sessions, [])

  const states = [
    { sessionId: 's2', state: PetState.WAITING, mood: '05', phase: 'ask', message: 'Waiting for your answer', detail: 's2 · Waiting for answer', attention: true, updatedAt: 4 },
    { sessionId: 's1', state: PetState.THINKING, mood: '01', phase: 'streaming', message: 'Responding', detail: 's1 · Responding', attention: false, updatedAt: 3 },
  ]
  assert.deepEqual(snapshotWith({ latest: idle, getStates: () => states }).sessions, states)

  // An active pulse overrides the entry of the session with the same id; other
  // sessions are left alone
  const pulse = createMessage(PetMessageKind.PULSE, {
    sessionId: 's1',
    state: PetState.SUCCESS,
    mood: '03',
    ttlMs: 5000,
    resumeState: PetState.IDLE,
    resumeMood: '06',
    message: 'That task is done~',
    detail: 's1 · Turn complete',
  })
  const flashed = snapshotWith({ latest: idle, getStates: () => states, pulse: { ...pulse, until: Date.now() + 4000 } }).sessions
  assert.equal(flashed.length, 2)
  const own = flashed.find((entry) => entry.sessionId === 's1')
  assert.equal(own.state, PetState.SUCCESS)
  assert.equal(own.mood, '03')
  assert.equal(own.message, 'That task is done~')
  assert.ok(own.pulseUntil > Date.now())
  assert.equal(flashed.find((entry) => entry.sessionId === 's2').state, PetState.WAITING)

  // A completion card in the queue synthesizes a completion:<id> entry that
  // survives after the pulse expires
  const completion = {
    sessionId: 'done-1',
    message: 'Task complete',
    detail: 'Task complete',
    phase: 'turn-end',
    updatedAt: 12,
  }
  const done = snapshotWith({ latest: idle, getCompletions: () => [completion] }).sessions
  assert.equal(done.length, 1)
  assert.equal(done[0].sessionId, 'completion:done-1')
  assert.equal(done[0].targetSessionId, 'done-1')
  assert.equal(done[0].state, PetState.SUCCESS)
  assert.equal(done[0].completed, true)
  assert.equal(done[0].completionNotification, true)

  // The session came back to life: the completion reminder for that same
  // session must be withdrawn and must not occupy a second card
  const live = snapshotWith({
    latest: idle,
    getStates: () => [{ sessionId: 'done-1', state: PetState.THINKING, mood: '04', message: 'Follow-up status', detail: 'Analyzing', updatedAt: 20 }],
    getCompletions: () => [completion],
  }).sessions
  assert.equal(live.length, 1)
  assert.equal(live[0].sessionId, 'done-1')
  assert.equal(live[0].state, PetState.THINKING)
  assert.equal(live.some((entry) => entry.sessionId === 'completion:done-1'), false)
})

/**
 * The two kinds of card the host synthesizes — the entry produced by an active
 * pulse overlay and the completion reminder in the queue — must explicitly carry
 * all three flags: approval / ask / planReview.
 *
 * Previously only the first two were set. **There is no behavioural difference
 * at all**: every consumer checks `=== true` (planReviewOf in session-order.cjs
 * is exactly `entry.planReview === true`), a missing field is strictly equivalent
 * to `false`, and the sort result is identical digit for digit. So this is not a
 * regression guard but a **shape guard**: the three synthesis points (pulse
 * override, completion reminder, snapshot fallback) must all spell out the same
 * set of flags, so whoever adds a new kind of card later can copy them instead
 * of having to guess "will it break if I leave one out" — the answer is no, but
 * an inconsistent field set makes the reader doubt they missed something.
 */
test('synthesized cards carry the full flag set', () => {
  const pulseCard = snapshotWith({
    latest: idle,
    pulse: { ...createMessage(PetMessageKind.PULSE, { sessionId: 's1', state: PetState.WAITING, mood: '05', ttlMs: 5000 }), until: Date.now() + 4000 },
  }).sessions
  const completionCard = snapshotWith({
    latest: idle,
    getCompletions: () => [{ sessionId: 'done-1', message: 'Task complete', detail: 'Task complete', phase: 'turn-end', updatedAt: 12 }],
  }).sessions
  assert.equal(pulseCard.length, 1)
  assert.equal(completionCard.length, 1)
  for (const entry of [...pulseCard, ...completionCard]) {
    const where = entry.sessionId
    assert.equal(entry.approval, false, `${where} should explicitly carry approval:false`)
    assert.equal(entry.ask, false, `${where} should explicitly carry ask:false`)
    assert.equal(entry.planReview, false, `${where} should explicitly carry planReview:false`)
  }
})

test('completion acknowledgement deletes one reminder, broadcasts, and forwards clearPulse', async () => {
  const acknowledged = []
  let broadcasts = 0
  const handler = createCompletionAckHandler({
    acknowledge: (sessionId, opts) => acknowledged.push({ sessionId, opts }),
    broadcast: () => { broadcasts += 1 },
  })
  const plain = responseRecorder()
  await handler(request('POST', { sessionId: 'done-1' }), plain)
  const flagged = responseRecorder()
  await handler(request('POST', { sessionId: 'done-1', clearPulse: true }), flagged)
  assert.equal(plain.status, 200)
  assert.equal(flagged.status, 200)
  assert.deepEqual(acknowledged, [
    { sessionId: 'done-1', opts: { clearPulse: false } },
    { sessionId: 'done-1', opts: { clearPulse: true } },
  ])
  assert.equal(broadcasts, 2, 'every acknowledgement must broadcast once')
})

test('applyCompletionAck only clears a SUCCESS pulse when clearPulse is set', () => {
  const queue = new Map([['done-1', { sessionId: 'done-1' }]])
  const success = { sessionId: 'done-1', state: PetState.SUCCESS }
  assert.equal(applyCompletionAck(queue, success, 'done-1'), success)
  assert.equal(queue.has('done-1'), false)
  queue.set('done-1', { sessionId: 'done-1' })
  assert.equal(applyCompletionAck(queue, success, 'done-1', { clearPulse: true }), null)
  // An ERROR card means "not finished yet"; acknowledging a completion reminder
  // must not wipe it away as well
  queue.set('done-1', { sessionId: 'done-1' })
  const errorPulse = { sessionId: 'done-1', state: PetState.ERROR }
  assert.equal(applyCompletionAck(queue, errorPulse, 'done-1', { clearPulse: true }), errorPulse)
})

// The three local POST endpoints share one contract: a bad method answers 405, a
// missing id answers 400, and none of them may trigger a side effect.
