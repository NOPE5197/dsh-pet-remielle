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


// Session title reading: the sessionTitle service's value wins, and every
// fallback derives the title from the session log
// (the host Session's public API is snapshotEvents(), not session.events).
function logSession(...titles) {
  return { snapshotEvents: () => titles.map((title) => ({ type: 'session/title', data: { title } })) }
}

test('readSessionTitle prefers the service and folds the log on every fallback', () => {
  assert.equal(readSessionTitle({
    sessions: { get: (id) => (id === 's1' ? logSession('title from the log') : undefined) },
    sessionTitle: { get: () => ({ title: '  title from the service  ' }) },
  }, 's1'), 'title from the service')

  // On cordis, property access throws when the service is not loaded or is
  // isolated; optional chaining cannot catch it, so it must be caught wholesale
  assert.equal(readSessionTitle({
    sessions: { get: () => logSession('old title', 'title from the log') },
    get sessionTitle() { throw new Error('cannot get property "sessionTitle" without inject') },
  }, 's1'), 'title from the log')

  const session = logSession('title from the log')
  for (const unusable of [undefined, { title: '   ' }]) {
    assert.equal(
      readSessionTitle({ sessions: { get: () => session }, sessionTitle: { get: () => unusable } }, 's1'),
      'title from the log',
      'should fall back to the log when the service yields no usable title',
    )
  }
})

test('readSessionTitle is undefined without a live session or a usable title', () => {
  assert.equal(readSessionTitle({ sessions: { get: () => undefined } }, 'nope'), undefined)
  assert.equal(readSessionTitle({ sessions: { get: () => logSession() } }, 's1'), undefined)
  assert.equal(readSessionTitle({ get sessions() { throw new Error('inactive context') } }, 's1'), undefined)
  assert.equal(readSessionTitle({ sessions: { get: () => ({ snapshotEvents: () => { throw new Error('boom') } }) } }, 's1'), undefined)
})

test('createSettingsScope reads volatile refs and disposes the profile presentation', async () => {  const writes = []
  const disposers = []
  let configured
  let activeOwner
  let updateListener
  const formsFiber = { name: 'settings-entry' }
  const eventFiber = { name: 'event-root' }
  const formsContext = {
    fiber: formsFiber,
    settings: {
      describe() {},
      configure(...args) {
        configured = args
        if (activeOwner === args[1]) throw new Error('already configured')
        activeOwner = args[1]
        return () => {
          if (activeOwner === args[1]) activeOwner = undefined
        }
      },
      update(...args) { writes.push(args); return Promise.resolve() },
    },
    effect(callback) { disposers.push(callback()) },
  }
  const eventContext = {
    fiber: eventFiber,
    on(name, listener) {
      assert.equal(name, 'loader/volatile-update')
      updateListener = listener
      return () => {}
    },
  }
  const config = new Config()
  assert.equal(typeof config.desktopMode.get, 'function')
  const scope = createSettingsScope(formsContext, config, eventContext)
  assert.deepEqual(configured, [{ auto: false }, eventFiber])
  assert.equal(disposers.length, 1)
  assert.equal(scope.get().desktopMode, false)
  assert.equal(typeof updateListener, 'undefined')
  scope.watch(() => {})
  assert.equal(typeof updateListener, 'function')
  disposers[0]()
  createSettingsScope(formsContext, config, eventContext)
  assert.equal(disposers.length, 2)
  disposers[1]()
  await scope.update({ desktopMode: true })
  assert.deepEqual(writes, [['dsh-pet-remielle', { desktopMode: true }]])
})

