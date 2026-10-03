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
