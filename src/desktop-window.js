/**
 * Desktop-window bridge: discover an Electron backend and spawn the pet
 * window process (src/pet-window.cjs, which loads the pet-view page).
 *
 * Electron backends, in preference order:
 *   1. DSH_PET_ELECTRON env var override.
 *   2. The bundled Electron runtime (vendor/electron-<platform>-<arch>,
 *      resolved per-platform/arch via electronArtifact, fetched on demand)
 *      — so every user (plain web DSH host included) gets the same floating
 *      window with browser-engine GIF animation.
 *   3. npm global install (`npm install -g electron`) — find via
 *      `npm prefix -g` → node_modules/electron/dist/.
 *   4. The dsh binary root (derived from process.argv[1]) →
 *      node_modules/electron/dist/ or desktop/node_modules/electron/dist/.
 *   5. cwd fallback — the profile directory's own node_modules, or a local
 *      dev checkout that has electron in its tree.
 *
 * Configuration travels via environment variables (DSH_PET_URL /
 * DSH_PET_PARENT_PID): passing extra CLI args to a spawned Electron on
 * Windows crashes with exit -1, while env is stable.
 */

import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTarget, electronBinaryIn, isUsableElectronRoot } from './electron-fetch.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Walk up from `startDir` looking for a directory containing the given
 * `marker` path (relative to the candidate root). Returns the first
 * matching root, or `null` after `maxDepth` levels.
 */
