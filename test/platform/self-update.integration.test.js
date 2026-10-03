import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PKG, setSelfUpdateHooks, updateHandler, run, getUpdateProgress, progressHandler,
  PROGRESS_ENDPOINT, verifyInstallIntegrity, infoHandler,
} from '../../src/self-update.js'

// Platform integration tests: the cases below spawn real child processes; the
// unit coverage that injects spawn/the clock lives in the default suite.
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

// ---- 0.4.4: idle timeout (replacing the fixed 90s hard timeout) + live progress ----
// The real child process is driven with process.execPath so it does not depend on
// PATH; the script deliberately contains only spaces and no cmd metacharacters
// like > < & | (on Windows shell:true splices it into cmd.exe /c "...").

test('run(): periodic output resets the idle timer so slow downloads are not killed', async () => {
  // The first line is printed immediately (simulating pnpm metadata resolution),
  // then output comes periodically (simulating download progress) — the total
  // process duration (~3s) exceeds the idle threshold (3s), but the idle timer is
  // constantly reset and the process must not be killed.
  // The 500ms interval leaves a 6x margin against the 3s idle threshold: when
  // the whole suite runs in parallel, a cold cmd.exe start can take over 1s.
  const script = "console.log('boot'); let n = 0; const t = setInterval(function () { n++; console.log('tick' + n); if (n === 6) { clearInterval(t) } }, 500)"
  const result = await run(process.execPath, ['-e', script], EXISTING_DIR, { idleTimeoutMs: 3000, totalTimeoutMs: 20000 })
  assert.equal(result.ok, true, 'periodic output must keep the process alive, got: ' + result.output)
  assert.ok((result.output.match(/tick/g) || []).length >= 6, 'all ticks captured: ' + result.output)
  assert.ok(!result.output.includes('[timeout'), 'no timeout marker')
})

test('run(): a silent process is killed by the idle timeout', async () => {
  const started = Date.now()
  const result = await run(process.execPath, ['-e', 'setTimeout(function () {}, 5000)'], EXISTING_DIR, { idleTimeoutMs: 500, totalTimeoutMs: 10000 })
  assert.equal(result.ok, false)
  assert.ok(result.output.includes('[timeout'), 'timeout marker present: ' + result.output)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4000, `killed near the idle threshold (took ${elapsed}ms, not the full 5s)`)
})

test('run(): live child output feeds the progress tail buffer', async () => {
  const script = "console.log('progress-line-1'); console.log('progress-line-2')"
  await run(process.execPath, ['-e', script], EXISTING_DIR, { idleTimeoutMs: 5000, totalTimeoutMs: 10000 })
  const prog = getUpdateProgress()
  assert.ok(prog.outputTail.includes('progress-line-1'), 'tail has line 1: ' + prog.outputTail)
  assert.ok(prog.outputTail.includes('progress-line-2'), 'tail has line 2: ' + prog.outputTail)
  assert.equal(prog.running, false, 'a bare run() does not flip the update-level running flag')
})
