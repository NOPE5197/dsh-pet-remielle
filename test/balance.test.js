/**
 * Balance / today's usage service (src/balance.js).
 *
 * This area used to have zero test coverage, yet it is the only place that writes
 * files to the user's disk (the usage ledger): a balance drop must accumulate
 * into "today's usage", a new day must reset it and archive the previous day, and
 * the archive is capped at 30 days — writing it wrong shows up as "the usage is
 * never right" with no error at all.
 *
 * The network egress is injected through fetchImpl, and the holidays background
 * refresh goes through the same injection and fails silently on 404, so this
 * file never touches the network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { computeTodayCost, createBalanceService, normalizeUsageMode } from '../src/balance.js'

const homes = []

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-balance-test-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop(), { recursive: true, force: true })
})

const LEDGER = '.dshp-usage.json'
// Matches BALANCE_TTL_MS in src/balance.js; keep both in sync
const BALANCE_TTL_MS = 25000
function readLedger(home) {
  return JSON.parse(readFileSync(join(home, LEDGER), 'utf8'))
}
function writeLedger(home, body) {
  writeFileSync(join(home, LEDGER), JSON.stringify(body), 'utf8')
}
function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function yesterdayKey() {
  const d = new Date(Date.now() - 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** A successful balance endpoint response. */
function okBody(balance) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ balance_infos: [{ total_balance: String(balance), currency: 'CNY' }] }),
  }
}

/**
 * fetch stub. The holiday calendar's background refresh also goes through here
 * and gets a 404 so it fails silently, leaving only the balance requests in
 * calls, which makes caching and dedup easy to assert.
 */
function fakeFetch(balance) {
  const calls = []
  const impl = async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('/user/balance')) {
      return typeof balance === 'function' ? balance(calls.length) : okBody(balance)
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  impl.calls = calls
  impl.balanceCalls = () => calls.filter((u) => u.includes('/user/balance')).length
  return impl
}

function service(fetchImpl, extra = {}) {
  return createBalanceService({
    resolveCredential: async (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'sk-test' } : null),
    dshHome: tempHome(),
    fetchImpl,
    log: () => {},
    ...extra,
  })
}

test('normalizeUsageMode falls back to ledger for anything but the exact token', () => {
  assert.equal(normalizeUsageMode('token'), 'token')
  assert.equal(normalizeUsageMode('ledger'), 'ledger')
  assert.equal(normalizeUsageMode('TOKEN'), 'ledger')
  assert.equal(normalizeUsageMode(''), 'ledger')
  assert.equal(normalizeUsageMode(undefined), 'ledger')
})

test('computeTodayCost sums the platform cost buckets and rejects unusable shapes', () => {
  const payload = {
    data: {
      biz_data: {
        data: [
          { series: [{ buckets: [{ cost: '1.5' }, { cost: '2.25' }] }] },
          { series: [{ buckets: [{ cost: '0.25' }] }, { buckets: [] }] },
        ],
      },
    },
  }
  assert.equal(computeTodayCost(payload), 4)
  // A non-numeric cost is skipped but does not set found — when everything is
  // non-numeric it must return null (= not obtainable), never 0
  assert.equal(computeTodayCost({ data: { biz_data: { data: [{ series: [{ buckets: [{ cost: 'x' }] }] }] } } }), null)
  assert.equal(computeTodayCost({ data: { biz_data: { data: [] } } }), null)
  assert.equal(computeTodayCost({}), null)
  assert.equal(computeTodayCost(null), null)
})

test('missing credential is reported without touching the network', async () => {
  const fetchImpl = fakeFetch(100)
  const svc = createBalanceService({
    resolveCredential: async () => null,
    dshHome: tempHome(),
    fetchImpl,
    log: () => {},
  })
  const result = await svc.getBalance('ledger')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_KEY')
  assert.equal(fetchImpl.balanceCalls(), 0, 'no credential means no request should be sent')
})

test('a 4xx fails fast while a 5xx is retried once', async () => {
  const client = fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) }))
  const r1 = await service(client).getBalance('ledger')
  assert.equal(r1.ok, false)
  assert.equal(client.balanceCalls(), 1, '4xx must not be retried')

  const server = fakeFetch(() => ({ ok: false, status: 503, json: async () => ({}) }))
  const r2 = await service(server).getBalance('ledger')
  assert.equal(r2.ok, false)
  assert.equal(server.balanceCalls(), 2, '5xx should be retried once')
  assert.equal(r2.transient, true, 'a server failure is transient and can fall back to the old cache')
})