export function findRoot(startDir, marker, maxDepth = 10) {
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(resolve(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Locate the dsh binary root by walking up from process.argv[1] (the main
 * script, typically `@deepseek-ai/dsh/lib/bin.js`). Falls back to cwd.
 */
export function findDshRoot(fallbackCwd) {
  const argv1 = process.argv[1]
  if (argv1) {
    const root = findRoot(dirname(resolve(argv1)), 'package.json')
    if (root) {
      if (existsSync(resolve(root, 'lib', 'bin.js')) || existsSync(resolve(root, 'node_modules', '@deepseek-ai', 'dsh'))) {
        return root
      }
    }
  }
  return fallbackCwd ?? null
}

/**
 * Try to find the npm global prefix by running `npm prefix -g`.
 * Returns the prefix path on success, null on failure.
 */
function getNpmGlobalPrefix() {
  try {
    const out = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * Candidate Electron backends, in preference order. Platform and cwd are
 * injectable for tests.
 * @returns `[{ kind: 'electron', command, args }]`.
 */
export function backendCandidates({ platform = process.platform, cwd = process.cwd(), arch = process.arch } = {}) {
  const candidates = []
  const args = [resolve(here, 'pet-window.cjs')]

  // --- 1. DSH_PET_ELECTRON env var override (highest priority) ---
  if (process.env.DSH_PET_ELECTRON) {
    candidates.push({ kind: 'electron', command: process.env.DSH_PET_ELECTRON, args })
  }

  // --- 2. Bundled vendor runtime (ships with the plugin, resolved per platform/arch) ---
  // Discovered candidates are always integrity-checked (issue #24): an exe-only incomplete
  // directory must be skipped so the caller falls through to the automatic reinstall in
  // ensureElectronRuntime, instead of forever launching an incomplete runtime.
  const bundledRoot = resolve(here, '..', 'vendor', runtimeTarget(platform, arch).folder)
  const bundled = electronBinaryIn(bundledRoot, platform, arch)
  if (isUsableElectronRoot(bundledRoot, platform)) {
    candidates.push({ kind: 'electron', command: bundled, args })
  }

  // --- 3. npm global install — user ran `npm install -g electron` somewhere ---
  const npmPrefix = getNpmGlobalPrefix()
  if (npmPrefix) {
    const globalRoot = resolve(npmPrefix, 'node_modules', 'electron', 'dist')
    const globalElectron = electronBinaryIn(globalRoot, platform, arch)
    if (isUsableElectronRoot(globalRoot, platform)) {
      candidates.push({ kind: 'electron', command: globalElectron, args })
    }
  }

  // --- 4. dsh binary root (from process.argv[1]) — the harness or any
  //     sibling project that happens to have electron in its node_modules ---
  const dshRoot = findDshRoot(cwd)
  if (dshRoot) {
    for (const base of [
      resolve(dshRoot, 'node_modules', 'electron', 'dist'),
      resolve(dshRoot, 'desktop', 'node_modules', 'electron', 'dist'),
    ]) {
      if (isUsableElectronRoot(base, platform)) {
        candidates.push({ kind: 'electron', command: electronBinaryIn(base, platform, arch), args })
        break
      }
    }
  }

  // --- 5. cwd fallback — profile directory or local dev checkout ---
  for (const base of [
    resolve(cwd, 'desktop/node_modules/electron/dist'),
    resolve(cwd, 'node_modules/electron/dist'),
  ]) {
    if (isUsableElectronRoot(base, platform)) {
      candidates.push({ kind: 'electron', command: electronBinaryIn(base, platform, arch), args })
      break
    }
  }

  return candidates
}

/** First usable backend, or null when none is available. */
export function resolveBackend(options) {
  return backendCandidates(options)[0] ?? null
}

/**
 * Manages the spawned pet window process. `start()` is a no-op when the
 * window already runs or when no backend was found (the browser pet stays
 * as the fallback). `stop()` tears the process down; `running` reflects whether
 * a window process is alive; `onExit` fires when the window dies and receives this instance.
 */
export class DesktopWindow {
  constructor({
    url,
    webUrl,
    backend = resolveBackend(),
    parentPid = process.pid,
    logger = console,
    spawnImpl = spawn,
    onExit,
    posX = null,
    posY = null,
    rendererHeader = null,
  } = {}) {
    if (!url) throw new Error('DesktopWindow requires a --url')
    this.url = url
    this.webUrl = webUrl
    this.backend = backend
    this.parentPid = parentPid
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.onExit = onExit
    // The DSH Desktop host's desktopBrowserAccess renderer admission header: when present it is
    // handed to pet-window.cjs via env for self-injection into same-origin requests (otherwise
    // every request gets 403 "forbidden" while the host has "Browser access" off, and the
    // desktop window only shows the word forbidden). See that file's comments.
    this.rendererHeader = rendererHeader && typeof rendererHeader.name === 'string' && rendererHeader.name
      && typeof rendererHeader.value === 'string' && rendererHeader.value
      ? { name: rendererHeader.name, value: rendererHeader.value }
      : null
    // Window position from the last close (config.desktopX/desktopY): valid coordinates are passed
    // via env to pet-window.cjs, which positions the window at creation. The coordinates share
    // the bounds API's space (see the force-device-scale-factor comment at the top of
    // pet-window.cjs: physical pixels on non-macOS, logical points on macOS).
    this.posX = Number.isFinite(Number(posX)) && posX !== null ? Number(posX) : null
    this.posY = Number.isFinite(Number(posY)) && posY !== null ? Number(posY) : null
    this.child = undefined
    this.startNonce = Date.now()
  }

  get running() {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  start() {
    if (this.running) return this.child
    if (!this.backend) {
      this.logger.info?.('dsh-pet-remielle: no Electron backend found, browser pet remains')
      return undefined
    }
    const child = this.spawnImpl(this.backend.command, this.backend.args, {
      cwd: dirname(this.backend.command),
      // pipe rather than inherit: Electron/Chromium often writes an empty line to the host console
      // during startup. Diagnostic logs that do carry content are still forwarded; purely blank
      // chunks are dropped.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        DSH_PET_URL: this.url + (this.url.includes('?') ? '&' : '?') + 'v=' + this.startNonce,
        DSH_WEB_URL: this.webUrl || new URL('/', this.url).origin,
        DSH_PET_PARENT_PID: String(this.parentPid),
        // Last-position persistence: only passed when both coordinates are present; the child process
        // positions the window at creation based on them.
        ...(this.posX !== null && this.posY !== null
          ? { DSH_PET_POS_X: String(Math.round(this.posX)), DSH_PET_POS_Y: String(Math.round(this.posY)) }
          : {}),
        // DSH Desktop renderer admission header (optional, see the constructor comment).
        ...(this.rendererHeader
          ? { DSH_PET_RENDERER_HEADER_NAME: this.rendererHeader.name, DSH_PET_RENDERER_HEADER_VALUE: this.rendererHeader.value }
          : {}),
      },
    })
    this.child = child
    let exitNotified = false
    const notifyExit = () => {
      if (exitNotified) return
      exitNotified = true
      // This exit callback belongs to child. The host may already have swapped in a new process for
      // some other reason (the user restarted desktop mode while this process's exit event
      // arrives late), in which case this.child points at **someone else**.
      //
      // The previous version handled the two things asymmetrically: the cleanup of
      // this.child had a `=== child` guard while onExit was called unconditionally. The
      // host-side onExit nulls the desktop reference, so a "late exit of the old process"
      // would wipe out "the new process that is running" — the host believes there is no pet
      // window, and opening it once more then yields two always-on-top windows plus a zombie
      // electron process with no references.
      //
      // "stale" is only declared when "another process really has taken over": this.child
      // already being undefined is the normal path where stop() deliberately stopped it, and
      // that exit still has to notify onExit (the host relies on the exit callback elsewhere for
      // cleanup), so it must not be swallowed along with it.
      const superseded = this.child !== undefined && this.child !== child
      if (!superseded) this.child = undefined
      // The exit reason must be visible: a desktop window process dying silently makes
      // "position/startup" problems completely undebuggable (the DSH Desktop host does not
      // forward the child stdio to the log, and only this line reaches disk).
      const code = child.exitCode
      const signal = child.signalCode
      this.logger.info?.(`dsh-pet-remielle: pet window exited (code=${code === null ? 'signal:' + String(signal) : code}${superseded ? ', superseded by a newer window' : ''})`)
      if (!superseded) this.onExit?.(this)
    }
    const forward = (stream, dest) => {
      if (!stream || typeof stream.on !== 'function' || !dest || typeof dest.write !== 'function') return
      stream.on('data', (chunk) => {
        const text = String(chunk)
        if (!text.trim()) return
        dest.write(text)
      })
    }
    forward(child.stdout, process.stdout)
    forward(child.stderr, process.stderr)
    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet-remielle: pet window failed to start: ${error.message}`)
      notifyExit()
    })
    child.once('exit', () => {
      notifyExit()
    })
    return child
  }

  /** Stop the pet window and resolve once its process has exited (immediately
   *  when it was not running). Callers that must release file locks before
   *  replacing plugin files (self-update) await the returned promise. */
  stop(reason = 'stopped') {
    const child = this.child
    this.child = undefined
    if (!child || child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => {
      // Fallback timer: even if kill fails and the exit event never arrives, the update flow
      // must not get stuck
      const fallback = setTimeout(resolve, 5000)
      if (typeof fallback.unref === 'function') fallback.unref()
      child.once('exit', () => {
        clearTimeout(fallback)
        resolve()
      })
      try {
        child.kill()
      } catch (error) {
        this.logger.warn?.(`dsh-pet-remielle: pet window kill failed (${reason}): ${String(error)}`)
      }
    })
  }
}
