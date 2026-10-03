/**
 * dsh-pet-remielle balance/usage service.
 *
 * Ported from DeepSeek-Balance-Whale-Widget (lib/index.js), adapted to the pet
 * plugin's host context:
 *   - balance from `api.deepseek.com/user/balance` (DEEPSEEK_API_KEY)
 *   - today usage in two modes:
 *       ledger (default): balance-delta ledger persisted to `$DSH_HOME/.dshp-usage.json`
 *       token:            platform usage API (DEEPSEEK_PLATFORM_TOKEN) with
 *                         peak/off-peak pricing
 *   - 25s in-memory cache + in-flight dedup + transient-failure stale fallback.
 *
 * The ledger file name is `.dshp-usage.json` (not the whale's `.dshw-usage.json`)
 * so the two plugins never fight over the same ledger.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHolidayStore } from './holidays.js'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const BALANCE_TTL_MS = 25000

export function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
}

/**
 * `usage/by_api_key/cost` returns the platform's own cost per hour bucket
 * (`data.biz_data.data[].series[].buckets[].cost`, CNY string). Summing them
 * gives the exact today usage — no local pricing table needed.
 */
export function computeTodayCost(data) {
  const biz = data && data.data && data.data.biz_data
  const groups = biz && Array.isArray(biz.data) ? biz.data : null
  if (!groups) return null
  let total = 0
  let found = false
  for (const g of groups) {
    const series = Array.isArray(g && g.series) ? g.series : []
    for (const s of series) {
      const buckets = Array.isArray(s && s.buckets) ? s.buckets : []
      for (const b of buckets) {
        const c = Number(b && b.cost)
        if (!isFinite(c)) continue
        found = true
        total += c
      }
    }
  }
  return found ? total : null
}

/**
 * @param {object} options
 * @param {(name: string) => Promise<{value: string}|null>} options.resolveCredential
 * @param {string} [options.dshHome]
 * @param {(m: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] network egress, injected by tests (defaults to global fetch)
 * @param {() => number} [options.now] clock, injected by tests (defaults to Date.now)
 */
