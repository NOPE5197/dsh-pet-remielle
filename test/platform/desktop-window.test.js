/**
 * DesktopWindow tests: Electron backend candidate discovery (env override,
 * bundled runtime, npm global, dsh root, cwd fallback), start/stop lifecycle
 * with a stubbed spawn, and the no-backend fallback.
 *
 * About the assertion style: the desktop pet's renderer layer is one whole HTML string plus an
 * inline script, with no DOM that node can drive, so the main tool in this file is "read the
 * source, match literals" (177 assert.match / doesNotMatch). This is an unavoidable choice for
 * that scenario, not debt waiting to be cleaned up:
 *   · Structural assertions ("both clients call the shared module", "neither client carries
 *     its own copy", "no hardcoded lift amount") guard against code regressions and are exactly
 *     the guardrails for changes like 3b6ace9 / 704ea4e, so they stay;
 *   · Purely literal assertions (matching a single string, going red when a variable is
 *     renamed) whose behaviour is already covered elsewhere (typically the behavioural
 *     assertions in test/bubble-title.test.js for the shared pure functions) are duplication
 *     and were deleted.
 * Deciding whether a new assertion belongs: first ask "is its behaviour already covered by
 * client-interactions / bubble-title and friends?" — if so, keep only the structural assertion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { backendCandidates, DesktopWindow, findRoot, findDshRoot } from '../../src/desktop-window.js'
import { cardHeightOf } from '../helpers/card-height.mjs'

/**
 * The structural contract of candidate discovery.
 *
 * This used to assert "the bundled runtime comes first", but the bundled / npm-global /
 * dsh-root candidates all require `isUsableElectronRoot()` to hold, which means the 184MB
 * Electron runtime really has to be on disk. On a clean clone and in CI it does not exist, so
 * the whole test got skipped — it looked like "it ran", but the coverage was zero.
 *
 * Broken down: how the candidate **paths are computed** is covered by
 * test/platform/electron-fetch.test.js (runtimeTarget / electronBinaryIn return the correct
 * file name per platform); what belongs here is "is every selected candidate well-formed" —
 * and that does not depend on whether this machine has Electron installed.
 */
test('every backend candidate is well-formed and points at the pet-window entry', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    delete process.env.DSH_PET_ELECTRON
    const list = backendCandidates({ platform: 'win32', cwd: 'C:/fairy' })
    for (const candidate of list) {
      assert.equal(candidate.kind, 'electron', 'only the Electron backend is supported today')
      assert.ok(candidate.command, 'a candidate must provide the executable path')
      assert.ok(
        candidate.args[0].includes('pet-window.cjs'),
        `the candidate entry should point at pet-window.cjs, got ${candidate.args[0]}`,
      )
    }
    // When this machine really has the bundled runtime installed, also confirm it comes first
    // (without it installed the check simply does not hold)
    if (list.some((c) => c.command.includes('electron-win32-x64'))) {
      assert.ok(list[0].command.includes('electron-win32-x64'), 'the bundled runtime should take priority over the npm global install')
    }
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('backend candidates honor DSH_PET_ELECTRON first', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    process.env.DSH_PET_ELECTRON = 'D:/custom/electron/electron.exe'
    const list = backendCandidates({ platform: 'win32', cwd: 'C:/fairy' })
    assert.equal(list[0].command, 'D:/custom/electron/electron.exe')
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('backend candidates on non-win32 fall back to harness electron', () => {
  const saved = process.env.DSH_PET_ELECTRON
  try {
    delete process.env.DSH_PET_ELECTRON
    const list = backendCandidates({ platform: 'darwin', cwd: 'C:/fairy' })
    assert.equal(list.some((entry) => entry.command.includes('electron-win32-x64')), false)
  } finally {
    if (saved !== undefined) process.env.DSH_PET_ELECTRON = saved
    else delete process.env.DSH_PET_ELECTRON
  }
})

test('DesktopWindow start spawns electron with env config', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    parentPid: 1234,
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.ok(spawned)
  assert.equal(spawned.command, 'D:/plugins/vendor/electron-win32-x64/electron.exe')
  assert.deepEqual(spawned.args, ['D:/plugins/src/pet-window.cjs'])
  assert.equal(spawned.options.windowsHide, false)
  assert.ok(spawned.options.env.DSH_PET_URL.startsWith('http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view'))
  assert.ok(spawned.options.env.DSH_PET_URL.includes('v='))
  assert.equal(spawned.options.env.DSH_WEB_URL, 'http://127.0.0.1:50336')
  assert.equal(spawned.options.env.DSH_PET_PARENT_PID, '1234')
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_NAME, undefined)
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_VALUE, undefined)
  assert.equal(window.running, true)
  window.stop()
  assert.equal(window.running, false)
})

test('DesktopWindow start passes renderer access header env when provided', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    // The DSH Desktop host's desktopBrowserAccess renderer admission header (issue: the desktop
    // window got 403 "forbidden" under DSH Desktop): it must be passed through env to the
    // window process verbatim.
    rendererHeader: { name: 'x-dsh-desktop-renderer', value: 'a'.repeat(43) },
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_NAME, 'x-dsh-desktop-renderer')
  assert.equal(spawned.options.env.DSH_PET_RENDERER_HEADER_VALUE, 'a'.repeat(43))
  window.stop()
})

test('DesktopWindow start passes DSH_WEB_URL when provided', () => {
  let spawned = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
    webUrl: 'http://127.0.0.1:50336/?token=launch-token',
    backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options }
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  assert.equal(spawned.options.env.DSH_WEB_URL, 'http://127.0.0.1:50336/?token=launch-token')
  assert.ok(spawned.options.env.DSH_PET_URL.startsWith('http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view'))
  window.stop()
})

