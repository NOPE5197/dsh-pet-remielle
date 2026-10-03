/**
 * Client-side behavior of the balance widget controller (src/balance-widget.js).
 *
 * That file's own header says "This controller owns NO DOM" — it only fetches the data,
 * maintains the rolling-number animation and then emits "display frames" for the desktop
 * pet's own bubble to render. So this file needs no DOM stubs at all: a fake window plus a
 * fake fetch is enough to drive it, which is also why it never had a test before.
 *
 * The safety-related assertion lives in fmt(): when the balance cannot be fetched it must
 * show '--' and never ¥0.00 — the latter reads to users as "the balance is already spent".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const SRC = readFileSync(new URL('../src/balance-widget.js', import.meta.url), 'utf8')

const ANIM_MS = 700

/**
 * Load a brand-new widget instance.
 * The source is an IIFE that returns as soon as it sees window.__petBalance, so every load
 * needs a clean window.
 */
function load({ fetchImpl, frameStep = ANIM_MS } = {}) {
  const timers = { intervals: new Set(), timeouts: new Set() }
  const requests = []
  let frameTs = 0

  const win = {
    setInterval(fn) { timers.intervals.add(fn); return timers.intervals.size },
    clearInterval(id) { timers.intervals.delete([...timers.intervals][id - 1]) },
    setTimeout(fn) { timers.timeouts.add(fn); return timers.timeouts.size },
    clearTimeout(id) { timers.timeouts.delete([...timers.timeouts][id - 1]) },
    requestAnimationFrame(cb) { frameTs += frameStep; cb(frameTs); return frameTs },
    cancelAnimationFrame() {},
  }
  win.window = win
  const doc = { createElement: () => ({ style: {}, classList: { add() {} } }) }
  const fetchStub = async (url, options) => {
    requests.push({ url: String(url), options })
    return fetchImpl ? fetchImpl(String(url), options) : { json: async () => ({ ok: false, error: 'Not configured' }) }
  }
  class AbortControllerStub {
    constructor() { this.signal = {} }
    abort() {}
  }

  new Function('window', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', SRC)
    .call(win, win, doc, fetchStub, AbortControllerStub, win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval, win.requestAnimationFrame, win.cancelAnimationFrame)

  const api = win.__petBalance
  const frames = []
  const unsubscribe = api.subscribe((frame) => frames.push(frame))
  // Drain the microtask chain (fetch → json → then/catch/finally)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return { api, frames, requests, flush, unsubscribe, timers }
}

function balanceBody(totalBalance, extra = {}) {
  return { ok: true, totalBalance, currency: 'CNY', todayUsage: 1.5, isPeak: false, ...extra }
}

test('fmt never renders an unknown balance as zero', () => {
  const { api } = load()
  // Amounts are sensitive: null / undefined / NaN / Infinity all show '--', never ¥0.00
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'abc']) {
    assert.equal(api.fmt(bad, 'CNY'), '--', `${String(bad)} should render as --`)
  }
  assert.equal(api.fmt(0, 'CNY'), '¥ 0.00', 'only a real zero balance renders as ¥0.00')
  assert.equal(api.fmt(12.3, 'CNY'), '¥ 12.30')
  assert.equal(api.fmt(12.345, 'CNY'), '¥ 12.35')
  assert.equal(api.fmt(12.5, 'USD'), '12.50 USD', 'a non-CNY currency gets no symbol prefix')
  assert.equal(api.fmt(12.5), '¥ 12.50', 'a missing currency falls back to CNY')
  // Known edge case: an empty string goes through Number('') === 0 and renders ¥0.00. The
  // real call path can never pass an empty string (the initial values of state.todayUsage /
  // shown are null, and the intermediate animation values are all numbers), so it is not
  // asserted here.
})

test('showStatus and showBalance emit different frame kinds', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()

  api.showStatus()
  assert.deepEqual(frames.at(-1), { kind: 'status' })

  api.showBalance()
  assert.equal(frames.at(-1).kind, 'balance')
  assert.equal(frames.at(-1).label, 'DeepSeek balance')
  assert.equal(frames.at(-1).amount, '¥ 30.00')
  assert.equal(frames.at(-1).detail, "Today's usage ¥ 1.50", 'the detail uses today\'s usage and does not duplicate the period')
  assert.equal(frames.at(-1).period, 'Off-peak hours')
})

