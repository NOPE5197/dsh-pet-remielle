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
