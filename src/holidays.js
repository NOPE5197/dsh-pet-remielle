/**
 * "Statutory holidays" calendar used for peak/off-peak determination (issue #25).
 *
 * DeepSeek's current peak/off-peak rules (per the official statement of
 * 2026-09-19):
 *   - Weekdays: peak 9:00–12:00 and 14:00–18:00 (Beijing time), off-peak otherwise;
 *   - Saturday / Sunday: billed as off-peak all day (since 2026-08-23);
 *   - Chinese statutory holidays: billed as off-peak all day;
 *   - Weekends worked as make-up workdays: also billed as off-peak all day.
 *
 * The last two make the "make-up workday table" redundant — make-up workdays
 * only ever fall on weekends, and weekends are already off-peak all day, so the
 * check reduces to "weekend ∪ statutory holiday → off-peak; otherwise by hour".
 * This module therefore only maintains one set of days off.
 *
 * Data priority: remote cache > builtin static table > fallback approximation.
 * The remote source (a public holiday API) is only fetched on the first fetch or
 * when stale; failures fall back silently; the request carries only the year and
 * no user data whatsoever.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BEIJING_OFFSET_SEC = 8 * 3600
const DAY_MS = 86400000
/** Lifetime of remote data; an empty "not published yet" result uses a shorter TTL so it is picked up quickly. */
const CACHE_TTL_MS = 30 * DAY_MS
const EMPTY_CACHE_TTL_MS = 3 * DAY_MS
const FETCH_TIMEOUT_MS = 8000
/** Backoff after a failed refresh: the balance refreshes every 25 seconds, so while offline it must not retry every round and flood the log. */
const FAILURE_RETRY_MS = 10 * 60 * 1000
const SOURCE_URL = (year) => `https://timor.tech/api/holiday/year/${year}`

/**
 * Builtin days off (MM-DD, Beijing time). The data comes from the annual State
 * Council holiday arrangement and has been cross-checked day by day against the
 * public holiday API. The next year must be added in a release once the
 * November notice is published.
 */
export const BUILTIN_HOLIDAYS = {
  2025: [
    '01-01', // New Year's Day
    '01-28', '01-29', '01-30', '01-31', '02-01', '02-02', '02-03', '02-04', // Spring Festival
    '04-04', '04-05', '04-06', // Qingming
    '05-01', '05-02', '05-03', '05-04', '05-05', // Labour Day
    '05-31', '06-01', '06-02', // Dragon Boat Festival
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', '10-08', // National Day + Mid-Autumn Festival
  ],
  2026: [
    '01-01', '01-02', '01-03', // New Year's Day
    '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23', // Spring Festival
    '04-04', '04-05', '04-06', // Qingming
    '05-01', '05-02', '05-03', '05-04', '05-05', // Labour Day
    '06-19', '06-20', '06-21', // Dragon Boat Festival
    '09-25', '09-26', '09-27', // Mid-Autumn Festival
    '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', // National Day
  ],
}

/**
 * Fallback approximation for years covered by neither the builtin table nor the
 * remote cache: only the three big holidays whose dates are essentially fixed
 * are listed. Spring Festival / Dragon Boat / Mid-Autumn follow the lunar
 * calendar and cannot be derived without data; better to misjudge a few days
 * than to falsely report "peak hours" wholesale on the known fixed holidays.
 * Once remote data is available it wins.
 */
export const FIXED_FALLBACK = [
  '01-01', // New Year's Day
  '05-01', '05-02', '05-03', '05-04', '05-05', // Labour Day
  '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', // National Day
]

/** Wall-clock Date in Beijing time (UTC+8); reading it with getUTC* yields the Beijing-local fields. */
export function beijingDate(timeSec) {
  return new Date(Number(timeSec) * 1000 + BEIJING_OFFSET_SEC * 1000)
}

const pad2 = (n) => String(n).padStart(2, '0')

/** The "MM-DD" key in Beijing time. */
export function monthDayKey(date) {
  return pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate())
}

export function isWeekend(timeSec) {
  const day = beijingDate(timeSec).getUTCDay()
  return day === 0 || day === 6
}

/**
 * Whether this moment is in peak hours. `holidayDates` is a set of "MM-DD"
 * strings (may be empty). Weekends and statutory holidays always return false
 * (off-peak all day).
 */