test('an unexpected balance payload shape is flagged, not silently zeroed', async () => {
  const client = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ balance_infos: [] }) }))
  const result = await service(client).getBalance('ledger')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SHAPE', 'an unexpected shape must be distinguishable from a network failure')
  assert.match(result.error, /unexpected structure/)
})

test('ledger mode accumulates the balance drop and ignores top-ups', async () => {
  const home = tempHome()
  let balance = 100
  const svc = service(fakeFetch(() => okBody(balance)), { dshHome: home })

  assert.equal((await svc.getBalance('ledger')).todayUsage, 0, 'the first observation only records a baseline and is not usage')

  balance = 90
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 10, 'a balance drop of 10 should accumulate into today\'s usage of 10')

  balance = 95
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 10, 'a top-up is not consumption and usage must not decrease')

  balance = 80
  svc.invalidate()
  assert.equal((await svc.getBalance('ledger')).todayUsage, 25)
  assert.equal(readLedger(home).date, todayKey())
})

test('a new day resets the counter and archives yesterday', async () => {
  const home = tempHome()
  // Pre-seed a "yesterday" record: the new-day branch is triggered by ledger.date
  // differing from today
  writeLedger(home, { date: yesterdayKey(), lastBalance: 50, todayUsage: 33, history: {} })
  const svc = service(fakeFetch(40), { dshHome: home })

  const result = await svc.getBalance('ledger')
  assert.equal(result.todayUsage, 0, 'today\'s usage should reset to zero on a new day')
  const ledger = readLedger(home)
  assert.equal(ledger.date, todayKey())
  assert.equal(ledger.lastBalance, 40, "today's first balance becomes the new baseline")
  assert.equal(ledger.history[yesterdayKey()], 33, "yesterday's usage must be archived into history")
})

test('the archive keeps only the most recent 30 days', async () => {
  const home = tempHome()
  const history = {}
  for (let i = 0; i < 35; i++) history[`2000-01-${String(i + 1).padStart(2, '0')}`] = i + 1
  writeLedger(home, { date: yesterdayKey(), lastBalance: 10, todayUsage: 5, history })
  await service(fakeFetch(10), { dshHome: home }).getBalance('ledger')
  const kept = Object.keys(readLedger(home).history)
  assert.ok(kept.length <= 31, `the archive should be trimmed to about 30 days, actually ${kept.length}`)
  assert.equal(kept.includes('2000-01-01'), false, 'the oldest day should be evicted')
})

test('getBalance caches for the TTL and de-duplicates concurrent calls', async () => {
  const client = fakeFetch(77)
  const svc = service(client)

  await svc.getBalance('ledger')
  await svc.getBalance('ledger')
  assert.equal(client.balanceCalls(), 1, 'a second call inside the TTL should hit the cache')

  const [a, b] = await Promise.all([svc.getBalance('ledger'), svc.getBalance('ledger')])
  assert.equal(client.balanceCalls(), 1, 'concurrent calls should collapse into one request')
  assert.deepEqual(a, b, 'concurrent callers get the same result')
})

test('invalidate forces the next read to recompute', async () => {
  const client = fakeFetch(50)
  const svc = service(client)
  await svc.getBalance('ledger')
  svc.invalidate()
  await svc.getBalance('ledger')
  assert.equal(client.balanceCalls(), 2)
})

test('a transient failure keeps serving the last known balance, flagged stale', async () => {
  let healthy = true
  const client = fakeFetch(() => (healthy ? okBody(64) : { ok: false, status: 500, json: async () => ({}) }))
  // An advanceable clock: the stale fallback is only reachable after the TTL
  // expires naturally (invalidate drops the cache entirely)
  let clock = 1_000_000
  const svc = service(client, { now: () => clock })

  const first = await svc.getBalance('ledger')
  assert.equal(first.totalBalance, 64)
  assert.equal(first.stale, undefined)

  // Still inside the TTL: the cache is used directly and not even a request is sent
  clock += BALANCE_TTL_MS - 1
  assert.equal((await svc.getBalance('ledger')).totalBalance, 64)
  assert.equal(client.balanceCalls(), 1)

  // After the TTL expires with a failing server: the known balance must not be
  // cleared, but it must be flagged as stale
  healthy = false
  clock += 2
  const second = await svc.getBalance('ledger')
  assert.equal(second.totalBalance, 64, 'a transient failure must not clear the known balance')
  assert.equal(second.stale, true, 'but it must be flagged as stale so the caller can warn the user')
  assert.ok(second.error, 'it should carry the failure reason')
  assert.equal(client.balanceCalls(), 3, 'a 5xx is retried once and both attempts count as this request')
})