// DSH's settings.resolve is `schema(base+section)`: since 0.4.3 schema fields
// carry .volatile(), schemastery resolves every field into a cosmokit volatile
// wrapper object (the value hides inside wrapper.get()), and DSH's
// scope.get()/watch return that wrapper unchanged. With plain property access the
// plugin's pets becomes a non-array (emptying the pet list) and usageMode becomes
// '[object Object]' — a real incident on 2026-09-26. The register branch's
// get/watch must unwrap before handing values to plugin code.
test('createSettingsScope unwraps volatile wrappers on the DSH register path', () => {
  const section = {
    enabled: true,
    scale: 1.2,
    usageMode: 'token',
    platformToken: 'tok-123',
    desktopX: 280,
    desktopY: 482,
    activePetId: 'remielle',
    pets: [{ id: 'remielle', name: 'Remielle', enabled: true }],
  }
  // Simulate DSH: pour the persisted section into the real schema to get the
  // wrapper-layer resolved value
  const resolved = Config(section)
  assert.equal(typeof resolved.usageMode.get, 'function')
  let watchCallback
  const formsContext = {
    settings: {
      register(ns, schema, options) {
        assert.equal(ns, 'dsh-pet-remielle')
        return {
          get: () => resolved,
          watch(callback) { watchCallback = callback; return () => {} },
          update: () => Promise.resolve(),
        }
      },
    },
  }
  const scope = createSettingsScope(formsContext, {}, formsContext)
  const got = scope.get()
  assert.equal(got.usageMode, 'token')
  assert.equal(got.platformToken, 'tok-123')
  assert.equal(got.scale, 1.2)
  assert.equal(got.desktopX, 280)
  assert.equal(got.activePetId, 'remielle')
  assert.equal(Array.isArray(got.pets), true)
  assert.equal(got.pets.length, 1)
  assert.equal(got.pets[0].name, 'Remielle')
  // Fields that were not persisted fall back to the schema default rather than
  // undefined / a wrapper object
  assert.equal(got.bubbleScaleSync, true)
  // The watch callback is unwrapped too: the check `next.desktopMode === false`
  // has to be able to hold
  const seen = []
  scope.watch((next) => seen.push(next))
  assert.equal(typeof watchCallback, 'function')
  watchCallback(resolved, resolved)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].desktopMode, false)
  assert.equal(seen[0].usageMode, 'token')
})

// When "Respond to sub-agents" is switched off, the leftover sub-session
// completion cards must be withdrawn from the queue: the web client's filter
// only covers synthetic cards and cannot reach the host queue, so otherwise a
// sub-session card completed while the switch was on would stay on screen.
test('dropSubagentCompletions prunes only queued subagent cards', () => {
  const queue = new Map([
    ['sub', { sessionId: 'sub' }],
    ['plain', { sessionId: 'plain' }],
    ['gone', { sessionId: 'gone' }],
  ])
  // The decision uses host bookkeeping (already-disposed sub-sessions are still
  // recognized) and does not depend on a live Session — so 'gone' is pruned too,
  // while a plain session stays untouched.
  const subagents = new Set(['sub', 'gone'])
  assert.equal(dropSubagentCompletions(queue, (id) => subagents.has(id)), true)
  assert.deepEqual([...queue.keys()], ['plain'])

  const none = new Map([['plain', { sessionId: 'plain' }]])
  assert.equal(dropSubagentCompletions(none, () => false), false)
  assert.deepEqual([...none.keys()], ['plain'])
  assert.equal(dropSubagentCompletions(new Map(), () => true), false)
})

test('dropSubagentCompletions skips ids whose classifier throws', () => {
  const queue = new Map([
    ['broken', { sessionId: 'broken' }],
    ['sub', { sessionId: 'sub' }],
    ['plain', { sessionId: 'plain' }],
  ])
  assert.equal(dropSubagentCompletions(queue, (id) => {
    if (id === 'broken') throw new Error('classifier unavailable')
    return id === 'sub'
  }), true)
  assert.deepEqual([...queue.keys()], ['broken', 'plain'])
})

