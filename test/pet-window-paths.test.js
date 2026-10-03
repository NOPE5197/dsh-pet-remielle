import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const paths = require('../src/pet-window-paths.cjs')

/** One independent temporary root directory per case, the whole directory removed afterwards (only the one we created). */
function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-paths-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('directory helpers keep the stable dir and the per-pid fallback side by side', () => {
  const root = join('C:', 'appdata')
  assert.equal(paths.baseDirOf(root), join(root, 'dsh-pet-remielle'))
  assert.equal(paths.fallbackDirOf(root, 4242), `${join(root, 'dsh-pet-remielle')}-4242`)
  // The occupancy marker always lives in the stable directory: fallback instances rely on it too
  // to tell whether the stable directory is in use.
  assert.equal(paths.lockPathOf(root), join(root, 'dsh-pet-remielle', 'pet-window.lock'))
})

test('resolveUserDataDir uses the stable dir when nobody holds the lock', () => {
  const root = join('C:', 'appdata')
  const choice = paths.resolveUserDataDir({ appDataDir: root, pid: 100, occupantPid: null })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.fallback, false)
  assert.equal(choice.occupantPid, null)
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir falls back to a per-pid dir when a live foreign process holds it', () => {
  const root = join('C:', 'appdata')
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 200,
    isAlive: (pid) => pid === 200,
  })
  assert.equal(choice.dir, paths.fallbackDirOf(root, 100))
  assert.equal(choice.fallback, true)
  assert.equal(choice.occupantPid, 200)
  // The fallback instance does not touch the stable directory's marker: that marker belongs to
  // the owner of the stable directory, and overwriting it makes the owner misjudge "it is not
  // mine" on exit and leave a stale marker on disk permanently.
  assert.equal(choice.ownsLock, false)
})

test('resolveUserDataDir reuses the stable dir when the recorded pid is dead', () => {
  const root = join('C:', 'appdata')
  // Crash residue: the marker is still there but the process is gone → self-heal by reusing the
  // stable directory and taking over the marker.
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 200,
    isAlive: () => false,
  })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.fallback, false)
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir treats a stale lock written by ourselves as free', () => {
  const root = join('C:', 'appdata')
  // A pid identical to ours (a marker left by the previous abnormal exit) does not count as
  // occupied: otherwise every launch would switch directories.
  const choice = paths.resolveUserDataDir({
    appDataDir: root,
    pid: 100,
    occupantPid: 100,
    isAlive: () => true,
  })
  assert.equal(choice.dir, paths.baseDirOf(root))
  assert.equal(choice.ownsLock, true)
})

test('resolveUserDataDir ignores garbage occupant values', () => {
  const root = join('C:', 'appdata')
  for (const occupantPid of [0, -1, 1.5, Number.NaN, 'abc', undefined]) {
    const choice = paths.resolveUserDataDir({
      appDataDir: root,
      pid: 100,
      occupantPid,
      isAlive: () => true,
    })
    assert.equal(choice.dir, paths.baseDirOf(root), `occupantPid=${String(occupantPid)} should count as idle`)
    assert.equal(choice.ownsLock, true)
  }
})

test('readOccupantPid returns null for missing, corrupt or malformed locks', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    assert.equal(paths.readOccupantPid(lock), null, 'a missing file should count as idle')
    mkdirSync(join(root, 'dsh-pet-remielle'), { recursive: true })
    writeFileSync(lock, 'not json', 'utf8')
    assert.equal(paths.readOccupantPid(lock), null, 'corrupt JSON should count as idle')
    writeFileSync(lock, JSON.stringify({ pid: 'x' }), 'utf8')
    assert.equal(paths.readOccupantPid(lock), null, 'an invalid pid should count as idle')
    writeFileSync(lock, JSON.stringify({ pid: 321 }), 'utf8')
    assert.equal(paths.readOccupantPid(lock), 321)
  })
})

test('writeLock creates the stable dir and records this pid', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    assert.equal(paths.writeLock(lock, 777), true)
    const written = JSON.parse(readFileSync(lock, 'utf8'))
    assert.equal(written.pid, 777)
    assert.ok(Number.isFinite(written.startedAt))
    assert.equal(paths.readOccupantPid(lock), 777)
  })
})

test('releaseLock removes only a lock that still belongs to this pid', () => {
  withTempRoot((root) => {
    const lock = paths.lockPathOf(root)
    paths.writeLock(lock, 777)
    // The marker was taken over by another instance → must never be deleted, otherwise the
    // successor loses its mutual exclusion protection.
    assert.equal(paths.releaseLock(lock, 888), false)
    assert.equal(paths.readOccupantPid(lock), 777, "someone else's marker must be kept as-is")
    assert.equal(paths.releaseLock(lock, 777), true)
    assert.equal(paths.readOccupantPid(lock), null)
    // Releasing twice is idempotent (the file is already gone).
    assert.equal(paths.releaseLock(lock, 777), false)
  })
})
