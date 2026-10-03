/**
 * On-demand Electron runtime fetch for the dsh-pet-remielle desktop window.
 *
 * The floating desktop window needs a real Electron binary (~221MB, which is
 * why it is NOT bundled into the Git repo — see README "desktop mode runtime"). This
 * module lets the host fetch it automatically the first time desktop mode is
 * used, instead of making the user hunt down a large zip by hand.
 *
 * Cross-platform: the artifact layout (vendor dir, executable name, zip name)
 * is resolved from the current platform/arch, so the same code works on
 * Windows, Linux and macOS.
 *
 * Two resolve/extract implementations coexist (merged from two external PRs):
 *  - pr-17 (wjj-8283): runtimeTarget()/electronBinaryIn() + extracting directly into vendorDir,
 *    which handles macOS Electron.app symlinks correctly (copyFile fails with ENOTSUP on a
 *    .app).
 *  - pr-16 (OwNhj): electronArtifact() + findDistDir()/moveContents(), verified working on
 *    win32/linux in practice (real-machine smoke test passed).
 *  - Final policy: darwin uses pr-17's direct extraction; win32/linux uses pr-16's moveContents
 *    (both PRs produce exactly the same on-disk path on these two platforms, and pr-16 has
 *    practical verification behind it).
 *
 * Behaviour policy ("the user may not have access to the public internet"):
 *  - Tries the npmmirror binary mirror first (fast for CN users), then the
 *    official GitHub release. If every source fails it rejects and the caller
 *    falls back to the in-page pet — never crashes the plugin.
 *  - Concurrency-safe: concurrent calls while a fetch is in flight share one
 *    promise (single in-process lock across the whole host).
 *  - Idempotent: if the runtime binary for the current platform already exists it
 *    resolves immediately without touching the network.
 *
 * Files land exactly where `desktop-window.js`'s `bundledElectron` path points,
 * so a later `resolveBackend()` picks the freshly installed runtime up with no
 * reconfiguration:    <repo>/vendor/electron-<platform>-<arch>/<binary>
 */

import { spawn } from 'node:child_process'
import fsNode from 'node:fs'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Electron major we target — a stock build in this range works on any OS. */
export const ELECTRON_VERSION = '33.0.0'

/**
 * pr-16: Resolve the Electron artifact layout for a platform/arch. `platform`
 * uses node's tokens ('win32' | 'linux' | 'darwin'), which match Electron's
 * release zip naming. `binary` is the executable name (electron.exe on Windows,
 * electron elsewhere). `vendorDir`/`exe` point where the runtime is installed.
 * Used by the win32/linux extraction path and by tests.
 */
export function electronArtifact({ platform = process.platform, arch = process.arch } = {}) {
  const binary = platform === 'win32' ? 'electron.exe' : 'electron'
  const dir = `electron-${platform}-${arch}`
  return {
    platform,
    arch,
    binary,
    zipName: `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`,
    vendorDir: resolve(here, '..', 'vendor', dir),
    exe: resolve(here, '..', 'vendor', dir, binary),
  }
}

/**
 * pr-17: Map an OS/arch to the Electron release artifact triple plus the on-disk
 * folder name and the path (relative to that folder) of the launchable
 * Electron binary. Windows keeps the exact original layout; macOS uses the
 * `.app` bundle binary; Linux uses the bare `electron` binary.
 */
export function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return { tag: 'win32-x64', folder: 'electron-win32-x64', sub: ['electron.exe'] }
  }
  if (platform === 'darwin') {
    const a = arch === 'arm64' ? 'arm64' : 'x64'
    return { tag: `darwin-${a}`, folder: `electron-darwin-${a}`, sub: ['Electron.app', 'Contents', 'MacOS', 'Electron'] }
  }
  if (platform === 'linux') {
    return { tag: `linux-${arch}`, folder: `electron-linux-${arch}`, sub: ['electron'] }
  }
  return { tag: `${platform}-${arch}`, folder: `electron-${platform}-${arch}`, sub: ['electron'] }
}

/** Absolute path to the launchable Electron binary inside a dist/vendor root. */
export function electronBinaryIn(dir, platform = process.platform, arch = process.arch) {
  return resolve(dir, ...runtimeTarget(platform, arch).sub)
}

