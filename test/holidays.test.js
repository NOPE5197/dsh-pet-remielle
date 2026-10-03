/**
 * Holiday calendar and peak/off-peak determination (issue #25).
 *
 * Official rules (statement of 2026-09-19): weekday peak hours are 9:00–12:00
 * and 14:00–18:00 (Beijing time); Saturday and Sunday are off-peak all day
 * (since 2026-08-23); statutory holidays are off-peak all day; weekends worked
 * as make-up workdays are off-peak all day too. So the check is
 * = weekend ∪ statutory holiday → off-peak, otherwise by hour.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_HOLIDAYS,
  FIXED_FALLBACK,
  beijingDate,
  monthDayKey,
  isWeekend,
  isPeakMoment,
  parseHolidayPayload,
  createHolidayStore,
} from '../src/holidays.js'

/** Epoch seconds for a given hour and minute on a given Beijing-time day. */
function bj(y, m, d, h = 0, min = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, h - 8, min) / 1000)
}

const NO_HOLIDAYS = new Set()

test('workday peak hours are 9-12 and 14-18 Beijing time', () => {
  // 2026-09-21 is a Monday and is not in the builtin holiday table.
  const cases = [
    [8, 59, false], [9, 0, true], [11, 59, true], [12, 0, false],
    [13, 59, false], [14, 0, true], [17, 59, true], [18, 0, false], [23, 0, false],
  ]
  for (const [h, m, expected] of cases) {
    assert.equal(isPeakMoment(bj(2026, 9, 21, h, m), NO_HOLIDAYS), expected, `${h}:${m} should ${expected ? '' : 'not '}be peak`)
  }
})

test('weekends are off-peak all day (including adjusted workday weekends)', () => {
  // 2026-09-19 is a Saturday; 2026-09-20 is a Sunday and a "make-up workday
  // before Mid-Autumn" — the official rules explicitly keep such weekend
  // make-up workdays off-peak.
  for (const day of [19, 20]) {
    for (const h of [9, 10, 15, 17]) {
      assert.equal(isPeakMoment(bj(2026, 9, day, h), new Set(BUILTIN_HOLIDAYS[2026])), false, `9/${day} ${h}:00 should be off-peak`)
    }
  }
})

test('legal holidays are off-peak on weekdays too', () => {
  const holidays = new Set(BUILTIN_HOLIDAYS[2026])
  // 2026-10-01 is a Thursday in the National Day holiday → off-peak.
  assert.equal(isPeakMoment(bj(2026, 10, 1, 10), holidays), false)
  assert.equal(isPeakMoment(bj(2026, 10, 1, 15), holidays), false)
  // Mid-Autumn 2026-09-25 Friday → off-peak; 09-28 Monday after the holiday →
  // peak.
  assert.equal(isPeakMoment(bj(2026, 9, 25, 10), holidays), false)
  assert.equal(isPeakMoment(bj(2026, 9, 28, 10), holidays), true)
  // Christmas Eve (a weekday, not a holiday) is still peak by the hour rules.
  assert.equal(isPeakMoment(bj(2026, 12, 24, 10), holidays), true)
})

test('the builtin fallback table is not silently corrupted', () => {
  // This is not a tautology of "data == data": that table in the source is a
  // **hand-copied** State Council holiday arrangement, and copying one date wrong
  // makes nothing error — it just silently misjudges that day's peak/off-peak
  // pricing.
  // The holiday data for the next year can only be filled in after the official
  // publication each November, so only the least omittable days of each year are
  // pinned here (New Year's Day / Labour Day / National Day) rather than an
  // exhaustive list — exhaustiveness would force the test to change on every
  // table update.
  for (const year of [2025, 2026]) {
    const set = new Set(BUILTIN_HOLIDAYS[year])
    for (const md of ['01-01', '05-01', '10-01', '10-02']) {
      assert.ok(set.has(md), `${year} should contain ${md}`)
    }
  }
  const y2026 = new Set(BUILTIN_HOLIDAYS[2026])
  for (const md of ['02-17', '04-05', '06-20', '09-26', '10-07']) assert.ok(y2026.has(md), `2026 should contain ${md}`)
  const y2025 = new Set(BUILTIN_HOLIDAYS[2025])
  for (const md of ['01-28', '05-31', '10-08']) assert.ok(y2025.has(md), `2025 should contain ${md}`)
})

test('beijing wall-clock helpers are UTC+8 based', () => {
  const d = beijingDate(bj(2026, 9, 21, 0, 30))
  assert.equal(monthDayKey(d), '09-21')
  assert.equal(d.getUTCHours(), 0)
  assert.equal(isWeekend(bj(2026, 9, 19, 12)), true)
  assert.equal(isWeekend(bj(2026, 9, 21, 12)), false)
  // Monday 00:30 Beijing time is still Sunday 16:30 in UTC; the check must be
  // based on Beijing time.
  assert.equal(isWeekend(bj(2026, 9, 21, 0, 30)), false)
})