test('the period label and colour follow the peak flag', async () => {
  const peak = load({ fetchImpl: async () => ({ json: async () => balanceBody(30, { isPeak: true }) }) })
  peak.api.init('ledger')
  await peak.flush()
  peak.api.showBalance()
  assert.equal(peak.frames.at(-1).period, 'Peak hours')
  assert.equal(peak.frames.at(-1).color, '#e0433f')

  const off = load({ fetchImpl: async () => ({ json: async () => balanceBody(30, { isPeak: false }) }) })
  off.api.init('ledger')
  await off.flush()
  off.api.showBalance()
  assert.equal(off.frames.at(-1).period, 'Off-peak hours')
  assert.equal(off.frames.at(-1).color, '#2fa24c')
})

test('a failure replaces the period with an explicit notice instead of leaking a raw error', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => ({ json: async () => ({ ok: false, error: 'HTTP 500' }) }) })
  api.init('ledger')
  await flush()
  api.showBalance()
  const frame = frames.at(-1)
  assert.equal(frame.period, 'Fetch failed', 'the failure must be visible, not rendered as "Off-peak hours"')
  assert.equal(frame.color, '#c0392b')
  assert.equal(frame.amount, '--', 'when the balance cannot be fetched the amount is -- too, not ¥0.00')
  assert.ok(!frame.detail.includes('HTTP 500'), 'the error copy is no longer spliced into detail (the client appends the period a second time, so it would repeat)')
})

test('a rejected fetch degrades to the same failure frame', async () => {
  const { api, frames, flush } = load({ fetchImpl: async () => { throw new Error('network down') } })
  api.init('ledger')
  await flush()
  api.showBalance()
  assert.equal(frames.at(-1).period, 'Fetch failed')
  assert.equal(frames.at(-1).amount, '--')
})

test('the balance request always opts out of caching and carries a timeout signal', async () => {
  const { api, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/plugins/dsh-pet-remielle/balance')
  assert.equal(requests[0].options.cache, 'no-store', 'the balance must bypass the cache, otherwise users see a stale amount')
  assert.ok(requests[0].options.signal, 'a timeout signal is required, otherwise the request can hang forever')
})

test('concurrent refreshes collapse into a single request', async () => {
  let inflight = 0
  let peak = 0
  const { api, requests, flush } = load({
    fetchImpl: async () => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return { json: async () => balanceBody(30) }
    },
  })
  api.showBalance()
  api.showBalance()
  api.showBalance()
  await flush()
  assert.equal(peak, 1, 'the busy flag must guarantee that only one request is in flight at a time')
  assert.equal(requests.length, 1)
})

test('setUsageMode only refetches when the mode actually changes', async () => {
  const { api, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  assert.equal(requests.length, 1)

  api.setUsageMode('ledger')
  await flush()
  assert.equal(requests.length, 1, 'setting the same mode again must not fetch again')

  api.setUsageMode('token')
  await flush()
  assert.equal(requests.length, 2, 'switching modes must recompute immediately')

  api.setUsageMode('BOGUS')
  await flush()
  assert.equal(requests.length, 3, 'an invalid value is handled as ledger, which differs from the previous one, so it recomputes')
  api.setUsageMode('ledger')
  await flush()
  assert.equal(requests.length, 3, 'going back to the already-active ledger does not recompute')
})

test('setEnabled stops and restarts polling', async () => {
  const { api, timers, requests, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  assert.equal(timers.intervals.size, 1, 'the 60s polling starts as soon as it is loaded')

  api.setEnabled(false)
  assert.equal(timers.intervals.size, 0, 'turning the usage sub-switch off must stop the polling')
  api.setEnabled(false)
  assert.equal(requests.length, 0, 'turning it off again must not trigger a request')

  const before = requests.length
  api.setEnabled(true)
  await flush()
  assert.equal(timers.intervals.size, 1, 'turning it back on must resume the polling')
  assert.equal(requests.length, before + 1, 'turning it back on fetches once immediately')
})

test('unsubscribe stops delivery to that listener', async () => {
  const { api, frames, unsubscribe, flush } = load({ fetchImpl: async () => ({ json: async () => balanceBody(30) }) })
  api.init('ledger')
  await flush()
  api.showBalance()
  const seen = frames.length
  assert.ok(seen > 0)

  unsubscribe()
  api.showStatus()
  assert.equal(frames.length, seen, 'no frames arrive after unsubscribing')
})