/**
 * ASAR-safe fs (issue #24): the Electron host patches node:fs for ASAR — reading
 * "an existing .asar file itself" gets parsed as a virtual archive, and copying/verifying
 * resources/default_app.asar then fails with ENOENT "not found in <a file that actually
 * exists>". (Writing a non-existent .asar path lands as a real file, so extraction works while
 * copyFile breaks.)
 * The official Electron approach is to use original-fs to treat archives as plain files;
 * outside an Electron host there is no original-fs, so fall back to node:fs. A fake fs injected
 * by tests never reaches this problem.
 */
let asarSafeFsCache
function asarSafeFs() {
  if (asarSafeFsCache) return asarSafeFsCache
  if (process.versions.electron) {
    try {
      asarSafeFsCache = createRequire(import.meta.url)('original-fs')
      return asarSafeFsCache
    } catch { /* fall back to node:fs when there is no original-fs */ }
  }
  asarSafeFsCache = fsNode
  return asarSafeFsCache
}

/**
 * The list of runtime-critical files (relative to the runtime root, issue #24). Checking only
 * the executable would misjudge an exe-only residue as installed — after a per-file copy was
 * interrupted electron.exe is in place while resources/default_app.asar and friends are
 * missing, and the plugin would forever try to launch an incomplete runtime.
 */
export function requiredRuntimeFiles(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      'Electron.app/Contents/MacOS/Electron',
      'Electron.app/Contents/Resources/default_app.asar',
      'Electron.app/Contents/Info.plist',
    ]
  }
  return [
    platform === 'win32' ? 'electron.exe' : 'electron',
    'resources/default_app.asar',
    'resources.pak',
    'snapshot_blob.bin',
    'v8_context_snapshot.bin',
  ]
}

/**
 * A runtime root is usable only when every required file exists as a non-empty
 * regular file. Must use the ASAR-safe fs: under an Electron host the patched
 * node:fs mis-reads default_app.asar itself (issue #24).
 *
 * Second-layer fallback under the ASAR patch: the patched fs stats "a .asar file that really
 * exists" as a directory (isFile()=false, size untrustworthy), so liveness must still be
 * decidable even when original-fs is unavailable — in that case fall back to an existence
 * check via readdir on the real parent directory (the parent is not a .asar, so its listing is
 * not virtualized).
 */
export function isUsableElectronRoot(root, platform = process.platform) {
  const fs = asarSafeFs()
  for (const rel of requiredRuntimeFiles(platform)) {
    if (requiredFilePresent(fs, resolve(root, rel), rel)) continue
    return false
  }
  return true
}

function requiredFilePresent(fs, abs, rel) {
  try {
    const st = fs.statSync(abs)
    if (st.isFile() && st.size > 0) return true
  } catch { /* fall through to the directory-listing fallback */ }
  try {
    return readdirSync(dirname(abs)).includes(basename(rel))
  } catch {
    return false
  }
}

/** Diagnostic: which required files are missing from a runtime root (issue
 *  #24 troubleshooting — print the missing list into the host log when there is "no backend",
 *  so the incomplete point is obvious at a glance). */
export function missingRuntimeFiles(root, platform = process.platform) {
  const fs = asarSafeFs()
  return requiredRuntimeFiles(platform).filter((rel) => !requiredFilePresent(fs, resolve(root, rel), rel))
}

/**
 * VENDOR_DIR / ELECTRON_EXE use the macOS-capable resolver so the path is
 * correct on every platform (identical to electronArtifact() on win32/linux).
 */
export const VENDOR_DIR = resolve(here, '..', 'vendor', runtimeTarget().folder)
export const ELECTRON_EXE = electronBinaryIn(VENDOR_DIR)

/** Download candidates, best first. Each is the full zip URL for the current
 *  platform/arch (npmmirror first: fast in mainland China, then GitHub). */
export function downloadMirrors(version = ELECTRON_VERSION, platform = process.platform, arch = process.arch) {
  // Electron release zips are uniformly named electron-v<ver>-<platform>-<arch>.zip, so build
  // the name directly from platform/arch to avoid writing linux arm64 as linux-x64.
  const name = `electron-v${version}-${platform}-${arch}.zip`
  return [
    `https://registry.npmmirror.com/-/binary/electron/v${version}/${name}`,
    `https://github.com/electron/electron/releases/download/v${version}/${name}`,
  ]
}

/** In-process lock so concurrent `ensureElectronRuntime` calls share one fetch. */
let inflight = null

