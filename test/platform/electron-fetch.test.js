/**
 * electron-fetch tests: on-demand Electron runtime fetch (mirror ordering,
 * idempotency, full download→unzip→place flow, and all-mirrors-fail fallback).
 *
 * These tests never touch the network: fetchImpl / spawnImpl are injected.
 * They are platform-aware: the expected artifact name / binary name come from
 * the current platform/arch via electronArtifact() / runtimeTarget().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { downloadMirrors, ensureElectronRuntime, electronArtifact, runtimeTarget, electronBinaryIn, requiredRuntimeFiles, missingRuntimeFiles, ELECTRON_VERSION } from '../../src/electron-fetch.mjs'

/**
 * Every ensureElectronRuntime case below is driven with `platform: 'win32'`, so the fixture
 * must use the win32 executable name. This used to take `electronArtifact().binary` (no
 * argument = the running platform), so the fixture wrote electron.exe on a Windows runner but
 * electron on Ubuntu, while the production code looks it up by the **passed** platform — on a
 * non-Windows runner the two did not match and it failed with "electron.exe not found in the
 * extracted directory". Upstream 0.4.4 only ever ran on Windows, so this gap was never exposed.
 */
const BIN = electronArtifact({ platform: 'win32' }).binary

/** Minimal web ReadableStream carrying one chunk of payload. */
function streamOf(chunk) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
}

/**
 * A stream that dies *after* handing over a first chunk — the shape a flaky CDN
 * actually produces (200 OK + Content-Length, then the connection resets).
 * The existing fall-through test only covers a mirror that fails at the HTTP
 * status level, so this one covers the mid-transfer case.
 */
function brokenStream() {
  const enc = new TextEncoder()
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(enc.encode('hel')); return }
      controller.error(new Error('connection reset by peer'))
    },
  })
}

function fakeFetch(ok) {
  return async (url) => {
    if (!ok) return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null }, body: null }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k === 'content-length' ? '5' : null) },
      body: streamOf('hello'),
    }
  }
}

/**
 * Fake zip extractor (platform-aware): on darwin writes the Electron.app bundle
 * binary, otherwise writes the platform binary (BIN) into dest.
 * issue #24: must emit the full required-file set (resources/default_app.asar
 * etc.), otherwise isUsableElectronRoot rejects the freshly extracted runtime.
 */
function fakeSpawn(platform = 'win32') {
  return (command, args) => {
    const child = new EventEmitter()
    child.exitCode = null
    child.killed = false
    child.kill = () => { child.killed = true }
    setImmediate(() => {
      // args end with '-C', <dest> (both bsdtar/tar and unzip land files in dest)
      const idx = args.indexOf('-C')
      const dest = idx >= 0 ? args[idx + 1] : args[args.indexOf('-d') + 1]
      mkdirSync(dest, { recursive: true })
      if (platform === 'darwin') {
        const app = join(dest, 'Electron.app', 'Contents')
        const bin = join(app, 'MacOS', 'Electron')
        mkdirSync(dirname(bin), { recursive: true })
        mkdirSync(join(app, 'Resources'), { recursive: true })
        writeFileSync(bin, 'FAKE_ELECTRON')
        writeFileSync(join(app, 'Resources', 'default_app.asar'), 'FAKE_ASAR')
        writeFileSync(join(app, 'Info.plist'), 'fake')
        writeFileSync(join(dest, 'LICENSE'), 'fake')
      } else {
        // Write the executable name for the platform this extractor was asked for, not the global
        // BIN: fakeSpawn is a general fixture that takes a platform, so a future case going
        // through linux would need the extension-less electron.
        writeFileSync(join(dest, electronArtifact({ platform }).binary), 'FAKE_ELECTRON')
        mkdirSync(join(dest, 'resources'), { recursive: true })
        writeFileSync(join(dest, 'resources', 'default_app.asar'), 'FAKE_ASAR')
        writeFileSync(join(dest, 'resources.pak'), 'fake')
        writeFileSync(join(dest, 'snapshot_blob.bin'), 'fake')
        writeFileSync(join(dest, 'v8_context_snapshot.bin'), 'fake')
        writeFileSync(join(dest, 'LISEZ-moi.txt'), 'fake')
      }
      child.exitCode = 0
      child.emit('exit', 0)
    })
    return child
  }
}

function tempVendor() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-test-'))
  const vendor = join(dir, 'vendor', 'electron-test')
  return { dir, vendor }
}

