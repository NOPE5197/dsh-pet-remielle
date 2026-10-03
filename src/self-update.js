/**
 * Host half of the self-update flow: version check + one-click update.
 *
 * Ported from the pre-rewrite version's host logic:
 *   GET  /plugins/dsh-pet-remielle/check   -> query GitHub for the newest
 *                                             release/tag (direct, then local
 *                                             HTTP proxies / Steam++-style pins)
 *   POST /plugins/dsh-pet-remielle/update  -> run the update (git pull for a
 *                                             linked checkout, pnpm update --latest
 *                                             for a registry install) and return
 *                                             output; stops the desktop pet window
 *                                             first so its electron.exe does not
 *                                             lock the package directory
 *   GET  /plugins/dsh-pet-remielle/info    -> install mode, versions, command
 *   GET  /plugins/dsh-pet-remielle/update-progress
 *                                          -> running state, elapsed time and the
 *                                             tail of live output while updating
 *
 * Every route requires a loopback peer, a pinned HTTP method (POST for
 * `update`, GET for the reads), *and*, when the browser sends one, a
 * same-origin Origin — see the shared `localHostOk` helper. Host-header checking alone is
 * not a CSRF guard, and neither is the Origin check on its own: browsers omit
 * `Origin` on cross-origin GET/HEAD, so the method pin is what makes the
 * missing header unreachable for a hostile page.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, sep } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { localHostOk } from './local-access.js'

// Keep the previous named export for internal consumers while sharing the implementation.
export { localHostOk }

export const REPO = 'Gin-7/dsh-pet-remielle'
export const PKG = 'dsh-pet-remielle'
export const GITHUB = `https://github.com/${REPO}`
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`
export const TAGS_API = `https://api.github.com/repos/${REPO}/tags`

export const CHECK_ENDPOINT = '/plugins/dsh-pet-remielle/check'
export const UPDATE_ENDPOINT = '/plugins/dsh-pet-remielle/update'
export const PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'
export const INFO_ENDPOINT = '/plugins/dsh-pet-remielle/info'

// The package name / plugin id changed in 0.3.0 (before 0.2.0 it was
// @dsh-external/dsh-client-ui-pet-remielle, 0.2.0–0.3.0 it was dsh-pet-remielle):
// older installs have a different shape, cannot be incrementally updated, and
// must be uninstalled and reinstalled.
export const PACKAGE_RENAME_MIN = '0.3.0'

function semverLt(a, b) {
  const pa = (a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = (b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x < y
  }
  return false
}

export function needsCleanReinstallFor(version) {
  return semverLt(version, PACKAGE_RENAME_MIN)
}

/** Cannot be updated incrementally automatically: either the version is
 *  < 0.3.0 (the package name changed), or it is not a link install (never
 *  published to npm/pnpm, so `pnpm update` is unavailable). The user must then
 *  be guided through a full uninstall and reinstall. */
const isWin = process.platform === 'win32'

/** Local HTTP proxy candidates (in priority order) for reaching GitHub from CN networks. */
export function proxyCandidates() {
  const out = []
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[key]
    if (v && typeof v === 'string' && v.includes('://')) {
      try {
        const u = new URL(v)
        out.push(`${u.hostname}:${u.port || (u.protocol === 'http:' ? 80 : 443)}`)
      } catch { /* skip malformed */ }
    }
  }
  for (const p of ['127.0.0.1:7890', '127.0.0.1:7897', '127.0.0.1:10809', '127.0.0.1:1080']) {
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function isProxyUp(hostPort, timeoutMs = 600) {
  const [host, port] = hostPort.split(':')
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolvePromise(v)
    }
    // RFC 6066: never send SNI for an IP literal.
    const servername = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host
    const sock = tls.connect({ host, port: Number(port) || 443, servername, rejectUnauthorized: false, timeout: timeoutMs })
    sock.once('secureConnect', () => { sock.destroy(); finish(true) })
    sock.once('timeout', () => { sock.destroy(); finish(false) })
    sock.once('error', () => { sock.destroy(); finish(false) })
  })
}