/**
 * Ensure the Electron runtime exists, downloading it on demand.
 *
 * @param {object} [options]
 * @param {string[]} [options.mirrors]   zip URLs to try, in order.
 * @param {string}  [options.vendorDir]  target directory for the runtime (defaults to the platform vendor dir).
 * @param {(m: string) => void} [options.onProgress]  human-readable progress callback.
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [options.spawnImpl] injectable spawn (for tests).
 * @param {string}  [options.platform]   process.platform (injectable for tests).
 * @param {string}  [options.arch]       process.arch (injectable for tests).
 * @returns {Promise<string>}  absolute path to the Electron binary on success.
 * @throws  when every mirror fails and no runtime can be placed.
 */
export async function ensureElectronRuntime({
  mirrors = downloadMirrors(),
  vendorDir = VENDOR_DIR,
  onProgress,
  spawnImpl = spawn,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const electronExe = electronBinaryIn(vendorDir, platform, arch)
  // The fast path must be an integrity check, not merely "the exe exists" (issue #24): an
  // exe-only residue (interrupted copy, antivirus lock) is treated as installed by the old
  // check, so from then on it neither downloads nor self-heals.
  if (isUsableElectronRoot(vendorDir, platform)) return electronExe
  if (existsSync(electronExe)) {
    onProgress?.('Detected an incomplete Electron runtime leftover, reinstalling…')
    try { rmSync(vendorDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  // Serialise concurrent requests across the whole host process.
  if (inflight) return inflight
  const run = (async () => {
    const work = `${vendorDir}.tmp-${process.pid}-${Date.now()}`
    const zip = `${work}.zip`
    try {
      mkdirSync(work, { recursive: true })
      let lastError = null
      for (let i = 0; i < mirrors.length; i++) {
        const url = mirrors[i]
        const label = `(${i + 1}/${mirrors.length})`
        onProgress?.(`Downloading Electron ${ELECTRON_VERSION} ${label}…`)
        try {
          await downloadFile(url, zip, onProgress && ((p) => onProgress(`Downloading Electron ${ELECTRON_VERSION} ${label}: ${p}`)), fetchImpl)
          break
        } catch (error) {
          lastError = error
          onProgress?.(`Download source ${i + 1} failed (${error.message}), trying the next one…`)
          try { rmSync(zip, { force: true }) } catch { /* ignore */ }
          if (i === mirrors.length - 1) {
            throw new Error(`All Electron download sources failed: ${lastError.message}`, { cause: lastError })
          }
        }
      }
      onProgress?.('Extracting Electron…')
      if (platform === 'darwin') {
        // pr-17: extract directly into vendorDir — the macOS Electron.app bundle contains
        // symlinks/special files that make copyFile fail with ENOTSUP; tar/bsdtar/unzip
        // extraction preserves them as-is. vendorDir is a brand new directory (already rm'ed
        // before download), so after extraction just verifying the executable is enough.
        rmSync(vendorDir, { recursive: true, force: true })
        mkdirSync(vendorDir, { recursive: true })
        await unzip(zip, vendorDir, spawnImpl)
      } else {
        // pr-16 + issue #24: extract into a temporary staging area first and publish by "renaming the
        // directory" atomically once the integrity check passes. No more per-file copyFile —
        // the ASAR fs patch of the Electron host misjudges reading default_app.asar itself as
        // an in-archive path and fails with ENOENT (reporter's measurements: extraction works,
        // copying errors, and an exe-only residue is left behind that never self-heals).
        // Renaming does not read file content, so it sidesteps that by nature; renaming a
        // directory on the same volume is near-atomic, and on failure only the staging area is
        // cleaned up without polluting the real directory.
        await unzip(zip, work, spawnImpl)
        const binary = platform === 'win32' ? 'electron.exe' : 'electron'
        const distDir = findDistDir(work, binary)
        if (!isUsableElectronRoot(distDir, platform)) {
          throw new Error('The extracted Electron runtime is incomplete (missing critical files), install aborted')
        }
        let retired = null
        if (existsSync(vendorDir)) {
          // Reaching here means vendorDir can only be an incomplete residue (a complete runtime
          // already returned on the fast path). Windows does not allow renaming onto an
          // existing directory, so move the old one aside first.
          retired = `${vendorDir}.old-${process.pid}-${Date.now()}`
          renameSync(vendorDir, retired)
        }
        try {
          renameSync(distDir, vendorDir)
        } catch (error) {
          // Rename failed (cross-volume / locked, …) — fall back to per-file copying; the copy must go
          // through the ASAR-safe fs.
          if (retired) {
            try { renameSync(retired, vendorDir); retired = null } catch { /* losing the old directory does not matter either: its content was incomplete to begin with */ }
          }
          mkdirSync(vendorDir, { recursive: true })
          await moveContents(distDir, vendorDir)
        }
        if (retired) {
          try { rmSync(retired, { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }
      if (!isUsableElectronRoot(vendorDir, platform)) {
        if (platform === 'darwin') {
          const target = runtimeTarget(platform, arch)
          throw new Error(`Electron executable not found after extraction (${electronExe}) — expected ${target.sub.join('/')} from the ${target.tag} package`)
        }
        throw new Error(`Electron executable not found after extraction (${electronExe})`)
      }
      onProgress?.('Electron is ready ✓')
      return electronExe
    } finally {
      for (const p of [work, zip]) {
        try { rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      inflight = null
    }
  })()
  inflight = run
  return run
}

/** Stream a URL to disk with a rough percent progress. */
async function downloadFile(url, dest, onProgress, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r))
      }
      received += value.length
      if (onProgress && total > 0) onProgress(`${Math.round((received / total) * 100)}%`)
    }
    await new Promise((resolveFinish, rejectFinish) => {
      out.once('error', rejectFinish)
      out.end(() => resolveFinish())
    })
  } finally {
    reader.releaseLock?.()
  }
  // Fail loudly on a truncated/zero-length download rather than feeding a
  // corrupt zip to the unzip step.
  if (received === 0) throw new Error('Downloaded content is empty')
}

/**
 * pr-16: Locate the Electron distribution dir inside `work`: either `work`
 * itself (zip contents at the root) or the single top-level dir the zip
 * contains. The Electron release zips are not consistent about the top-level
 * dir, so handle both.
 */
function findDistDir(work, binary) {
  if (existsSync(join(work, binary))) return work
  const subdirs = readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const sub of subdirs) {
    if (existsSync(join(work, sub.name, binary))) return join(work, sub.name)
  }
  if (subdirs.length === 1) return join(work, subdirs[0].name)
  throw new Error(`${binary} not found in the extracted directory: ${work}`)
}

/**
 * Extract a zip using whichever platform tool is available (pr-16). On Windows
 * the built-in bsdtar (tar.exe) handles zip; on Linux/macOS prefer `unzip`,
 * then `bsdtar`, then `tar`. Tries candidates in order and succeeds on the
 * first that runs cleanly. Symlinks are preserved, so this is also safe for a
 * macOS `.app` bundle when the zip is extracted directly into its final dir.
 */
async function unzip(zip, dest, spawnImpl) {
  mkdirSync(dest, { recursive: true })
  const isWin = process.platform === 'win32'
  const attempts = isWin
    ? [
        ['tar.exe', ['-xf', zip, '-C', dest, '--strip-components=0']],
        ['unzip', ['-o', zip, '-d', dest]],
      ]
    : [
        ['unzip', ['-o', zip, '-d', dest]],
        ['bsdtar', ['-xf', zip, '-C', dest]],
        ['tar', ['-xf', zip, '-C', dest]],
      ]
  let lastError = null
  for (const [cmd, args] of attempts) {
    try {
      await runProgram(spawnImpl, cmd, args, dest)
      return
    } catch (error) {
      lastError = error
      // Clear any partial extraction before trying the next tool.
      try {
        for (const entry of readdirSync(dest)) {
          rmSync(join(dest, entry), { recursive: true, force: true })
        }
      } catch { /* ignore */ }
    }
  }
  throw lastError
}

/** Recursively move directory contents up into `target` (works across drives).
 *  Copy must go through the ASAR-safe fs: under an Electron host the patched
 *  node:fs mis-reads default_app.asar itself (issue #24). */
async function moveContents(src, target) {
  const fsp = asarSafeFs().promises
  const { join } = await import('node:path')
  await fsp.mkdir(target, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      // Recurse and then remove the emptied source dir.
      await moveContents(from, to)
      try { rmSync(from, { recursive: true, force: true }) } catch { /* ignore */ }
    } else {
      await fsp.copyFile(from, to)
    }
  }
}

/** Run a child program to completion; reject on non-zero exit. */
function runProgram(spawnImpl, command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl(command, args, { cwd, stdio: 'ignore', windowsHide: true })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} exited with code ${code}`))
    })
  })
}
