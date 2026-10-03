/**
 * Shared page-switch-dot hover copy, leave routing, tip layout clamp, and
 * bubble zoom resolution.
 * Web: inlined by scripts/build-client.mjs ahead of client.core.js.
 * Desktop: served at /plugins/dsh-pet-remielle/pet-tip.js.
 *
 * The file is .cjs: the package is "type":"module", so it follows the same
 * loading convention as session-order.cjs.
 */
;(function (global) {
  'use strict'

  function dotTipText(page) {
    return page === 0 ? 'Click to see the balance~' : 'Click to go back to status~'
  }

  function backboardTipText(project, title) {
    var parts = []
    var p = String(project || '').trim()
    var t = String(title || '').trim()
    if (p) parts.push(p)
    if (t && t !== p) parts.push(t)
    if (!parts.length) return 'Click to jump here and take a look~'
    return 'Click to look at ' + parts.join(' · ') + '~'
  }

  // Keeps the backboard's click target and tip text paired, and only commits once
  // the candidate target has settled.
  function createBackboardStabilizer(commit, delay, schedule, cancel) {
    var currentTarget = ''
    var currentTip = ''
    var pendingTarget = ''
    var pendingTip = ''
    var timer = 0
    var commitFn = typeof commit === 'function' ? commit : function () {}
    var scheduleFn = typeof schedule === 'function' ? schedule : function (fn, ms) { return setTimeout(fn, ms) }
    var cancelFn = typeof cancel === 'function' ? cancel : function (id) { clearTimeout(id) }

    function clearTimer() {
      if (!timer) return
      cancelFn(timer)
      timer = 0
    }

    function commitNow(target, tip) {
      clearTimer()
      currentTarget = target
      currentTip = tip
      pendingTarget = ''
      pendingTip = ''
      commitFn(target, tip)
    }

    function update(target, tip) {
      target = String(target || '')
      tip = String(tip || '')
      if (!target) {
        commitNow('', '')
        return
      }
      if (target === currentTarget && tip === currentTip) {
        pendingTarget = ''
        pendingTip = ''
        clearTimer()
        return
      }
      if (!currentTarget) {
        commitNow(target, tip)
        return
      }
      pendingTarget = target
      pendingTip = tip
      clearTimer()
      timer = scheduleFn(function () {
        timer = 0
        commitNow(pendingTarget, pendingTip)
      }, delay)
    }

    return {
      update: update,
      target: function () { return currentTarget },
      tip: function () { return currentTip },
    }
  }

  function openIdleDshPage(bridge) {
    if (!bridge || typeof bridge.openDshPage !== 'function') return false
    bridge.openDshPage()
    return true
  }

  // ---- Bubble zoom rules (shared by the web and desktop clients so the two
  // ends cannot drift apart) ----
  // Sync mode (bubbleScaleSync !== false): bubble zoom = pet scale × relative ratio;
  // fixed mode (bubbleScaleSync === false): bubble zoom = a fixed size factor.
  // A missing field falls back to the old rule (zoom = scale), which matches the
  // behavior of 0.3.6 and earlier.
  var BUBBLE_ZOOM_MIN = 0.3
  var BUBBLE_ZOOM_MAX = 3

  function clampZoom(value) {
    if (!isFinite(value) || value <= 0) return 1
    // Round to 4 decimals: scale/ratio step by 0.05, so the product has at most 4
    // decimals, and this also wipes out float noise like 1.5×0.8=1.2000000000000002.
    var clamped = Math.min(BUBBLE_ZOOM_MAX, Math.max(BUBBLE_ZOOM_MIN, value))
    return Math.round(clamped * 1e4) / 1e4
  }

  function bubbleZoomOf(snapshot) {
    if (!snapshot) return 1
    var scale = Number(snapshot.scale)
    if (!isFinite(scale) || scale <= 0) scale = 1
    if (snapshot.bubbleScaleSync === false) {
      var fixed = Number(snapshot.bubbleFixedSize)
      return clampZoom(isFinite(fixed) && fixed > 0 ? fixed : 1)
    }
    var ratio = Number(snapshot.bubbleScaleRatio)
    return clampZoom(scale * (isFinite(ratio) && ratio > 0 ? ratio : 1))
  }

  function applyDotTip(dot, page, anchor, show) {
    if (!dot || !dot.dataset) return
    dot.dataset.rm2Tip = dotTipText(page)
    dot.title = ''
    if (anchor === dot && typeof show === 'function') show(dot)
  }

  function onDotLeave(e, dot, dots, show, hide) {
    var related = e && e.relatedTarget
    if (related === dot || related === dots) return
    var host = dots && dots.parentNode
    if (related && host && host.dataset && host.dataset.rm2Tip && typeof host.contains === 'function' && host.contains(related)) {
      if (typeof show === 'function') show(host)
      return
    }
    if (typeof hide === 'function') hide()
  }

  // Measure the natural width on one line first, and wrap only when it exceeds the
  // visible maxW; copy that carries its own newlines (a full approval request) wraps directly.
  function fitTipWrap(petTip, maxW) {
    if (!petTip || !petTip.style) return
    var text = String(petTip.textContent || '')
    if (text.indexOf('\n') !== -1) {
      petTip.style.whiteSpace = 'pre-wrap'
      petTip.style.wordBreak = 'break-all'
      return
    }
    petTip.style.whiteSpace = 'nowrap'
    petTip.style.wordBreak = 'normal'
    petTip.style.maxWidth = 'none'
    if (petTip.offsetWidth > maxW) {
      petTip.style.whiteSpace = 'pre-wrap'
      petTip.style.wordBreak = 'break-all'
    }
  }

  // The web and desktop clients share one clamp: lay the box out at its natural
  // width inside the visible area, then clamp the box into the halo (it may be
  // biased toward the roomier side). The desktop showPetTip tightens L/T/R/B
  // against getWorkArea after the first frame, and still goes through this algorithm.
  function layoutPetTip(petTip, anchor, L, T, R, B) {
    if (!petTip || !anchor) return
    var pad = 24
    var gap = 6
    var win = typeof window !== 'undefined' ? window : null
    var W = (win && win.innerWidth) || 1280
    var H = (win && win.innerHeight) || 800
    var visL = Math.max(0, L)
    var visT = Math.max(0, T)
    var visR = Math.min(W, R)
    var visB = Math.min(H, B)
    if (visR - visL < 80) { visL = 0; visR = W }
    if (visB - visT < 40) { visT = 0; visB = H }
    var r = anchor.getBoundingClientRect()
    var cx = r.left + r.width / 2
    var visW = visR - visL - pad * 2
    var maxW = Math.min(420, Math.max(80, visW))
    fitTipWrap(petTip, maxW)
    petTip.style.maxWidth = maxW + 'px'
    var tw = petTip.offsetWidth
    var th = petTip.offsetHeight
    var minL = visL + pad
    var maxL = visR - tw - pad
    var left = cx - tw / 2
    if (maxL < minL) left = visL + Math.max(0, (visR - visL - tw) / 2)
    else left = Math.min(Math.max(minL, left), maxL)
    var minT = visT + pad
    var maxT = visB - th - pad
    var above = r.top - th - gap
    var below = r.bottom + gap
    var top
    if (above >= minT) top = above
    else if (below + th <= visB - pad) top = below
    else if (maxT >= minT) top = Math.min(Math.max(minT, above), maxT)
    else top = visT + Math.max(0, (visB - visT - th) / 2)
    petTip.style.left = left + 'px'
    petTip.style.top = top + 'px'
  }

  global.__rm2PetTip = {
    dotTipText: dotTipText,
    backboardTipText: backboardTipText,
    createBackboardStabilizer: createBackboardStabilizer,
    openIdleDshPage: openIdleDshPage,
    bubbleZoomOf: bubbleZoomOf,
    applyDotTip: applyDotTip,
    onDotLeave: onDotLeave,
    layoutPetTip: layoutPetTip,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2PetTip
  }
})(typeof window !== 'undefined' ? window : globalThis)