// Position persistence (issue #21): valid coordinates travel to the child process via
// DSH_PET_POS_X/Y; when one is missing or not finite the env vars must not be set (the child
// process then falls back to the default fit / the localStorage fallback).
test('DesktopWindow forwards persisted position via env only when both coordinates are valid', () => {
  const makeChild = () => {
    const child = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true }
    return child
  }
  const spawnWith = (extra) => {
    let spawned = null
    const window = new DesktopWindow({
      url: 'http://127.0.0.1:50336/plugins/dsh-pet-remielle/pet-view',
      backend: { kind: 'electron', command: 'D:/plugins/vendor/electron-win32-x64/electron.exe', args: ['D:/plugins/src/pet-window.cjs'] },
      spawnImpl: (_command, _args, options) => { spawned = { options } ; return makeChild() },
      ...extra,
    })
    window.start()
    window.stop()
    return spawned.options.env
  }
  const env = spawnWith({ posX: 120.4, posY: 88.6 })
  assert.equal(env.DSH_PET_POS_X, '120')
  assert.equal(env.DSH_PET_POS_Y, '89')
  const envHalf = spawnWith({ posX: 120, posY: null })
  assert.equal(envHalf.DSH_PET_POS_X, undefined)
  assert.equal(envHalf.DSH_PET_POS_Y, undefined)
  const envNone = spawnWith({})
  assert.equal(envNone.DSH_PET_POS_X, undefined)
  assert.equal(envNone.DSH_PET_POS_Y, undefined)
})

test('DesktopWindow without a backend stays inert', () => {
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: null,
    spawnImpl: () => { throw new Error('must not spawn') },
  })
  assert.equal(window.running, false)
  assert.equal(window.start(), undefined)
  window.stop()
})

test('DesktopWindow start is idempotent while running and fires onExit', () => {
  let calls = 0
  let exited = 0
  let childRef = null
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    spawnImpl: () => {
      calls += 1
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      childRef = child
      return child
    },
  })
  window.start()
  window.start()
  assert.equal(calls, 1)
  window.stop()
  assert.equal(exited, 0)
  childRef.emit('exit')
  assert.equal(exited, 1, 'a process deliberately stopped by stop() must still notify onExit on exit')
})

// The old process's exit event arrives late while the user has already restarted desktop
// mode: the new process is running and the old process's exit callback must not wipe it out.
// In the previous version the cleanup of this.child had a `=== child` guard while onExit was
// called unconditionally, so the host nulled `desktop` → the host believed there was no pet
// window, and opening it once more yields two always-on-top windows plus a zombie electron
// process with no references.
test('a superseded window exiting late never clears the newer window', () => {
  const spawned = []
  let exited = 0
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      spawned.push(child)
      return child
    },
  })
  window.start()
  const stale = spawned[0]
  // The old process has not exited, but the caller already called start() again → this.child
  // points at the new process
  stale.exitCode = 0
  window.start()
  assert.equal(spawned.length, 2, 'the previous process must not be judged running while it is still alive')

  stale.emit('exit')
  assert.equal(exited, 0, "a superseded old process exiting must not fire onExit — that would clear the new process that is running")
  assert.equal(window.running, true, 'the new process should still be running')
})

test('onExit identifies the owning DesktopWindow instance', () => {
  let owner
  let child
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/electron.exe', args: [] },
    onExit: (instance) => { owner = instance },
    spawnImpl: () => {
      child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      child.kill = () => { child.killed = true }
      return child
    },
  })
  window.start()
  child.exitCode = 0
  child.emit('exit')
  assert.equal(owner, window)
})

test('DesktopWindow reports asynchronous spawn failures through onExit once', () => {
  let exited = 0
  let childRef
  const window = new DesktopWindow({
    url: 'http://127.0.0.1:1/x',
    backend: { kind: 'electron', command: 'E:/missing/electron.exe', args: [] },
    onExit: () => { exited += 1 },
    logger: { error() {} },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.exitCode = null
      child.killed = false
      // This case only goes through spawn failure → onExit and never calls stop(), so it does not
      // attach child.kill (the running getter reads exitCode/killed and nothing calls the
      // kill method)
      childRef = child
      return child
    },
  })
  window.start()
  childRef.emit('error', new Error('ENOENT'))
  assert.equal(exited, 1)
  childRef.emit('exit', 1)
  assert.equal(window.running, false)
  assert.equal(exited, 1)
})

// ---------- findRoot ----------

test('findRoot walks up and finds the marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fr-'))
  try {
    const root = join(dir, 'a', 'b', 'c')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'marker.txt'), '')
    assert.equal(findRoot(root, 'marker.txt'), join(dir, 'a', 'b'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findRoot returns null when marker not found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fr-'))
  try {
    mkdirSync(join(dir, 'x'), { recursive: true })
    assert.equal(findRoot(join(dir, 'x'), 'nope.txt', 3), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- findDshRoot ----------

test('findDshRoot finds a dsh-like root from argv[1]', () => {
  const saved = process.argv[1]
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dr-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'bin.js'), '')
    process.argv[1] = join(dir, 'lib', 'bin.js')
    const root = findDshRoot('C:/fallback')
    assert.equal(root, dir)
    rmSync(dir, { recursive: true, force: true })
  } finally {
    process.argv[1] = saved
  }
})

test('findDshRoot returns fallbackCwd when no dsh root', () => {
  const saved = process.argv[1]
  try {
    process.argv[1] = '/unrelated/script.js'
    const result = findDshRoot('C:/fallback')
    assert.equal(result, 'C:/fallback')
  } finally {
    process.argv[1] = saved
  }
})