// The config fields really live in four places: the Config schema, defaults,
// publicConfig and the config endpoint allowlist, plus DSH 0.1.7's
// volatile / secret / pattern boundaries. Missing any one of them silently breaks
// the switch (mirror nearly got away with it: it is present in all four, but no
// test guarded it), so a single test pins all of them together.
//
// meta / inner are schemastery implementation details: default, volatile, role
// and pattern can only be read from here; there is no public equivalent API.
// 0.4.4's "volatile config stopped working" bug was caught precisely by the
// volatile assertion, so the whole suite stays — but as soon as the shape
// changes, the failure must point at "the meta shape changed" rather than at some
// individual field mismatch, so the shape itself is pinned once first.
test('config field lists and DSH 0.1.7 schema boundaries stay in sync', () => {
  const dict = Config.dict
  const metaOf = (field, what) => {
    assert.ok(field && (typeof field === 'object' || typeof field === 'function'), `${what}: the field should be retrievable from the schema`)
    assert.ok(field.meta && typeof field.meta === 'object', `${what}: a schemastery field should carry meta (this test's observation window)`)
    return field.meta
  }
  // For serializability schemastery stores the pattern as a plain { source, flags }
  // object rather than a RegExp instance (measured: `meta.pattern instanceof
  // RegExp` is false), so only .source can be read.
  const patternOf = (field, what) => {
    const pattern = metaOf(field, what).pattern
    assert.ok(pattern && typeof pattern === 'object' && typeof pattern.source === 'string', `${what}: the schema should carry a regex constraint (in { source, flags } form)`)
    return pattern.source
  }
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(dict).sort())
  for (const [key, field] of Object.entries(dict)) {
    const meta = metaOf(field, key)
    assert.deepEqual(defaults[key], meta.default, `the default value of ${key} disagrees with the schema`)
    assert.equal(meta.volatile, true, `${key} must be a volatile config field`)
  }
  assert.equal(metaOf(Config.dict.platformToken, 'platformToken').role, 'secret', 'platformToken must be masked as a secret')
  assert.equal(patternOf(Config.dict.activePetId, 'activePetId'), PET_ID_RE.source)
  assert.equal(patternOf(Config.dict.pets?.inner?.dict?.id, 'pets[].id'), PET_ID_RE.source)

  // activePetId and pets go through the pet registry endpoint, not a config
  // PATCH, and do not appear in publicConfig either.
  const registryOnly = new Set(['activePetId', 'pets'])
  const expected = Object.keys(dict).filter((key) => !registryOnly.has(key)).sort()
  assert.deepEqual([...CONFIG_PATCH_FIELDS].sort(), expected)
  assert.deepEqual(Object.keys(publicConfig({})).sort(), expected)
})

// Route registration must depend on webServer only.
//
// Upstream once wrote ctx.inject(['webServer', 'connection'], cb), and cordis's
// inject only runs the callback when **every** service in the list is available —
// and that callback holds all 20 webServer.register calls of mount(). So on a host
// without a connection service the plugin does not merely lose one endpoint: the
// entire route table fails to register — no state push, no bubbles, no settings
// panel, and no error at all. The intent of that commit was only to put the
// process token on the desktop url; it must not gate the whole route table.
//
// What is pinned is the config fact of the dependency **list**: adding
// 'connection' back to the list turns this red. This still uses a source match
// rather than really running mount() — mount reads the pet registry and starts a
// pile of async work, which is expensive and brittle to mock; and the change this
// assertion guards against is precisely "someone slips an optional service into
// the inject list".
test('route registration does not depend on the optional connection service', async () => {
  const harness = routeHarness()
  try {
    assert.ok(harness.routes.size >= 10, 'the entire route table should still register without the optional connection service')
    assert.ok(harness.routes.has('/plugins/dsh-pet-remielle/state'))
    assert.ok(harness.routes.has('/plugins/dsh-pet-remielle/session/current'))
    const state = responseRecorder()
    await harness.routes.get('/plugins/dsh-pet-remielle/state')(request('GET'), state)
    assert.equal(state.status, 200)
  } finally {
    harness.close()
  }
})