export function isPeakMoment(timeSec, holidayDates) {
  const sec = Number(timeSec)
  if (!isFinite(sec)) return false
  if (isWeekend(sec)) return false
  const date = beijingDate(sec)
  if (holidayDates && typeof holidayDates.has === 'function' && holidayDates.has(monthDayKey(date))) {
    return false
  }
  const hour = date.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * Parse the annual holiday API payload. Only dates with `holiday === true`
 * (days off) are taken; `holiday === false` marks make-up workdays (weekends),
 * which do not affect the peak/off-peak check and are ignored outright.
 */
export function parseHolidayPayload(payload) {
  const map = payload && payload.holiday
  if (!map || typeof map !== 'object') return []
  const out = []
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || entry.holiday !== true) continue
    const md = typeof entry.date === 'string' && entry.date.length >= 10 ? entry.date.slice(5) : key
    if (/^\d{2}-\d{2}$/.test(md)) out.push(md)
  }
  return Array.from(new Set(out)).sort()
}

/**
 * Holiday calendar: synchronous lookup (for the render path to call at any
 * time) + background refresh (async, silent on failure).
 *
 * @param {object} [options]
 * @param {string} [options.dshHome] cache directory (defaults to $DSH_HOME or ~/.dsh)
 * @param {(m: string, e?: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] easy to inject in tests
 * @param {() => number} [options.now] easy to inject in tests
 */
export function createHolidayStore({ dshHome, log = () => {}, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const DIR = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const remote = new Map() // year -> { dates: string[], fetchedAt: number }
  const lastAttempt = new Map() // year -> ms, only records failure times for backoff
  const diskChecked = new Set()
  let refreshing = null

  const cachePath = (year) => path.join(DIR, `.dshp-holidays-${year}.json`)

  function loadDisk(year) {
    if (remote.has(year) || diskChecked.has(year)) return
    diskChecked.add(year)
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath(year), 'utf8'))
      if (parsed && Array.isArray(parsed.dates) && typeof parsed.fetchedAt === 'number') {
        remote.set(year, {
          dates: parsed.dates.filter((d) => typeof d === 'string' && /^\d{2}-\d{2}$/.test(d)),
          fetchedAt: parsed.fetchedAt,
        })
      }
    } catch { /* no cache or corrupt: use the builtin table */ }
  }

  function datesFor(year) {
    loadDisk(year)
    const cached = remote.get(year)
    if (cached && cached.dates.length) return cached.dates
    if (BUILTIN_HOLIDAYS[year]) return BUILTIN_HOLIDAYS[year]
    return FIXED_FALLBACK
  }

  function holidaySet(timeSec) {
    return new Set(datesFor(beijingDate(timeSec).getUTCFullYear()))
  }

  /** Whether the current moment is in peak hours (synchronous, callable at any time). */
  function isPeak(timeSec) {
    const sec = Math.floor(Number(timeSec))
    if (!isFinite(sec)) return false
    return isPeakMoment(sec, holidaySet(sec))
  }

  function stale(year) {
    const attempted = lastAttempt.get(year)
    if (attempted !== undefined && now() - attempted < FAILURE_RETRY_MS) return false
    loadDisk(year)
    const cached = remote.get(year)
    if (!cached) return true
    const ttl = cached.dates.length ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS
    return now() - cached.fetchedAt > ttl
  }

  /**
   * Background refresh (idempotent, safe to call concurrently). Failures are
   * only logged — the builtin table and the fallback approximation are still
   * there, so the check is not interrupted.
   */
  function refresh(force = false) {
    const today = beijingDate(now() / 1000)
    const year = today.getUTCFullYear()
    const targets = [year]
    // December overlaps with the next year's notice publication window: fetch the
    // following year too, so the days around New Year are not misjudged.
    if (today.getUTCMonth() === 11) targets.push(year + 1)
    const pending = targets.filter((y) => force || stale(y))
    if (!pending.length) return Promise.resolve()
    if (refreshing) return refreshing
    refreshing = (async () => {
      for (const y of pending) {
        try {
          const res = await fetchImpl(SOURCE_URL(y), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          if (!res || !res.ok) {
            lastAttempt.set(y, now())
            log('[pet-holidays]', 'http ' + ((res && res.status) || 'failed'))
            continue
          }
          const dates = parseHolidayPayload(await res.json())
          const at = now()
          remote.set(y, { dates, fetchedAt: at })
          try {
            fs.mkdirSync(DIR, { recursive: true })
            fs.writeFileSync(cachePath(y), JSON.stringify({ year: y, fetchedAt: at, dates }), 'utf8')
          } catch { /* a cache write failure does not affect this check */ }
        } catch (err) {
          lastAttempt.set(y, now())
          log('[pet-holidays]', 'refresh failed: ' + String((err && err.message) || err).slice(0, 120))
        }
      }
    })().finally(() => { refreshing = null })
    return refreshing
  }

  return { datesFor, holidaySet, isPeak, refresh, cachePath }
}
