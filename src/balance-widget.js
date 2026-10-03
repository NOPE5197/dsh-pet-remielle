/**
 * dsh-pet-remielle balance controller (client side).
 *
 * This controller owns NO DOM. It fetches the balance, keeps the
 * rolling-number animation, then emits "display frames" that the pet's
 * OWN status bubble renders.
 *
 * Emitted frames (via subscribe):
 *   { kind: 'status' }                         -> show the pet's session status
 *   { kind: 'balance', label, amount, detail, period, color } -> balance + time period
 *
 * Interactions:
 *   - 60s auto-refresh (silent; the balance number rolls if it changes while
 *     the balance view is open)
 *   - showBalance / showStatus: page-based navigation (dot / wheel); stays
 *     on the current page until the user switches
 */

;(function () {
  'use strict'
  if (window.__petBalance) return

  var BALANCE_URL = '/plugins/dsh-pet-remielle/balance'
  var REFRESH_MS = 60000
  var ANIM_MS = 700
  var FETCH_TIMEOUT_MS = 25000

  var usageMode = 'ledger'
  var state = { balance: null, currency: 'CNY', todayUsage: null, isPeak: false, status: 'loading', message: '' }
  var shown = null
  var busy = false
  var animId = null
  var mode = 'status' // 'status' | 'balance' | 'random'
  var pollTimer = null
  var polling = true
  var listeners = []

  // ---- helpers ----
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function fmt(balance, currency) {
    // An unknown balance shows as "--"; never render a null / not-fetched value as
    // ¥0.00 (amounts are sensitive — it would read as "the balance is spent").
    if (balance === null || balance === undefined || !isFinite(Number(balance))) return '--'
    var num = Number(balance)
    var fixed = num.toFixed(2)
    currency = currency || 'CNY'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }

  function emit(frame) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](frame) } catch (e) { /* ignore */ }
    }
  }

  function periodText() {
    return state.isPeak ? 'Peak hours' : 'Off-peak hours'
  }
  function periodColor() {
    return state.isPeak ? '#e0433f' : '#2fa24c'
  }

  function emitBalance(amount) {
    var used = state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--'
    var detail = "Today's usage " + used
    var period = periodText()
    var color = periodColor()
    // Stay observable on failure: replace the period with "fetch failed" instead of
    // splicing the error message into detail as well (the client appends " · period"
    // a second time, so it would show up duplicated).
    if (state.status === 'error' && state.message) {
      period = 'Fetch failed'
      color = '#c0392b'
    }
    emit({
      kind: 'balance',
      label: 'DeepSeek balance',
      amount: amount !== undefined ? fmt(amount, state.currency) : fmt(shown, state.currency),
      detail: detail,
      period: period,
      color: color,
    })
  }

  // ---- rolling number animation: emits one frame per animation step ----
  function animateAmount(from, to, currency) {
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      emitBalance(to)
      return
    }
    var startTime = null
    function step(ts) {
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / ANIM_MS)
      var eased = 1 - Math.pow(1 - t, 3)
      var val = from + (to - from) * eased
      emitBalance(val)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        emitBalance(to)
      }
    }
    animId = requestAnimationFrame(step)
  }

  // ---- refresh ----
  function refresh(manual) {
    if (busy) return
    busy = true
    if (manual || state.balance === null) state.status = 'loading'
    var ctrl = null
    var timer = null
    try {
      ctrl = new AbortController()
      timer = setTimeout(function () { try { ctrl.abort() } catch (e) {} }, FETCH_TIMEOUT_MS)
    } catch (e) {}
    fetch(BALANCE_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (data && data.ok) {
          var nb = Number(data.totalBalance)
          var nc = String(data.currency || 'CNY')
          var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
          state.balance = nb
          state.currency = nc
          state.message = ''
          state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
          state.isPeak = !!data.isPeak
          state.status = 'ok'
          if (changed && (manual || mode !== 'status')) {
            animateAmount(shown, nb, nc)
          } else if (changed) {
            shown = nb
          } else if (shown === null || !isFinite(shown)) {
            shown = nb
          }
          if (mode === 'balance') emitBalance(shown)
        } else {
          state.status = 'error'
          state.message = (data && data.error) ? String(data.error) : 'Fetch failed'
          if (mode === 'balance') emitBalance(shown)
        }
      })
      .catch(function () {
        state.status = 'error'
        state.message = 'Fetch failed'
        if (mode === 'balance') emitBalance(shown)
      })
      .finally(function () {
        busy = false
        if (timer) clearTimeout(timer)
      })
  }

  // ---- public API ----
  window.__petBalance = {
    init: function (modeArg) {
      usageMode = modeArg === 'token' ? 'token' : 'ledger'
      refresh(false)
    },
    setUsageMode: function (m) {
      var next = m === 'token' ? 'token' : 'ledger'
      if (next === usageMode) return
      usageMode = next
      refresh(false)
    },
    /** Stop the 60s polling while the usage sub-switch is off, resume when it comes back on (fetch once right away). */
    setEnabled: function (on) {
      var next = on === true
      if (next === polling) return
      polling = next
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      if (polling) {
        refresh(false)
        pollTimer = setInterval(function () { refresh(false) }, REFRESH_MS)
      }
    },
    /** Switch to balance mode for page-based navigation. */
    showBalance: function () {
      mode = 'balance'
      emitBalance(shown)
      refresh(false)
    },
    /** Switch back to status mode. */
    showStatus: function () {
      mode = 'status'
      emit({ kind: 'status' })
    },
    subscribe: function (cb) {
      listeners.push(cb)
      return function () {
        var i = listeners.indexOf(cb)
        if (i !== -1) listeners.splice(i, 1)
      }
    },
    fmt: fmt,
  }

  pollTimer = setInterval(function () { refresh(false) }, REFRESH_MS)
})()