export function createBalanceService({ resolveCredential, getPlatformToken, dshHome, log, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const DSH_HOME = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const logger = log || (() => {})
  // Peak/off-peak determination (issue #25): weekends and statutory holidays are
  // off-peak all day; otherwise 9–12 and 14–18 count as peak. The holiday
  // calendar falls back to a builtin table and silently refreshes remote data
  // in the background.
  const holidays = createHolidayStore({ dshHome: DSH_HOME, log: logger, fetchImpl, now })

  const USAGE_FILE_CANDIDATES = [
    path.join(DSH_HOME, '.dshp-usage.json'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshp-usage.json'),
  ]

  let balanceCache = null
  let balanceInFlight = null

  async function fetchBalance() {
    let cred
    try {
      cred = await resolveCredential('DEEPSEEK_API_KEY')
    } catch (err) {
      return { ok: false, code: 'NO_KEY', error: 'failed to read credential: ' + String((err && err.message) || err).slice(0, 160) }
    }
    if (!cred) {
      return { ok: false, code: 'NO_KEY', error: 'DEEPSEEK_API_KEY is not configured' }
    }
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetchImpl(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + cred.value },
          signal: AbortSignal.timeout(20000),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let data
      try {
        data = await res.json()
      } catch (err) {
        lastErr = err
        break
      }
      const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : null
      if (!info || info.total_balance === undefined) {
        return { ok: false, code: 'SHAPE', error: 'the balance endpoint returned an unexpected structure' }
      }
      return {
        ok: true,
        totalBalance: Number(info.total_balance),
        currency: String(info.currency || 'CNY'),
        updatedAt: new Date(now()).toISOString(),
      }
    }
    const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
    return {
      ok: false,
      code: 'HTTP',
      transient: transient,
      error: 'balance endpoint request failed: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
    }
  }

  async function fetchUsage() {
    // Prefer the platformToken from the config (filled in on the main settings
    // page), falling back to the DSH credential service
    let token = ''
    try { token = String((typeof getPlatformToken === 'function' ? getPlatformToken() : '') || '').replace(/^Bearer\s+/i, '') } catch { /* ignore */ }
    if (!token) {
      let cred
      try {
        cred = await resolveCredential('DEEPSEEK_PLATFORM_TOKEN')
      } catch (err) {
        return { error: 'platform cred resolve failed' }
      }
      if (!cred) return { error: 'no platform token' }
      token = String(cred.value).replace(/^Bearer\s+/i, '')
    }
    try {
      const current = new Date(now())
      const tz = -current.getTimezoneOffset() * 60
      const start = Math.floor(new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime() / 1000)
      const end = start + 86400
      const url = `${USAGE_URL}?start=${start}&end=${end}&tz=${tz}`
      const res = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return { error: 'http ' + res.status }
      const data = await res.json()
      const amount = computeTodayCost(data)
      if (isFinite(amount)) return { amount }
      return { error: 'no usage' }
    } catch (err) {
      return { error: String((err && err.message) || err) }
    }
  }

  function todayKey() {
    const d = new Date(now())
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function readUsageLedger() {
    for (const p of USAGE_FILE_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
      } catch (err) { /* try next */ }
    }
    return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
  }

  function writeUsageLedger(led) {
    const body = JSON.stringify(led)
    for (const p of USAGE_FILE_CANDIDATES) {
      try {
        fs.writeFileSync(p, body, 'utf8')
        return true
      } catch (err) { /* try next */ }
    }
    return false
  }

  /** Ledger mode: after every balance observation, accumulate the day's usage from the positive balance delta (reset and archive automatically on a new day). */
  function recordLedgerUsage(currentBalance) {
    const t = todayKey()
    const led = readUsageLedger()
    if (led.date !== t) {
      if (led.date && typeof led.todayUsage === 'number') {
        led.history = led.history || {}
        led.history[led.date] = led.todayUsage
      }
      led.date = t
      led.lastBalance = currentBalance
      led.todayUsage = 0
    } else {
      const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
      if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
        led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
      }
      led.lastBalance = currentBalance
    }
    const keys = Object.keys(led.history || {}).sort()
    while (keys.length > 30) {
      delete led.history[keys.shift()]
    }
    writeUsageLedger(led)
    return led
  }

  async function getBalancePayload(usageMode) {
    const payload = await fetchBalance()
    if (!payload.ok) return payload
    // Whatever the mode, record the balance observation in the ledger first
    // (ledger data accumulates automatically)
    const led = recordLedgerUsage(Number(payload.totalBalance))
    const mode = normalizeUsageMode(usageMode)
    const full = { ...payload }
    full.isPeak = holidays.isPeak(Math.floor(now() / 1000))
    // Calendar refresh is background behaviour and must not block the balance
    // display; failures stay silent (the builtin table still backstops it).
    void holidays.refresh()
    if (mode === 'ledger') {
      full.todayUsage = led.todayUsage
      full.usageMode = 'ledger'
      return full
    }
    // token: try to compute in real time with the platform token
    const u = await fetchUsage()
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      return full
    }
    // No token, or the token failed: fall back to ledger mode
    full.todayUsage = led.todayUsage
    full.usageMode = 'ledger'
    return full
  }

  async function getBalance(usageMode) {
    const at = now()
    if (balanceCache && at - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.payload
    }
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = getBalancePayload(usageMode)
      .then((payload) => {
        if (payload.ok) {
          balanceCache = { at: now(), payload }
          return payload
        }
        if (payload.transient && balanceCache) {
          // transient network/API blip: keep serving the last known balance
          return { ...balanceCache.payload, stale: true, error: payload.error }
        }
        if (!payload.transient) logger('[pet-balance]', payload.code, payload.error)
        return payload
      })
      .catch((err) => ({
        ok: false,
        code: 'ERROR',
        error: 'balance service failure: ' + String((err && err.message) || err).slice(0, 200),
      }))
      .finally(() => {
        balanceInFlight = null
      })
    return balanceInFlight
  }

  /** Force the next request to recompute (e.g. when usageMode changes). */
  function invalidate() {
    balanceCache = null
  }

  return { getBalance, invalidate, normalizeUsageMode }
}
