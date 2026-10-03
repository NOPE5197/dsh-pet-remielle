/**
 * Turn-hang watchdog (host half) — a backstop for "force-killing a session
 * leaves it stuck in Analyzing forever".
 *
 * When the user force-kills a session in the GUI, the turn/end that the DSH
 * agent-loop backfills may never reach disk and is not broadcast on the live
 * event bus (it is only repaired with turn/end{kind:'interrupted'} when
 * cold-reading the log), so on the plugin side the event stream just stops
 * abruptly and the reducer stays in THINKING forever (for instance at step/start
 * — "Analyzing"). This module only performs a pure check and stays unit
 * testable: it records the time of each session's last event and, together with
 * reducer.states(), scans for sessions that are still THINKING/WORKING with no
 * event for longer than the threshold; WAITING/ERROR/IDLE are never treated as
 * hung — approvals and waiting for a user answer may legitimately take a long
 * time. The wrap-up after a hit (synthesizing turn/end{kind:'aborted'}) is wired
 * up by index.js, reusing the reducer's existing aborted branch to return to
 * IDLE "Stopped", without adding any new public method.
 */

/** Chunk events are frequent during normal streaming, so 3 minutes with no event at all counts as a hung turn. */
export const TURN_STALL_THRESHOLD_MS = 180_000

/** Watchdog scan period (the setInterval interval in index.js). */
export const TURN_WATCHDOG_INTERVAL_MS = 30_000

function isStallProne(state) {
  return state === 'THINKING' || state === 'WORKING'
}

/**
 * Create the watchdog. `now` can be injected for unit tests; `tick` only reads
 * and never writes, and the caller removes the entries of the returned hit list
 * by calling `end` on each one after wrapping the turn up (synthesizing
 * turn/end).
 */
export function createTurnWatchdog({ thresholdMs = TURN_STALL_THRESHOLD_MS, now = Date.now } = {}) {
  const lastSeenMs = new Map()
  return {
    /** Refresh that session's activity timestamp whenever any session/event arrives. */
    feed(sessionId) {
      if (!sessionId) return
      lastSeenMs.set(String(sessionId), now())
    },
    /** After turn/end or session/disposed the turn is wrapped up, so the entry is removed. */
    end(sessionId) {
      if (!sessionId) return
      lastSeenMs.delete(String(sessionId))
    },
    /**
     * Scan a reducer.states() snapshot and return the ids of sessions that are
     * over the threshold yet still THINKING/WORKING; sessions that were never
     * fed or have already ended naturally never match.
     */
    tick(states, at = now()) {
      const stalled = []
      for (const entry of Array.isArray(states) ? states : []) {
        const sessionId = String(entry?.sessionId ?? '')
        const seen = lastSeenMs.get(sessionId)
        if (seen === undefined) continue
        if (!isStallProne(entry.state)) continue
        if (at - seen < thresholdMs) continue
        stalled.push(sessionId)
      }
      return stalled
    },
  }
}
