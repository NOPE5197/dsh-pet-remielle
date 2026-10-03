window.__ModuleLoader__.load({ id: "dsh-pet-remielle", factory: (require) => {
const module = { exports: {} }
const exports = module.exports
const RM_PLUGIN_VERSION = "0.4.5"
/**
 * Shared bubble-deck ordering used by both the desktop floating window
 * (src/pet-view.html, served by the host at /plugins/dsh-pet-remielle/session-order.js)
 * and the web client (src/client.core.js, inlined by scripts/build-client.mjs).
 *
 * The file uses .cjs: the package is "type":"module", so host ESM can only get
 * the exports through createRequire. The public URL is still session-order.js
 * (a browser script does not understand .cjs extension semantics).
 *
 * Priority: approval > plan review > ask (ask_user_question) > completion > attention
 * > current session > state rank > updatedAt.
 */
;(function (global) {
  'use strict'

  function stateRank(state) {
    switch (state) {
      case 'WAITING': return 60
      case 'ERROR': return 50
      case 'SUCCESS': return 70
      case 'WORKING': return 30
      case 'THINKING': return 20
      case 'DISCONNECTED': return -1
      default: return 0
    }
  }
  function attentionOf(entry) {
    return entry.attention === true || entry.state === 'WAITING' || entry.state === 'ERROR'
  }
  function completionOf(entry) {
    return entry.completionNotification === true
  }
  function targetSessionOf(entry) {
    return entry.targetSessionId || entry.sessionId
  }
  function approvalOf(entry) {
    return entry.approval === true
  }
  function planReviewOf(entry) {
    return entry.planReview === true
  }
  function askOf(entry) {
    return entry.ask === true
  }
  function tierOf(entry) {
    if (approvalOf(entry)) return 6
    if (planReviewOf(entry)) return 5
    if (askOf(entry)) return 4
    if (completionOf(entry)) return 3
    if (attentionOf(entry)) return 2
    return 0
  }
  // Hysteresis for the top 2: when two sessions are completely equal in rank
  // (tier/current/stateRank all the same), the top two must not swap places just
  // because of updatedAt (every streaming chunk refreshes it) — the stacked-card
  // width is decided by the topmost card, so otherwise the box width would jitter
  // at high frequency between the two sessions.
  // Remember the previous top-two id sequence; if this pure sort happens to
  // produce exactly the reverse order, swap it back.
  // Tier changes such as approval / answer / completion / attention are
  // unaffected and move up as usual.
  var lastTopIds = []
  // Pure comparison, no hysteresis: shared by the host's states()/snapshot and
  // the client's orderSessions so there is only one set of priorities.
  function compareSessions(a, b, currentSessionId) {
    var aTier = tierOf(a)
    var bTier = tierOf(b)
    if (aTier !== bTier) return bTier - aTier
    var aCur = a.sessionId === currentSessionId ? 1 : 0
    var bCur = b.sessionId === currentSessionId ? 1 : 0
    if (aCur !== bCur) return bCur - aCur
    var priority = stateRank(b.state) - stateRank(a.state)
    return priority || (b.updatedAt || 0) - (a.updatedAt || 0)
  }
  function orderSessions(sessions, currentSessionId) {
    var ranked = sessions.slice().sort(function (a, b) {
      return compareSessions(a, b, currentSessionId)
    })
    if (lastTopIds.length === 2 && ranked.length >= 2) {
      var first = ranked[0]
      var second = ranked[1]
      if (String(targetSessionOf(second) || '') === lastTopIds[0]
        && String(targetSessionOf(first) || '') === lastTopIds[1]
        && sameRankKey(first, second, currentSessionId)) {
        ranked[0] = second
        ranked[1] = first
      }
    }
    lastTopIds = [
      ranked.length > 0 ? String(targetSessionOf(ranked[0]) || '') : '',
      ranked.length > 1 ? String(targetSessionOf(ranked[1]) || '') : '',
    ]
    return ranked
  }
  function sameRankKey(a, b, currentSessionId) {
    return tierOf(a) === tierOf(b)
      && (a.sessionId === currentSessionId ? 1 : 0) === (b.sessionId === currentSessionId ? 1 : 0)
      && stateRank(a.state) === stateRank(b.state)
  }

  // Web/desktop destructure attentionOf and friends; compareSessions is reused by
  // host ESM through CJS. stateRank/askOf/tierOf remain internal only.
  global.__rm2SessionOrder = {
    attentionOf: attentionOf,
    completionOf: completionOf,
    targetSessionOf: targetSessionOf,
    approvalOf: approvalOf,
    planReviewOf: planReviewOf,
    orderSessions: orderSessions,
    compareSessions: compareSessions,
  }
  // There is a window in a browser script / build concatenation, so module.exports
  // must not be written, or it would overwrite the client bundle's
  // module.exports. A Node require has no window and can be treated as a CJS export.
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2SessionOrder
  }
})(typeof window !== 'undefined' ? window : globalThis)

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

/**
 * Get "the frame an animated GIF is showing right now" — the right-click menu's
 * "Pause animation" uses it to freeze the pet in the pose it had at the moment
 * you clicked, instead of always snapping back to the first frame.
 *
 * Why this file is needed: Chromium's canvas.drawImage(<img src=animated gif>)
 * always paints only the first frame. Locally measured (vendor/electron-win32-x64,
 * a 360x360 / 120-frame 06.gif sticker): 20 samples spanning 462ms and covering
 * 7 full loops had pixel signatures that were all identical, and equal to frame 0
 * of ImageDecoder. The old implementation made the pet jump instantly back to its
 * starting pose after pausing, for exactly this reason.
 *
 * The fix goes through WebCodecs' ImageDecoder: read every frame's duration →
 * locate the frame index by "elapsed milliseconds played" → decode that frame on
 * demand (disposal / partial frames are composited by the browser, so the result
 * matches what is on screen) → draw it to a static PNG. It requires a secure
 * context: 127.0.0.1, localhost and https all count, a plain http LAN address does
 * not. When unavailable, freeze() returns null and the caller falls back to a
 * first-frame snapshot (the old behaviour) — the pause switch itself still works,
 * only the frozen pose is imprecise.
 *
 * The file uses .cjs: the package is "type":"module", so host ESM can only get
 * the exports through createRequire. The public URL is still gif-frame.js (a
 * browser script does not understand .cjs extension semantics); the web client
 * inlines it straight into lib/client.js via scripts/build-client.mjs.
 */
;(function (global) {
  'use strict'

  /** Sum of frame durations (milliseconds). Invalid / non-positive durations count as 0. */
  function totalDuration(durations) {
    var total = 0
    if (!durations) return 0
    for (var i = 0; i < durations.length; i++) {
      var d = Number(durations[i])
      if (isFinite(d) && d > 0) total += d
    }
    return total
  }

  /**
   * Which frame the GIF is showing after `elapsed` milliseconds have played.
   * elapsed may be arbitrarily large or negative: it is taken modulo the full
   * loop duration (GIFs loop). Returns 0 when no frame can be determined.
   */
  function indexAt(durations, elapsed) {
    var n = durations ? durations.length : 0
    if (!n) return 0
    var total = totalDuration(durations)
    if (!(total > 0)) return 0
    var t = Number(elapsed)
    if (!isFinite(t)) t = 0
    t = t % total
    if (t < 0) t += total
    var acc = 0
    for (var i = 0; i < n; i++) {
      var d = Number(durations[i])
      if (!isFinite(d) || d <= 0) continue
      acc += d
      if (t < acc) return i
    }
    return n - 1
  }

  /** Only GIFs take the decode-to-get-a-frame path; PNG stickers (drawing) are handed to the caller's first-frame snapshot fallback as-is. */
  function isGif(url) {
    return /\.gif(?:[?#]|$)/i.test(String(url || ''))
  }

  function now() {
    if (global.performance && typeof global.performance.now === 'function') return global.performance.now()
    return Date.now()
  }

  /** ImageDecoder needs a secure context; if anything is missing the whole chain yields to the first-frame fallback. */
  function supported() {
    return typeof global.ImageDecoder === 'function'
      && typeof global.fetch === 'function'
      && !!global.document
  }

  /**
   * Attach an animation start clock to an <img>: GIF playback progress starts
   * counting at "the first frame finished decoding and was painted", and the load
   * event lands just after that moment (these stickers run at 30ms per frame, so
   * the error is ≤ 1 frame), so the load moment is used directly as 0. Every src
   * change restarts the clock.
   */
  function watch(img) {
    if (!img || img.__rm2GifWatch || typeof img.addEventListener !== 'function') return
    img.__rm2GifWatch = true
    img.__rm2GifStart = 0
    img.addEventListener('load', function () {
      img.__rm2GifStart = now()
    })
  }

  /** How long the image currently on that <img> has been playing (milliseconds). Never started returns 0, which equals the first frame. */
  function livedMs(img) {
    var t0 = img && img.__rm2GifStart
    if (!t0) return 0
    return Math.max(0, now() - t0)
  }

  var entries = new Map() // url -> { bytes, promise }
  var MAX_ENTRIES = 3 // a sticker is 0.5–2.5MB on its own, keep only the few most recently used

  function trim() {
    while (entries.size > MAX_ENTRIES) {
      var oldest = entries.keys().next()
      if (oldest.done) return
      entries.delete(oldest.value)
    }
  }

  function fetchBytes(url) {
    return global.fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.arrayBuffer()
    })
  }

  /** Decode one by one to read the durations: only the numbers are needed, so one frame is decoded and closed at a time without keeping a VideoFrame resident. */
  function readDurations(buf) {
    var dec = new global.ImageDecoder({ data: buf, type: 'image/gif' })
    return dec.completed
      .then(function () { return dec.tracks.ready })
      .then(function () {
        var track = dec.tracks.selectedTrack
        var n = (track && track.frameCount) || 0
        var durations = []
        var chain = Promise.resolve()
        for (var i = 0; i < n; i++) chain = stepDuration(chain, dec, durations, i)
        return chain.then(function () {
          try { dec.close() } catch (e) { /* already closed */ }
          if (!durations.length) return null
          return {
            durations: durations,
            total: totalDuration(durations),
            width: (track && track.codedWidth) || 0,
            height: (track && track.codedHeight) || 0,
          }
        })
      })
  }

  function stepDuration(chain, dec, out, index) {
    return chain.then(function () {
      return dec.decode({ frameIndex: index }).then(function (res) {
        out.push(res.image.duration / 1000) // microseconds -> milliseconds
        res.image.close()
      })
    })
  }

  /**
   * The frame table (with a byte cache): warm() can be called while the menu is
   * hovered, hiding the few hundred milliseconds of frame-table decoding inside
   * the time it takes the user to move onto the menu item, so clicking freezes
   * almost instantly.
   * Failures are also cached as null, so every pause does not rerun the decoding.
   */
  function timeline(url) {
    if (!supported() || !isGif(url)) return Promise.resolve(null)
    var hit = entries.get(url)
    if (hit) return hit.promise
    var entry = { bytes: null, promise: null }
    entry.promise = fetchBytes(url).then(function (buf) {
      entry.bytes = buf
      return readDurations(buf)
    }).catch(function () { return null })
    entries.set(url, entry)
    trim()
    return entry.promise
  }

  function warm(url) {
    return timeline(url).catch(function () { return null })
  }

  /** Decode the given frame and turn it into a PNG data URL (the size comes from the GIF logical screen so partial frames are not shrunk). */
  function frameDataUrl(url, index, size) {
    var entry = entries.get(url)
    var bytes = entry && entry.bytes
      ? Promise.resolve(entry.bytes)
      : fetchBytes(url).then(function (buf) {
        if (entry) entry.bytes = buf
        return buf
      })
    return bytes.then(function (buf) {
      var dec = new global.ImageDecoder({ data: buf, type: 'image/gif' })
      return dec.completed
        .then(function () { return dec.decode({ frameIndex: index }) })
        .then(function (res) {
          var frame = res.image
          var w = (size && size.width) || frame.displayWidth
          var h = (size && size.height) || frame.displayHeight
          var canvas = global.document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          var g = canvas.getContext('2d')
          g.drawImage(frame, 0, 0, w, h)
          var dataUrl = canvas.toDataURL('image/png')
          frame.close()
          try { dec.close() } catch (e) { /* already closed */ }
          return dataUrl
        })
    }).catch(function () { return null })
  }

  /**
   * Freeze entry point: url is the animated GIF address and elapsedMs is how long
   * it had already played at the moment pause was clicked.
   * Returns a PNG data URL; returns null if anything in the chain is unavailable
   * (insecure context, not a GIF, frame fetch failure).
   */
  function freeze(url, elapsedMs) {
    if (!supported() || !isGif(url)) return Promise.resolve(null)
    return timeline(url).then(function (info) {
      if (!info) return null
      return frameDataUrl(url, indexAt(info.durations, elapsedMs), info)
    }).catch(function () { return null })
  }

  var api = {
    supported: supported,
    isGif: isGif,
    indexAt: indexAt,
    totalDuration: totalDuration,
    watch: watch,
    livedMs: livedMs,
    warm: warm,
    timeline: timeline,
    freeze: freeze,
  }

  global.__rm2GifFrame = api
  // There is a window in a browser script / build concatenation, so module.exports
  // must not be written, or it would overwrite the client bundle's
  // module.exports. A Node require has no window and can be treated as a CJS export.
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = api
  }
})(typeof window !== 'undefined' ? window : globalThis)

/**
 * Shared presentation layer for bubble session cards: title throttling, text
 * width measurement, and the copy, class names and card-deck layout for the three
 * states — approval / plan review / completion. The web and desktop clients share
 * one implementation: any change to this copy has to land on both ends at once,
 * which is exactly how the "plan review" tip drifted once (it repeated the
 * project name).
 * Web: inlined by scripts/build-client.mjs ahead of client.core.js.
 * Desktop: served at /plugins/dsh-pet-remielle/bubble-title.js.
 *
 * The file is .cjs: the package is "type":"module", so it follows the same
 * loading convention as pet-tip.cjs.
 */
;(function (global) {
  'use strict'

  // Bubble first line: with the same sticker it changes at most every 2s (locked in
  // 0.3.1 to stop think/work copy flipping on every chunk).
  var BUBBLE_TITLE_MS = 2000
  // Bubble box minimum width: absorbs the width swings a title has at common
  // lengths, so the box does not jitter constantly.
  var BUBBLE_MIN_W = 277
  // How far the second deck layer (the fake backboard) is lifted: card height 91px
  // (hard-coded in CSS) − 80px = 11px showing; in sync-scale mode the stack's zoom
  // = character size, so the 75% notch shows about 8px.
  var STACK_LIFT_PX = 80
  var PLAN_MARKER = 'Plan review'

  // Hidden measuring node: copies the real rendering font to measure text width
  // precisely, so max-content cannot stretch the box.
  // Lazily created at module level, so mountPet can mount many times without ever
  // appending a second node to body.
  var __petMeasureEl = null
  function ensureMeasureEl() {
    if (!__petMeasureEl) {
      __petMeasureEl = document.createElement('span')
      __petMeasureEl.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;'
    }
    // Mounting and creation are checked separately. The old implementation appended
    // unconditionally whenever !__petMeasureEl, so a missing body threw loudly;
    // after switching to `if (document.body)` that skip becomes permanent—the
    // element is already cached and mounting is never retried, so offsetWidth in
    // measureTextW is always 0, every card width silently collapses to BUBBLE_MIN_W,
    // and nothing errors. Re-mounting by parentNode instead: still no throw when
    // body is missing, but it attaches as soon as body shows up. parentNode rather
    // than isConnected is used because the test DOM stub has no isConnected.
    if (document.body && __petMeasureEl.parentNode !== document.body) document.body.appendChild(__petMeasureEl)
    return __petMeasureEl
  }

  function measureTextW(srcEl, text) {
    var el = ensureMeasureEl()
    if (window.getComputedStyle && srcEl) {
      var cs = window.getComputedStyle(srcEl)
      el.style.fontFamily = cs.fontFamily
      el.style.fontSize = cs.fontSize
      el.style.fontWeight = cs.fontWeight
      el.style.letterSpacing = cs.letterSpacing
    }
    el.textContent = text || ''
    return el.offsetWidth || 0
  }

  // Both boxes (the stacked conversation card / the balance bubble) share one width
  // rule: take the "widest line" + padding, with a BUBBLE_MIN_W floor and a
  // min(440, viewport-24) ceiling. Returns the total width including padding.
  function bubbleRowWidth(textW) {
    var win = typeof window !== 'undefined' ? window : null
    var vw = Math.max(150, ((win && win.innerWidth) || 1280) - 24)
    return Math.min(440, vw, Math.max(BUBBLE_MIN_W, textW + 67))
  }

  function clearBubbleTitleTimer(el) {
    if (el && el.titleTimer) {
      window.clearTimeout(el.titleTimer)
      el.titleTimer = 0
    }
  }

  function commitBubbleTitle(el, text, mood) {
    clearBubbleTitleTimer(el)
    el.titleMood = mood
    el.titleChangedAt = Date.now()
    el.pendingTitle = ''
    el.pendingMood = ''
    if (text !== el.lastText) {
      el.lastText = text
      el.title.textContent = text
    }
  }

  // Update immediately when the sticker changed, or on WAITING / ERROR / SUCCESS /
  // attention / a completion card / a placeholder card; otherwise wait for
  // BUBBLE_TITLE_MS to expire before flushing the waiting pending text.
  function applyBubbleTitle(el, entry) {
    var text = entry.message || ''
    var mood = entry.mood || ''
    var state = entry.state || ''
    var immediate = !text
      || state === 'WAITING' || state === 'ERROR' || state === 'SUCCESS'
      || entry.attention === true
      || entry.completionNotification === true
      || entry.idlePlaceholder === true
    if (!el.titleChangedAt) {
      commitBubbleTitle(el, text, mood)
      return
    }
    var moodChanged = mood !== el.titleMood
    var elapsed = Date.now() - el.titleChangedAt
    if (immediate || moodChanged || elapsed >= BUBBLE_TITLE_MS) {
      commitBubbleTitle(el, text, mood)
      return
    }
    if (text === el.lastText) {
      el.pendingTitle = ''
      clearBubbleTitleTimer(el)
      return
    }
    el.pendingTitle = text
    el.pendingMood = mood
    if (!el.titleTimer) {
      el.titleTimer = window.setTimeout(function () {
        el.titleTimer = 0
        if (el.pendingTitle && el.pendingTitle !== el.lastText) {
          commitBubbleTitle(el, el.pendingTitle, el.pendingMood || el.titleMood)
        }
      }, Math.max(16, BUBBLE_TITLE_MS - elapsed))
    }
  }

  // Normalize the detail line into single-line text: one shared separator, and it
  // is rendered as block because display:flex breaks text-overflow.
  function detailShown(detail) {
    return String(detail || '').replace(/^\s*[·•]\s*/, '· ')
  }

  // A detail looks like `<project> · Plan review · <summary>`: the tip takes only the
  // summary after the marker, so the project name and "Plan review" do not show up
  // twice in the bubble tip.
  function planSummaryOf(text) {
    var parts = String(text || '').split(/\s*·\s*/).filter(Boolean)
    var marker = parts.indexOf(PLAN_MARKER)
    return marker >= 0 ? parts.slice(marker + 1).join(' · ') : ''
  }

  function cardView(entry, derived) {
    derived = derived || {}
    return {
      detailShown: derived.detailShown || '',
      planSummary: derived.planSummary || '',
      approval: derived.approval === true,
      planReview: derived.planReview === true,
      completed: derived.completed === true,
      attention: derived.attention === true,
      idlePlaceholder: entry.idlePlaceholder === true,
      phase: entry.phase,
      summaryCount: entry.summaryCount,
    }
  }

  function classNameOf(view, index) {
    return 'rm2-pet-bubble'
      + (index === 0 ? ' top' : '')
      + (view.attention ? ' attention' : '')
      + (view.completed ? ' completed' : '')
      + (view.idlePlaceholder ? ' idle-placeholder' : '')
      + (view.summaryCount ? ' summary-backboard' : '')
  }

  // Hovering an approval card uses the full second line (workspace · preview): the
  // bubble width elides it with CSS, so only the self-drawn overlay lets you read the
  // request; the native title is deprecated because it does not scale with zoom; the
  // action hint lives in the check mark's aria-label. The title is emptied to avoid
  // double tooltips with the self-drawn overlay.
  function tipTextOf(view) {
    if (view.idlePlaceholder) return ''
    if (view.approval) return view.detailShown || ''
    if (view.planReview) {
      return view.planSummary
        ? PLAN_MARKER + ': ' + view.planSummary + ' — click to open Approve / Request changes'
        : PLAN_MARKER + ' — click to open Approve / Request changes'
    }
    if (view.completed) return 'All done~ Click to see the result'
    if (view.attention) return 'Your turn — click here to handle it'
    return 'Click to jump here and take a look~'
  }

  // Fake backboard: a fixed-height empty box that only shows +N; the click target is
  // resolved dynamically by activate on the second layer.
  function applyBackboardChrome(el, entry, index) {
    el.detail.style.display = 'none'
    el.action.style.display = 'none'
    el.stackCount.textContent = entry.summaryCount ? '+' + entry.summaryCount : ''
    el.node.className = 'rm2-pet-bubble' + (entry.summaryCount ? ' summary-backboard' : '')
    el.node.setAttribute('aria-disabled', 'false')
    el.node.style.cursor = 'pointer'
    el.node.title = ''
    el.node.dataset.rm2Tip = entry.backboardTip || ''
    el.node.style.zIndex = String(100 - index)
    el.node.style.order = String(index)
    el.node.style.marginTop = '-' + STACK_LIFT_PX + 'px'
    el.node.style.width = '100%'
    el.node.style.opacity = String(Math.max(0.46, 0.82 - index * 0.1))
    el.node.style.display = 'block'
  }

  function applyCardChrome(el, entry, index, derived) {
    var view = cardView(entry, derived)
    el.stackCount.textContent = view.summaryCount ? '+' + view.summaryCount : ''
    el.node.className = classNameOf(view, index)
    el.node.setAttribute('aria-disabled', view.idlePlaceholder ? 'true' : 'false')
    // Cursor policy: once clicking always jumps to the whole card, work cards are
    // clickable too, and only the idle placeholder card shows default.
    el.node.style.cursor = view.idlePlaceholder ? 'default' : 'pointer'
    el.node.dataset.idlePlaceholder = view.idlePlaceholder ? 'true' : 'false'
    el.node.dataset.rm2Tip = tipTextOf(view)
    el.node.title = ''
    if (view.approval || view.planReview || (view.attention && !view.completed)) {
      var glyph = view.approval ? '✓' : (view.planReview || view.phase === 'ask') ? '?' : '!'
      if (el.action.textContent !== glyph) el.action.textContent = glyph
      el.action.setAttribute('aria-label', view.approval
        ? 'Allow once — click to confirm'
        : view.planReview ? 'Plan review — click to open the review' : 'Needs attention — click to jump')
    } else if (el.action.firstChild !== el.brandImg) {
      el.action.textContent = ''
      el.action.appendChild(el.brandImg)
      el.action.setAttribute('aria-label', 'Remielle desktop pet')
    }
    // Deck layout: the front card is readable and background cards expose
    // only a shallow lower edge. Visual order is driven by the flex `order`
    // property (not DOM order), so cards keep their correct stacking even
    // when a session moves between the front and the backboard slot.
    el.node.style.zIndex = String(100 - index)
    el.node.style.order = String(index)
    el.node.style.marginTop = index === 0 ? '0px' : '-' + STACK_LIFT_PX + 'px'
    // All cards share one width: the widest visible card determines the deck,
    // so a short front card never floats above a much wider lower card.
    el.node.style.width = '100%'
    el.node.style.opacity = index === 0 ? '1' : String(Math.max(0.46, 0.82 - index * 0.1))
    el.node.style.display = 'block'
  }

  global.__rm2BubbleTitle = {
    BUBBLE_TITLE_MS: BUBBLE_TITLE_MS,
    BUBBLE_MIN_W: BUBBLE_MIN_W,
    STACK_LIFT_PX: STACK_LIFT_PX,
    ensureMeasureEl: ensureMeasureEl,
    measureTextW: measureTextW,
    bubbleRowWidth: bubbleRowWidth,
    clearBubbleTitleTimer: clearBubbleTitleTimer,
    commitBubbleTitle: commitBubbleTitle,
    applyBubbleTitle: applyBubbleTitle,
    detailShown: detailShown,
    planSummaryOf: planSummaryOf,
    classNameOf: classNameOf,
    tipTextOf: tipTextOf,
    applyBackboardChrome: applyBackboardChrome,
    applyCardChrome: applyCardChrome,
  }
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2BubbleTitle
  }
})(typeof window !== 'undefined' ? window : globalThis)