test('parseHolidayPayload keeps days off and ignores adjusted workdays', () => {
  // The `name` fields stay in the source language on purpose: this payload mirrors
  // a real response from the public Chinese holiday API, and the parser never
  // reads them (only `holiday` and `date`).
  const payload = {
    code: 0,
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
      '01-04': { holiday: false, name: '元旦后补班', date: '2026-01-04' },
      '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
      '10-10': { holiday: false, name: '国庆节后补班', date: '2026-10-10' },
    },
  }
  assert.deepEqual(parseHolidayPayload(payload), ['01-01', '10-01'])
  assert.deepEqual(parseHolidayPayload(null), [])
  assert.deepEqual(parseHolidayPayload({ holiday: {} }), [])
  // With the date field missing it falls back to the key name
  assert.deepEqual(parseHolidayPayload({ holiday: { '05-01': { holiday: true } } }), ['05-01'])
})

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'pet-holidays-test-'))
}

test('store falls back to the builtin table for known years', () => {
  const home = tempHome()
  try {
    const store = createHolidayStore({ dshHome: home, now: () => bj(2026, 9, 21, 10) * 1000 })
    assert.deepEqual(store.datesFor(2026), BUILTIN_HOLIDAYS[2026])
    // 2026-10-01 Thursday 10:00 → off-peak
    assert.equal(store.isPeak(bj(2026, 10, 1, 10)), false)
    // 2026-09-21 Monday 10:00 → peak
    assert.equal(store.isPeak(bj(2026, 9, 21, 10)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store uses the fixed-date fallback for years without data', () => {
  const home = tempHome()
  try {
    const store = createHolidayStore({ dshHome: home, now: () => bj(2099, 6, 1, 10) * 1000 })
    assert.deepEqual(store.datesFor(2099), FIXED_FALLBACK)
    // 2099-10-01 is a Thursday: covered by the fallback table → off-peak; lunar
    // holidays such as Spring Festival cannot be derived → by the hour rules.
    assert.equal(store.isPeak(bj(2099, 10, 1, 10)), false)
    assert.equal(store.isPeak(bj(2099, 6, 1, 10)), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store refreshes from remote, caches to disk and respects TTL', async () => {
  const home = tempHome()
  try {
    // The cache directory may not exist yet and the write must still succeed (first
    // use / a custom DSH_HOME in real life)
    const cacheHome = join(home, 'not-yet-created')
    const fixedNow = bj(2099, 3, 10, 10) * 1000
    let calls = 0
    const fetchImpl = async (url) => {
      calls += 1
      assert.match(String(url), /\/holiday\/year\/2099$/)
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, holiday: { '03-08': { holiday: true, date: '2099-03-08' }, '03-09': { holiday: false, date: '2099-03-09' } } }),
      }
    }
    const store = createHolidayStore({ dshHome: cacheHome, fetchImpl, now: () => fixedNow })
    await store.refresh()
    assert.equal(calls, 1)
    assert.deepEqual(store.datesFor(2099), ['03-08'])
    const cacheFile = join(cacheHome, '.dshp-holidays-2099.json')
    assert.ok(existsSync(cacheFile), 'cache file should be written')
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')).dates, ['03-08'])
    // No repeated request inside the TTL
    await store.refresh()
    assert.equal(calls, 1)
    // A fresh instance recovers from the on-disk cache
    const store2 = createHolidayStore({ dshHome: cacheHome, fetchImpl: async () => { throw new Error('must not fetch') }, now: () => fixedNow })
    assert.deepEqual(store2.datesFor(2099), ['03-08'])
    // A forced refresh after expiry issues a new request
    await store.refresh(true)
    assert.equal(calls, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('store stays usable when the remote refresh fails', async () => {
  const home = tempHome()
  try {
    const logs = []
    let calls = 0
    let clock = bj(2026, 9, 21, 10) * 1000
    const store = createHolidayStore({
      dshHome: home,
      fetchImpl: async () => { calls += 1; throw new Error('offline') },
      now: () => clock,
      log: (tag, msg) => logs.push(`${tag} ${msg}`),
    })
    await store.refresh()
    assert.equal(calls, 1)
    assert.ok(logs.length >= 1, 'failure should be logged')
    // Failure backoff: the balance refreshes every 25 seconds, so it must not retry
    // and flood the log within 10 minutes
    clock += 25000
    await store.refresh()
    assert.equal(calls, 1, 'a failed refresh should back off')
    clock += 10 * 60 * 1000
    await store.refresh()
    assert.equal(calls, 2, 'the backoff should expire')
    assert.deepEqual(store.datesFor(2026), BUILTIN_HOLIDAYS[2026])
    // An empty result (the year is not published yet) must also be written to
    // disk silently and keep using the fallback table for the check
    const empty = createHolidayStore({ dshHome: home, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0, holiday: {} }) }), now: () => bj(2099, 3, 10, 10) * 1000 })
    await empty.refresh()
    assert.deepEqual(empty.datesFor(2099), FIXED_FALLBACK)
    writeFileSync(join(home, '.dshp-holidays-2099.json'), JSON.stringify({ year: 2099, fetchedAt: 0, dates: [] }), 'utf8')
    assert.deepEqual(createHolidayStore({ dshHome: home, now: () => 0 }).datesFor(2099), FIXED_FALLBACK)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
