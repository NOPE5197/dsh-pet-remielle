/**
 * pet-window userData directory decisions (follow-up to issue #21).
 *
 * This directory has to satisfy three constraints that pull against each other:
 *
 *  ① Isolated from the host's Electron. Sharing the default %APPDATA%/Electron locks the disk
 *     cache and serves stale responses (historical bug: the desktop pet page kept running the
 *     old right-click logic that had been deleted), so it must be a separate directory and we
 *     cannot take the shortcut of using the default path.
 *  ② In a stable location. The original implementation used %TEMP%/dsh-pet-remielle — system
 *     disk cleanup deletes the whole directory, taking the Electron cache and the renderer's
 *     localStorage position fallback with it.
 *  ③ Used by only one pet-window process at a time. The host relies on a watchdog to detect
 *     its own exit, so restarting it quickly makes the old and new instances overlap; two
 *     processes sharing one Chromium profile re-introduce the stale cache problem from ①.
 *     Hence an occupancy marker recording the pid, falling back to a sibling directory carrying
 *     our own pid when it is held by a live process.
 *
 * The fallback is "best effort": it only guarantees the two instances do not fight, at the
 * cost that this round's localStorage position fallback starts from zero (the host-persisted
 * window coordinates are unaffected — they travel a different path).
 *
 * This file is pure logic and does not require electron, so it can be unit-tested directly.
 */

const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

/** Stable directory name (same as the plugin, so users can recognize it in %APPDATA%). */
const DIR_NAME = 'dsh-pet-remielle'
/** Occupancy marker file name. */
const LOCK_FILE = 'pet-window.lock'

/** Stable directory: `<appData>/dsh-pet-remielle`. */
function baseDirOf(appDataDir) {
  return path.join(appDataDir, DIR_NAME)
}

/** Fallback directory: `<appData>/dsh-pet-remielle-<pid>` (used when the stable directory is held by a live instance). */
function fallbackDirOf(appDataDir, pid) {
  return `${baseDirOf(appDataDir)}-${pid}`
}

/** Occupancy marker path. It always lives inside the stable directory, and fallback instances read it too. */
function lockPathOf(appDataDir) {
  return path.join(baseDirOf(appDataDir), LOCK_FILE)
}

/**
 * Is the pid still alive? ESRCH = the process does not exist; EPERM = it exists but the signal
 * may not be sent — the latter is precisely proof that the process is still there (the NodeService
 * host of DSH Desktop is exactly that case) and must never be treated as exited.
 * The criterion matches the host watchdog in pet-window.cjs.
 */
function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** Read the pid from the occupancy marker; a missing file / corrupt JSON / invalid content all return null (treated as idle). */
function readOccupantPid(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    const pid = Number(parsed && parsed.pid)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Write the occupancy marker (creating the parent directory if needed). Never throws — it degrades to "no mutual exclusion" rather than failing to start. */
function writeLock(lockPath, pid) {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: Number(pid), startedAt: Date.now() }), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Release the occupancy marker. Delete it only when the marker still belongs to us — otherwise
 * the successor's marker gets deleted by mistake and the next launch loses mutual exclusion.
 */
function releaseLock(lockPath, pid) {
  try {
    if (readOccupantPid(lockPath) !== Number(pid)) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Pick the userData directory for this round.
 *
 * @param {object} options
 * @param {string} options.appDataDir stable root directory (Electron's `app.getPath('appData')`)
 * @param {number} options.pid this process's pid
 * @param {number|null} [options.occupantPid] the pid in the occupancy marker (may be read beforehand and passed in)
 * @param {(pid: number) => boolean} [options.isAlive] liveness probe (real probe by default, injectable in tests)
 * @returns {{dir: string, baseDir: string, lockPath: string, fallback: boolean, occupantPid: number|null, ownsLock: boolean}}
 */
function resolveUserDataDir({ appDataDir, pid, occupantPid = null, isAlive = isProcessAlive }) {
  const baseDir = baseDirOf(appDataDir)
  const seen = Number(occupantPid)
  // Only back off when "another, still-alive process holds the stable directory": an occupant
  // that is our own leftover (same pid) or already dead (crash residue) just reuses the stable
  // directory, which makes it self-healing.
  const busy = Number.isInteger(seen) && seen > 0 && seen !== Number(pid) && isAlive(seen)
  return {
    dir: busy ? fallbackDirOf(appDataDir, pid) : baseDir,
    baseDir,
    lockPath: lockPathOf(appDataDir),
    fallback: busy,
    occupantPid: busy ? seen : null,
    // The fallback instance does not touch the stable directory's marker: that marker belongs
    // to the user of the stable directory, and overwriting it would make the real owner
    // misjudge "it is not mine" on exit and leave a stale marker on disk.
    ownsLock: !busy,
  }
}

module.exports = {
  DIR_NAME,
  LOCK_FILE,
  baseDirOf,
  fallbackDirOf,
  isProcessAlive,
  lockPathOf,
  readOccupantPid,
  releaseLock,
  resolveUserDataDir,
  writeLock,
}