/** HTTPS GET through an HTTP proxy (CONNECT tunnel) using OpenSSL TLS. */
export function httpsGetViaProxy(url, proxyHostPort, timeoutMs = 12000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url)
    const [ph, pp] = proxyHostPort.split(':')
    const targetHost = u.hostname
    const targetPort = u.port || '443'
    const connectReq = http.request({
      host: ph,
      port: Number(pp) || 8080,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        rejectPromise(new Error(`proxy CONNECT failed: ${res.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({
        socket,
        servername: /^\d+\.\d+\.\d+\.\d+$/.test(targetHost) ? undefined : targetHost,
        timeout: timeoutMs,
      }, () => {
        const req = https.request({
          socket: tlsSocket,
          method: 'GET',
          path: u.pathname + u.search,
          headers: {
            'User-Agent': 'dsh-pet-remielle',
            Accept: 'application/vnd.github+json',
            Host: targetHost,
          },
        }, (resp) => {
          let body = ''
          resp.on('data', (d) => (body += String(d)))
          resp.on('end', () => resolvePromise({ status: resp.statusCode || 0, body }))
        })
        req.on('error', (err) => rejectPromise(err))
        req.end()
      })
      tlsSocket.on('error', (err) => rejectPromise(err))
    })
    connectReq.on('timeout', () => { connectReq.destroy(); rejectPromise(new Error('proxy connect timeout')) })
    connectReq.on('error', (err) => rejectPromise(err))
    connectReq.end()
  })
}

/** Direct GET via the global fetch. */
export async function httpsGetDirect(url, timeoutMs = 5000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'dsh-pet-remielle', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(t)
  }
}

/** Fetch the newest release (falling back to the newest tag), trying direct then proxies. */
export async function fetchRemoteLatest() {
  const attempt = async (fetchFn) => {
    try {
      const rel = await fetchFn(RELEASES_API)
      if (rel.status === 200) {
        const j = JSON.parse(rel.body)
        if (j && typeof j.tag_name === 'string') {
          return {
            latest: j.tag_name,
            notes: typeof j.body === 'string' ? j.body : '',
            htmlUrl: typeof j.html_url === 'string' ? j.html_url : GITHUB + '/releases',
          }
        }
      }
      const tags = await fetchFn(TAGS_API)
      if (tags.status === 200) {
        const arr = JSON.parse(tags.body)
        if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0].name === 'string') {
          return { latest: arr[0].name, notes: '', htmlUrl: GITHUB + '/releases' }
        }
      }
      return null
    } catch {
      return null
    }
  }

  // 1) plain direct fetch
  const direct = await attempt(httpsGetDirect)
  if (direct) return direct
  // 2) classic HTTP proxy (CONNECT)
  for (const hostPort of proxyCandidates()) {
    if (!(await isProxyUp(hostPort))) continue
    const via = await attempt((u) => httpsGetViaProxy(u, hostPort))
    if (via) return via
  }
  return null
}

/** True when we reached GitHub's API (even a 404 = repo exists but no release). */
export async function githubReachable() {
  try {
    const r = await httpsGetDirect(RELEASES_API, 4000)
    if (r.status === 200 || r.status === 404) return true
  } catch { /* keep trying */ }
  for (const hostPort of proxyCandidates()) {
    if (!(await isProxyUp(hostPort))) continue
    try {
      const r = await httpsGetViaProxy(RELEASES_API, hostPort, 4000)
      if (r.status === 200 || r.status === 404) return true
    } catch { /* try next */ }
  }
  return false
}

export function resolveInstall() {
  const here = fileURLToPath(import.meta.url)
  const pkgDir = dirname(dirname(here))
  let version = '0.0.1'
  try {
    const pj = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'))
    if (pj && typeof pj.version === 'string') version = pj.version
  } catch { /* keep default */ }
  const marker = `${sep}node_modules${sep}`
  const idx = pkgDir.indexOf(marker)
  if (idx === -1) return { mode: 'link', repoDir: pkgDir, version }
  return { mode: 'github', profileDir: pkgDir.slice(0, idx), version }
}

// ---- update progress (ring buffer + live endpoint) ----
// Lesson from the fixed 90s hard timeout (0.4.3 wrongly killed many users on
// slow networks): pnpm resolving metadata and downloading tarballs can legitimately
// take more than 90s (a single package resolution costs 13s+ on a direct npmjs
// connection from CN), but as long as the child keeps producing output it is not
// hung. Switched to an "idle timeout": every chunk of output resets the timer and
// only 60s of total silence counts as hung; a 10-minute overall cap backstops it
// (in case output keeps coming but the process never ends).
export const IDLE_TIMEOUT_MS = 60000
export const TOTAL_TIMEOUT_MS = 600000

// Only the last ~50 lines of progress are kept: the progress card only needs the
// most recent download/install activity, and the full output is still returned in
// the final response (shown in the done state). The pnpm progress bar refreshes with
// \r, so splitting by lines naturally keeps only what is near the last frame.
const PROGRESS_TAIL_LINES = 50

let updateProgress = { running: false, startedAt: 0, lastActivityAt: 0, tail: [] }

/** Append a chunk of child output to the progress buffer (split by line, dropping lines older than the window). */
function pushProgressOutput(text) {
  const lines = String(text).split(/\r?\n|\r/)
  for (const ln of lines) {
    if (!ln) continue
    updateProgress.tail.push(ln)
  }
  while (updateProgress.tail.length > PROGRESS_TAIL_LINES) updateProgress.tail.shift()
  updateProgress.lastActivityAt = Date.now()
}

function beginUpdateProgress() {
  updateProgress = { running: true, startedAt: Date.now(), lastActivityAt: Date.now(), tail: [] }
}

function endUpdateProgress() {
  updateProgress.running = false
}

/** Progress endpoint payload: whether an update is running, how long it has taken, the tail of recent output. */
export function getUpdateProgress() {
  return {
    running: updateProgress.running,
    elapsedMs: updateProgress.running ? Date.now() - updateProgress.startedAt : 0,
    outputTail: updateProgress.tail.join('\n'),
  }
}

export function progressHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: progress route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  json(res, 200, { ok: true, ...getUpdateProgress() })
}

/** On Windows shell:true wraps a cmd.exe layer, so taskkill /T kills the whole tree and no pnpm.exe orphan is left. */
function killChildTree(child, spawnImpl = spawn) {
  try {
    if (isWin && child.pid) {
      const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on?.('error', () => { try { child.kill() } catch { /* ignore */ } })
    } else {
      child.kill()
    }
  } catch {
    try { child.kill() } catch { /* ignore */ }
  }
}

export function run(cmd, args, cwd, opts) {
  const idleTimeoutMs = (opts && opts.idleTimeoutMs) || IDLE_TIMEOUT_MS
  const totalTimeoutMs = (opts && opts.totalTimeoutMs) || TOTAL_TIMEOUT_MS
  const spawnImpl = opts?.spawnImpl || spawn
  const setTimeoutImpl = opts?.setTimeoutImpl || setTimeout
  const clearTimeoutImpl = opts?.clearTimeoutImpl || clearTimeout
  const killChildTreeImpl = opts?.killChildTreeImpl || ((child) => killChildTree(child, spawnImpl))
  return new Promise((resolvePromise) => {
    let settled = false
    let idleTimer = null
    let totalTimer = null
    const finish = (ok, output) => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeoutImpl(idleTimer)
      if (totalTimer) clearTimeoutImpl(totalTimer)
      if (activeChild === child) activeChild = null
      resolvePromise({ ok, output })
    }
    // Kill on timeout: tear down the process tree first, then reach the conclusion —
    // a hung pnpm that stays alive keeps rewriting node_modules, so a user retrying
    // the update would be stacking half-finished state on half-finished state
    const finishTimedOut = (output) => {
      killChildTreeImpl(child)
      finish(false, output)
    }
    let child
    try {
      if (isWin) {
        // .cmd shims (pnpm, git may resolve through PATHEXT) need cmd.exe.
        const quoted = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
        child = spawnImpl(quoted, { cwd, windowsHide: true, shell: true })
      } else {
        child = spawnImpl(cmd, args, { cwd, windowsHide: true })
      }
    } catch (err) {
      finish(false, String(err))
      return
    }
    activeChild = child
    let out = ''
    // Idle timeout: any chunk of output (stdout/stderr) resets the timer. During a
    // slow-network download pnpm keeps emitting progress lines and is not killed
    // by mistake; a genuinely hung process produces no output for 60s and is
    // terminated.
    const armIdleTimer = () => {
      if (idleTimer) clearTimeoutImpl(idleTimer)
      idleTimer = setTimeoutImpl(
        () => finishTimedOut(out + `\n[timeout: no output for ${Math.max(1, Math.round(idleTimeoutMs / 1000))}s — the update process looks hung]`),
        idleTimeoutMs,
      )
      idleTimer.unref?.()
    }
    child.stdout?.on('data', (d) => { out += String(d); pushProgressOutput(String(d)); armIdleTimer() })
    child.stderr?.on('data', (d) => { out += String(d); pushProgressOutput(String(d)); armIdleTimer() })
    child.on('error', (err) => finish(false, out + '\n' + String(err.message)))
    child.on('close', (code) => finish(code === 0, out))
    // Overall cap as backstop: it still exits when output keeps coming but the
    // process never finishes (e.g. an interactive prompt is stuck)
    totalTimer = setTimeoutImpl(
      () => finishTimedOut(out + `\n[timeout: exceeded total ${Math.max(1, Math.round(totalTimeoutMs / 1000))}s]`),
      totalTimeoutMs,
    )
    totalTimer.unref?.()
    armIdleTimer()
  })
}

/** The in-flight update child process (pnpm/git). killActiveUpdate() terminates it when
 *  the host exits — otherwise an orphan process keeps rewriting node_modules and the
 *  half-finished package crashes the next start. */
let activeChild = null
export function killActiveUpdate() {
  const child = activeChild
  if (!child || child.exitCode !== null) return
  killChildTree(child)
}

// ---- integrity self-check of the old install after a failure ----
// When pnpm is killed midway by a timeout or by host exit, node_modules may
// already be half-modified (pnpm has no rollback): the old version still runs
// right now (the code is in memory) but the next restart may fail to load. When
// an update fails, detect our own package directory immediately and report it
// honestly, so the user learns at once whether the old version is still usable
// instead of only finding out at the next restart.
export function verifyInstallIntegrity(pkgDir) {
  const dir = pkgDir || dirname(dirname(fileURLToPath(import.meta.url)))
  const problems = []
  let pj = null
  try {
    pj = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  } catch (err) {
    problems.push(`package.json is unreadable (${String((err && err.message) || err).slice(0, 80)})`)
  }
  if (pj) {
    const entry = typeof pj.main === 'string' && pj.main ? pj.main : 'src/index.js'
    if (!existsSync(`${dir}/${entry}`)) problems.push(`entry file is missing: ${entry}`)
  }
  if (!existsSync(`${dir}/src`)) problems.push('the src/ directory is missing')
  return { ok: problems.length === 0, problems, pkgDir: dir }
}

/**
 * Loopback + same-origin guard, same standard as `localOnly` in src/index.js.
 *
 * The Host header alone is not a CSRF guard: it is derived from the request
 * target, so a hostile page reaching `http://127.0.0.1:<port>/…` produces a
 * request that passes a Host check while coming from somewhere else entirely.
 * Only `socket.remoteAddress` is unforgeable by page script.
 *
 * The Origin check is the second layer, and it is **not sufficient alone**:
 * browsers only attach `Origin` to a cross-origin request when the request is
 * CORS-tainted or the method is outside GET/HEAD/POST-with-simple-headers. A
 * hostile page's `<img src="…/update">` arrives with no `Origin` at all and
 * passes everything below. That is why every handler here also pins its
 * method — see `updateHandler`, which is the one route with side effects.
 */
function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function infoHandler(req, res) {
  // The payload carries absolute profileDir / repoDir paths. Guard it like every
  // other route here instead of leaving it as the one unguarded read endpoint.
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: info route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  try {
    const info = resolveInstall()
    const needsReinstall = needsCleanReinstallFor(info.version)
    const cmd = needsReinstall
      ? '(version below 0.3.0: the package name has changed, so a clean uninstall and reinstall is required)'
      : info.mode === 'link' && info.repoDir
        ? `cd /d "${info.repoDir}" && git pull`
        : info.profileDir
          ? `cd /d "${info.profileDir}" && pnpm update --latest ${PKG}`
          : ''
    json(res, 200, {
      pkg: PKG,
      repo: REPO,
      github: GITHUB,
      mode: info.mode,
      version: info.version,
      profileDir: info.profileDir || null,
      repoDir: info.repoDir || null,
      needsCleanReinstall: needsReinstall,
      updateCommand: cmd,
    })
  } catch (err) {
    json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
}

export async function checkHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, error: 'forbidden: check route is local-only' })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'method not allowed (GET only)' })
    return
  }
  try {
    const remote = await fetchRemoteLatest()
    if (!remote) {
      const reachable = await githubReachable()
      if (reachable) {
        json(res, 200, { ok: false, error: 'no version yet', reachable: true })
        return
      }
      let direct = false
      let proxiesUp = []
      try {
        await fetch('https://api.github.com', { signal: AbortSignal.timeout(3000) })
        direct = true
      } catch { /* direct blocked */ }
      for (const hp of proxyCandidates()) {
        if (await isProxyUp(hp)) proxiesUp.push(hp)
      }
      json(res, 200, { ok: false, error: 'network unreachable', direct, proxiesUp })
      return
    }
    json(res, 200, { ok: true, ...remote, needsCleanReinstall: needsCleanReinstallFor(resolveInstall().version) })
  } catch (err) {
    json(res, 500, { ok: false, error: 'check failed: ' + String(err && err.message ? err.message : err) })
  }
}

