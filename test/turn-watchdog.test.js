import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetMessageKind, PetState } from '../src/protocol.js'
import { PetReducer } from '../src/pet-reducer.js'
import {
  TURN_STALL_THRESHOLD_MS,
  TURN_WATCHDOG_INTERVAL_MS,
  createTurnWatchdog,
} from '../src/turn-watchdog.js'

// The same event-construction helper as pet-reducer.test.js
function session(id = 's1', extra = {}) {
  return { header: { id, ...extra.header }, ...extra }
}

function event(type, data = {}, seq = 1) {
  return { type, seq, data }
}

/** Simulate index.js's wiring: feed the watchdog while feeding the reducer with events. */
function drive(reducer, watchdog, sess, events) {
  for (const ev of events) {
    watchdog.feed(sess.header.id)
    reducer.handle(sess, ev)
  }
}

// Hang detection looks only at "how long the event stream has been silent", not
// at what the session is waiting for.
// A session waiting for an answer or an approval may legitimately wait a long
// time and must never be killed by mistake.
test('turn watchdog kills stalled turns but spares sessions waiting on the human', () => {
  assert.equal(TURN_STALL_THRESHOLD_MS, 180_000)
  assert.equal(TURN_WATCHDOG_INTERVAL_MS, 30_000)

  // ① THINKING stuck: no hit one tick before the threshold, hit at the
  // threshold; the wrap-up reuses turn/end{aborted}
  const t0 = 1_000_000
  let now = t0
  const stalled = createTurnWatchdog({ now: () => now })
  const reducer = new PetReducer()
  drive(reducer, stalled, session('hung'), [
    event('turn/start'),
    event('step/start', {}, 2), // the force-kill scene: the event stream stops at step/start "Analyzing"
  ])
  assert.deepEqual(stalled.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS - 1), [])
  assert.deepEqual(stalled.tick(reducer.states(), t0 + TURN_STALL_THRESHOLD_MS), ['hung'])
  // How index.js handles a hit: after ending the entry it synthesizes
  // turn/end{aborted} and reuses the existing wrap-up path, passing no seq
  // (record.lastSeq stays unchanged; the stopped copy seed falls back stably
  // through seedNumber).
  stalled.end('hung')
  const messages = [...reducer.handle(
    { header: { id: 'hung' } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'aborted' } } },
  )]
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.state, PetState.IDLE)
  assert.equal(state.stage, 'Stopped')
  assert.equal(state.message, 'The task has stopped~')
  // A stopped record no longer appears in the card deck
  assert.deepEqual(reducer.states(), [])

  // ①b WORKING (stuck while slacking) counts as hung too
  let busyNow = 0
  const busy = createTurnWatchdog({ now: () => busyNow })
  const busyReducer = new PetReducer()
  drive(busyReducer, busy, session('busy'), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
  ])
  busyNow += TURN_STALL_THRESHOLD_MS
  assert.deepEqual(busy.tick(busyReducer.states(), busyNow), ['busy'])

  // ② WAITING (waiting for an answer / an approval) must not be killed after
  // exceeding the threshold
  let askNow = 0
  const asking = createTurnWatchdog({ now: () => askNow })
  const askReducer = new PetReducer()
  drive(askReducer, asking, session('asking'), [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
  ])
  assert.equal(askReducer.states()[0].state, PetState.WAITING)
  askNow += TURN_STALL_THRESHOLD_MS * 10
  assert.deepEqual(asking.tick(askReducer.states(), askNow), [])

  // ③ the entry is removed after turn/end and no longer fires
  let doneNow = 0
  const done = createTurnWatchdog({ now: () => doneNow })
  const doneReducer = new PetReducer()
  drive(doneReducer, done, session('done'), [
    event('turn/start'),
    event('step/start', {}, 2),
    event('turn/end', { reason: { kind: 'completed' } }, 3),
  ])
  done.end('done') // offEvent removes the entry on turn/end
  doneNow += TURN_STALL_THRESHOLD_MS * 10
  assert.deepEqual(done.tick(doneReducer.states(), doneNow), [])

  // ④ no trigger inside the threshold; continuous feeding (normal streaming)
  // refreshes the timestamp and only the moment it arrives does it hit
  let liveNow = 0
  const live = createTurnWatchdog({ now: () => liveNow })
  const liveReducer = new PetReducer()
  drive(liveReducer, live, session('live'), [event('turn/start')])
  liveNow += TURN_WATCHDOG_INTERVAL_MS * 5
  live.feed('live') // chunk events are frequent while streaming, refreshing the timestamp constantly
  liveNow += TURN_STALL_THRESHOLD_MS - 1000
  assert.deepEqual(live.tick(liveReducer.states(), liveNow), [])
  liveNow += 1000
  assert.deepEqual(live.tick(liveReducer.states(), liveNow), ['live'])
})