test('missingRuntimeFiles lists exactly the absent required files (residue diagnosis)', () => {
  const { dir, vendor } = tempVendor()
  try {
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, 'electron.exe'), 'EXE')
    writeFileSync(join(vendor, 'resources.pak'), 'PAK')
    const missing = missingRuntimeFiles(vendor, 'win32')
    assert.ok(missing.includes('resources/default_app.asar'))
    assert.ok(missing.includes('snapshot_blob.bin'))
    assert.ok(missing.includes('v8_context_snapshot.bin'))
    assert.ok(!missing.includes('electron.exe'))
    assert.ok(!missing.includes('resources.pak'))
    // Complete root → empty list
    mkdirSync(join(vendor, 'resources'), { recursive: true })
    writeFileSync(join(vendor, 'resources', 'default_app.asar'), 'ASAR')
    writeFileSync(join(vendor, 'snapshot_blob.bin'), 'SNAP')
    writeFileSync(join(vendor, 'v8_context_snapshot.bin'), 'SNAP2')
    assert.deepEqual(missingRuntimeFiles(vendor, 'win32'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Mirror and filename assertions are always derived from ELECTRON_VERSION and deliberately do
 * **not** pass a version literal —
 * production code goes through the default-parameter path of `downloadMirrors()`, while a test
 * passing the literal '33.0.0' covers neither that path nor keeps working when Electron is
 * upgraded without editing a pile of magic strings.
 *
 * This used to be three tests: mirror ordering, win32/linux filenames, darwin-arm64. The third
 * is a subset of the first two, and all three assert the same thing (the zip name is decided by
 * platform+arch), so they were merged into this single table. The executable file name
 * (electron.exe / electron) is electronArtifact's business and has its own test.
 */
test('downloadMirrors: npmmirror first then github, artifact name per platform/arch', () => {
  const cases = [
    ['win32', 'x64'], ['win32', 'arm64'],
    ['linux', 'x64'], ['linux', 'arm64'],
    ['darwin', 'x64'], ['darwin', 'arm64'],
  ]
  for (const [platform, arch] of cases) {
    const name = `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`
    const mirrors = downloadMirrors(undefined, platform, arch)
    assert.equal(mirrors.length, 2, `${platform}/${arch} should have two mirrors`)
    assert.ok(
      mirrors[0].startsWith(`https://registry.npmmirror.com/-/binary/electron/v${ELECTRON_VERSION}/`),
      `${platform}/${arch} should prefer the npmmirror mirror`,
    )
    assert.ok(
      mirrors[1].startsWith(`https://github.com/electron/electron/releases/download/`),
      `${platform}/${arch} should fall back to the GitHub releases mirror`,
    )
    // Both file names must match character for character, otherwise falling back after the
    // first mirror fails would fetch a nonexistent artifact
    assert.ok(mirrors[0].endsWith(`/${name}`), `${platform}/${arch} npmmirror file name should be ${name}`)
    assert.ok(mirrors[1].endsWith(`/${name}`), `${platform}/${arch} GitHub file name should be ${name}`)
  }
})

test('electronArtifact: binary name and vendor dir are platform-specific', () => {
  const win = electronArtifact({ platform: 'win32', arch: 'x64' })
  assert.equal(win.binary, 'electron.exe')
  assert.ok(win.vendorDir.includes('electron-win32-x64'))
  assert.equal(win.zipName, `electron-v${ELECTRON_VERSION}-win32-x64.zip`)

  const linux = electronArtifact({ platform: 'linux', arch: 'x64' })
  assert.equal(linux.binary, 'electron')
  assert.ok(linux.vendorDir.includes('electron-linux-x64'))
  assert.equal(linux.zipName, `electron-v${ELECTRON_VERSION}-linux-x64.zip`)
})

test('runtimeTarget/electronBinaryIn map the launchable binary per platform', () => {
  assert.deepEqual(runtimeTarget('win32', 'x64').sub, ['electron.exe'])
  assert.equal(electronBinaryIn('/v', 'win32', 'x64'), resolve('/v', 'electron.exe'))
  assert.deepEqual(runtimeTarget('darwin', 'arm64').sub, ['Electron.app', 'Contents', 'MacOS', 'Electron'])
  assert.equal(electronBinaryIn('/v', 'darwin', 'arm64'), resolve('/v', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  assert.deepEqual(runtimeTarget('darwin', 'x64').sub, ['Electron.app', 'Contents', 'MacOS', 'Electron'])
})

test('ensureElectronRuntime is idempotent when the runtime already exists', async () => {
  const { dir, vendor } = tempVendor()
  try {
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, BIN), 'EXISTS')
    // issue #24: the fast path requires the complete critical-file set, so an exe-only residue is
    // judged incomplete and triggers a reinstall.
    for (const rel of requiredRuntimeFiles('win32')) {
      const p = join(vendor, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'fake')
    }
    let fetchCalls = 0
    const exe = await ensureElectronRuntime({
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch') },
      spawnImpl: () => { throw new Error('must not spawn') },
    })
    assert.equal(exe, resolve(vendor, BIN))
    assert.equal(fetchCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exe-only residue is treated as broken and repaired by reinstalling (issue #24)', async () => {
  const { dir, vendor } = tempVendor()
  try {
    // The typical residue of an interrupted copy: electron.exe is in place while
    // resources/default_app.asar is missing.
    mkdirSync(vendor, { recursive: true })
    writeFileSync(join(vendor, BIN), 'EXE_ONLY')
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(exe, resolve(vendor, BIN))
    // The runtime is complete after the reinstall.
    assert.ok(existsSync(join(vendor, 'resources', 'default_app.asar')), 'missing default_app.asar should be restored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('incomplete extraction aborts the install without polluting vendorDir (issue #24)', async () => {
  const { dir, vendor } = tempVendor()
  try {
    // The fake extractor only writes the exe (simulating an interrupted / incomplete extraction):
    // the staging check must refuse to publish it.
    await assert.rejects(
      ensureElectronRuntime({
        mirrors: ['https://mirror.test/electron.zip'],
        vendorDir: vendor,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: fakeFetch(true),
        spawnImpl: (command, args) => {
          const child = new EventEmitter()
          setImmediate(() => {
            const idx = args.indexOf('-C')
            const dest = idx >= 0 ? args[idx + 1] : args[args.indexOf('-d') + 1]
            mkdirSync(dest, { recursive: true })
            writeFileSync(join(dest, BIN), 'EXE_ONLY')
            child.exitCode = 0
            child.emit('exit', 0)
          })
          return child
        },
      }),
      /runtime is incomplete/,
    )
    assert.ok(!existsSync(vendor), 'vendorDir must stay clean when staging validation fails')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime downloads, unzips and places the Electron binary', async () => {
  const { dir, vendor } = tempVendor()
  const progress = []
  try {
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      onProgress: (m) => progress.push(m),
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('win32'),
    })
    assert.ok(existsSync(exe), `${BIN} should be placed`)
    assert.equal(exe, resolve(vendor, BIN))
    assert.match(progress.join(' '), /Electron is ready/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime places the Electron.app bundle binary on macOS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-electron-test-'))
  const vendor = join(dir, 'vendor', 'electron-darwin-arm64')
  try {
    const exe = await ensureElectronRuntime({
      mirrors: ['https://mirror.test/electron.zip'],
      vendorDir: vendor,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: fakeFetch(true),
      spawnImpl: fakeSpawn('darwin'),
    })
    assert.equal(exe, resolve(vendor, 'Electron.app', 'Contents', 'MacOS', 'Electron'))
    assert.ok(existsSync(exe), 'macOS Electron binary should be placed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime rejects when every mirror fails', async () => {
  const { dir, vendor } = tempVendor()
  try {
    await assert.rejects(
      ensureElectronRuntime({
        mirrors: ['https://a.test/x.zip', 'https://b.test/y.zip'],
        vendorDir: vendor,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: fakeFetch(false),
        spawnImpl: () => { throw new Error('must not spawn') },
      }),
      /All Electron download sources failed/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime falls through to the second mirror after the first fails', async () => {
  const { dir, vendor } = tempVendor()
  const tried = []
  try {
    await ensureElectronRuntime({
      mirrors: ['https://mirror-1.test/a.zip', 'https://mirror-2.test/b.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        tried.push(url)
        if (url.includes('mirror-1')) return { ok: false, status: 503, statusText: 'unavailable', headers: { get: () => null }, body: null }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'content-length' ? '5' : null) }, body: streamOf('hello') }
      },
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(tried.length, 2, 'should have tried both mirrors')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureElectronRuntime falls through when a mirror answers 200 but dies mid-transfer', async () => {
  const { dir, vendor } = tempVendor()
  const tried = []
  try {
    await ensureElectronRuntime({
      mirrors: ['https://mirror-1.test/a.zip', 'https://mirror-2.test/b.zip'],
      vendorDir: vendor,
      platform: 'win32',
      arch: 'x64',
      fetchImpl: async (url) => {
        tried.push(url)
        // The headers declare 5 bytes but only 3 are emitted before the connection dies — exactly the
        // shape of a flaky CDN; testing only "404 on the very first byte" misses it, and a
        // truncated zip always fails at the extraction step.
        if (url.includes('mirror-1')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: (k) => (k === 'content-length' ? '5' : null) },
            body: brokenStream(),
          }
        }
        return { ok: true, status: 200, statusText: 'OK', headers: { get: (k) => (k === 'content-length' ? '5' : null) }, body: streamOf('hello') }
      },
      spawnImpl: fakeSpawn('win32'),
    })
    assert.equal(tried.length, 2, 'a mirror that dies mid-transfer should be skipped in favour of the next one')
    assert.ok(tried[0].includes('mirror-1') && tried[1].includes('mirror-2'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