// ---- injection points (set when the host registers the routes, overridable by tests)----
// - stopDesktopWindow: stop the desktop pet window before updating and wait for
//   its process to exit. The desktop pet window's Electron runtime lives inside
//   the plugin package directory (vendor/electron-<platform>-<arch>, resolved
//   per platform by electronArtifact); on Windows a process that does not exit
//   locks those files — pnpm/git replacing the package contents hits EPERM
//   directly. Skipped when not injected (unit tests / no desktop window).
// - run / resolveInstall: tests inject fake implementations.
const hooks = {
  stopDesktopWindow: null,
  onUpdateSuccess: null,
  run,
  resolveInstall,
}
export function setSelfUpdateHooks(next = {}) {
  if ('stopDesktopWindow' in next) {
    hooks.stopDesktopWindow = typeof next.stopDesktopWindow === 'function' ? next.stopDesktopWindow : null
  }
  if ('onUpdateSuccess' in next) {
    hooks.onUpdateSuccess = typeof next.onUpdateSuccess === 'function' ? next.onUpdateSuccess : null
  }
  if ('run' in next) hooks.run = typeof next.run === 'function' ? next.run : run
  if ('resolveInstall' in next) {
    hooks.resolveInstall = typeof next.resolveInstall === 'function' ? next.resolveInstall : resolveInstall
  }
}