/**
 * Markdown renderer for release notes (shared by the settings page "About" tab
 * and the one-click update's update card).
 *
 * A GitHub release body is markdown and used to be shown as plain text in a
 * <pre>, which mashed headings/lists/links into a single line. This implements a
 * sufficient subset: headings, lists, code blocks / inline code, quotes, thematic
 * breaks, bold and italic, strikethrough, links.
 *
 * Safety contract: escape the whole thing as HTML first and only then apply the
 * markdown transforms (the escaped &lt; and friends cannot be reinterpreted a
 * second time); link targets only allow http(s)/mailto and everything else is
 * forced to '#' — the release body comes from a remote source and cannot be
 * trusted.
 *
 * The file uses .cjs: the package is "type":"module", so host ESM can only get
 * the exports through createRequire; the web client concatenates it before
 * client.core.js via scripts/build-client.mjs and reaches it through
 * window.__rm2Markdown. It is pure, so it is unit testable without a DOM stub
 * (see test/markdown.test.js).
 */
;(function (global) {
  'use strict'

  function mdEscapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function mdSafeUrl(url) {
    var u = String(url || '').trim()
    return /^(https?:\/\/|mailto:)/i.test(u) ? u.replace(/"/g, '%22') : '#'
  }
  function mdInline(text) {
    var s = mdEscapeHtml(text)
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>' })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + mdSafeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    return s
  }
  function renderMarkdown(src) {
    var lines = String(src || '').split(/\r?\n/)
    var html = []
    var inCode = false
    var listTag = null
    var para = []
    function flushPara() { if (para.length) { html.push('<p>' + para.join('<br>') + '</p>'); para = [] } }
    function closeList() { if (listTag) { html.push('</' + listTag + '>'); listTag = null } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (/^\s*```/.test(line)) {
        if (inCode) { html.push('</code></pre>'); inCode = false }
        else { flushPara(); closeList(); html.push('<pre><code>'); inCode = true }
        continue
      }
      if (inCode) { html.push(mdEscapeHtml(line)); continue }
      var h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) { flushPara(); closeList(); var lv = h[1].length; html.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>'); continue }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue }
      var ul = line.match(/^\s*[-*+]\s+(.*)$/)
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ul || ol) {
        flushPara()
        var want = ul ? 'ul' : 'ol'
        if (listTag !== want) { closeList(); html.push('<' + want + '>'); listTag = want }
        html.push('<li>' + mdInline((ul || ol)[1]) + '</li>')
        continue
      }
      var q = line.match(/^\s*>\s?(.*)$/)
      if (q) { flushPara(); closeList(); html.push('<blockquote>' + mdInline(q[1]) + '</blockquote>'); continue }
      if (!line.trim()) { flushPara(); closeList(); continue }
      para.push(mdInline(line))
    }
    if (inCode) html.push('</code></pre>')
    flushPara(); closeList()
    return html.join('')
  }

  global.__rm2Markdown = {
    mdEscapeHtml: mdEscapeHtml,
    mdSafeUrl: mdSafeUrl,
    mdInline: mdInline,
    renderMarkdown: renderMarkdown,
  }
  // There is a window in a browser script / build concatenation, so module.exports
  // must not be written, or it would overwrite the client bundle's
  // module.exports. A Node require has no window and can be treated as a CJS export.
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2Markdown
  }
})(typeof window !== 'undefined' ? window : globalThis)

/**
 * dsh-pet-remielle client core.
 *
 * This file is the body of the browser plugin: the build script wraps it in
 * the web shell's module loader (`window.__ModuleLoader__.load`). Do not add
 * top-level imports here.
 *
 * Three responsibilities:
 *  1. Settings section "Pet Management" (`settings.section` slot, React): the
 *     pet registry — enable/disable pets, rename them, pick the active pet, and
 *     add new ones (drop six GIFs into assets/pets/<id>/ and flip it on).
 *  2. Settings card injected into the DSH settings page
 *     (`settings.plugins.tab`) talking to the host config endpoint (global
 *     enable toggle).
 *  3. The floating sticker pet itself (plain DOM) — instead of scraping the
 *     page DOM for work state, it polls the host state endpoint, which is
 *     driven by real session events through the PetReducer. Sticker GIFs are
 *     served by the host at
 *     /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif;
 *     scale/opacity/locked/enabled/petId ride along on the snapshot.
 */

var CONFIG_ENDPOINT = '/plugins/dsh-pet-remielle/config'
var STATE_ENDPOINT = '/plugins/dsh-pet-remielle/state'
var COMPLETION_ACK_ENDPOINT = '/plugins/dsh-pet-remielle/completion/ack'
var SESSION_CURRENT_ENDPOINT = '/plugins/dsh-pet-remielle/session/current'
var THEME_ENDPOINT = '/plugins/dsh-pet-remielle/theme'
// Host theme reporting heartbeat: the host keeps a 10-minute TTL on reported values
// (HOST_THEME_TTL_MS in index.js), so renew every 5 minutes and keep half as slack.
var HOST_THEME_HEARTBEAT_MS = 5 * 60 * 1000
var PETS_ENDPOINT = '/plugins/dsh-pet-remielle/pets'
var ASSETS_PREFIX = '/plugins/dsh-pet-remielle/assets'
var DESKTOP_ENDPOINT = '/plugins/dsh-pet-remielle/desktop'
var CHECK_ENDPOINT = '/plugins/dsh-pet-remielle/check'
var UPDATE_ENDPOINT = '/plugins/dsh-pet-remielle/update'
var PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'
var INFO_ENDPOINT = '/plugins/dsh-pet-remielle/info'
var DEFAULT_PET_ID = 'remielle'

// `require` is provided by the module-loader factory wrapper.
var React = require('react')

var MOODS = {
  '01': 'Drawing',
  '02': 'Slacking',
  '03': 'Pleased',
  '04': 'Thinking',
  '05': 'Waiting',
  '06': 'Idle',
}

var MOOD_ORDER = ['01', '02', '03', '04', '05', '06']

var STREAM_ENDPOINT = '/plugins/dsh-pet-remielle/stream'
var POLL_MS = 800
var STABLE_POLL_MS = 3000

// Gateway-prefix detection (fnOS / TRIM app-center style mounting).
// When the dsh web is served under a path prefix (e.g. /app/<appId>/ via the
// NAS webui), the host rewrites static HTML src/href and intercepts
// fetch/EventSource/script-src, but runtime DOM assignments like
// img.src = '/plugins/...' are NOT rewritten and would 404 at the NAS root.
// Detect the prefix from this bundle's own <script> load URL (the bridge
// rewrites it when mounted), falling back to the page path; '' when served
// directly (127.0.0.1:3080).
var RM_GATEWAY_PREFIX = (function () {
  try {
    var scripts = document.querySelectorAll('script[src*="dsh-pet-remielle"]')
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].src || ''
      var idx = s.indexOf('/plugins/dsh-pet-remielle/')
      if (idx > 0) return s.slice(0, idx)
    }
    var m = (location.pathname || '').match(/^\/app\/[^/]+/)
    if (m) return m[0]
  } catch (e) { /* non-browser context */ }
  return ''
})()
function withPrefix(p) { return RM_GATEWAY_PREFIX + p }

var CSS = [
  // Right-click menu — pink palette, matching the status bubble on both the
  // in-page pet and the desktop window (hardcoded, not DSW vars).
  // The width is pinned to 240px (it used to be stretched by its content, so one long
  // status line widened the whole menu). Inline spacing is tightened, and slider rows
  // became "name column flex:1 + fixed-width slider + fixed-width percentage": once the
  // name column swallows the slack, the slider and the percentage are pushed to the row's
  // trailing edge, so the left/right edges of the "Character size" and "Opacity" sliders
  // line up exactly (the old version had rows whose names differed in length, and
  // space-between put the sliders in different places).
  '.rm2-pet-menu{position:fixed;z-index:2147483000;box-sizing:border-box;width:240px;background:#fff0f5;border:1px solid rgba(240,120,160,.45);border-radius:10px;corner-shape:round!important;box-shadow:0 8px 24px rgba(190,70,110,.22);padding:6px;font-family:system-ui,sans-serif;font-size:13px;color:#8a2f52;display:none;user-select:none;}',
  '.rm2-pet-menu-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:7px 9px;border-radius:7px;corner-shape:round!important;cursor:pointer;white-space:nowrap;}',
  '.rm2-pet-menu-item>span:first-child{flex:1 1 auto;}',
  '.rm2-pet-menu-item:hover{background:rgba(240,120,160,.14);}',
  '.rm2-pet-menu-item .mute{color:#c2607f;font-size:12px;}',
  // line-height:1 is not decoration: the check mark "✓" (U+2713) falls back to another
  // font on this machine, whose glyph box is 19px tall while the label is only 16px, so
  // with line-height:normal the line box is stretched to 33px (30px for unchecked rows) —
  // which makes ticking/unticking jolt the whole row by 3px. Suppressing the tick's own
  // line-height contribution is enough: measured, the tick box goes 19→13px and the line
  // height stays a constant 30px, with the tick's visual position unchanged (0px offset
  // from center). The desktop side has the same `.menu-item .tick` (both ends must match).
  '.rm2-pet-menu-item .tick{color:#b03a60;font-weight:600;line-height:1;}',
  '.rm2-pet-menu-status{opacity:.85;cursor:default;}',
  '.rm2-pet-menu-status>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-pet-menu-slider{flex:none;width:92px;margin:0 2px;accent-color:#e8508a;}',
  '.rm2-pet-menu-pct{flex:none;min-width:36px;text-align:right;font-size:12px;}',
  '.rm2-pet-menu-sep{height:1px;background:rgba(240,120,160,.25);margin:5px 6px;}',
  '.rm2-pet-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:13px;min-width:200px;max-width:453px;padding:16px 27px 16px 40px;border-radius:29px;corner-shape:round!important;background:#fff0f5;border:1px solid rgba(240,120,160,.45);box-shadow:0 11px 32px rgba(190,70,110,.22);font-size:16px;line-height:1.45;text-align:left;pointer-events:none;white-space:nowrap;text-overflow:ellipsis;cursor:default;}',
  '.rm2-pet-bubble-title{font-weight:600;color:#b03a60;}',
  '.rm2-pet-bubble-detail{color:#c2607f;margin-top:3px;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
  // Hand-drawn hover tooltip overlay: the native title ignores setZoomFactor, so on
  // high-zoom screens (e.g. 200%) the text ends up far too small.
  '.rm2-pet-tip{position:fixed;z-index:2147483400;box-sizing:border-box;max-width:min(420px,calc(100vw - 48px));padding:8px 12px;border-radius:10px;corner-shape:round!important;background:#fff0f5;border:1px solid rgba(240,120,160,.45);box-shadow:0 8px 24px rgba(190,70,110,.22);font-family:system-ui,sans-serif;font-size:13px;line-height:1.5;color:#8a2f52;white-space:pre-wrap;word-break:break-all;display:none;pointer-events:none;}',
  'body[data-ds-dark-theme] .rm2-pet-tip{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  // Bubble paging dot
  '.rm2-bubble-dots{position:absolute;left:13px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;pointer-events:auto;z-index:120;}',
  '.rm2-bubble-dot{width:13px;height:13px;border-radius:50%;corner-shape:round!important;background:#e8508a;cursor:pointer;box-shadow:0 0 0 3px rgba(255,255,255,.65);transition:transform .18s,background .18s;}',
  '.rm2-bubble-dot:hover{transform:scale(1.25);}',
  '.rm2-pet-bubble::after{content:\"\";position:absolute;top:100%;left:50%;transform:translateX(-50%);corner-shape:round!important;border:8px solid transparent;border-top-color:rgba(240,120,160,.45);}',
  'body[data-ds-dark-theme] .rm2-pet-bubble{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble-title{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble-detail{color:#f0a8c0;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble::after{border-top-color:rgba(255,150,185,.42);}',
  // Progress bar inside confirmation dialog
  '.rm2-pet-dl-text{color:#b03a60;font-weight:600;font-size:12px;font-family:system-ui,sans-serif;}',
  '.rm2-pet-dl-bar{width:100%;height:4px;border-radius:2px;background:rgba(240,120,160,.2);overflow:hidden;}',
  '.rm2-pet-dl-bar-fill{height:100%;width:0%;border-radius:2px;background:#b03a60;transition:width .3s;}',
  'body[data-ds-dark-theme] .rm2-pet-dl-text{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-dl-bar{background:rgba(255,150,185,.2);}',
  'body[data-ds-dark-theme] .rm2-pet-dl-bar-fill{background:#ffd6e4;}',
  // Confirmation dialog — modal overlay matching dsh style
  '.rm2-pet-confirm-overlay{position:fixed;inset:0;z-index:2147483200;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);}',
  '.rm2-pet-confirm{width:min(380px,90vw);background:var(--dsw-alias-bg-overlay,#f8faff);border:1px solid var(--dsw-alias-border-l2,rgba(71,91,145,.3));border-radius:14px;corner-shape:round!important;box-shadow:0 20px 56px rgba(15,30,72,.34);padding:24px;font-family:system-ui,sans-serif;color:var(--dsw-alias-label-primary,#172347);}',
  '.rm2-pet-confirm-title{font-size:15px;font-weight:600;margin-bottom:8px;color:#b03a60;}',
  '.rm2-pet-confirm-body{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#6f7c99);margin-bottom:20px;}',
  '.rm2-pet-confirm-body b{color:#b03a60;}',
  '.rm2-pet-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px;}',
  '.rm2-pet-confirm-btn{padding:7px 18px;border-radius:8px;corner-shape:round!important;border:1px solid rgba(240,120,160,.3);background:transparent;color:#8a2f52;font-size:13px;cursor:pointer;font-family:inherit;transition:background .15s;}',
  '.rm2-pet-confirm-btn:hover{background:rgba(240,120,160,.12);}',
  '.rm2-pet-confirm-btn.primary{background:#b03a60;color:#fff;border-color:#b03a60;}',
  '.rm2-pet-confirm-btn.primary:hover{background:#9a2e54;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm{background:rgba(13,25,59,.98);border-color:rgba(151,169,216,.34);color:#e7ecf7;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-title{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-body{color:#96a6c9;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-body b{color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn{color:#c2a0b8;border-color:rgba(255,150,185,.3);}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn:hover{background:rgba(255,150,185,.15);}',
  'body[data-ds-dark-theme] .rm2-pet-confirm-btn.primary{background:#b03a60;color:#fff;}',
  'body[data-ds-dark-theme] .rm2-pet-menu{background:rgba(72,20,42,.96);border-color:rgba(255,150,185,.42);color:#ffd6e4;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item .mute{color:#f0a8c0;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item .tick{color:#ffb3c9;}',
  'body[data-ds-dark-theme] .rm2-pet-menu-item:hover{background:rgba(255,150,185,.16);}',
  // Toggle switch — matches old zzz-pet-switch style
  '.rm2-pet-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;corner-shape:round!important;background:rgba(113,130,166,.45);cursor:pointer;transition:background .15s;border:none;padding:0;}',
  '.rm2-pet-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;corner-shape:round!important;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}',
  '.rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-pet-switch.on::after{left:18px;}',
  'body[data-ds-dark-theme] .rm2-pet-switch{background:rgba(150,166,201,.4);}',
  'body[data-ds-dark-theme] .rm2-pet-switch.on{background:var(--dsw-alias-brand-primary,#8ba4d8);}',
  // Settings section spacing
  '.rm2-pet-settings-field{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06));}',
  '.rm2-pet-settings-field:last-child{border-bottom:none;}',
  '[data-testid="dsh-pet-remielle-settings"]:hover{border-color:var(--dsw-alias-label-dimmed);}',
  // Settings-page buttons/inputs — use only the host's native --dsw-alias-* variables,
  // so light/dark follows the host variables automatically instead of hand-written
  // body[data-ds-dark-theme] overrides (the --border-color/--danger-color used before are
  // variables that do not exist, so they always fell back to the light value and the dark
  // theme ended up with light-grey borders).
  '.rm2-pet-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:12px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s;}',
  '.rm2-pet-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}',
  '.rm2-pet-btn:disabled{opacity:.45;cursor:default;}',
  '.rm2-pet-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#526aa8);color:var(--dsw-alias-bg-layer-1,#fff);}',
  // The primary button's text color must not use --dsw-alias-brand-primary-invert:
  // measured, in the light theme it has the same value as brand-primary (both are
  // near-black #0f1115) → black text on a black background. DSH's light-theme accent is
  // near-black and its dark-theme accent is near-white, and bg-layer-1 (light #fff / dark
  // #232324) is naturally the inverse of those.
  // The primary button's hover must explicitly write the accent background back:
  // .rm2-pet-btn-primary elements also carry .rm2-pet-btn, and the .rm2-pet-btn:hover
  // above (specificity 0,3,0) outranks .rm2-pet-btn-primary (0,1,0), which would swap the
  // primary button's hover background for the light-grey interactive-bg-hover → white text
  // on a light background clashing.
  // Declaring it here with the same specificity but later wins, so hover only dims via
  // opacity and the background stays put.
  '.rm2-pet-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#526aa8);opacity:.85;}',
  '.rm2-pet-input{box-sizing:border-box;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:12px;line-height:20px;}',
  '.rm2-pet-input::placeholder{color:var(--dsw-alias-label-quaternary,#9aa5bd);}',
  '.rm2-pet-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-pet-input:disabled{opacity:.45;}',
  // Markdown render area (update card + the About tab's release notes in settings).
  // The container background is given inline by each usage site; only the inner elements
  // are styled here. Semi-transparent white/black overlays work for both themes, and the
  // dark theme only needs a nudge to the code background.
  '.rm2-md h1,.rm2-md h2,.rm2-md h3,.rm2-md h4,.rm2-md h5,.rm2-md h6{margin:10px 0 4px;line-height:1.4;}',
  '.rm2-md h1{font-size:1.25em;}.rm2-md h2{font-size:1.15em;}.rm2-md h3{font-size:1.08em;}.rm2-md h4,.rm2-md h5,.rm2-md h6{font-size:1em;}',
  '.rm2-md p{margin:6px 0;}',
  '.rm2-md ul,.rm2-md ol{margin:6px 0;padding-left:20px;}',
  '.rm2-md li{margin:2px 0;}',
  '.rm2-md code{font-family:ui-monospace,Consolas,monospace;font-size:.95em;background:rgba(103,126,183,.14);border-radius:4px;padding:1px 4px;}',
  '.rm2-md pre{margin:6px 0;padding:8px 10px;overflow:auto;background:rgba(103,126,183,.12);border-radius:6px;}',
  '.rm2-md pre code{background:transparent;padding:0;}',
  '.rm2-md a{color:var(--dsw-alias-brand-primary,#526aa8);}',
  '.rm2-md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2,#d8d8d8);color:var(--dsw-alias-label-secondary,#6f7c99);}',
  '.rm2-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l2,#d8d8d8);margin:10px 0;}',
  '.rm2-md>:first-child{margin-top:0;}',
  '.rm2-md>:last-child{margin-bottom:0;}',
  'body[data-ds-dark-theme] .rm2-md code{background:rgba(255,255,255,.1);}',
  'body[data-ds-dark-theme] .rm2-md pre{background:rgba(255,255,255,.07);}',
  'body[data-ds-dark-theme] .rm2-pet-menu-sep{background:rgba(255,150,185,.25);}',
  // Stacked session cards (status page)
  '.rm2-pet-bubbles{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:16px;width:fit-content;max-width:min(440px,calc(100vw - 24px));display:flex;flex-direction:column;align-items:center;pointer-events:none;cursor:default;}',
  '.rm2-pet-bubbles .rm2-pet-bubble{position:relative;bottom:auto;left:auto;transform:none;margin:0;box-sizing:border-box;width:fit-content;min-width:200px;max-width:min(440px,calc(100vw - 24px));height:91px;min-height:91px;padding:16px 27px 16px 40px;border-radius:29px;corner-shape:round!important;text-align:left;box-shadow:0 11px 32px rgba(190,70,110,.22);transition:width .18s ease,opacity .18s ease;}',
  '.rm2-pet-bubbles .rm2-pet-bubble::after{display:none;}',
  '.rm2-pet-bubbles .rm2-pet-bubble{pointer-events:auto;cursor:pointer;}',
  '.rm2-pet-bubble-header{display:flex;align-items:center;min-width:0;min-height:29px;}',
  '.rm2-pet-bubble-title{min-width:0;flex:none;white-space:nowrap;overflow:visible;text-overflow:clip;line-height:1.35;}',
  '.rm2-pet-bubble.title-clipped .rm2-pet-bubble-title{flex:1;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-pet-bubble-action{display:inline-flex;flex:none;order:2;align-items:center;justify-content:center;width:29px;height:29px;margin-left:11px;margin-right:0;border-radius:50%;corner-shape:round!important;background:#e8508a;color:#fff;font-size:20px;font-weight:700;line-height:1;}',
  '.rm2-pet-bubble-action img{width:20px;height:20px;display:block;filter:brightness(0) saturate(100%) invert(1);}',
  '.rm2-pet-bubble-completion{display:none;flex:none;width:16px;height:16px;margin-right:13px;border-radius:50%;corner-shape:round!important;background:#35c979;box-shadow:0 0 0 4px rgba(53,201,121,.18);}',
  '.rm2-pet-bubble.completed .rm2-pet-bubble-completion{display:inline-flex;}',
  '.rm2-pet-bubble.idle-placeholder{height:61px;min-height:61px;padding-top:15px;padding-bottom:15px;}',
  '.rm2-pet-bubble-stack-count{display:none;position:absolute;right:16px;bottom:0;height:8px;align-items:center;color:#f0a8c0;font-size:9px;font-weight:700;line-height:8px;}',
  '.rm2-pet-bubble.summary-backboard .rm2-pet-bubble-stack-count{display:flex;}',
  '.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-title,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-detail,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-action,.rm2-pet-bubbles .rm2-pet-bubble:not(.top) .rm2-pet-bubble-completion{visibility:hidden;}',
  '.rm2-pet-bubble.top{border-color:#b03a60;box-shadow:0 8px 24px rgba(190,70,110,.22);}',
  '.rm2-pet-bubble.attention{border-color:#e8508a;animation:rm2-pet-attention 1.6s ease-in-out infinite;}',
  '@keyframes rm2-pet-attention{0%,100%{box-shadow:0 0 0 0 rgba(232,80,138,.35);}50%{box-shadow:0 0 0 6px rgba(232,80,138,0);}}',
  'body[data-ds-dark-theme] .rm2-pet-bubble.top{border-color:#ffb3c9;}',
  'body[data-ds-dark-theme] .rm2-pet-bubble.attention{border-color:#ff6fa8;}',
  // Card-deck cards clip overlong content (keeping the ellipsis); the single bubble
  // (balance page) is not inside .rm2-pet-bubbles and is unaffected by this clipping.
  '.rm2-pet-bubbles .rm2-pet-bubble{overflow:hidden;}',
  // The balance bubble reuses the conversation card's working look: border-box with the
  // same fixed 91px height, the same 440px max-width, and no bubble tail triangle.
  // The 29px title line-height matches the conversation card header's min-height(29px).
  '.rm2-bubble-balance{box-sizing:border-box;height:91px;min-height:91px;max-width:440px;}',
  '.rm2-bubble-balance .rm2-pet-bubble-title{line-height:29px;min-width:0;overflow:hidden;text-overflow:ellipsis;}',
  '.rm2-bubble-balance::after{display:none;}',
].join('\n')

function mk(tag, style, text) {
  var n = document.createElement(tag)
  if (style) n.style.cssText = style
  if (text !== undefined) n.textContent = text
  return n
}

/** Sticker URL for one pet + mood, served by the host (gateway-prefix aware). */
function gifUrl(petId, mood) {
  return withPrefix(ASSETS_PREFIX) + '/' + encodeURIComponent(petId) + '/' + mood + '.gif'
}

/** Quick semver-ish compare (strips leading v, numeric dot segments). */
function semverGt(a, b) {
  const pa = (a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = (b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y
  }
  return false
}

// ---- self-update UI (proactive bubble + release card) ----
// The module may be re-evaluated on a plugin reload: the update bubble/card and their
// document listeners are guarded by a window-level singleton, so repeated mounts do not
// pile up stray nodes and listeners on body.
var latestInfo = null
if (!window.__rm2UpdateUi) {
  var updBubbleEl = mk('button', 'display:none;position:fixed;right:20px;bottom:42px;z-index:2147483300;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary,#526aa8);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-brand-primary,#526aa8);cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;', '🆕 New version')
  updBubbleEl.title = 'View update'
  updBubbleEl.addEventListener('click', function () { openUpdateCard() })
  var updCardEl = mk('div', 'display:none;position:fixed;z-index:2147483301;top:50%;left:50%;transform:translate(-50%,-50%);width:min(460px,92vw);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#d8d8d8);border-radius:12px;padding:18px;font-size:13px;color:var(--dsw-alias-label-primary,#172347);font-family:system-ui,sans-serif;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28));')
  var appendUpdateUi = function () {
    document.body.appendChild(updBubbleEl)
    document.body.appendChild(updCardEl)
  }
  if (document.body) appendUpdateUi()
  else window.addEventListener('DOMContentLoaded', appendUpdateUi)
  document.addEventListener('pointerdown', function (e) {
    // While an update is running, clicking outside must not close it (only ✕ does), so a
    // stray click cannot lose the update-status display.
    if (updateState && updateState.phase === 'running') return
    if (updCardEl.style.display === 'block' && !updCardEl.contains(e.target)) updCardEl.style.display = 'none'
  }, true)
  window.__rm2UpdateUi = { bubble: updBubbleEl, card: updCardEl }
}
var updBubble = window.__rm2UpdateUi.bubble
var updCard = window.__rm2UpdateUi.card
// Update flow state: null = idle; running = request in flight (clicking outside is
// disabled); done = succeeded, waiting for a restart
var updateState = null
var lastUpdateError = ''
var updatePollTimer = 0
function closeUpdateCard() { updCard.style.display = 'none' }
function setLatestUpdate(info, isNew) {
  latestInfo = info
  if (isNew) updBubble.style.display = 'inline-flex'
  else updBubble.style.display = 'none'
}
// ---- markdown rendering (release notes) ----
// Already extracted to src/markdown.cjs: a pure function that the web client has
// build-client.mjs concatenate ahead of this file, and that the unit tests require
// directly (test/markdown.test.js) instead of evaluating a slice between markers.
var __md = window.__rm2Markdown
if (!__md) throw new Error('__rm2Markdown is missing: build-client.mjs markdown prepend was broken')
const renderMarkdown = __md.renderMarkdown

function baseUpdateNotes() {
  if (latestInfo.needsCleanReinstall) {
    return 'Version below 0.3.0 — the package name changed, so it cannot update automatically.\nPlease uninstall the old version completely, then reinstall dsh-pet-remielle.'
  }
  return latestInfo.notes || '(no release notes)'
}
function renderUpdateCard() {
  if (!latestInfo) return
  updCard.textContent = ''
  var phase = updateState && updateState.phase
  var titleText = phase === 'done' ? 'Update complete' : phase === 'running' ? 'Updating' : 'New version available'
  var heading = mk('div', 'display:flex;justify-content:space-between;align-items:center;gap:12px;')
  var title = mk('strong', 'font-size:15px;', titleText)
  // ✕ is always able to close; while updating it is the only way to close (clicking outside does nothing)
  var closeX = mk('button', 'border:none;background:transparent;cursor:pointer;font-size:16px;color:var(--dsw-alias-label-tertiary,#6f7c99);', '✕')
  closeX.addEventListener('click', closeUpdateCard)
  heading.appendChild(title)
  heading.appendChild(closeX)
  updCard.appendChild(heading)
  var versions = mk('div', 'display:flex;align-items:center;gap:10px;margin:14px 0 4px;font-weight:600;')
  versions.appendChild(mk('span', 'text-decoration:line-through;color:var(--dsw-alias-label-tertiary,#6f7c99);', (typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : '?')))
  versions.appendChild(mk('span', 'color:var(--dsw-alias-label-tertiary,#6f7c99);', '→'))
  versions.appendChild(mk('span', 'color:var(--dsw-alias-brand-primary,#526aa8);', latestInfo.latest))
  updCard.appendChild(versions)
  // Release notes are markdown (the GitHub release body), so they are rendered into
  // typography instead of plain text; the update output / failure reason are process
  // logs and stay verbatim in a monospace <pre>.
  var notesBox = mk('div', 'margin:8px 0 0;max-height:180px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;')
  notesBox.className = 'rm2-md'
  notesBox.innerHTML = renderMarkdown(baseUpdateNotes())
  updCard.appendChild(notesBox)
  if (phase === 'done') {
    updCard.appendChild(mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '──── Update output ────\n' + (updateState.output || '(no output)') + '\n\nRestart DSH for the new version to take effect.'))
  } else if (lastUpdateError) {
    // The failure output can be a whole block of pnpm log, so it needs a height cap and
    // scrolling, otherwise the card is stretched absurdly long
    updCard.appendChild(mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '❌ Last update failed: ' + friendlyUpdateError(lastUpdateError)))
  }
  // While updating: show the tail of the child-process output forwarded by the host live
  // (the watchdog polls once a second to refresh it)
  var prog = phase === 'running' ? (updateState.progress || null) : null
  if (prog && prog.outputTail) {
    var progPre = mk('pre', 'white-space:pre-wrap;margin:8px 0 0;max-height:120px;overflow:auto;background:rgba(103,126,183,.07);border:1px solid var(--dsw-alias-border-l1,rgba(71,91,145,.18));border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.55;', '──── Live output (auto-refresh) ────\n' + prog.outputTail)
    progPre.className = 'rm2-upd-progress'
    updCard.appendChild(progPre)
    progPre.scrollTop = progPre.scrollHeight
  }
  var actions = mk('div', 'display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px;min-height:32px;')
  // The manual-update entry point is **always present** (visible in every state, placed
  // on the left): once a one-click update fails or times out, the user can take the manual
  // path immediately instead of waiting for the next prompt. The separate GitHub entry that
  // used to exist linked to the same release page as this button, so the two were merged.
  // needsCleanReinstall has its own "View upgrade notes" and is not duplicated.
  if (!latestInfo.needsCleanReinstall) {
    var manualBtn = mk('button', 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d8d8d8);background:transparent;cursor:pointer;font-size:13px;font-family:inherit;margin-right:auto;', 'Manual update (GitHub)')
    manualBtn.addEventListener('click', function () { window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank') })
    actions.appendChild(manualBtn)
  }
  if (phase === 'running') {
    // While updating: plain status copy only — no unclickable fake buttons are rendered
    var elapsedS = prog && prog.elapsedMs ? Math.round(prog.elapsedMs / 1000) : 0
    actions.appendChild(mk('span', 'color:var(--dsw-alias-label-secondary,#42506b);font-size:13px;', '⏳ Updating, do not close DSH…' + (elapsedS ? ' (' + elapsedS + 's elapsed)' : '')))
  } else if (phase === 'done') {
    actions.appendChild(mk('span', 'color:#2fa24c;font-weight:600;font-size:13px;', '✔ Restart DSH for it to take effect'))
  } else if (latestInfo.needsCleanReinstall) {
    var upgrade = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', 'View upgrade notes')
    upgrade.addEventListener('click', function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#updating', '_blank') })
    actions.appendChild(upgrade)
  } else {
    var updBtn = mk('button', 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary,#526aa8);color:#fff;cursor:pointer;font-size:13px;font-family:inherit;', 'Update now')
    updBtn.addEventListener('click', function () { runSelfUpdate() })
    actions.appendChild(updBtn)
  }
  updCard.appendChild(actions)
  updCard.style.display = 'block'
}
function openUpdateCard() {
  if (!latestInfo) return
  renderUpdateCard()
}
function stopUpdateWatchdog() {
  if (updatePollTimer) { window.clearInterval(updatePollTimer); updatePollTimer = 0 }
}
// Update failure hint: give one conclusion only (timeout caused by a slow network /
// suggest updating manually), without spelling out pnpm or mirror details; the concrete
// action is delegated to the "Manual update (GitHub)" button below the card, which jumps
// to the release page.
function friendlyUpdateError(msg) {
  var s = String(msg || '')
  if (/\[timeout/i.test(s)) {
    return s + '\n\n💡 The network is slow and the download timed out (the package is about 17 MB). Manual update is recommended.'
  }
  return s + '\n\n💡 Consider updating manually.'
}
function finishUpdateSuccess(output) {
  stopUpdateWatchdog()
  updateState = { phase: 'done', output: output || '' }
  updBubble.style.display = 'none'
  renderUpdateCard()
}
function failUpdate(message) {
  stopUpdateWatchdog()
  lastUpdateError = message
  updateState = null
  renderUpdateCard()
}
// Watchdog: the response to an update request can be lost to proxy/connection problems,
// leaving the card stuck on "Updating" forever. Every 1s during an update it does two
// things — ① query /update-progress for the tail of the child-process output and the
// elapsed time, and refresh the progress card; ② query /info — as soon as the installed
// version differs from the page build version, the update is judged to be genuinely
// finished; if nothing changes after 3 minutes, show a timeout hint (retryable).
var lastProgressKey = ''
function startUpdateWatchdog() {
  stopUpdateWatchdog()
  var startedAt = Date.now()
  var pageVersion = typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : ''
  lastProgressKey = ''
  updatePollTimer = window.setInterval(function () {
    fetchJson(PROGRESS_ENDPOINT + '?t=' + Date.now())
      .then(function (p) {
        if (!updateState || updateState.phase !== 'running') return
        if (p && typeof p.outputTail === 'string') {
          var next = { elapsedMs: p.elapsedMs || 0, outputTail: p.outputTail }
          // Only redraw when the output or the second count changes, so pointless card
          // rebuilds do not interrupt the user's scrolling
          var key = next.outputTail + '|' + Math.round(next.elapsedMs / 1000)
          if (key !== lastProgressKey) {
            lastProgressKey = key
            updateState.progress = next
            renderUpdateCard()
          }
        }
      })
      .catch(function () { /* ignore a single failed query, fetch again next cycle */ })
    fetchJson(INFO_ENDPOINT + '?t=' + Date.now())
      .then(function (info) {
        if (!updateState || updateState.phase !== 'running') { stopUpdateWatchdog(); return }
        if (info && info.version && info.version !== pageVersion) {
          finishUpdateSuccess('Detected installed version ' + info.version + ' (the update request response never arrived, so the actual install result is authoritative).')
        } else if (Date.now() - startedAt > 180000) {
          failUpdate('Timed out waiting for the update result. If the DSH console already shows success, just restart DSH; otherwise you can retry.')
        }
      })
      .catch(function () { /* ignore a single failed query, query again next cycle */ })
  }, 1000)
}
function runSelfUpdate() {
  if (updateState && updateState.phase === 'running') return
  lastUpdateError = ''
  updateState = { phase: 'running', output: '' }
  renderUpdateCard()
  startUpdateWatchdog()
  fetch(UPDATE_ENDPOINT, { method: 'POST' })
    .then(function (r) { return r.json().catch(function () { return null }).then(function (j) { return { ok: r.ok, j: j } }) })
    .then(function (res) {
      if (res.ok && res.j && res.j.ok) {
        finishUpdateSuccess(res.j.output || '')
      } else {
        // On failure: fall back to the regular view (keeping the retry button) and put the
        // error message into the notes
        failUpdate((res.j && res.j.output) || ('Request failed' + (res.ok ? '' : ' (HTTP error)')))
      }
    })
    .catch(function (err) {
      // A lost response must not be treated as a hard failure: the watchdog keeps polling
      // /info, and the actual install result is authoritative
      if (!updateState || updateState.phase !== 'running') return
      stopUpdateWatchdog()
      startUpdateWatchdog()
    })
}

/** Poll the host state endpoint once; resolves to the snapshot or null. */
function fetchState() {
  return fetch(STATE_ENDPOINT, { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('state request failed: ' + response.status)
      return response.json()
    })
    .catch(function () { return null })
}

function fetchJson(url) {
  return fetch(url, { cache: 'no-store' }).then(function (response) {
    if (!response.ok) throw new Error('request failed: ' + response.status)
    return response.json()
  })
}

/** PATCH several config fields in one request (the endpoint takes an object and rejects unknown keys). */
function patchConfigFields(patch) {
  return fetch(CONFIG_ENDPOINT, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(function () {})
}

function patchConfig(field, next) {
  return patchConfigFields({ [field]: next })
}

function patchPet(id, patch) {
  return fetch(PETS_ENDPOINT + '/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(function () { return null })
}

/** ---------- settings card (React) ---------- */

function Field(props) {
  return React.createElement('label', { className: 'rm2-pet-settings-field', style: props.fieldStyle || undefined },
    React.createElement('span', null,
      React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, props.label),
      React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 3 } }, props.hint),
    ),
    props.children,
  )
}

function Switch(props) {
  var on = props.checked === true
  return React.createElement('button', {
    type: 'button',
    className: 'rm2-pet-switch' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': on,
    disabled: props.disabled,
    onClick: function () { if (!props.disabled && props.onChange) props.onChange(!on) },
  })
}

function RemielleCard() {
  var statusState = React.useState('loading')
  var status = statusState[0]
  var setStatus = statusState[1]
  var valueState = React.useState({})
  var value = valueState[0]
  var setValue = valueState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var patchSeq = React.useRef(0)
  var writable = status === 'ready' && !busy
  React.useEffect(function () {
    var active = true
    fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('settings request failed: ' + response.status)
        return response.json()
      })
      .then(function (next) { if (active) { setValue(next); setStatus('ready') } })
      .catch(function () { if (active) setStatus('unavailable') })
    return function () { active = false }
  }, [])
  var write = function (field, next) {
    var seq = ++patchSeq.current
    setBusy(true)
    fetch(CONFIG_ENDPOINT, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [field]: next }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('settings write failed: ' + response.status)
        return response.json()
      })
      .then(function (updated) {
        if (seq === patchSeq.current) { setValue(updated); setStatus('ready') }
      })
      .catch(function () { if (seq === patchSeq.current) setStatus('unavailable') })
      .finally(function () { if (seq === patchSeq.current) setBusy(false) })
  }
  var cardStyle = {
    listStyle: 'none',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: 12,
    transition: 'border-color .16s, background .16s',
    padding: '14px 16px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    font: 'inherit', color: 'inherit',
  }
  return React.createElement('li', { style: cardStyle, 'data-testid': 'dsh-pet-remielle-settings' },
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 } }, 'Remielle desktop pet'),
      React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5, marginTop: 2 } }, 'A web desktop pet that changes with the real-time state of DSH sessions.'),
    ),
    status === 'unavailable'
      ? React.createElement('span', { role: 'status', style: { whiteSpace: 'nowrap', fontSize: 12, opacity: 0.6 } }, 'Not connected to the Host')
      : status === 'loading'
      ? React.createElement('span', { style: { whiteSpace: 'nowrap', fontSize: 12, opacity: 0.6 } }, 'Loading…')
      : React.createElement(Switch, { checked: value.enabled !== false, disabled: !writable, onChange: function (val) {
        setValue(function (prev) { return Object.assign({}, prev, { enabled: val }) }) // optimistic update, instant feedback
        void write('enabled', val)
      } }),
  )
}

/** ---------- pet management section (React) ---------- */

function petBadge(pet) {
  if (!pet.available) return 'Directory missing'
  if (!pet.complete) return 'Missing art (needs 01–06 complete)'
  if (pet.enabled) return 'Enabled'
  return 'Not enabled'
}

function RenameButton(props) {
  var editingState = React.useState(false)
  var editing = editingState[0]
  var setEditing = editingState[1]
  var nameState = React.useState(props.pet.name)
  var name = nameState[0]
  var setName = nameState[1]
  var save = function () {
    var next = name.trim() || props.pet.name
    void patchPet(props.pet.id, { name: next }).then(function (result) {
      if (result) { props.refresh(); setEditing(false) }
    })
  }
  // When not editing, the name itself is the rename entry: double-click to edit (it does
  // not take up a whole button slot and looks just like an ordinary name)
  if (!editing) {
    return React.createElement('strong', {
      style: { fontSize: 13, cursor: 'text' },
      title: 'Double-click to rename',
      onDoubleClick: function () { if (!props.busy) { setName(props.pet.name); setEditing(true) } },
    }, props.pet.name)
  }
  return React.createElement('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
    React.createElement('input', {
      type: 'text', value: name, className: 'rm2-pet-input', style: { width: 120 },
      autoFocus: true,
      onChange: function (event) { setName(event.target.value) },
      onBlur: save,
      onKeyDown: function (event) {
        if (event.key === 'Enter') save()
        if (event.key === 'Escape') setEditing(false)
      },
    }),
    React.createElement('button', {
      type: 'button', className: 'rm2-pet-btn rm2-pet-btn-primary',
      onMouseDown: function (event) { event.preventDefault() }, // keep focus on the input so onBlur does not save twice first
      onClick: save,
    }, 'Save'),
  )
}

function AddPetForm(props) {
  var idState = React.useState('')
  var id = idState[0]
  var setId = idState[1]
  var nameState = React.useState('')
  var name = nameState[0]
  var setName = nameState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var okId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
  var submit = function () {
    var clean = id.trim()
    if (!okId.test(clean)) {
      setError('The id may only contain letters, digits, underscores and hyphens, and cannot start with a symbol.')
      return
    }
    setError(null)
    void patchPet(clean, { name: name.trim() || clean, enabled: true }).then(function (result) {
      if (result) {
        setId('')
        setName('')
        props.refresh()
      } else {
        setError('Add failed: make sure the DSH Host is running.')
      }
    })
  }
  return React.createElement('div', {
    style: {
      marginTop: 14, padding: 14, border: '1px dashed var(--dsw-alias-border-l2, #d8d8d8)',
      borderRadius: 12, display: 'grid', gap: 10,
    },
  },
    React.createElement('strong', { style: { fontSize: 14 } }, 'Add a new pet'),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: '2px' } },
      React.createElement('span', { style: { padding: '1px 8px', borderRadius: 999, background: 'rgba(212,156,0,.18)', color: '#9a6a00', fontSize: 11, fontWeight: 600 } }, 'In development'),
      React.createElement('span', { style: { opacity: 0.8, fontSize: 12 } }, 'Uploading a new desktop pet is not finished yet — for now, drop the stickers into the directory manually as described below, then register the pet.'),
    ),
    React.createElement('p', { style: { margin: 0, opacity: 0.7, fontSize: 12 } },
      'Put the 6 mood stickers (01.gif–06.gif) into the plugin directory assets/pets/<id>/, then register the pet here.'),
    React.createElement('div', { style: { display: 'grid', gap: 8 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, minWidth: 60 } }, 'ID'),
        React.createElement('input', {
          type: 'text', placeholder: 'Directory name (letters, digits, underscores)', value: id,
          className: 'rm2-pet-input', style: { flex: 1, fontSize: 13 },
          onChange: function (event) { setId(event.target.value) },
        }),
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, minWidth: 60 } }, 'Name'),
        React.createElement('input', {
          type: 'text', placeholder: 'Display name (optional)', value: name,
          className: 'rm2-pet-input', style: { flex: 1, fontSize: 13 },
          onChange: function (event) { setName(event.target.value) },
        }),
      ),
      React.createElement('button', {
        type: 'button', onClick: submit, className: 'rm2-pet-btn rm2-pet-btn-primary', style: { fontSize: 13, padding: '6px 14px', alignSelf: 'flex-start' },
      }, 'Add and enable'),
    ),
    error ? React.createElement('small', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 12 } }, error) : null,
  )
}

function PetsSection() {
  var tabState = React.useState('appearance')
  var tab = tabState[0]
  var setTab = tabState[1]
  var dataState = React.useState(null)
  var data = dataState[0]
  var setData = dataState[1]
  var errorState = React.useState(null)
  var error = errorState[0]
  var setError = errorState[1]
  var busyState = React.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var configState = React.useState(null)
  var config = configState[0]
  var setConfig = configState[1]
  var sliderTimers = React.useRef(new Map())
  var helpState = React.useState(false)
  var tokenHelpOpen = helpState[0]
  var setTokenHelpOpen = helpState[1]
  var updState = React.useState(null)       // { latest, notes } | null
  var updInfo = updState[0]
  var setUpdInfo = updState[1]
  var updCheckingState = React.useState(false)
  var updChecking = updCheckingState[0]
  var setUpdChecking = updCheckingState[1]
  var updMsgState = React.useState(null)    // 'checking' | 'latest' | 'error:...' | null
  var updMsg = updMsgState[0]
  var setUpdMsg = updMsgState[1]
  var currentVersion = (typeof RM_PLUGIN_VERSION !== 'undefined' ? RM_PLUGIN_VERSION : '?')
  var checkUpdate = function () {
    if (updChecking) return
    setUpdChecking(true)
    setUpdMsg('checking')
    fetch(CHECK_ENDPOINT, { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        setUpdChecking(false)
        if (!j || !j.ok || typeof j.latest !== 'string') {
          setUpdInfo(null)
          setUpdMsg(j && j.error === 'no version yet' ? 'no-release' : (j && j.error ? 'error:' + j.error : 'error'))
          return
        }
        var info = { latest: j.latest, notes: j.notes || '', needsCleanReinstall: j.needsCleanReinstall === true }
        var isNew = semverGt(info.latest, currentVersion)
        setUpdInfo(info)
        setUpdMsg(isNew ? 'has-update' : 'latest')
        setLatestUpdate(info, isNew)
        updBubble.style.display = 'none' // the settings page already shows the update info, no bubble needed
      })
      .catch(function () {
        setUpdChecking(false)
        setUpdInfo(null)
        setUpdMsg('error')
      })
  }
  var refresh = function () {
    fetchJson(PETS_ENDPOINT)
      .then(function (result) { setData(result); setError(null) })
      .catch(function () { setError('Cannot reach the DSH Host — the pet registry is unavailable for now.') })
  }
  React.useEffect(function () { refresh() }, [])
  React.useEffect(function () {
    var active = true
    fetchJson(CONFIG_ENDPOINT)
      .then(function (next) { if (active) setConfig(next) })
      .catch(function () {})
    return function () { active = false; for (var _t of sliderTimers.current.values()) clearTimeout(_t); sliderTimers.current.clear() }
  }, [])
  var write = function (key, val) {
    setConfig(function (prev) { return Object.assign({}, prev, {[key]: val}) })
    void patchConfig(key, val)
  }
  var writeSlider = function (key, val) {
    setConfig(function (prev) { return Object.assign({}, prev, {[key]: val}) })
    var pending = sliderTimers.current.get(key)
    if (pending) clearTimeout(pending)
    sliderTimers.current.set(key, setTimeout(function () { sliderTimers.current.delete(key); void patchConfig(key, val) }, 250))
  }
  var sectionStyle = { display: 'grid', gap: 10, padding: '4px 2px', fontSize: 13, color: 'var(--dsw-alias-label-primary, #172347)' }
  var tabs = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'pets', label: 'Pets' },
    { id: 'behavior', label: 'Behavior' },
    { id: 'desktop', label: 'Desktop' },
    { id: 'about', label: 'About' },
  ]
  var tabBar = React.createElement('div', { style: { display: 'flex', gap: 2, borderBottom: '1px solid var(--dsw-alias-border-l2, #d8d8d8)', marginBottom: 12 } },
    tabs.map(function (t) {
      var active = tab === t.id
      return React.createElement('button', {
        key: t.id, type: 'button',
        onClick: function () { setTab(t.id) },
        style: {
          flex: 1, padding: '8px 0', border: 'none', borderBottom: active ? '2px solid var(--dsw-alias-brand-primary, #526aa8)' : '2px solid transparent',
          background: 'transparent', cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
          color: active ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--dsw-alias-label-secondary, #6f7c99)',
          fontFamily: 'inherit', transition: 'color .15s',
        },
      }, t.label)
    }),
  )
  var v = config || {}
  // Sub-settings: indented under the parent switch to express the hierarchy (pure
  // whitespace indentation, no emphasis border)
  var subFieldStyle = { marginLeft: 18, paddingLeft: 12 }
  var appearanceTab = React.createElement('div', null,
    React.createElement(Field, { label: 'Character size', hint: Math.round((v.scale ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.scale ?? 1, disabled: !config, onChange: function (e) { writeSlider('scale', Number(e.target.value)) } }),
    ),
    React.createElement(Field, { label: 'Bubble scales with pet', hint: v.bubbleScaleSync !== false ? 'bubble size = character size × relative ratio' : 'the bubble uses a fixed size and does not scale with the character' },
      React.createElement(Switch, { checked: v.bubbleScaleSync !== false, disabled: !config, onChange: function (val) { write('bubbleScaleSync', val) } }),
    ),
    v.bubbleScaleSync !== false
      ? React.createElement(Field, { label: 'Bubble size relative to pet', hint: Math.round((v.bubbleScaleRatio ?? 1) * 100) + '%', fieldStyle: subFieldStyle },
          React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.bubbleScaleRatio ?? 1, disabled: !config, onChange: function (e) { writeSlider('bubbleScaleRatio', Number(e.target.value)) } }),
        )
      : React.createElement(Field, { label: 'Fixed bubble size', hint: Math.round((v.bubbleFixedSize ?? 1) * 100) + '%', fieldStyle: subFieldStyle },
          React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.05, value: v.bubbleFixedSize ?? 1, disabled: !config, onChange: function (e) { writeSlider('bubbleFixedSize', Number(e.target.value)) } }),
        ),
    React.createElement(Field, { label: 'Opacity', hint: Math.round((v.opacity ?? 1) * 100) + '%' },
      React.createElement('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: v.opacity ?? 1, disabled: !config, onChange: function (e) { writeSlider('opacity', Number(e.target.value)) } }),
    ),
    React.createElement(Field, { label: 'Mirror horizontally', hint: v.mirror === true ? 'Mirrored' : 'Normal direction' },
      React.createElement(Switch, { checked: v.mirror === true, disabled: !config, onChange: function (val) { write('mirror', val) } }),
    ),
  )
  var petsTab = React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
      React.createElement('span', { style: { fontWeight: 600 } }, 'Pet list'),
      React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, 'Manage your desktop pet collection'),
    ),
      error
        ? React.createElement('div', { role: 'alert' },
            React.createElement('span', null, error),
            React.createElement('button', { type: 'button', onClick: refresh, className: 'rm2-pet-btn', style: { marginLeft: 10 } }, 'Retry'),
          )
        : data === null
        ? React.createElement('p', { style: { opacity: 0.6, fontSize: 12 } }, 'Loading the pet list…')
        : React.createElement(React.Fragment, null,
            data.pets.map(function (pet) {
              var badge = petBadge(pet)
              return React.createElement('div', {
                key: pet.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 8,
                  border: '1px solid ' + (pet.id === data.activePetId ? 'var(--dsw-alias-brand-primary, #526aa8)' : 'var(--dsw-alias-border-l2, #d8d8d8)'),
                  background: pet.id === data.activePetId ? 'rgba(82,106,168,.06)' : 'transparent',
                  marginBottom: 6,
                },
              },
                React.createElement('img', { src: gifUrl(pet.id, pet.previewMood || '06'), alt: pet.name, style: { width: 36, height: 36, borderRadius: 6, objectFit: 'cover' }, draggable: false }),
                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    // The name itself is the rename entry: double-click to edit. Pets whose
                    // directory is missing cannot be renamed (PATCH /pets/:id also fails for
                    // a nonexistent directory), so they stay plain text.
                    pet.available
                      ? React.createElement(RenameButton, { pet: pet, refresh: refresh, busy: busy })
                      : React.createElement('strong', { style: { fontSize: 13 } }, pet.name),
                    React.createElement('span', {
                      style: {
                        fontSize: 11, padding: '1px 8px', borderRadius: 999,
                        border: '1px solid ' + (pet.available && pet.complete ? 'var(--dsw-alias-border-l2, #d8d8d8)' : 'var(--dsw-alias-label-error, #c0392b)'),
                        color: pet.available && pet.complete ? 'inherit' : 'var(--dsw-alias-label-error, #c0392b)',
                      },
                    }, badge),
                    React.createElement('span', { style: { fontSize: 11, opacity: 0.5, fontFamily: 'monospace' } }, pet.id),
                  ),
                  React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                    pet.id !== data.activePetId && pet.available && pet.complete
                      ? React.createElement('button', {
                          type: 'button', disabled: busy, className: 'rm2-pet-btn',
                          onClick: function () { void patchPet(pet.id, { active: true }).then(function (result) { if (result) refresh() }) },
                        }, 'Set as current')
                      : null,
                  ),
                ),
                React.createElement(Switch, {
                  checked: pet.enabled === true,
                  disabled: !pet.available || busy,
                  onChange: function (val) {
                    void patchPet(pet.id, { enabled: val }).then(function (result) { if (result) refresh() })
                  },
                }),
              )
            }),
            data.pets.length === 0 ? React.createElement('p', { style: { opacity: 0.7, fontSize: 12 } }, 'No pets yet — add one to get started!') : null,
            React.createElement(AddPetForm, { refresh: refresh }),
          ),
  )
  var behaviorTab = React.createElement('div', null,
    React.createElement(Field, { label: 'Enable desktop pet', hint: 'Turn this off to hide the pet immediately.' },
      React.createElement(Switch, { checked: v.enabled !== false, disabled: !config, onChange: function (val) { write('enabled', val) } }),
    ),
    React.createElement(Field, { label: 'Lock position', hint: 'When on, the pet cannot be dragged.' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('button', {
          type: 'button', disabled: !config, className: 'rm2-pet-btn',
          // The old implementation wrongly posted /desktop/start — pressing "Reset position"
          // actually brought up the desktop floating window.
          // It now matches the right-click menu semantics: clear all four coordinates at
          // once (in-page posX/posY + desktop window desktopX/desktopY), so the next entry
          // into desktop mode lands at the default spot again.
          onClick: function () { void patchConfigFields({ posX: null, posY: null, desktopX: null, desktopY: null }) },
        }, 'Reset position'),
        React.createElement(Switch, { checked: v.locked === true, disabled: !config, onChange: function (val) { write('locked', val) } }),
      ),
    ),
    React.createElement(Field, { label: 'Pause animation', hint: 'Pause the GIF animation; the pet stays frozen on the current frame.' },
      React.createElement(Switch, { checked: v.paused === true, disabled: !config, onChange: function (val) { write('paused', val) } }),
    ),
    React.createElement(Field, { label: 'Hide desktop pet', hint: 'Hide the pet. The right-click menu has no entry for this (switching it off leaves no way back) — to restore it, turn the switch off here.' },
      React.createElement(Switch, { checked: v.hidden === true, disabled: !config, onChange: function (val) { write('hidden', val) } }),
    ),
    React.createElement(Field, { label: 'Respond to sub-agents', hint: 'By default only top-level tasks are followed, so the status does not jump around too much.' },
      React.createElement(Switch, { checked: v.includeSubagents === true, disabled: !config, onChange: function (val) { write('includeSubagents', val) } }),
    ),
    // ---- message bubble ----
    React.createElement(Field, { label: 'Message bubble', hint: 'When on, a bubble can be shown above the pet; the sub-options control its content (it can flip pages when both are on).' },
      React.createElement(Switch, { checked: v.showBubble !== false, disabled: !config, onChange: function (val) {
        // Master switch off → all sub-switches off; master switch on → all sub-switches on,
        // back to the status page
        write('showBubble', val)
        if (!val) { write('showBubbleStatus', false); write('showBubbleUsage', false) }
        else {
          write('showBubbleStatus', true); write('showBubbleUsage', true)
          // The page reset when the bubble goes from off to on is handled by updateBubble in
          // the pet view
        }
      } }),
    ),
    // Bubble sub-options (always expanded)
    React.createElement('div', { style: { marginLeft: 20, display: 'grid', gap: 8 } },
      React.createElement(Field, { label: 'Status', hint: 'Show the session status in the bubble (stage / to-do / progress)' },
        React.createElement(Switch, { checked: v.showBubbleStatus !== false, disabled: !config, onChange: function (val) {
          write('showBubbleStatus', val)
          if (val) write('showBubble', true)
          if (!val && v.showBubbleUsage !== true) write('showBubble', false)
        } }),
      ),
      React.createElement(Field, { label: 'Usage', hint: 'DeepSeek balance and today\'s usage (requires DEEPSEEK_API_KEY)', fieldStyle: { borderBottom: 'none' } },
        React.createElement(Switch, { checked: v.showBubbleUsage === true, disabled: !config, onChange: function (val) {
          write('showBubbleUsage', val)
          if (val) write('showBubble', true)
          if (!val && v.showBubbleStatus !== true) write('showBubble', false)
        } }),
      ),
      // Usage mode (below the usage sub-option, above the separator)
      React.createElement('div', { style: { marginLeft: 16, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06))', display: 'grid', gap: 6 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { fontSize: 12, opacity: v.showBubbleUsage === true ? 1 : 0.4 } }, 'Usage mode'),
            // Help icon for real-time token mode: a circle with a question mark; clicking it
            // opens the how-to dialog
            v.usageMode === 'token'
              ? React.createElement('button', {
                  type: 'button',
                  title: 'How to get DEEPSEEK_PLATFORM_TOKEN',
                  onClick: function (e) { e.stopPropagation(); setTokenHelpOpen(true) },
                  style: { width: 16, height: 16, padding: 0, borderRadius: '50%', cornerShape: 'round', border: '1px solid var(--dsw-alias-border-l2, #b8b8b8)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 11, lineHeight: '14px', fontFamily: 'inherit', textAlign: 'center', opacity: v.showBubbleUsage === true ? 1 : 0.4 },
                }, '?')
              : null,
          ),
          React.createElement('select', {
            value: v.usageMode === 'token' ? 'token' : 'ledger',
            disabled: !config || v.showBubbleUsage !== true,
            onChange: function (e) { write('usageMode', e.target.value) },
            style: { padding: '4px 8px', width: 160, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)', background: 'var(--dsw-alias-bg-layer-2, transparent)', cursor: config && v.showBubbleUsage === true ? 'pointer' : 'default', fontSize: 12, fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary, inherit)', opacity: v.showBubbleUsage === true ? 1 : 0.4 },
          },
            React.createElement('option', { value: 'ledger' }, 'Ledger (no token)'),
            React.createElement('option', { value: 'token' }, 'Real-time token (exact)')
          ),
        ),
        React.createElement('p', { style: { margin: 0, opacity: v.showBubbleUsage === true ? 0.5 : 0.25, fontSize: 11 } },
          v.usageMode === 'token'
            ? 'Calls the platform usage API directly — exact. Prefer the token configured below; if it is left empty it falls back to the DSH credential service.'
            : 'The ledger accumulates the balance difference — slightly off, but no token needed.'
        ),
        // Token configuration (shown only in token mode with usage enabled)
        v.usageMode === 'token'
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('input', {
                type: 'password',
                value: v.platformToken || '',
                disabled: !config || v.showBubbleUsage !== true,
                placeholder: v.platformTokenConfigured ? 'Token configured (enter a new one to replace it)' : 'DEEPSEEK_PLATFORM_TOKEN',
                onChange: function (e) { write('platformToken', e.target.value) },
                className: 'rm2-pet-input',
                style: { flex: 1 },
              }),
            )
          : null,
      ),
    ),
    // ---- usage mode has moved into the bubble sub-options ----
  )
  var desktopTab = React.createElement('div', null,
    React.createElement(Field, { label: 'Desktop floating mode', hint: 'Show the pet in a separate always-on-top window (requires the Electron runtime).' },
      React.createElement(Switch, { checked: v.desktopMode === true, disabled: !config, onChange: function (val) { write('desktopMode', val) } }),
    ),
    v.desktopMode
      ? React.createElement('p', { style: { margin: '8px 0 0', opacity: 0.6, fontSize: 12 } }, 'The desktop window supports dragging, wheel zoom and double-click drawing. Turn this off to go back to the in-page pet.')
      : null,
  )
  var aboutTab = React.createElement('div', null,
    React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.7 } }, 'Check whether a new version is available, or run an incremental update.'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
      React.createElement('span', { style: { fontSize: 13 } }, 'Current version:'),
      React.createElement('span', { style: { fontWeight: 600 } }, currentVersion),
      updMsg === 'has-update'
        ? null
        : React.createElement('button', {
            type: 'button', disabled: updChecking, className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
            onClick: checkUpdate,
          }, updChecking ? 'Checking…' : (updMsg === 'latest' ? 'Check again' : 'Check for updates')),
    ),
    updMsg === 'checking'
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6f7c99)' } }, 'Checking for updates…')
      : updMsg === 'latest'
      ? React.createElement('p', { style: { margin: '10px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2e8b57)' } }, 'You are already on the latest version.')
      : updMsg === 'no-release'
      ? React.createElement('p', { style: { margin: '10px 0 0', fontSize: 12, opacity: 0.7 } }, 'The repository has not published any release yet, so there is nothing to check.')
      : updMsg === 'has-update'
      ? updInfo && updInfo.needsCleanReinstall
        ? React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, 'New version available: ' + updInfo.latest + '.'),
            React.createElement('p', { style: { margin: '0 0 10px', fontSize: 13, lineHeight: 1.6 } },
              'Your version is below 0.3.0 and the package name changed as of 0.3.0, so it cannot be updated incrementally. Please uninstall the old version completely, then reinstall dsh-pet-remielle.'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle#updating', '_blank') },
              }, 'View upgrade notes'),
            ),
          )
        : React.createElement('div', { style: { margin: '10px 0 0' } },
            React.createElement('p', { style: { margin: '0 0 6px', fontSize: 13 } }, 'New version available: ' + (updInfo ? updInfo.latest : '') + ' — you can update in one click.'),
            updInfo && updInfo.notes
              ? React.createElement('div', { className: 'rm2-md', style: { margin: '0 0 10px', maxHeight: 200, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-2, rgba(103,126,183,.07))', border: '1px solid var(--dsw-alias-border-l2,#d8d8d8)', borderRadius: 8, padding: '8px 10px', fontSize: 12, lineHeight: 1.55 }, dangerouslySetInnerHTML: { __html: renderMarkdown(updInfo.notes) } })
              : null,
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn rm2-pet-btn-primary', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { openUpdateCard() },
              }, 'Update now'),
              React.createElement('button', {
                type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
                onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank') },
              }, 'View on GitHub'),
            ),
          )
      : updMsg && updMsg.indexOf('error') === 0
      ? React.createElement('p', { style: { margin: '10px 0 0', opacity: 0.7, fontSize: 12 } }, 'Update check failed: ' + (updMsg === 'error' ? 'cannot reach GitHub — try again later or check your network/proxy.' : updMsg.replace('error:', '') + ' — try again later or check your network/proxy.'))
      : null,
    React.createElement('p', { style: { margin: '14px 0 0', opacity: 0.5, fontSize: 12 } },
      'Update checks fetch the latest version through the GitHub API; runtimes such as the desktop floating window update together with the plugin. Restart DSH after an update for it to take effect.'),
    // Feedback area (the standalone "Feedback" tab was merged into "About"); the version
    // number is already shown above and is not repeated
    React.createElement('div', { style: { marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.06))' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
        React.createElement('span', { style: { fontWeight: 600 } }, 'Feedback'),
        React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, 'Found a problem or have an idea?'),
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
          onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=bug_report.yml', '_blank') },
        }, 'Report a bug'),
        React.createElement('button', {
          type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
          onClick: function () { window.open('https://github.com/Gin-7/dsh-pet-remielle/issues/new?template=feature_request.yml', '_blank') },
        }, 'Feature request'),
      ),
    ),
  )
  var tabContent = tab === 'appearance' ? appearanceTab : tab === 'pets' ? petsTab : tab === 'behavior' ? behaviorTab : tab === 'desktop' ? desktopTab : aboutTab
  return React.createElement('section', { style: sectionStyle, 'data-testid': 'dsh-pet-remielle-pets-section' },
    React.createElement('h3', { style: { margin: 0, fontSize: 15 } }, 'Pet Management'),
    tabBar,
    tabContent,
    tokenHelpOpen
      ? React.createElement('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483400,
            background: 'rgba(15,20,35,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20,
          },
          onClick: function () { setTokenHelpOpen(false) },
        },
        React.createElement('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-2,#fff)', border: '1px solid var(--dsw-alias-border-l2,#d8d8d8)',
            borderRadius: 12, padding: '18px 20px', maxWidth: 440, width: '100%', maxHeight: '82vh', overflow: 'auto',
            boxShadow: 'var(--dsw-shadow-lv3,0 24px 64px rgba(15,30,72,.28))', fontFamily: 'system-ui,sans-serif', color: 'var(--dsw-alias-label-primary,#172347)', fontSize: 13, lineHeight: 1.7,
          },
          onClick: function (e) { e.stopPropagation() },
        },
          React.createElement('h4', { style: { margin: '0 0 10px', fontSize: 14 } }, 'How to get DEEPSEEK_PLATFORM_TOKEN'),
          React.createElement('ol', { style: { margin: '0 0 12px', paddingLeft: 20 } },
            React.createElement('li', null, 'Sign in to platform.deepseek.com in your browser.'),
            React.createElement('li', null, 'Press F12 to open the developer tools → Application → Local Storage → https://platform.deepseek.com.'),
            React.createElement('li', null, 'Find userToken, copy its value, and paste it into the input above.'),
          ),
          React.createElement('p', { style: { margin: '0 0 12px', opacity: 0.6, fontSize: 12 } }, 'Note: this token is a platform login session credential and may expire — fetch a new one when it does; do not share it, and consider logging in to the platform again periodically to rotate the token.'),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } },
            React.createElement('button', {
              type: 'button', className: 'rm2-pet-btn', style: { fontSize: 13, padding: '6px 14px' },
              onClick: function () { setTokenHelpOpen(false) },
            }, 'Close'),
          ),
        ),
      )
      : null,
  )
}

/** ---------- floating pet (plain DOM) ---------- */

function mountPet(ctx) {
  function optionalService(name) {
    if (!ctx) return undefined
    try {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch (e) {
      return undefined
    }
  }
  // Balance controller: idempotently loads the shared client script (removes the dead tag
  // on load failure so the next attempt can retry)
  if (!window.__petBalance && !document.querySelector('script[src*="balance-widget.js"]')) {
    var balanceScript = document.createElement('script')
    balanceScript.src = '/plugins/dsh-pet-remielle/balance-widget.js'
    balanceScript.async = true
    balanceScript.onerror = function () { if (balanceScript.parentNode) balanceScript.parentNode.removeChild(balanceScript) }
    document.head.appendChild(balanceScript)
  }
  var root = mk('div', 'position:fixed;right:20px;bottom:20px;z-index:2147483000;pointer-events:auto;user-select:none;display:none;')
  root.setAttribute('data-rm2-pet-root', '')
  var dock = mk('div', 'position:relative;display:inline-block;cursor:grab;touch-action:none;')
  dock.title = 'Drag me · Click to interact · Right-click menu'
  var img = mk('img', 'width:180px;height:auto;pointer-events:none;display:none;')
  img.alt = 'Desktop pet'
  img.draggable = false
  var bubble = mk('div', 'display:none;')
  // Single bubble (balance page): reuses the visual working state of the status card's
  // top card (thick border / shadow / weight), so it looks the same as a conversation card
  bubble.className = 'rm2-pet-bubble top'
  // An empty title cuts off the ancestor dock's native tooltip, so the balance page's dot
  // does not show a border and then pop up "Drag me…"
  bubble.title = ''
  var bubbleTitle = mk('div', '')
  bubbleTitle.className = 'rm2-pet-bubble-title'
  var bubbleDetail = mk('div', '')
  bubbleDetail.className = 'rm2-pet-bubble-detail'
  bubble.appendChild(bubbleTitle)
  bubble.appendChild(bubbleDetail)
  // Stacked session cards (status page): one readable card per session + one +N backboard
  var bubbleStack = mk('div', 'display:none;')
  bubbleStack.className = 'rm2-pet-bubbles'
  bubbleStack.title = ''
  // Paging dot (a single one: clicking switches between status ↔ balance)
  var bubbleDots = mk('div', '', '')
  bubbleDots.className = 'rm2-bubble-dots'
  bubbleDots.title = ''
  var bubbleDot = mk('div', '', '')
  bubbleDot.className = 'rm2-bubble-dot'
  bubbleDot.title = ''
  bubbleDots.appendChild(bubbleDot)
  bubble.appendChild(bubbleDots)
  // The bubble area swallows every pet interaction event that would otherwise bubble up to
  // the dock: pointerdown/mousedown (drag), click (random reaction), dblclick
  // (double-click drawing).
  // The status page and the balance page behave identically; the bubble's own interactions
  // (paging dot, session-card click, wheel paging) are handled first in their own
  // handlers and are unaffected. contextmenu is not intercepted, so right-clicking the
  // bubble still opens the menu.
  function swallowPetInteraction(el) {
    var types = ['pointerdown', 'mousedown', 'click', 'dblclick']
    for (var i = 0; i < types.length; i++) {
      el.addEventListener(types[i], function (e) { e.stopPropagation() })
    }
  }
  swallowPetInteraction(bubble)
  swallowPetInteraction(bubbleStack)
  // Hand-drawn hover tooltip overlay: the native title is rendered by the system and does
  // not scale with setZoomFactor, so on high-DPI screens (200%) the text is too small.
  // The text lives on the card's dataset.rm2Tip; the overlay is shown on hover.
  var petTip = null
  var petTipAnchor = null
  var __tip = window.__rm2PetTip
  if (!__tip) throw new Error('__rm2PetTip is missing: build-client.mjs pet-tip prepend was broken')
  // Grabbing the current GIF frame (for the pause freeze): the desktop side has the very
  // same implementation, see src/gif-frame.cjs
  var __gifFrame = window.__rm2GifFrame
  if (!__gifFrame) throw new Error('__rm2GifFrame is missing: build-client.mjs gif-frame prepend was broken')
  __gifFrame.watch(img)
  // Title throttling, width measurement and state copy for bubble session cards (approval /
  // plan review / done): the desktop side has the very same implementation,
  // src/bubble-title.cjs
  var __bubbleTitle = window.__rm2BubbleTitle
  if (!__bubbleTitle) throw new Error('__rm2BubbleTitle is missing: build-client.mjs bubble-title prepend was broken')
  var measureTextW = __bubbleTitle.measureTextW
  var bubbleRowWidth = __bubbleTitle.bubbleRowWidth
  function hidePetTip() {
    petTipAnchor = null
    if (petTip) petTip.style.display = 'none'
  }
  function layoutPetTip(anchor, L, T, R, B) {
    __tip.layoutPetTip(petTip, anchor, L, T, R, B)
  }
  function showPetTip(anchor) {
    var text = anchor && anchor.dataset ? anchor.dataset.rm2Tip : ''
    if (!text) { hidePetTip(); return }
    if (!petTip) {
      petTip = mk('div', '')
      petTip.className = 'rm2-pet-tip'
      document.body.appendChild(petTip)
    }
    petTip.textContent = text
    petTip.style.left = '-9999px'
    petTip.style.top = '0px'
    petTip.style.display = 'block'
    petTipAnchor = anchor
    var W = window.innerWidth || 1280
    var H = window.innerHeight || 800
    layoutPetTip(anchor, 0, 0, W, H)
  }
  function syncDotTip() {
    __tip.applyDotTip(bubbleDot, currentBubblePage, petTipAnchor, showPetTip)
  }
  function onDotLeave(e) {
    __tip.onDotLeave(e, bubbleDot, bubbleDots, showPetTip, hidePetTip)
  }
  function commitBackboardTarget(target, tip) {
    var el = bubbleEls.get(BUBBLE_BACKBOARD_ID)
    if (el && el.node) {
      el.node.dataset.rm2Tip = tip
      if (petTipAnchor === el.node) showPetTip(el.node)
    }
  }
  var currentBubblePage = 0
  function switchBubblePage(p) {
    currentBubblePage = p
    syncDotTip()
    // Both pages are re-rendered in sync: the balance page no longer waits for the widget's
    // async first frame — while __petBalance is not ready, the old deck would linger until
    // the next polling cycle
    if (lastSnapshot) updateBubble(lastSnapshot)
    if (p === 0) {
      balanceFrame = null
      balanceRequested = false
      if (window.__petBalance && window.__petBalance.showStatus) window.__petBalance.showStatus()
    } else if (p === 1 && window.__petBalance && window.__petBalance.showBalance) {
      window.__petBalance.showBalance()
    }
  }
  bubbleDot.addEventListener('click', function (e) { e.stopPropagation(); switchBubblePage(currentBubblePage === 0 ? 1 : 0) })
  bubbleDot.addEventListener('mouseenter', function (e) { if (e && e.stopPropagation) e.stopPropagation(); showPetTip(bubbleDot) })
  bubbleDot.addEventListener('mouseleave', onDotLeave)
  syncDotTip()
  // Both the status deck and the single bubble (balance page) must catch the wheel to flip
  // pages, instead of letting it bubble up to the dock and scale the pet
  function onBubbleWheel(e) {
    e.preventDefault(); e.stopPropagation()
    // Only flip pages when both are on (with a single one the bubble has
    // pointer-events:none and normally never fires — belt and braces)
    if (lastSnapshot) {
      var so = lastSnapshot.showBubble !== false && lastSnapshot.showBubbleStatus !== false
      var uo = lastSnapshot.showBubble !== false && lastSnapshot.showBubbleUsage === true
      if (!(so && uo)) return
    }
    switchBubblePage(currentBubblePage === 0 ? 1 : 0)
  }
  bubble.addEventListener('wheel', onBubbleWheel, { passive: false })
  bubbleStack.addEventListener('wheel', onBubbleWheel, { passive: false })
  // Confirmation dialog
  var confirmOverlay = mk('div')
  confirmOverlay.className = 'rm2-pet-confirm-overlay'
  var confirmBox = mk('div')
  confirmBox.className = 'rm2-pet-confirm'
  var confirmTitle = mk('div', '', 'Open the desktop floating window')
  confirmTitle.className = 'rm2-pet-confirm-title'
  var confirmBody = mk('div')
  confirmBody.className = 'rm2-pet-confirm-body'
  confirmBody.innerHTML = 'Opening the desktop floating window requires downloading the <b>Electron runtime (about 221 MB)</b>.<br>The download comes from the npmmirror mirror or from GitHub.'
  var confirmProgress = mk('div')
  confirmProgress.style.cssText = 'display:none;margin:14px 0 0;'
  var confirmPctText = mk('div', '', '0%')
  confirmPctText.className = 'rm2-pet-dl-text'
  confirmPctText.style.cssText = 'margin-bottom:6px;'
  var confirmBar = mk('div')
  confirmBar.className = 'rm2-pet-dl-bar'
  confirmBar.style.cssText = 'width:100%;'
  var confirmFill = mk('div')
  confirmFill.className = 'rm2-pet-dl-bar-fill'
  confirmBar.appendChild(confirmFill)
  confirmProgress.appendChild(confirmPctText)
  confirmProgress.appendChild(confirmBar)
  var confirmActions = mk('div')
  confirmActions.className = 'rm2-pet-confirm-actions'
  var confirmCancel = mk('button', '', 'Cancel')
  confirmCancel.className = 'rm2-pet-confirm-btn'
  var confirmOk = mk('button', '', 'Start download')
  confirmOk.className = 'rm2-pet-confirm-btn primary'
  confirmActions.appendChild(confirmCancel)
  confirmActions.appendChild(confirmOk)
  confirmBox.appendChild(confirmTitle)
  confirmBox.appendChild(confirmBody)
  confirmBox.appendChild(confirmProgress)
  confirmBox.appendChild(confirmActions)
  confirmOverlay.appendChild(confirmBox)
  document.body.appendChild(confirmOverlay)
  confirmCancel.addEventListener('click', function () {
    confirmOverlay.style.display = 'none'
    fetch(DESKTOP_ENDPOINT + '/cancel-download', { method: 'POST' }).catch(function () {})
    patchConfig('desktopMode', false) // cancel = do not enable desktop mode, the switch goes back to off
  })
  confirmOk.addEventListener('click', function () {
    confirmOk.disabled = true
    confirmOk.textContent = 'Downloading…'
    confirmCancel.style.display = 'none'
    confirmProgress.style.display = 'block'
    fetch(DESKTOP_ENDPOINT + '/confirm-download', { method: 'POST' }).catch(function () {
      confirmOk.disabled = false
      confirmOk.textContent = 'Start download'
      confirmCancel.style.display = ''
      confirmProgress.style.display = 'none'
    })
  })
  var menu = mk('div', '')
  menu.className = 'rm2-pet-menu'
  var picEl = mk('canvas', 'position:fixed;right:24px;top:24px;z-index:2147483200;width:220px;height:auto;border-radius:10px;display:none;cursor:pointer;')
  picEl.className = 'rm2-pet-pic'
  picEl.title = 'Click to close'
  picEl.addEventListener('click', function () { picStop(); picEl.style.display = 'none' })
  var styleEl = document.createElement('style')
  styleEl.textContent = CSS
  styleEl.setAttribute('data-rm2-pet-css', '')

  dock.appendChild(img)
  dock.appendChild(bubble)
  dock.appendChild(bubbleStack)
  root.appendChild(dock)
  document.body.appendChild(picEl)
  document.head.appendChild(styleEl)
  document.body.appendChild(root)
  document.body.appendChild(menu)

  // ---- pet-local state ----
  var currentMood = '06'
  var displayedMood = null
  var currentPetId = DEFAULT_PET_ID
  var lastSnapshot = null
  var balanceFrame = null
  var balanceRequested = false
  var manualOverride = null
  var paused = false
  // Hidden at first: pet visibility is driven by the snapshot
  // (desktopActive/desktopMode/enabled/hidden); rendering and only then hiding would make
  // the bottom-right pet flash briefly when the page is opened in desktop mode.
  var hidden = true
  var pendingDesktopHide = false
  // Grace period after a desktop-mode switch: when the desktop window never activates
  // (Electron missing / the download failed / the launch crashed) the in-page pet's hide
  // is cancelled automatically, so there is never a "page hidden + no desktop window"
  // situation with no pet on either client
  var desktopHideTimer = null
  function armDesktopHideTimer() {
    if (desktopHideTimer) window.clearTimeout(desktopHideTimer)
    desktopHideTimer = window.setTimeout(function () {
      desktopHideTimer = null
      if (!pendingDesktopHide) return
      pendingDesktopHide = false
      if (lastSnapshot) applySnapshot(lastSnapshot)
    }, 15000)
  }
  var lockedNow = false
  var petDragging = false
  function syncPetCursor() {
    // Keep the grabbing cursor while the pointer is held: the snapshot's applyVisuals
    // reaches this every time, so it must not unconditionally fall back to grab.
    dock.style.cursor = lockedNow ? 'default' : petDragging ? 'grabbing' : 'grab'
  }
  var positionRestored = false
  var lastTurnEndShown = false
  var intervalId = 0
  var pulseFallbackTimer = 0
  var stream = null
  var disposed = false

  /** Mirroring applies to the pet artwork only (the bubble and the dot are not flipped); shared by applyVisuals and applyOffset. */
  function applyMirror(snapshot) {
    img.style.transform = snapshot && snapshot.mirror === true ? 'scaleX(-1)' : ''
  }

  function applyVisuals(snapshot) {
    var scale = snapshot.scale ?? 1
    var opacity = snapshot.opacity ?? 1
    img.style.width = Math.round(180 * scale) + 'px'
    applyMirror(snapshot)
    // Bubble zoom uses the same rule as the desktop side, pet-tip.cjs's bubbleZoomOf
    // (sync / fixed modes)
    var bubbleZoom = __tip.bubbleZoomOf(snapshot)
    bubble.style.zoom = String(bubbleZoom)
    bubbleStack.style.zoom = String(bubbleZoom)
    img.style.opacity = String(opacity)
    lockedNow = snapshot.locked === true
    syncPetCursor()
  }

  var prevBubbleVisible = false
  // Fixed sessionId of the fake backboard on the deck's second layer (it maps to no real
  // session; it only carries the +N and the click-to-jump).
  var BUBBLE_BACKBOARD_ID = '__pet_backboard__'
  var BACKBOARD_TIP_DEBOUNCE_MS = 400
  var backboardStabilizer = __tip.createBackboardStabilizer(
    commitBackboardTarget,
    BACKBOARD_TIP_DEBOUNCE_MS,
    function (fn, ms) { return window.setTimeout(fn, ms) },
    function (timer) { window.clearTimeout(timer) },
  )
  var currentSessionId = undefined
  // Per-tab reporting identity: clearing the current session from a hidden page must not
  // wipe another page's selection.
  var currentSessionClientId = 'pet-tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)
  var bubbleEls = new Map() // sessionId -> { node, title, detail }
  // The ordering logic is shared with the desktop floating window via
  // src/session-order.cjs (concatenated ahead of this file at build time by
  // scripts/build-client.mjs): approval > plan review > waiting for an answer > completion
  // card > attention > current session > stateRank > updatedAt.
  var __order = window.__rm2SessionOrder
  // The build script (build-client.mjs) must concatenate session-order.cjs ahead of this
  // file; when the concatenation breaks, failing early here points straight at the cause
  // instead of throwing a TypeError on the first sort and silently killing the whole pet
  // module.
  if (!__order) throw new Error('__rm2SessionOrder is missing: build-client.mjs session-order prepend was broken')
  var attentionOf = __order.attentionOf
  var completionOf = __order.completionOf
  var targetSessionOf = __order.targetSessionOf
  var approvalOf = __order.approvalOf
  var planReviewOf = __order.planReviewOf
  function orderSessions(sessions) {
    return __order.orderSessions(sessions, currentSessionId)
  }
  // Current-session reporting: fire-and-forget; the host keeps it in memory per tab and
  // hands it back with the next snapshot (an empty string means clear).
  function isForegroundSurface() {
    if (typeof document === 'undefined') return true
    if (document.visibilityState === 'hidden') return false
    return typeof document.hasFocus !== 'function' || document.hasFocus()
  }
  function activeGlobalPanel() {
    var layout = optionalService('layout')
    try {
      var info = layout && layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function'
        ? layout.panelInfo.getSnapshot()
        : undefined
      return !!info && info.activePanelId !== null && info.activePanelId !== undefined
    } catch (e) {
      return false
    }
  }
  function isViewingConversation() {
    return isForegroundSurface() && !activeGlobalPanel()
  }
  function reportCurrentSession(id) {
    if (disposed || !isViewingConversation()) return
    fetch(SESSION_CURRENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id || '', clientId: currentSessionClientId }),
      keepalive: true,
    }).catch(function () {})
  }
  // Clear **this tab's** reported current session when the page unloads, loses focus or is
  // hidden: otherwise closing the page outright leaves a stale currentSessionId on the
  // desktop side, which makes both the top-of-deck ordering and the automatic ack
  // misjudge. sendBeacon (with a Blob typed application/json) / fetch keepalive make sure
  // the request still goes out during unload; when neither is available we give up
  // silently. Clearing by clientId does not wipe another visible tab's state.
  function clearReportedCurrentSession() {
    if (disposed) return
    var body = JSON.stringify({ sessionId: '', clientId: currentSessionClientId })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(SESSION_CURRENT_ENDPOINT, new Blob([body], { type: 'application/json' }))
      return
    }
    fetch(SESSION_CURRENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {})
  }
  function onCurrentSessionFocus() {
    if (disposed) return
    if (currentSessionId) reportCurrentSession(currentSessionId)
    if (lastSnapshot) ackCurrentSessionCompletion(lastSnapshot)
  }
  function onCurrentSessionVisibilityChange() {
    if (disposed) return
    if (isViewingConversation()) {
      if (currentSessionId) reportCurrentSession(currentSessionId)
      if (lastSnapshot) ackCurrentSessionCompletion(lastSnapshot)
    } else {
      clearReportedCurrentSession()
    }
  }
  window.addEventListener('pagehide', clearReportedCurrentSession)
  window.addEventListener('beforeunload', clearReportedCurrentSession)
  window.addEventListener('blur', clearReportedCurrentSession)
  window.addEventListener('focus', onCurrentSessionFocus)
  document.addEventListener('visibilitychange', onCurrentSessionVisibilityChange)
  // Host theme reporting: the desktop floating window is a separate Electron window and
  // cannot read the body[data-ds-dark-theme] here — its menu/bubble colors can only be kept
  // in sync through this report. Without it, the window just follows the system theme, and
  // whenever the host theme and the system theme disagree the two clients' menus end up
  // different colors (the most common combination in practice: system dark + DSH light
  // theme). The host only keeps it in memory and hands it back with the snapshot; the local
  // report itself is fire-and-forget and triggers no broadcast.
  var reportedHostTheme = ''
  function currentHostTheme() {
    var body = document.body
    if (!body || typeof body.hasAttribute !== 'function') return ''
    return body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  }
  function hostThemeBody(theme) {
    return JSON.stringify({ theme: theme, clientId: currentSessionClientId })
  }
  function sendHostTheme(theme) {
    if (disposed) return
    fetch(THEME_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: hostThemeBody(theme),
      keepalive: true,
    }).catch(function () {})
  }
  function trackHostTheme() {
    if (disposed) return
    var theme = currentHostTheme()
    if (!theme || theme === reportedHostTheme) return
    reportedHostTheme = theme
    sendHostTheme(theme)
  }
  // Clear on unload: once the page is closed the desktop floating window should not keep
  // the host colors and should fall back to the system theme. Same caveat as
  // currentSession: this does not run when the page is killed, and the host side has a TTL
  // as a fallback.
  function clearReportedHostTheme() {
    if (disposed) return
    var body = hostThemeBody('')
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(THEME_ENDPOINT, new Blob([body], { type: 'application/json' }))
      return
    }
    fetch(THEME_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {})
  }
  function watchHostTheme() {
    if (disposed || typeof MutationObserver !== 'function' || !document.body) return
    trackHostTheme()
    // The host switching theme = adding/removing data-ds-dark-theme on body; report on
    // every attribute shake
    hostThemeMutationObserver = new MutationObserver(trackHostTheme)
    hostThemeMutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme'],
    })
    // Heartbeat renewal: the reported value has a TTL on the host side (pagehide does not
    // run when the page is force-killed, so the TTL is the fallback); reporting only on
    // change would let the desktop window silently fall back to the system theme once the
    // TTL expires, which is yet another shade compared to the web client.
    hostThemeHeartbeatTimer = window.setInterval(function () {
      if (disposed) return
      var theme = currentHostTheme()
      if (theme) sendHostTheme(theme)
    }, HOST_THEME_HEARTBEAT_MS)
    window.addEventListener('pagehide', clearReportedHostTheme)
    window.addEventListener('beforeunload', clearReportedHostTheme)
  }
  var hostThemeMutationObserver = null
  var hostThemeHeartbeatTimer = 0
  if (document.body) watchHostTheme()
  else document.addEventListener('DOMContentLoaded', watchHostTheme)
  var completionAckPending = new Set()
  function acknowledgeCompletion(sessionId, attempt) {
    if (disposed || !sessionId) return
    var retry = attempt || 0
    if (retry === 0 && completionAckPending.has(sessionId)) return
    completionAckPending.add(sessionId)
    fetch(COMPLETION_ACK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    }).then(function (response) {
      if (!response.ok) throw new Error('completion acknowledgement failed')
      completionAckPending.delete(sessionId)
    }).catch(function () {
      if (retry < 2) {
        window.setTimeout(function () { acknowledgeCompletion(sessionId, retry + 1) }, 250 * (retry + 1))
      } else {
        completionAckPending.delete(sessionId)
      }
    })
  }
  function acknowledgeCompletionAfterOpen(sessionId) {
    var attempts = 40
    var confirm = function () {
      if (disposed) return
      if (currentSessionIdOf() === sessionId) {
        acknowledgeCompletion(sessionId)
        return
      }
      if (attempts-- > 0) window.setTimeout(confirm, 50)
    }
    confirm()
  }
  /**
   * "The session you are currently viewing has completed" means it has been read. This is
   * a **side effect** and must not live on the render path: in desktop mode applySnapshot
   * returns early for `desktopActive` / `pendingDesktopHide` (the page pet is hidden), so
   * rendering and the ack are skipped together and the green dot only disappears on a
   * manual click. So it runs independently at the snapshot entry point.
   */
  function ackCurrentSessionCompletion(snapshot) {
    if (disposed || !isViewingConversation()) return
    var list = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : []
    var completions = list.filter(function (entry) { return entry && completionOf(entry) })
    if (!completions.length) return
    // Without a currentSessionId, do not guess. "There is only one completion card" does not
    // mean "the user is looking at it": this function runs inside apply() before rendering,
    // so right after a page load (or when several tabs overwrite each other) currentSessionId
    // is still the previous frame's value, and a wrong guess silently swallows a reminder
    // the user has not seen.
    //
    // The cost is very brief: currentSessionId has only three writers — one synchronous
    // assignment at mount time (before the first SSE snapshot), then maintenance through
    // sessionList.subscribe → syncCurrentSession; while a panel is open
    // currentSessionIdOf() leaves the value dangling, and when the panel closes the reopened
    // branch of layout.panelInfo.subscribe forces a recomputation to restore it. So not
    // guessing here cannot cause "the reminder never auto-clears".
    var target = currentSessionId
    if (!target) return
    for (var i = 0; i < completions.length; i++) {
      if (targetSessionOf(completions[i]) === target) {
        acknowledgeCompletion(target)
        return
      }
    }
  }

  function warnNavigationError(sessionId, error) {
    console.warn('[dsh-pet-remielle] unable to open session', sessionId, error)
  }
  function openLegacySession(sessionId, completed) {
    if (!ctx || !ctx.sessions || typeof ctx.sessions.open !== 'function') return false
    try {
      ctx.sessions.open(sessionId)
    } catch (e) {
      warnNavigationError(sessionId, e)
      return false
    }
    if (completed) acknowledgeCompletionAfterOpen(sessionId)
    return true
  }
  function openSession(sessionId, completed) {
    if (!sessionId) return
    // The sessions service owns selection and mounts the conversation scope.
    // Completion acknowledgement happens only after opening, so an SSE update
    // cannot replace the clicked card with the idle placeholder first.
    var workspace = optionalService('uiWorkspace')
    if (workspace && typeof workspace.openSession === 'function') {
      try {
        workspace.openSession(sessionId)
        if (completed) acknowledgeCompletionAfterOpen(sessionId)
        return
      } catch (e) {
        warnNavigationError(sessionId, e)
      }
    }
    if (openLegacySession(sessionId, completed)) return
    try {
      window.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: sessionId }))
      window.dispatchEvent(new Event('storage'))
    } catch (e) { /* storage may be unavailable in an embedded shell */ }
  }
  function controlLabel(node) {
    if (!node) return ''
    var aria = typeof node.getAttribute === 'function' ? (node.getAttribute('aria-label') || '') : ''
    return String(node.innerText || node.textContent || aria || '').replace(/\s+/g, ' ').trim()
  }
  function approvalPanels(sessionId) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
    var roots = document.querySelectorAll('[data-conversation-session]')
    if (roots.length > 0) {
      var scoped = []
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r]
        var rootSession = typeof root.getAttribute === 'function' ? root.getAttribute('data-conversation-session') : ''
        if (sessionId && rootSession !== sessionId) continue
        var found = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('[data-approval-key]') : []
        for (var f = 0; f < found.length; f++) scoped.push(found[f])
      }
      return scoped
    }
    var panels = document.querySelectorAll('[data-approval-key]')
    return panels.length === 1 ? panels : []
  }
  function clickNativeAllowOnce(sessionId) {
    if (sessionId && currentSessionIdOf() !== sessionId) return false
    var panels = approvalPanels(sessionId)
    for (var p = 0; p < panels.length; p++) {
      var nodes = panels[p].querySelectorAll('button, [role="button"]')
      for (var i = 0; i < nodes.length; i++) {
        if (/(允许一次|allow once)/i.test(controlLabel(nodes[i]))) {
          nodes[i].click()
          return true
        }
      }
    }
    return false
  }
  function approveSession(sessionId) {
    // Open the conversation so ApprovalPanel mounts, then click the native allow-once
    // button. The DSH host labels it 允许一次 / "Allow once" depending on its own locale, so
    // the matcher below accepts both.
    if (!sessionId || !ctx) return
    var workspace = optionalService('uiWorkspace')
    var canOpen = workspace && typeof workspace.openSession === 'function'
      || ctx.sessions && typeof ctx.sessions.open === 'function'
    if (!canOpen) return
    openSession(sessionId)
    var attempts = 80
    var tryClick = function () {
      var current = currentSessionIdOf()
      if (current === sessionId && clickNativeAllowOnce(sessionId)) return
      if (current !== sessionId) openSession(sessionId)
      if (attempts-- > 0) window.setTimeout(tryClick, 50)
    }
    window.setTimeout(tryClick, 50)
  }
  function currentSessionIdOf() {
    if (activeGlobalPanel()) return undefined
    if (!ctx || !ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.getSnapshot !== 'function') return undefined
    var snapshot = ctx.sessions.list.getSnapshot()
    if (snapshot.current !== undefined) return snapshot.current
    var byId = snapshot.byId || {}
    var ids = Object.keys(byId)
    for (var i = 0; i < ids.length; i++) {
      if ((byId[ids[i]].retainedBy?.mainView ?? 0) > 0) return ids[i]
    }
    return undefined
  }
  function ensureBubbleEl(sessionId) {
    var existing = bubbleEls.get(sessionId)
    if (existing) return existing
    var node = mk('div', 'display:none;')
    node.className = 'rm2-pet-bubble'
    node.setAttribute('role', 'button')
    node.tabIndex = 0
    var header = mk('div', '')
    header.className = 'rm2-pet-bubble-header'
    var completion = mk('span', '')
    completion.className = 'rm2-pet-bubble-completion'
    header.appendChild(completion)
    var action = mk('span', '', '')
    action.className = 'rm2-pet-bubble-action'
    action.setAttribute('aria-label', 'Remielle desktop pet')
    var brandImg = document.createElement('img')
    brandImg.src = withPrefix('/favicon.svg')
    brandImg.alt = ''
    action.appendChild(brandImg)
    var title = mk('div', '')
    title.className = 'rm2-pet-bubble-title'
    header.appendChild(title)
    header.appendChild(action)
    var detail = mk('div', '')
    detail.className = 'rm2-pet-bubble-detail'
    var detailText = document.createElement('span')
    detail.appendChild(detailText)
    var stackCount = document.createElement('span')
    stackCount.className = 'rm2-pet-bubble-stack-count'
    node.appendChild(header)
    node.appendChild(detail)
    node.appendChild(stackCount)
    var el = { node: node, title: title, detail: detail, detailText: detailText, action: action, brandImg: brandImg, stackCount: stackCount, targetSessionId: sessionId, canApprove: false, lastText: '', lastDetail: '', naturalHeaderWidth: 0, titleMood: '', titleChangedAt: 0, titleTimer: 0, pendingTitle: '', pendingMood: '' }
    var activate = function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (el.node.dataset.idlePlaceholder === 'true') return
      // Fake backboard: on click, resolve the 2nd-ranked session dynamically from this
      // frame's ordering and jump to it.
      if (el.targetSessionId === BUBBLE_BACKBOARD_ID) {
        var target = backboardStabilizer.target()
        if (target) openSession(target, false)
        return
      }
      openSession(el.targetSessionId, el.completed)
    }
    action.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (el.canApprove) approveSession(el.targetSessionId)
      else openSession(el.targetSessionId, el.completed)
    })
    node.addEventListener('pointerdown', function (event) { event.stopPropagation() })
    node.addEventListener('click', activate)
    node.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') activate(event)
    })
    node.addEventListener('mouseenter', function () { showPetTip(node) })
    node.addEventListener('mouseleave', hidePetTip)
    bubbleStack.appendChild(node)
    bubbleEls.set(sessionId, el)
    return el
  }
  var clearBubbleTitleTimer = __bubbleTitle.clearBubbleTitleTimer
  var commitBubbleTitle = __bubbleTitle.commitBubbleTitle
  var applyBubbleTitle = __bubbleTitle.applyBubbleTitle
  function renderBubble(el, entry, index) {
    var text = entry.message || ''
    var detail = entry.detail || ''
    if (entry.backboard) {
      commitBubbleTitle(el, '', '')
      __bubbleTitle.applyBackboardChrome(el, entry, index)
      if (petTipAnchor === el.node) showPetTip(el.node)
      return
    }
    if (!text && !detail) {
      commitBubbleTitle(el, '', entry.mood || '')
      el.node.style.display = 'none'
      if (petTipAnchor === el.node) hidePetTip()
      return
    }
    applyBubbleTitle(el, entry)
    // The detail line is a single line of text, so use block to make overflow/ellipsis
    // work (display:flex would break text-overflow)
    var shown = __bubbleTitle.detailShown(detail)
    el.detail.style.display = detail ? 'block' : 'none'
    if (detail !== el.lastDetail) {
      el.lastDetail = detail
      el.detailText.textContent = shown
    }
    var attention = attentionOf(entry)
    var approval = approvalOf(entry)
    var planReview = planReviewOf(entry)
    var completed = completionOf(entry)
    el.targetSessionId = targetSessionOf(entry)
    el.canApprove = approval
    el.completed = completed
    // The placeholder card must not be interactive (activate has a guard), so its tip must
    // not fall into the generic "click to jump here" copy.
    __bubbleTitle.applyCardChrome(el, entry, index, {
      detailShown: shown,
      planSummary: __bubbleTitle.planSummaryOf(shown),
      approval: approval,
      planReview: planReview,
      completed: completed,
      attention: attention,
    })
    if (petTipAnchor === el.node) showPetTip(el.node)
  }
  // Kept identical to the success copy pool of the host's src/status-copy.js (the web
  // bundle does not include that module, so it is inlined here).
  var SUCCESS_COPY_POOL = ['That task is done~', 'This round went smoothly~', 'Job finished, not bad~']
  function seedNumberOf(seed) {
    var text = String(seed == null ? '' : seed)
    var total = 0
    for (var i = 0; i < text.length; i++) total += text.charCodeAt(i)
    return Math.abs(total)
  }
  function updateBubbles(snapshot) {
    if (!snapshot) return
    // A present sessions[] is authoritative even when empty. Falling back to
    // the legacy singleton only when the field is absent prevents an IDLE
    // snapshot from resurrecting bubbles for turns that already stopped.
    var sessions = Array.isArray(snapshot.sessions)
      ? snapshot.sessions
      : [snapshot] // legacy single-session snapshot
    var foreground = isForegroundSurface()
    var currentVisible = foreground && !activeGlobalPanel()
    // Be defensive against an older Host process that still includes settled
    // records. The browser deck never renders durable inactive sessions.
    sessions = sessions.filter(function (entry) {
      return entry && entry.state !== 'IDLE' && entry.state !== 'DISCONNECTED'
    })
    // Opening a session means it has been read: a durable ERROR on the current conversation
    // is no longer treated as a reminder card (same meaning as the completion green dot).
    // The host settles that session to IDLE; remove it from the deck here so we do not have
    // to wait for the next SSE frame.
    if (currentVisible && currentSessionId) {
      sessions = sessions.filter(function (entry) {
        return !(entry && entry.state === 'ERROR' && targetSessionOf(entry) === currentSessionId)
      })
    }
    sessions = sessions.map(function (entry) {
      if (!currentVisible || !entry || !completionOf(entry) || targetSessionOf(entry) !== currentSessionId) return entry
      // Read state is not handled here (see ackCurrentSessionCompletion: rendering is
      // short-circuited in desktop mode); this only removes already-read cards from the deck.
      if (entry.state === 'SUCCESS' && entry.pulseUntil > Date.now()) {
        return { ...entry, completionNotification: false }
      }
      return null
    }).filter(Boolean)
    // Fallback: the plugin's completion reminder only accepts SUCCESS, while the DSH
    // sidebar green dot (SessionSummary.completed) covers any session that "finished
    // running" (including interrupted / stopped / abnormally terminated ones). Here those
    // "the sidebar shows a green dot but the host did not generate a completion card"
    // sessions are pulled in from sessions.list.getSnapshot().byId; existingIds
    // deduplicates so they do not collide with the host-generated completion:<id> cards.
    try {
      if (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === 'function') {
        var listSnap = ctx.sessions.list.getSnapshot()
        var byId = (listSnap && typeof listSnap.byId === 'object') ? listSnap.byId : null
        var existingIds = new Set()
        for (var ei = 0; ei < sessions.length; ei++) existingIds.add(sessions[ei].sessionId)
        if (byId) {
          for (var sid in byId) {
            if (!Object.prototype.hasOwnProperty.call(byId, sid)) continue
            var item = byId[sid]
            if (!item || item.completed !== true) continue
            // Sub-sessions (subagents) never enter the deck: with the switch on, the host
            // generates a completion:<sid> card by itself (the reducer only ignores
            // sub-session events when includeSubagents=false), and synthesizing one on top
            // of that would show sub-agent completion reminders even to users who turned
            // the switch off.
            // Only origin is checked — parentId must not be skipped along with it: forked
            // sessions also carry a parentId but are not sub-agents, and when one is
            // interrupted/stopped the host does not generate a completion card (only a
            // clean finish is queued), so the web fallback is the only reminder source in
            // that case.
            if (item.origin === 'subagent') continue
            if (existingIds.has(sid) || existingIds.has('completion:' + sid)) continue
            if (item.running === true || (currentVisible && sid === currentSessionId)) continue
            sessions.push({
              sessionId: 'completion:' + sid,
              targetSessionId: sid,
              state: 'SUCCESS',
              completed: true,
              completionNotification: true,
              // The title must not use displayTitle/title (that is the session's first user
              // message verbatim, and putting it straight into the bubble would leak the raw
              // prompt text into the bubble's first line); use fixed copy from the same pool
              // as the host's status-copy.js success variants. The seed is the sessionId, so
              // the same card keeps stable copy.
              message: SUCCESS_COPY_POOL[seedNumberOf(sid) % SUCCESS_COPY_POOL.length],
              detail: (item.cwd && String(item.cwd).split(/[\\/]/).filter(Boolean).pop())
                ? 'Done · ' + String(item.cwd).split(/[\\/]/).filter(Boolean).pop()
                : 'Done',
              title: item.title,
              project: (item.cwd && String(item.cwd).split(/[\\/]/).filter(Boolean).pop()) || undefined,
              mood: '03',
              updatedAt: item.updatedAt || Date.now(),
            })
            existingIds.add('completion:' + sid)
          }
          sessions = sessions.map(function (entry) {
            if (!entry || entry.title) return entry
            var tid = targetSessionOf(entry)
            var row = byId[tid] || byId[entry.sessionId]
            if (!row || !row.title) return entry
            return Object.assign({}, entry, { title: row.title })
          })
        }
      }
    } catch (e) { /* an occasional sessions.list error must not block deck rendering; the backboard tip falls back to project / voice when the title is missing */ }
    var liveTargets = new Set()
    for (var li = 0; li < sessions.length; li++) {
      if (!completionOf(sessions[li])) liveTargets.add(targetSessionOf(sessions[li]))
    }
    if (liveTargets.size > 0) {
      sessions = sessions.filter(function (entry) {
        return !completionOf(entry) || !liveTargets.has(targetSessionOf(entry))
      })
    }
    if (sessions.length === 0 && snapshot.enabled !== false) {
      sessions = [{
        sessionId: '__pet_idle__',
        state: 'IDLE',
        mood: snapshot.mood || '06',
        message: snapshot.message || 'Remielle is idling~',
        detail: '',
        phase: 'idle',
        updatedAt: snapshot.updatedAt || 0,
        idlePlaceholder: true,
      }]
    }
    var ordered = orderSessions(sessions)
    // Pet body follows the top bubble's mood.
    var topEntry = ordered[0]
    if (topEntry && topEntry.mood) snapshot.mood = topEntry.mood
    // The deck only renders the first-layer real cards; the second layer is a contentless
    // fake backboard (only +N), so the 2nd-ranked session's text and icon are never
    // rendered — which is why same-tier sessions rotating by updatedAt do not make the
    // background card visibly swap.
    // Clicking the backboard resolves the 2nd rank dynamically from this frame's ordering
    // and jumps to it; here we only need to remember who it is.
    var visibleEntries = ordered.slice(0, 1)
    if (ordered.length > 1) {
      backboardStabilizer.update(
        targetSessionOf(ordered[1]) || '',
        __tip.backboardTipText(ordered[1].project, ordered[1].title),
      )
      visibleEntries.push({
        sessionId: BUBBLE_BACKBOARD_ID,
        state: 'IDLE',
        message: '',
        detail: '',
        phase: '',
        updatedAt: 0,
        backboard: true,
        summaryCount: ordered.length - 1,
        backboardTip: backboardStabilizer.tip(),
      })
    } else {
      backboardStabilizer.update('', '')
    }
    var count = visibleEntries.length
    var seen = new Set()
    var measuredWidth = 150
    bubbleStack.style.width = 'fit-content'
    // Render each card at intrinsic width first, then set the deck width from
    // the TOP card only (lower cards' content is hidden, so only the top
    // card should drive the deck width; this keeps the top card stable).
    for (var i = 0; i < count; i++) {
      var entry = visibleEntries[i]
      seen.add(entry.sessionId)
      var bubbleEl = ensureBubbleEl(entry.sessionId)
      if (bubbleEl.node.parentNode !== bubbleStack) bubbleStack.appendChild(bubbleEl.node)
      renderBubble(bubbleEl, entry, i)
      bubbleEl.node.style.minWidth = '200px'
      bubbleEl.node.style.width = 'max-content'
      bubbleEl.node.style.maxWidth = 'none'
      bubbleEl.node.classList.remove('title-clipped')
      var titleWidth = bubbleEl.title.scrollWidth || bubbleEl.title.offsetWidth || 0
      // The whale icon stays visible on completion, so its width is always counted in
      // (it used to be set to 0 when the whale was hidden after completion)
      var actionWidth = 40
      var completionWidth = completionOf(entry) ? 29 : 0
      bubbleEl.naturalHeaderWidth = titleWidth + actionWidth + completionWidth
      // The width is decided by the wider of the two lines (title line or detail line,
      // take the wider + padding); the cap is applied by bubbleRowWidth's
      // min(440, viewport-24) below, and only when that cap is exceeded does the detail
      // line's ellipsis clip the content — matching the "widest line decides the width +
      // maximum width limit" design.
      var detailW = bubbleEl.detail.scrollWidth || bubbleEl.detail.offsetWidth || 0
      if (i === 0) measuredWidth = Math.max(bubbleEl.naturalHeaderWidth, detailW)
      bubbleEl.node.style.maxWidth = ''
      bubbleEl.node.style.width = '100%'
    }
    var deckWidth = bubbleRowWidth(measuredWidth)
    var deckWidthPx = deckWidth + 'px'
    if (bubbleStack.style.width !== deckWidthPx) bubbleStack.style.width = deckWidthPx
    for (var j = 0; j < count; j++) {
      var renderEntry = visibleEntries[j]
      var renderEl = bubbleEls.get(renderEntry.sessionId)
      renderBubble(renderEl, renderEntry, j)
      renderEl.node.classList.toggle('title-clipped', renderEl.naturalHeaderWidth > Math.max(0, deckWidth - 67))
    }
    for (var key of bubbleEls.keys()) {
      if (!seen.has(key)) {
        var el = bubbleEls.get(key)
        clearBubbleTitleTimer(el)
        if (el && el.node && el.node.remove) el.node.remove()
        bubbleEls.delete(key)
      }
    }
    // The switching dot is centered on the top card (the first readable card), matching
    // the balance page (not centered on the whole stack area)
    if (bubbleDots && ordered[0] && bubbleEls.get(ordered[0].sessionId)) {
      var topNode = bubbleEls.get(ordered[0].sessionId).node
      if (bubbleDots.parentNode !== topNode) topNode.appendChild(bubbleDots)
    }
    bubbleStack.style.display = snapshot.bubble !== false && count > 0 ? 'flex' : 'none'
    if (count === 0) bubbleStack.style.width = ''
  }
  // Follow the user's current conversation so its bubble ranks on top of
  // same-priority peers (the "which dialog is on top" rule).
  function syncCurrentSession(force) {
    if (disposed) return
    if (activeGlobalPanel()) {
      clearReportedCurrentSession()
      return
    }
    var next = currentSessionIdOf()
    if (!force && next === currentSessionId) return
    currentSessionId = next
    reportCurrentSession(next)
    if (next && lastSnapshot && Array.isArray(lastSnapshot.sessions)) {
      var openedCompletion = lastSnapshot.sessions.some(function (entry) {
        return entry && targetSessionOf(entry) === next && completionOf(entry)
      })
      if (openedCompletion && isViewingConversation()) acknowledgeCompletion(next)
    }
    // Everything goes through updateBubble: it carries the balance-page gating, and calling
    // updateBubbles directly would force the deck visible while the balance page is open,
    // briefly overlapping the single bubble
    if (lastSnapshot) updateBubble(lastSnapshot)
  }
  if (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.effect === 'function') {
    var sessionList = ctx.sessions.list
    currentSessionId = currentSessionIdOf()
    reportCurrentSession(currentSessionId)
    ctx.effect(function () {
      return sessionList.subscribe(function () { syncCurrentSession(false) })
    })
    var layout = optionalService('layout')
    if (layout && layout.panelInfo && typeof layout.panelInfo.subscribe === 'function') {
      var panelWasActive = activeGlobalPanel()
      ctx.effect(function () {
        return layout.panelInfo.subscribe(function () {
          var panelActive = activeGlobalPanel()
          var reopened = panelWasActive && !panelActive
          panelWasActive = panelActive
          syncCurrentSession(reopened)
        })
      })
    }
  }
  function updateBubble(snapshot) {
    if (!snapshot) return
    // When the bubble goes from nothing to something (master switch off → on), go back to
    // the status page
    var bubbleEnabled = snapshot.showBubble !== false && (snapshot.showBubbleStatus !== false || snapshot.showBubbleUsage === true)
    if (bubbleEnabled && !prevBubbleVisible && currentBubblePage !== 0) {
      currentBubblePage = 0
      balanceFrame = null
      balanceRequested = false
    }
    prevBubbleVisible = bubbleEnabled
    // Sub-switch evaluation
    var statusOn = snapshot.showBubble !== false && snapshot.showBubbleStatus !== false
    var usageOn = snapshot.showBubble !== false && snapshot.showBubbleUsage === true
    var bothOn = statusOn && usageOn
    var anyOn = statusOn || usageOn
    // Forced page assignment: usage only → balance page; status only → status page
    var pageBefore = currentBubblePage
    if (!statusOn && usageOn && currentBubblePage === 0) { currentBubblePage = 1 }
    if (statusOn && !usageOn) { currentBubblePage = 0 }
    if (statusOn && usageOn && currentBubblePage > 1) { currentBubblePage = 0 }
    if (currentBubblePage !== pageBefore) {
      if (currentBubblePage === 0) balanceFrame = null
    }
    // Entering the balance page with no balance data yet: trigger one fetch (deferred so it
    // does not re-enter updateBubble synchronously)
    if (currentBubblePage === 1 && !(balanceFrame && balanceFrame.kind === 'balance') && window.__petBalance && !balanceRequested) {
      balanceRequested = true
      window.setTimeout(function () { if (window.__petBalance) window.__petBalance.showBalance() }, 0)
    }
    if (currentBubblePage === 0) balanceRequested = false
    // The bubble always captures clicks and the wheel: this prevents clicks and wheel
    // events from passing through to the pet and triggering interactions / scaling (the
    // status page and the balance page behave identically).
    // The deck container must be hit-testable too: otherwise wheel/click events landing in
    // the gap between cards would reach the dock (scale / switch reaction).
    var bubblePointer = snapshot.showBubble !== false ? 'auto' : 'none'
    bubble.style.pointerEvents = bubblePointer
    bubbleStack.style.pointerEvents = bubblePointer
    // Dot: only shown when both are on (a single dot; clicking switches)
    bubbleDots.style.display = bothOn ? '' : 'none'
    syncDotTip()
    var cur = currentBubblePage
    var show = anyOn && (cur === 0 ? statusOn : usageOn)
    if (cur === 0) {
      // Status page: show the stacked session cards (one per session + the +N backboard)
      show = show && statusOn
      bubbleStack.style.display = show ? 'flex' : 'none'
      if (show) updateBubbles(snapshot)
      // The dot is attached to the top card by updateBubbles (the first readable card) and
      // centered there; the status page shows no single bubble, so it cannot overlap the
      // stacked cards as an empty bubble
      bubble.style.display = 'none'
      bubble.classList.remove('rm2-bubble-balance')
      bubbleTitle.textContent = ''
      bubbleDetail.textContent = ''
    } else if (cur === 1) {
      // Balance page: hide the stacked cards, render the balanceFrame data
      bubbleStack.style.display = 'none'
      if (bubbleDots.parentNode !== bubble) bubble.appendChild(bubbleDots)
      bubble.classList.add('rm2-bubble-balance')
      show = show && !!balanceFrame && balanceFrame.kind === 'balance'
      // Even without balance data yet, show the bubble container (at least keep the dot, so
      // the user can switch back to the status page); with usage-only and the balance frame
      // not ready the container is kept too (showing "Loading balance…") instead of the
      // whole bubble vanishing
      bubble.style.display = 'block'
      if (show) {
        bubbleTitle.textContent = (balanceFrame.label || 'DeepSeek balance') + '  ' + (balanceFrame.amount || '--')
        bubbleTitle.style.color = ''
        // The period gets its own color: assembled from textContent + a span, which rules
        // out HTML injection passed through from the upstream currency
        bubbleDetail.textContent = ''
        bubbleDetail.appendChild(document.createTextNode(balanceFrame.detail || ''))
        var periodSpan = document.createElement('span')
        periodSpan.style.color = balanceFrame.color || '#888'
        periodSpan.textContent = ' · ' + (balanceFrame.period || '')
        bubbleDetail.appendChild(periodSpan)
        // Measure both text lines precisely with the real rendering font; the width reuses
        // the same rule as for conversation cards (widest line + padding, min/max clamp)
        var titleText = (balanceFrame.label || 'DeepSeek balance') + '  ' + (balanceFrame.amount || '--')
        var detailText = (balanceFrame.detail || '') + ' · ' + (balanceFrame.period || '')
        var maxTextW = Math.max(measureTextW(bubbleTitle, titleText), measureTextW(bubbleDetail, detailText))
        bubble.style.width = bubbleRowWidth(maxTextW) + 'px'
      } else {
        bubbleTitle.textContent = 'Loading balance…'
        bubbleDetail.textContent = ''
      }
    }
  }

  /** After a pulse overlay expires the host falls back to the durable state; schedule one refresh. */
  function schedulePulseFallback(snapshot) {
    if (!snapshot.pulseUntil || snapshot.pulseUntil <= Date.now()) return
    window.clearTimeout(pulseFallbackTimer)
    pulseFallbackTimer = window.setTimeout(function () {
      fetchState().then(applySnapshot)
    }, snapshot.pulseUntil - Date.now() + 60)
  }

  /** Single entry point for both polling and the SSE stream. */
  function applySnapshot(snapshot) {
    if (disposed || !snapshot) return
    if (snapshot.kind === 'session-action') {
      if (snapshot.sessionId && snapshot.approve) approveSession(snapshot.sessionId)
      // Desktop floating window clicking a bubble card (approve=false): only jump to that
      // conversation; a completion card also acks on the way.
      else if (snapshot.sessionId) openSession(snapshot.sessionId, snapshot.completed === true)
      return
    }
    if (snapshot.kind === 'download') {
      if (snapshot.phase === 'confirm') {
        // The dialog must be reset as a whole: the previous round's done/error state hides
        // the OK button and turns Cancel into "Close". Without a full reset, the "Start
        // download" button simply does not exist in the dialog that pops up again and the
        // user can only close it → the dialog loops and downloading never starts (observed
        // in DSH Desktop).
        confirmOk.disabled = false
        confirmOk.style.display = ''
        confirmOk.textContent = 'Start download'
        confirmCancel.disabled = false
        confirmCancel.textContent = 'Cancel'
        confirmCancel.style.display = ''
        confirmProgress.style.display = 'none'
        confirmOverlay.style.display = 'flex'
      } else if (snapshot.phase === 'start') {
        confirmOk.textContent = 'Downloading…'
        confirmCancel.style.display = 'none'
        confirmProgress.style.display = 'block'
        confirmPctText.textContent = 'Downloading Electron…'
        confirmFill.style.width = '0%'
      } else if (snapshot.phase === 'progress') {
        if (snapshot.percent >= 0) {
          confirmFill.style.width = snapshot.percent + '%'
          confirmPctText.textContent = snapshot.text || ('Downloading ' + snapshot.percent + '%')
        } else {
          confirmPctText.textContent = snapshot.text || 'Downloading…'
        }
      } else if (snapshot.phase === 'done') {
        confirmFill.style.width = '100%'
        confirmPctText.textContent = 'Electron is ready ✓'
        confirmOk.style.display = 'none'
        confirmCancel.textContent = 'Close'
        confirmCancel.style.display = ''
        setTimeout(function () { confirmOverlay.style.display = 'none' }, 1500)
      } else if (snapshot.phase === 'error') {
        confirmPctText.textContent = snapshot.text || 'Download failed — the in-page pet stays available'
        confirmFill.style.width = '0%'
        confirmOk.style.display = 'none'
        confirmCancel.textContent = 'Close'
        confirmCancel.style.display = ''
      }
      return
    }
    var wasDesktopMode = lastSnapshot && lastSnapshot.desktopMode === true
    lastSnapshot = snapshot
    // Read state is a side effect and must be handled before the render short-circuit
    // (desktopActive / pendingDesktopHide): in desktop mode the page pet is hidden and the
    // whole render block is skipped, but "I watched it finish" still holds.
    ackCurrentSessionCompletion(snapshot)
    // Balance controller: initialize / sync the usage mode; stop the 60s polling when the
    // usage sub-switch is off
    if (window.__petBalance) {
      var usageEnabled = snapshot.showBubble !== false && snapshot.showBubbleUsage === true
      window.__petBalance.setEnabled(usageEnabled)
      if (!window.__petBalanceInited) {
        window.__petBalanceInited = true
        window.__petBalance.init(snapshot.usageMode || 'ledger')
      } else if (snapshot.usageMode) {
        window.__petBalance.setUsageMode(snapshot.usageMode)
      }
    }
    // The desktop pet window is showing; keep the page pet hidden to avoid
    // two pets on screen. Restores automatically when the window goes away.
    if (snapshot.desktopActive === true) {
      pendingDesktopHide = false
      if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
      if (root.style.display !== 'none') {
        root.style.display = 'none'
        closeMenu()
      }
      return
    }
    if (snapshot.desktopMode === true && !wasDesktopMode) {
      pendingDesktopHide = true
      armDesktopHideTimer()
    }
    if (snapshot.desktopMode !== true) {
      pendingDesktopHide = false
      if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
    }
    if (pendingDesktopHide) {
      if (root.style.display !== 'none') {
        root.style.display = 'none'
        closeMenu()
      }
      return
    }
    if (root.style.display === 'none' && !hidden) {
      setHidden(false)
    }
    applyVisuals(snapshot)
    if (!positionRestored && snapshot.posX != null && snapshot.posY != null) {
      positionRestored = true
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      root.style.left = snapshot.posX + 'px'
      root.style.top = snapshot.posY + 'px'
    }
    if (snapshot.petId && snapshot.petId !== currentPetId) {
      currentPetId = snapshot.petId
      displayedMood = null
    }
    updateBubble(snapshot)
    // Briefly show "Pleased" (03) when the agent's reply finishes (triggered only once, to
    // avoid repeats)
    if (snapshot.state === 'IDLE' && snapshot.phase === 'turn-end' && !manualOverride && !lastTurnEndShown) {
      lastTurnEndShown = true
      manualOverride = { mood: '03', until: Date.now() + 2000 }
    }
    if (snapshot.state !== 'IDLE') lastTurnEndShown = false
    var wantHidden = snapshot.enabled === false || snapshot.hidden === true
    if (wantHidden && !hidden) setHidden(true)
    else if (!wantHidden && hidden) setHidden(false)
    if (wantHidden) return
    if (snapshot.paused === true && !paused) setPaused(true)
    else if (snapshot.paused !== true && paused) setPaused(false)
    sync()
    schedulePulseFallback(snapshot)
  }

  function poll() {
    if (disposed) return
    fetchState().then(applySnapshot)
  }

  /** Subscribe to the host SSE stream; slow the poll down to a fallback. */
  function startStream() {
    if (stream || typeof EventSource === 'undefined') return
    var source
    try {
      source = new EventSource(STREAM_ENDPOINT)
    } catch (e) {
      return
    }
    stream = source
    source.onmessage = function (e) {
      if (disposed) return
      var snapshot
      try {
        snapshot = JSON.parse(e.data)
      } catch (err) {
        return
      }
      applySnapshot(snapshot)
    }
    // EventSource reconnects on its own; the slower poll keeps convergence
    // (registry changes, dead streams) without spamming the server.
    window.clearInterval(intervalId)
    intervalId = window.setInterval(poll, STABLE_POLL_MS)
  }

  function resetPos() {
    root.style.left = ''
    root.style.top = ''
    root.style.right = '20px'
    root.style.bottom = '20px'
    // Both position stores are cleared together: the in-page coordinates live in
    // posX/posY, the desktop window coordinates in desktopX/desktopY.
    // Clearing only the former would make "Reset position" stop working after switching to
    // desktop mode (the desktop window would still sit where it was dragged to last).
    void patchConfigFields({ posX: null, posY: null, desktopX: null, desktopY: null })
    positionRestored = true
  }

  function setHidden(v) {
    hidden = v
    if (v) {
      root.style.display = 'none'
    } else {
      root.style.display = ''
    }
    closeMenu()
  }

  function setPaused(v) {
    paused = v
    if (paused) {
      freezeCurrentFrame()
      dock.title = 'Paused (resume from the right-click menu)'
    } else {
      var animated = img.dataset.animated
      delete img.dataset.animated
      if (animated && animated !== img.src) img.src = animated
      else showMood(currentMood)
      dock.title = 'Drag me · Click to interact · Right-click menu'
    }
  }

  // Pause = freeze on "whichever frame was showing at the moment you pressed".
  // A plain canvas.drawImage(img) does not work: Chromium only ever draws the first frame of
  // an animated GIF (measured: 20 sampled signatures are all identical, see
  // src/gif-frame.cjs), so the old implementation snapped back to the starting pose.
  // Here the current frame index is located by elapsed playback time, that frame is decoded,
  // and then swapped in; if it cannot be decoded (no ImageDecoder outside a secure context /
  // not a GIF) we fall back to a first-frame snapshot, so the pause switch itself never
  // fails.
  function freezeCurrentFrame() {
    var url = img.src
    if (!__gifFrame.isGif(url)) { snapshotFirstFrame(); return }
    var elapsed = __gifFrame.livedMs(img) // read the instant first: decode time must not count into the animation progress
    void __gifFrame.freeze(url, elapsed).then(function (dataUrl) {
      // Playback resumed or the sticker changed in the meantime: drop this result rather than
      // pinning the pet to an old frame
      if (!paused || img.src !== url) return
      if (!dataUrl) { snapshotFirstFrame(); return }
      img.dataset.animated = url
      img.src = dataUrl
    })
  }

  // First-frame fallback (= the old behavior): what drawImage returns is the first frame.
  function snapshotFirstFrame() {
    try {
      var canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || 180
      canvas.height = img.naturalHeight || 180
      var g = canvas.getContext('2d')
      if (g && img.src) {
        g.drawImage(img, 0, 0, canvas.width, canvas.height)
        img.dataset.animated = img.src
        img.src = canvas.toDataURL('image/png')
      }
    } catch (e) { /* keep animating */ }
  }

  // Per-mood alignment offset (legacy, kept for API compat). Since all GIFs
  // are now the same size, this just sets a consistent width.
  function applyOffset(mood) {
    var scale = (lastSnapshot && lastSnapshot.scale) || 1
    img.style.width = Math.round(180 * scale) + 'px'
    applyMirror(lastSnapshot)
  }

  // Sticker URLs resolve per active pet; a missing artwork falls back to the
  // default pet once so a stale petId (deleted dir) still shows something.
  function showMood(mood) {
    var petId = currentPetId
    var src = gifUrl(petId, mood)
    if (img.dataset.mood === mood && img.src) {
      // Same sticker already displayed: update only the alignment offset,
      // keep the running GIF animation untouched.
      applyOffset(mood)
      displayedMood = mood
      return
    }
    img.onerror = function () {
      if (petId !== DEFAULT_PET_ID) {
        petId = DEFAULT_PET_ID
        currentPetId = petId
        img.onerror = null
        img.src = gifUrl(petId, mood)
      } else {
        img.onerror = null
        img.style.display = 'none'
      }
    }
    img.src = src
    img.dataset.mood = mood
    img.style.display = 'block'
    applyOffset(mood)
    displayedMood = mood
  }

  /** Pop a random pic artwork (double-click drawing): thick brush sweeps from the
   *  top-left corner down to the bottom-right, moving back and forth along the
   *  current diagonal edge and painting the picture only where it passes. */
  var PIC_DRAW_MS = 6000 // brush drawing duration == the duration of showing "Drawing (01)"
  var picTimer = 0
  var picFadeTimer = 0
  var picHideTimer = 0
  var picRevealRaf = 0
  var picLoads = []
  function picStop() {
    if (picTimer) { window.clearTimeout(picTimer); picTimer = 0 }
    if (picFadeTimer) { window.clearTimeout(picFadeTimer); picFadeTimer = 0 }
    if (picHideTimer) { window.clearTimeout(picHideTimer); picHideTimer = 0 }
    if (picRevealRaf) { window.cancelAnimationFrame(picRevealRaf); picRevealRaf = 0 }
  }
  var picSeq = 0
  function showPic() {
    var snap = lastSnapshot
    var count = snap && snap.pics ? snap.pics : 0
    if (!count) return
    var n = Math.floor(Math.random() * count) + 1
    var src = withPrefix(ASSETS_PREFIX) + '/' + encodeURIComponent(currentPetId) + '/pics/' + n + '.png'
    // Consecutive double-clicks: showPic starts with an internal picStop that clears the
    // previous round's animation and all timers, then immediately starts a new round
    picStop()
    // And immediately clears the canvas content: the previous picture must not linger while
    // the new one has not finished loading
    var pg = picEl.getContext('2d')
    if (pg && picEl.width > 0 && picEl.height > 0) pg.clearRect(0, 0, picEl.width, picEl.height)
    picEl.style.display = 'block'
    picEl.style.opacity = '1'
    picEl.style.transition = 'none'
    var seq = ++picSeq
    var img = new Image()
    img.src = src
    picLoads.push(img)
    if (picLoads.length > 3) picLoads.shift()
    img.onload = function () {
      if (seq !== picSeq) return // a late old image load: a new round already started, drop it
      brushReveal(img)
    }
  }

  function brushReveal(img) {
    var W = img.naturalWidth || 220
    var H = img.naturalHeight || 220
    picEl.width = W
    picEl.height = H
    var g = picEl.getContext('2d')
    g.clearRect(0, 0, W, H)
    var D = W + H                // diagonal travel distance
    var r = Math.max(W, H) * 0.15 // brush thickness (a bit thicker)
    var T = PIC_DRAW_MS           // reveal duration == the duration of "Drawing (01)"
    var t0 = null

    function lineAt(dd) {
      var ax = Math.max(0, dd - H), ay = dd - ax
      var by = Math.max(0, dd - W), bx = dd - by
      return { ax: ax, ay: ay, bx: bx, by: by }
    }

    function frame(ts) {
      if (t0 === null) t0 = ts
      var p = Math.min(1, (ts - t0) / T)
      if (p >= 1) {
        g.globalAlpha = 1
        g.globalCompositeOperation = 'source-over'
        g.drawImage(img, 0, 0, W, H)
        afterReveal()
        return
      }
      var d = D * p
      var L = lineAt(d)
      // the brush travels back and forth along the edge line (ping-pong loop):
      // top end → left end → top end → left end … The picture
      // appears along the path the brush has already passed.
      var half = 440                                   // ms per one-way trip
      var ph = (ts - t0) % (half * 2)
      var s = ph < half ? ph / half : 1 - (ph - half) / half
      for (var k = 0; k < 2; k++) {
        var sk = Math.min(1, Math.max(0, s + k * 0.04))
        // s=0 at the top end, s=1 at the left end
        var cx = L.bx + (L.ax - L.bx) * sk
        var cy = L.by + (L.ay - L.by) * sk
        // add a little randomness to the brush path so the strokes are less regular
        cx += (Math.random() - 0.5) * r * 0.6
        cy += (Math.random() - 0.5) * r * 0.6
        var rr = r * (0.85 + 0.3 * Math.random())
        // crisp opaque brush stamp: punch the sharp image through a hard clip
        g.save()
        g.beginPath()
        g.arc(cx, cy, rr, 0, Math.PI * 2)
        g.clip()
        g.globalAlpha = 1
        g.globalCompositeOperation = 'source-over'
        g.drawImage(img, 0, 0, W, H)
        g.restore()
      }
      picRevealRaf = window.requestAnimationFrame(frame)
    }
    picRevealRaf = window.requestAnimationFrame(frame)
  }

  function afterReveal() {
    // Switch to "Pleased" (03) the moment drawing finishes, so "Idle" (06) never flashes in
    // between.
    manualOverride = { mood: '03', until: Date.now() + 2200 }
    sync()
    picTimer = window.setTimeout(function () {
      picFadeTimer = window.setTimeout(function () {
        picEl.style.transition = 'opacity 0.8s ease-out'
        picEl.style.opacity = '0'
        // The closing timer must be cancellable too: after a new round starts it must not
        // fade out the new canvas
        picHideTimer = window.setTimeout(function () { picEl.style.display = 'none'; picEl.style.transition = '' }, 800)
      }, 2200)
    }, 0)
  }

  function sync() {
    var now = Date.now()
    var mood = currentMood
    if (manualOverride && now < manualOverride.until) {
      mood = manualOverride.mood
    } else {
      manualOverride = null
      if (lastSnapshot && lastSnapshot.mood) mood = lastSnapshot.mood
    }
    if (mood !== currentMood) currentMood = mood
    if (!paused && displayedMood !== currentMood) showMood(currentMood)
  }

  function poll() {
    if (disposed) return
    fetchState().then(function (snapshot) {
      applySnapshot(snapshot)
    })
  }

  intervalId = window.setInterval(poll, POLL_MS)
  poll()
  startStream()

  // ---- interactions ----
  var dragMoved = false
  dock.addEventListener('pointerdown', function (e) {
    if ((e.button !== undefined && e.button !== 0) || lockedNow) return
    e.preventDefault()
    var rect = dock.getBoundingClientRect()
    var startX = e.clientX - rect.left
    var startY = e.clientY - rect.top
    var ox = e.clientX
    var oy = e.clientY
    dragMoved = false
    petDragging = true
    syncPetCursor()
    function onMove(ev) {
      if (Math.abs(ev.clientX - ox) + Math.abs(ev.clientY - oy) > 6) dragMoved = true
      root.style.right = 'auto'
      root.style.bottom = 'auto'
      var w = root.offsetWidth || 180
      var h = root.offsetHeight || 180
      var x = Math.max(0, Math.min(window.innerWidth - w, ev.clientX - startX))
      var y = Math.max(0, Math.min(window.innerHeight - h, ev.clientY - startY))
      root.style.left = x + 'px'
      root.style.top = y + 'px'
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      petDragging = false
      syncPetCursor()
      if (dragMoved) {
        var r = root.getBoundingClientRect()
        patchConfig('posX', Math.round(r.left))
        patchConfig('posY', Math.round(r.top))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  })

  dock.addEventListener('click', function () {
    if (dragMoved) return
    var candidates = MOOD_ORDER.filter(function (m) { return m !== currentMood })
    var pick = candidates[Math.floor(Math.random() * candidates.length)]
    manualOverride = { mood: pick, until: Date.now() + 1800 }
    sync()
  })

  // Balance controller: render the display frame into its own bubble (the script loads
  // asynchronously, so keep retrying until it is ready)
  var unsubBalance = null
  var balanceWaitTimer = null
  function whenPetBalance(cb) {
    if (window.__petBalance) { cb(); return }
    var tries = 0
    balanceWaitTimer = window.setInterval(function () {
      tries++
      if (window.__petBalance) {
        window.clearInterval(balanceWaitTimer)
        balanceWaitTimer = null
        cb()
      } else if (tries > 60) {
        window.clearInterval(balanceWaitTimer)
        balanceWaitTimer = null
      }
    }, 100)
  }
  whenPetBalance(function () {
    // Keep the unsubscribe function: it is called when the plugin unloads, otherwise the
    // old closure stays strongly referenced forever through the widget's listeners
    unsubBalance = window.__petBalance.subscribe(function (frame) {
      // Only store the data, do not render the bubble directly; bubble rendering is decided
      // uniformly by updateBubble based on currentBubblePage
      balanceFrame = frame
      // Deferred rendering, to avoid racing with the snapshot-driven updateBubble re-entry
      if (currentBubblePage === 1 && lastSnapshot) {
        window.setTimeout(function () { if (currentBubblePage === 1 && lastSnapshot) updateBubble(lastSnapshot) }, 0)
      }
    })
  })

  // Double-click: play a drawing sticker loop and pop a random artwork.
  // No drawing lock: on consecutive double-clicks showPic first picStops the previous round
  // (animation frame + all timers) and immediately starts a new round, instead of waiting out
  // the cooldown left over from the previous one. The right-click menu's "Draw" reuses the
  // same entry point, so both clients' menus are isomorphic (the desktop pet-view.html also
  // shares playDraw between its menu and double-click).
  function playDraw() {
    if (!lastSnapshot || lastSnapshot.pics === 0) return
    manualOverride = { mood: '01', until: Date.now() + PIC_DRAW_MS }
    sync()
    showPic()
  }
  dock.addEventListener('dblclick', playDraw)

  // Mouse wheel: resize the pet (persisted through config).
  dock.addEventListener('wheel', function (e) {
    e.preventDefault()
    if (!lastSnapshot) return
    var delta = e.deltaY < 0 ? 0.05 : -0.05
    var next = Math.min(2, Math.max(0.5, (lastSnapshot.scale ?? 1) + delta))
    next = Math.round(next * 20) / 20
    void patchConfig('scale', next)
  }, { passive: false })

  // ---- context menu ----
  var menuOpen = false
  function makeRow(label, rightText) {
    var row = mk('div', '')
    row.className = 'rm2-pet-menu-item'
    row.appendChild(mk('span', '', label))
    if (rightText) {
      var r = mk('span', '', rightText)
      r.className = 'mute'
      row.appendChild(r)
    }
    return row
  }
  function makeActionRow(label, act) {
    var row = makeRow(label)
    row.addEventListener('click', act)
    return row
  }
  function makeToggleRow(label, on, act) {
    var row = makeRow(label, on ? '✓' : '')
    var r = row.querySelector('.mute')
    if (on && r) r.classList.add('tick')
    row.addEventListener('click', act)
    return row
  }
  function makeSep() {
    var sep = mk('div', '')
    sep.className = 'rm2-pet-menu-sep'
    return sep
  }
  // Slider row: isomorphic with the desktop pet-view.html menuSliderRow (same skeleton on
  // both clients, only the DOM spelling differs).
  // Width, spacing and the percentage slot all go through CSS classes (.rm2-pet-menu-slider
  // / -pct), matched item by item with the desktop side; the name column absorbs the slack
  // via .rm2-pet-menu-item>span:first-child's flex:1, so the sliders line up.
  // The name column **deliberately has no min-width:0**: interactive rows never shrink, so a
  // narrowing menu becomes visible overflow instead of silently clipping "Character size" to
  // "Character s…" (clipping is reserved for the status row).
  function makeSliderRow(label, min, max, value, onInput) {
    var row = mk('div', '')
    row.className = 'rm2-pet-menu-item'
    var slider = mk('input', '')
    slider.className = 'rm2-pet-menu-slider'
    slider.type = 'range'
    slider.min = String(min)
    slider.max = String(max)
    slider.step = '0.05'
    slider.value = String(value)
    var pct = mk('span', '', Math.round(value * 100) + '%')
    pct.className = 'tick rm2-pet-menu-pct'
    slider.addEventListener('input', function () {
      var next = Number(slider.value)
      pct.textContent = Math.round(next * 100) + '%'
      onInput(next)
    })
    row.appendChild(mk('span', '', label))
    row.appendChild(slider)
    row.appendChild(pct)
    return row
  }

  // The unified right-click menu — the web client (here) and the desktop client
  // (pet-view.html buildMenu) share one skeleton, one order and identically named items:
  //   status info │ Character size · Opacity · Mirror horizontally │ Lock position · Pause
  //   animation · Show bubble │ Draw · Reset position │ Desktop floating mode
  // Three inclusion rules: visible on the pet immediately after clicking, no reason to jump
  // to the settings page for it, and still an exit once it is off.
  // So enable/hide desktop pet, Pet Management, respond to sub-agents, platform token,
  // usage mode, the bubble sub-options and the zoom sub-options stay in the settings page
  // only — they are either low-frequency, or they would switch off their own entry point.
  function buildMenuContent() {
    menu.textContent = ''
    var snap = lastSnapshot
    var running = snap && (snap.state === 'THINKING' || snap.state === 'WORKING' || snap.state === 'WAITING' || snap.state === 'ERROR')
    // The status row is a **single** span (the whole "mood · message · Running" string),
    // isomorphic with the desktop menuRow: only when the whole string sits on
    // :first-child does the min-width:0 + ellipsis clipping rule apply; split into two spans
    // the second part cannot shrink and a long message overflows the menu's rounded corners.
    var statusText = (MOODS[currentMood] || MOODS['06']) + ' · ' + (snap ? snap.message : 'Connecting') + (running ? ' · Running' : '')
    var status = makeRow(statusText)
    status.classList.add('rm2-pet-menu-status')
    menu.appendChild(status)
    menu.appendChild(makeSep())
    // ---- Appearance: immediately visible, all adjusted in place ----
    menu.appendChild(makeSliderRow('Character size', 0.5, 2, (snap && snap.scale) || 1, function (next) {
      void patchConfig('scale', next)
      if (lastSnapshot) {
        lastSnapshot.scale = next
        applyOffset(currentMood)
      }
    }))
    menu.appendChild(makeSliderRow('Opacity', 0.3, 1, (snap && snap.opacity) || 1, function (next) {
      void patchConfig('opacity', next)
      if (lastSnapshot) {
        lastSnapshot.opacity = next
        applyVisuals(lastSnapshot)
      }
    }))
    menu.appendChild(makeToggleRow('Mirror horizontally', snap ? snap.mirror === true : false, function () {
      var next = !(lastSnapshot ? lastSnapshot.mirror === true : false)
      void patchConfig('mirror', next)
      if (lastSnapshot) {
        lastSnapshot = { ...lastSnapshot, mirror: next }
        applyVisuals(lastSnapshot)
      }
      buildMenuContent()
    }))
    menu.appendChild(makeSep())
    // ---- Behavior: the switches take effect immediately and always write the config
    // (otherwise a snapshot would flip the local state back from the config) ----
    menu.appendChild(makeToggleRow('Lock position', lockedNow, function () {
      var next = !lockedNow
      lockedNow = next
      syncPetCursor()
      void patchConfig('locked', next)
      buildMenuContent()
    }))
    var pauseRow = makeToggleRow('Pause animation', paused, function () {
      var next = !paused
      setPaused(next)
      // It must write the config: applySnapshot corrects the local paused against
      // config.paused every time, so a local-only change is flipped back on the next
      // snapshot (with the old implementation clicking it looked like nothing happened).
      void patchConfig('paused', next)
      buildMenuContent()
    })
    // Decode the frame table on hover (120–160 frames, about 0.1–0.4s) so pressing it can
    // freeze immediately
    pauseRow.addEventListener('mouseenter', function () { void __gifFrame.warm(img.src) })
    menu.appendChild(pauseRow)
    menu.appendChild(makeToggleRow('Show bubble', lastSnapshot ? lastSnapshot.bubble !== false : true, function () {
      var next = !(lastSnapshot ? lastSnapshot.bubble !== false : true)
      // Same logic as the master switch in settings: off → all sub-switches off; on → all
      // sub-switches on. One PATCH for all three, so the intermediate state of three round
      // trips is never read by an SSE snapshot.
      void patchConfigFields({
        showBubble: next,
        showBubbleStatus: next,
        showBubbleUsage: next,
      })
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, bubble: next }
      buildMenuContent()
    }))
    menu.appendChild(makeSep())
    // ---- Actions and modes ----
    menu.appendChild(makeActionRow('Draw', function () { playDraw(); closeMenu() }))
    menu.appendChild(makeActionRow('Reset position', function () { resetPos(); closeMenu() }))
    menu.appendChild(makeToggleRow('Desktop floating mode', lastSnapshot ? lastSnapshot.desktopMode === true : false, function () {
      // The desktopMode config is always the source of truth: shown = config value, clicking
      // flips the config. The desktop window's runtime state (desktopActive) is not read, to
      // avoid "it did not sync" caused by an async skew. The desktop menu has the same name
      // and meaning (the check mark means "currently in desktop mode"), so it no longer
      // calls it "Desktop floating mode" on one client and "switch to web mode" on the other.
      var target = lastSnapshot ? !(lastSnapshot.desktopMode === true) : false
      void patchConfig('desktopMode', target)
      if (lastSnapshot) lastSnapshot = { ...lastSnapshot, desktopMode: target }
      if (target) {
        pendingDesktopHide = true
        armDesktopHideTimer()
        if (root.style.display !== 'none') {
          root.style.display = 'none'
          closeMenu()
        }
      } else {
        pendingDesktopHide = false
        if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
      }
      buildMenuContent()
    }))
  }

  // Normally the menu anchors to the pet's top-right corner (compact, and the bubble does
  // not stretch the dock from its absolute position); it only switches to bounding-box
  // avoidance when the menu rect intersects the bubble. When hugging an edge it still goes
  // right → left → up. One shared implementation with the desktop pet-view.html.
  function menuBoxOf(el) {
    if (!el) return null
    var cr = el.getBoundingClientRect()
    if (cr.width < 1 || cr.height < 1) return null
    return { top: cr.top, left: cr.left, right: cr.right, bottom: cr.bottom }
  }
  function unionMenuBox(a, b) {
    if (!a) return b
    if (!b) return a
    return {
      top: Math.min(a.top, b.top),
      left: Math.min(a.left, b.left),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    }
  }
  function sideMenuPos(r, mw, mh, W, H) {
    // When the pet's box cannot be obtained (the sticker has not decoded yet → the img has
    // height 0 and menuBoxOf returns null), anchor to the bottom-right of the viewport: the
    // web pet sits in the bottom-right corner anyway. Without this layer, reading
    // r.right on null would throw and the menu would stay at its old coordinates.
    if (!r) r = { top: H - 48, left: W - 48, right: W - 48, bottom: H - 48 }
    var left, top
    if (r.right + 8 + mw <= W - 4) {
      left = r.right + 8
      top = Math.max(4, Math.min(r.top, H - mh - 4))
    } else if (r.left - 8 - mw >= 4) {
      left = r.left - mw - 8
      top = Math.max(4, Math.min(r.top, H - mh - 4))
    } else {
      left = Math.max(4, Math.min(r.right - mw, W - mw - 4))
      top = Math.max(4, r.top - mh - 8)
    }
    return { left: left, top: top }
  }
  function openMenuAt() {
    buildMenuContent()
    menu.style.display = 'block'
    var mw = menu.offsetWidth
    var mh = menu.offsetHeight
    var W = window.innerWidth || 1280
    var H = window.innerHeight || 800
    var pet = menuBoxOf(img) || menuBoxOf(dock)
    var bubbleBox = unionMenuBox(menuBoxOf(bubbleStack), menuBoxOf(bubble))
    var cluster = unionMenuBox(pet, bubbleBox) || pet
    var pos = sideMenuPos(pet, mw, mh, W, H)
    if (bubbleBox && pos.left < bubbleBox.right && pos.left + mw > bubbleBox.left && pos.top < bubbleBox.bottom && pos.top + mh > bubbleBox.top) {
      pos = sideMenuPos(cluster, mw, mh, W, H)
    }
    menu.style.left = pos.left + 'px'
    menu.style.top = pos.top + 'px'
    menuOpen = true
  }
  function closeMenu() {
    menu.style.display = 'none'
    menuOpen = false
  }

  function outsideDown(e) {
    if (menuOpen && !menu.contains(e.target)) closeMenu()
  }
  document.addEventListener('pointerdown', outsideDown, true)

  dock.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt()
  })

  sync()

  ctx.effect(function () { return function () {
    clearReportedCurrentSession()
    clearReportedHostTheme()
    disposed = true
    window.removeEventListener('pagehide', clearReportedCurrentSession)
    window.removeEventListener('beforeunload', clearReportedCurrentSession)
    window.removeEventListener('blur', clearReportedCurrentSession)
    window.removeEventListener('focus', onCurrentSessionFocus)
    document.removeEventListener('visibilitychange', onCurrentSessionVisibilityChange)
    document.removeEventListener('DOMContentLoaded', watchHostTheme)
    window.removeEventListener('pagehide', clearReportedHostTheme)
    window.removeEventListener('beforeunload', clearReportedHostTheme)
    if (hostThemeMutationObserver) {
      try { hostThemeMutationObserver.disconnect() } catch (e) { /* already disconnected */ }
      hostThemeMutationObserver = null
    }
    if (hostThemeHeartbeatTimer) {
      window.clearInterval(hostThemeHeartbeatTimer)
      hostThemeHeartbeatTimer = 0
    }
    if (intervalId) window.clearInterval(intervalId)
    document.removeEventListener('pointerdown', outsideDown, true)
    // Disconnect SSE, unsubscribe the balance feed, and clear every leftover timer and
    // detached node; otherwise disabling and re-enabling the plugin (or HMR) accumulates
    // connections, listeners and detached DOM
    if (stream) { try { stream.close() } catch (e) { /* already closed */ } stream = null }
    if (unsubBalance) { try { unsubBalance() } catch (e) { /* ignore */ } unsubBalance = null }
    if (balanceWaitTimer) window.clearInterval(balanceWaitTimer)
    if (pulseFallbackTimer) window.clearTimeout(pulseFallbackTimer)
    if (updatePollTimer) window.clearInterval(updatePollTimer)
    if (desktopHideTimer) { window.clearTimeout(desktopHideTimer); desktopHideTimer = null }
    for (const el of bubbleEls.values()) clearBubbleTitleTimer(el)
    bubbleEls.clear()
    try { picStop() } catch (e) { /* ignore */ }
    confirmOverlay.remove()
    picEl.remove()
    styleEl.remove()
    root.remove()
    menu.remove()
  } })
}

/** ---------- plugin entry ---------- */

function apply(ctx) {
  if (typeof document === 'undefined' || !document.body) return

  if (ctx.slots) {
    ctx.slots.inject('settings.section', function () {
      return ctx.slots.register({
        name: 'settings.section', id: 'pets', order: 25,
        label: function () { return 'Pet Management' },
        inject: function () { return {} },
      }, PetsSection)
    })
    ctx.slots.inject('settings.plugins.tab', function () {
      return ctx.slots.register({
        name: 'settings.plugins.tab', id: 'dsh-pet-remielle', order: 30,
        label: function () { return 'Remielle desktop pet' },
        inject: function () { return {} },
      }, RemielleCard)
    })
  }

  mountPet(ctx)
}

module.exports = {
  name: 'dsh-pet-remielle-client',
  inject: ['slots', 'sessions'],
  apply: apply,
}

return module.exports
} })
