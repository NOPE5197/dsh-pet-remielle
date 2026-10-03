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