async function quiesceDesktopWindow() {
  if (typeof hooks.stopDesktopWindow !== 'function') return
  try { await hooks.stopDesktopWindow() } catch { /* continue trying the update even if it cannot be stopped */ }
}

export async function updateHandler(req, res) {
  if (!localHostOk(req)) {
    json(res, 403, { ok: false, output: 'forbidden: update route is local-only' })
    return
  }
  // The method must be pinned: under the Fetch spec a cross-origin GET/HEAD
  // (<img src=...>, <form method=GET>) carries no Origin header and its mode is
  // no-cors rather than cors, so all three guards above pass. Without a pinned
  // method a single hostile <img> could trigger git pull / pnpm update (and the
  // latter runs dependency lifecycle scripts).
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, output: 'method not allowed (POST only)' })
    return
  }
  if (updateProgress.running) {
    json(res, 409, { ok: false, output: 'An update is already running. Please wait for it to finish and try again.' })
    return
  }
  // Claim the update state before the first await, covering window shutdown,
  // execution and wrap-up; a rejected request must not reset the progress.
  beginUpdateProgress()
  // Full backstop: any unexpected exception anywhere in the update chain (such
  // as the package directory being mid-replacement) must become a 500 response
  // — an async route throwing an unhandled rejection takes the host process down
  try {
    const info = hooks.resolveInstall()
    // Only versions < 0.3.0 (the package name changed) need a clean uninstall
    // and reinstall; both link and registry installs at >= 0.3.0 support the
    // one-click incremental update (link → git pull, registry → pnpm update
    // --latest).
    if (needsCleanReinstallFor(info.version)) {
      json(res, 500, {
        ok: false,
        needsCleanReinstall: true,
        output: 'Version below 0.3.0: the package name / plugin id has changed, so an automatic incremental update is impossible.\nUninstall the current install first, then install the latest version:\n  · If the old version is 0.2.0 or earlier: dsh plugin --profile web remove @dsh-external/dsh-client-ui-pet-remielle\n  · If the old version is 0.2.0–0.3.0: dsh plugin --profile web remove dsh-pet-remielle\n  Then: dsh plugin --profile web add dsh-pet-remielle\n(See the upgrade notes in the README.)',
      })
      return
    }
    // Stop the desktop pet window and wait for it to exit first: a running
    // electron.exe locks files inside the plugin directory, which otherwise makes
    // pnpm/git fail with EPERM when replacing the package contents (the same
    // applies to git pull in link mode)
    await quiesceDesktopWindow()
    let result
    if (info.mode === 'link' && info.repoDir) {
      result = await hooks.run('git', ['-C', info.repoDir, 'pull'], info.repoDir)
    } else if (info.profileDir && existsSync(info.profileDir)) {
      // --latest: step outside the exact version possibly pinned in package.json
      // (say "0.3.3"). A plain pnpm update only upgrades inside the declared
      // range, so an exact pin reinstalls the old version forever yet reports
      // success.
      result = await hooks.run('pnpm', ['update', '--latest', PKG], info.profileDir)
    } else {
      json(res, 500, { ok: false, output: 'unknown install shape' })
      return
    }
    // Post-success callback: the host uses it to wrap up (e.g. switching off
    // desktop mode — the runtime is removed by the update). A returned string
    // is appended to the output shown to the user.
    if (result.ok && typeof hooks.onUpdateSuccess === 'function') {
      try {
        const note = hooks.onUpdateSuccess()
        if (typeof note === 'string' && note) result = { ok: true, output: result.output + '\n' + note }
      } catch { /* a failed wrap-up does not change the update result */ }
    }
    // Failure self-check: pnpm being killed midway may leave a half-finished
    // node_modules — the old version is unaffected right now (the code is already
    // loaded into memory), but the user must be told immediately whether the old
    // install on disk can still survive until the next restart
    if (!result.ok) {
      try {
        const pkgDir = info.mode === 'link' && info.repoDir
          ? info.repoDir
          : info.profileDir
            ? `${info.profileDir}/node_modules/${PKG}`
            : null
        if (pkgDir) {
          const integrity = verifyInstallIntegrity(pkgDir)
          result.output += integrity.ok
            ? '\n\n✅ Self-check: the current install is intact, the old version keeps working normally, and you can retry the update later.'
            : `\n\n⚠️ Self-check: the current install is not intact (${integrity.problems.join('; ')}) — the old version may fail to load after a restart; reinstall manually following the instructions on GitHub Releases.`
        }
      } catch { /* a failed self-check does not change the existing error response */ }
    }
    json(res, result.ok ? 200 : 500, { ok: result.ok, output: result.output.slice(-6000) })
  } catch (err) {
    try { json(res, 500, { ok: false, output: 'update failed: ' + String(err && err.message ? err.message : err) }) } catch { /* response already sent */ }
  } finally {
    endUpdateProgress()
  }
}
