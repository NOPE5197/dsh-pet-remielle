import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PKG, setSelfUpdateHooks, updateHandler, run, getUpdateProgress, progressHandler,
  PROGRESS_ENDPOINT, verifyInstallIntegrity, infoHandler,
} from '../src/self-update.js'

// A directory that is guaranteed to exist, so the existsSync(profileDir) check passes
const EXISTING_DIR = fileURLToPath(new URL('.', import.meta.url))

// A real request always carries a socket: the guard inspects the TCP peer address
// (the Host header can be forged by a page)
function request(method, host = '127.0.0.1:3080', extra = {}) {
  const req = Readable.from([])
  req.method = method
  req.headers = { host, ...extra }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
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

test('registry update stops the desktop window first and runs pnpm update --latest', async () => {
  const calls = []
  setSelfUpdateHooks({
    stopDesktopWindow: async () => { calls.push('stop') },
    run: async (cmd, args, cwd) => {
      calls.push(`run ${cmd} ${args.join(' ')} @ ${cwd}`)
      return { ok: true, output: 'done' }
    },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  // Stopping the window must happen before pnpm, and --latest steps over any exact
  // version pin
  assert.deepEqual(calls, [
    'stop',
    `run pnpm update --latest ${PKG} @ ${EXISTING_DIR}`,
  ])
})

test('link update runs git pull in the repo dir', async () => {
  const seen = []
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async (cmd, args, cwd) => { seen.push([cmd, args, cwd]); return { ok: false, output: 'boom' } },
    resolveInstall: () => ({ mode: 'link', repoDir: 'D:/repo', version: '0.3.4' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  assert.deepEqual(seen, [['git', ['-C', 'D:/repo', 'pull'], 'D:/repo']])
})

test('a failing desktop-window stop does not block the update', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: async () => { throw new Error('window already gone') },
    run: async () => { ran = true; return { ok: true, output: '' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  assert.equal(ran, true)
})

test('update route rejects non-local hosts', async () => {
  setSelfUpdateHooks({ resolveInstall: () => { throw new Error('must not resolve') } })
  const res = responseRecorder()
  await updateHandler(request('POST', 'evil.example.com:3080'), res)
  assert.equal(res.status, 403)
})

test('successful update runs the onUpdateSuccess hook and appends its note to output', async () => {
  const events = []
  setSelfUpdateHooks({
    run: async () => ({ ok: true, output: 'done' }),
    onUpdateSuccess: () => { events.push('success'); return 'Desktop mode was switched off automatically' },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(body.output.includes('Desktop mode was switched off automatically'))
  assert.deepEqual(events, ['success'])
})

test('a failed update does not run the onUpdateSuccess hook', async () => {
  let called = 0
  setSelfUpdateHooks({
    run: async () => ({ ok: false, output: 'EPERM' }),
    onUpdateSuccess: () => { called += 1 },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.3.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  assert.equal(called, 0)
})

test('failed or rejected updates release the lock so a later update can run', async (t) => {
  t.after(() => setSelfUpdateHooks({ stopDesktopWindow: null, onUpdateSuccess: null, run: null, resolveInstall: null }))
  const defaults = {
    stopDesktopWindow: null,
    onUpdateSuccess: null,
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.4' }),
    run: async () => ({ ok: true, output: 'done' }),
  }
  const failures = [
    ['command failure', { run: async () => ({ ok: false, output: 'EPERM' }) }, /EPERM/],
    ['command exception', { run: async () => { throw new Error('pnpm vanished mid-flight') } }, /pnpm vanished mid-flight/],
    ['install exception', { resolveInstall: () => { throw new Error('install unavailable') } }, /install unavailable/],
    ['unsupported version', { resolveInstall: () => ({ version: '0.2.0' }) }, /automatic incremental update is impossible/],
    ['unknown install', { resolveInstall: () => ({ version: '0.4.4' }) }, /unknown install shape/],
  ]
  for (const [name, hooks, message] of failures) {
    setSelfUpdateHooks({ ...defaults, ...hooks })
    const res = responseRecorder()
    await updateHandler(request('POST'), res)
    assert.equal(res.status, 500, name)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false, name)
    assert.match(body.output, message, name)
    assert.equal(getUpdateProgress().running, false, name)

    setSelfUpdateHooks(defaults)
    const retry = responseRecorder()
    await updateHandler(request('POST'), retry)
    assert.equal(retry.status, 200, name)
  }
})

// ---- 0.4.4: idle timeout (replacing the fixed 90s hard timeout) + live progress ----
// The real child process is driven with process.execPath so it does not depend on
// PATH; the script deliberately contains only spaces and no cmd metacharacters
// like > < & | (on Windows shell:true splices it into cmd.exe /c "...").


test('updateHandler rejects concurrent requests during preparation and execution without disturbing the active update', async (t) => {
  t.after(() => setSelfUpdateHooks({ stopDesktopWindow: null, onUpdateSuccess: null, run: null, resolveInstall: null }))
  const stopped = Promise.withResolvers()
  const running = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const calls = []
  setSelfUpdateHooks({
    stopDesktopWindow: async () => { calls.push('stop'); await stopped.promise },
    run: async () => {
      calls.push('run')
      running.resolve()
      return finished.promise
    },
    onUpdateSuccess: () => {
      assert.equal(getUpdateProgress().running, true, 'the lock covers the success hook')
      calls.push('success')
    },
    resolveInstall: () => {
      calls.push('resolve')
      return { mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.4' }
    },
  })
  const res = responseRecorder()
  const pending = [updateHandler(request('POST'), res)]
  try {
    for (const phase of ['preparation', 'execution']) {
      if (phase === 'execution') {
        stopped.resolve()
        await running.promise
      }
      const duplicate = responseRecorder()
      pending.push(updateHandler(request('POST'), duplicate))
      assert.equal(duplicate.status, 409, phase)
      const body = JSON.parse(duplicate.body)
      assert.equal(body.ok, false, phase)
      assert.match(body.output, /An update is already running/, phase)
      assert.equal(getUpdateProgress().running, true, 'a rejection must not clear the active update')
      assert.deepEqual(calls, phase === 'preparation' ? ['resolve', 'stop'] : ['resolve', 'stop', 'run'])
    }
  } finally {
    stopped.resolve()
    finished.resolve({ ok: true, output: 'done' })
    await Promise.all(pending)
  }
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).output, 'done')
  assert.deepEqual(calls, ['resolve', 'stop', 'run', 'success'])
  assert.equal(getUpdateProgress().running, false)

  const retry = responseRecorder()
  await updateHandler(request('POST'), retry)
  assert.equal(retry.status, 200, 'a completed update must not block a later request')
  assert.equal(calls.filter((call) => call === 'run').length, 2)
})

test('progress endpoint serves live state locally and rejects remote hosts', () => {
  const res = responseRecorder()
  progressHandler(request('GET'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(typeof body.outputTail, 'string')
  assert.ok('running' in body && 'elapsedMs' in body)

  const res2 = responseRecorder()
  progressHandler(request('GET', 'evil.example.com:3080'), res2)
  assert.equal(res2.status, 403)
})

// ---- 0.4.4: integrity self-check of the old install after a failure (a failed
// update must not cost the user their working old version either) ----

test('verifyInstallIntegrity: intact package passes, broken package reports problems', async () => {
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = await mkdtemp(join(tmpdir(), 'rm2-integrity-'))
  try {
    // Intact shape: package.json + entry + src/
    const good = join(base, 'good')
    await mkdir(good, { recursive: true })
    await writeFile(join(good, 'package.json'), JSON.stringify({ name: 'dsh-pet-remielle', version: '0.4.3', main: 'lib/index.js' }))
    await mkdir(join(good, 'lib'), { recursive: true })
    await writeFile(join(good, 'lib', 'index.js'), 'export {}')
    await mkdir(join(good, 'src'), { recursive: true })
    const goodReport = verifyInstallIntegrity(good)
    assert.equal(goodReport.ok, true, 'an intact package must pass: ' + JSON.stringify(goodReport.problems))

    // Broken shape: package.json missing (simulating pnpm being killed midway)
    const broken = join(base, 'broken')
    await mkdir(join(broken, 'src'), { recursive: true })
    const badReport = verifyInstallIntegrity(broken)
    assert.equal(badReport.ok, false)
    assert.ok(badReport.problems.some((p) => p.includes('package.json')), 'a missing package.json must be reported')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a failed update appends an integrity verdict so the user knows the old version still works', async () => {
  setSelfUpdateHooks({
    run: async () => ({ ok: false, output: '[timeout: no output for 60s — the update process looks hung]' }),
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST'), res)
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  // There is no node_modules/dsh-pet-remielle under EXISTING_DIR, so the
  // self-check necessarily reports problems — the key assertion: the failure
  // response must carry the self-check verdict instead of only dumping a chunk of
  // pnpm log
  assert.ok(body.output.includes('Self-check'), 'a failed update must include an integrity verdict: ' + body.output.slice(-200))
  assert.ok(/✅|⚠️/.test(body.output), 'the verdict must state whether the old install survives')
})

// ---- CSRF guards ----

test('a cross-origin POST to the update route is refused and never runs pnpm/git', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  // A hostile page's Host header matches this machine (a browser cannot forge it,
  // it is decided by the request target) and only Origin reveals the cross-origin
  // nature — exactly the class of request that a past "Host only" check missed.
  const res = responseRecorder()
  await updateHandler(request('POST', '127.0.0.1:3080', { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
  assert.equal(ran, false, 'cross-origin POST must not reach git/pnpm')
})

test('a request from a non-loopback peer is refused even with a loopback Host header', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  const req = request('POST')
  req.socket = { remoteAddress: '192.168.1.20' }
  await updateHandler(req, res)
  assert.equal(res.status, 403)
  assert.equal(ran, false, 'a remote peer must not trigger the update')
})

test('a same-origin loopback request is still accepted', async () => {
  let ran = false
  setSelfUpdateHooks({
    stopDesktopWindow: null,
    run: async () => { ran = true; return { ok: true, output: 'updated' } },
    resolveInstall: () => ({ mode: 'registry', profileDir: EXISTING_DIR, version: '0.4.3' }),
  })
  const res = responseRecorder()
  await updateHandler(request('POST', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
  assert.equal(ran, true)
})

test('the info route refuses cross-origin callers instead of leaking absolute paths', () => {
  const res = responseRecorder()
  infoHandler(request('GET', '127.0.0.1:3080', { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
  assert.ok(!/profileDir|repoDir/.test(res.body), 'guarded response must not carry install paths')
})

test('the info route still serves its payload to a same-origin caller', () => {
  const res = responseRecorder()
  infoHandler(request('GET', '127.0.0.1:3080', { origin: 'http://127.0.0.1:3080' }), res)
  assert.equal(res.status, 200)
  // resolveInstall runs the real implementation (not through hooks), so only
  // stable fields are asserted
  assert.equal(JSON.parse(res.body).pkg, PKG)
})

// Under the Fetch spec a cross-origin GET/HEAD carries **no Origin** (its mode is
// no-cors rather than cors), and the Host header is decided by the request
// target. The method must be pinned to POST so that a hostile page's
// <img src=".../update"> can never reach hooks.run().
test('plain cross-origin GET and HEAD cannot trigger the update', async () => {
  for (const method of ['GET', 'HEAD']) {
    let ran = false
    setSelfUpdateHooks({
      stopDesktopWindow: null,
      run: async () => { ran = true; return { ok: true, output: 'updated' } },
      resolveInstall: () => ({ mode: 'link', repoDir: 'C:/fake/repo', version: '0.4.3' }),
    })
    const res = responseRecorder()
    // Simulate a cross-origin resource request with no Origin: loopback peer,
    // correct Host.
    await updateHandler(request(method), res)
    assert.equal(res.status, 405, `${method} must be rejected`)
    assert.equal(ran, false, `${method} must not reach git/pnpm`)
  }
})

test('the read routes refuse a mutating method', () => {
  for (const [name, handler] of [['info', infoHandler], ['progress', progressHandler]]) {
    const res = responseRecorder()
    handler(request('POST'), res)
    assert.equal(res.status, 405, `${name} must be GET-only`)
  }
})