test('invalidate drops the stale fallback along with the cache', async () => {
  // Record the current behaviour: invalidate exists to force a recompute when the
  // usageMode changes and drops the cache entirely, so a transient failure right
  // after it has no old balance to fall back to. That is exactly what you want when
  // switching modes, but a reader can easily assume it keeps the old value as a
  // fallback, so the status quo is pinned.
  let healthy = true
  const client = fakeFetch(() => (healthy ? okBody(64) : { ok: false, status: 500, json: async () => ({}) }))
  const svc = service(client)
  await svc.getBalance('ledger')

  healthy = false
  svc.invalidate()
  const result = await svc.getBalance('ledger')
  assert.equal(result.ok, false, 'failing after invalidate is a failure with no fallback')
  assert.equal(result.stale, undefined)
})

test('token mode strips a Bearer prefix and falls back to ledger when the platform call fails', async () => {
  const home = tempHome()
  const urls = []
  const fetchImpl = async (url) => {
    const href = String(url)
    urls.push(href)
    if (href.includes('/user/balance')) return okBody(20)
    return { ok: false, status: 403, json: async () => ({}) }
  }
  const svc = service(fetchImpl, { dshHome: home, getPlatformToken: () => 'Bearer secret-token' })

  const result = await svc.getBalance('token')
  // The platform API answers 403 → fall back to ledger mode instead of showing the
  // balance page as "usage unavailable"
  assert.equal(result.usageMode, 'ledger')
  assert.equal(result.todayUsage, 0, 'the fallback should report ledger mode\'s usage for the day')
  assert.ok(urls.some((u) => u.includes('/api/v0/usage/by_api_key/cost')), 'the platform API really should have been tried')

  const usageUrl = urls.find((u) => u.includes('by_api_key/cost'))
  assert.ok(usageUrl.includes('start=') && usageUrl.includes('end=') && usageUrl.includes('tz='), 'the platform API needs the day start/end times and the timezone')
})

test('a platform cost payload is adopted as today usage in token mode', async () => {
  const fetchImpl = async (url) => (String(url).includes('/user/balance')
    ? okBody(20)
    : {
        ok: true,
        status: 200,
        json: async () => ({ data: { biz_data: { data: [{ series: [{ buckets: [{ cost: '1.25' }, { cost: '2' }] }] }] } } }),
      })
  const result = await service(fetchImpl, { getPlatformToken: () => 'tok' }).getBalance('token')
  assert.equal(result.usageMode, 'token')
  assert.equal(result.todayUsage, 3.25)
})

test('the injected clock controls ledger date and token usage window', async () => {
  const home = tempHome()
  const clock = new Date('2026-02-03T16:30:00.000Z').getTime()
  const urls = []
  const fetchImpl = async (url) => {
    const href = String(url)
    urls.push(href)
    if (href.includes('/user/balance')) return okBody(20)
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { biz_data: { data: [{ series: [{ buckets: [{ cost: '1' }] }] }] } } }),
    }
  }
  const svc = service(fetchImpl, { dshHome: home, getPlatformToken: () => 'tok', now: () => clock })

  const result = await svc.getBalance('token')
  const local = new Date(clock)
  const p = (n) => String(n).padStart(2, '0')
  const expectedDate = `${local.getFullYear()}-${p(local.getMonth() + 1)}-${p(local.getDate())}`
  const expectedStart = Math.floor(new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime() / 1000)
  assert.equal(result.updatedAt, new Date(clock).toISOString())
  assert.equal(JSON.parse(readFileSync(join(home, LEDGER), 'utf8')).date, expectedDate)
  const usageUrl = urls.find((url) => url.includes('/api/v0/usage/by_api_key/cost'))
  assert.ok(usageUrl.includes(`start=${expectedStart}`), `usage window must use injected date: ${usageUrl}`)
})
