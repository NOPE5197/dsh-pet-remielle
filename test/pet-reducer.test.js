import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PetMessageKind, PetState } from '../src/protocol.js'
import { PetReducer, moodFor } from '../src/pet-reducer.js'

function session(id = 's1', extra = {}) {
  return { header: { id, ...extra.header }, ...extra }
}

function event(type, data = {}, seq = 1) {
  return { type, seq, data }
}

function collect(reducer, sess, events) {
  const messages = []
  for (const ev of events) {
    for (const message of reducer.handle(sess, ev)) messages.push(message)
  }
  return messages
}

function latestState(reducer, sess, events) {
  const messages = collect(reducer, sess, events)
  return messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
}

test('turn/start -> THINKING with sticker 04', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [event('turn/start')])
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.mood, '04')
})

test('assistant streaming -> sticker 01 (Drawing)', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('assistant/message', {}, 2),
  ])
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.phase, 'streaming')
  assert.equal(state.mood, '01')
})

test('assistant/chunk text-delta -> Drawing 01, reasoning-delta -> Thinking 04', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('assistant/chunk', { chunk: { type: 'reasoning-delta', text: 'let me think…' } }, 2),
    event('assistant/chunk', { chunk: { type: 'text-delta', text: 'sure' } }, 3),
    event('assistant/chunk', { chunk: { type: 'tool-call-delta', name: 'read' } }, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  const reasoning = states[1]
  const output = states[2]
  const tool = states[3]
  assert.equal(reasoning.phase, 'think')
  assert.equal(reasoning.mood, '04')          // reasoning chunk → 04
  assert.equal(output.phase, 'streaming')
  assert.equal(output.mood, '01')             // output → 01
  assert.equal(tool.state, PetState.WORKING)
  assert.equal(tool.mood, '02')               // tool → 02
})

test('tool/call -> WORKING with sticker 02 and activity', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'grep' }, 2),
  ])
  assert.equal(state.state, PetState.WORKING)
  assert.equal(state.mood, '02')
  assert.equal(state.activity, 'searching')
})

test('exit_plan_mode keeps a plan-review card until the tool resolves', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', {
      callId: 'plan-1',
      name: 'exit_plan_mode',
      arguments: { plan: '# Swapping the reasoning panel material\n\nMake the panel match the official menu.' },
    }, 2),
  ])
  const pending = reducer.states()[0]
  assert.equal(pending.state, PetState.WAITING)
  assert.equal(pending.planReview, true)
  assert.equal(pending.ask, false)
  assert.equal(pending.approval, false)
  assert.equal(pending.phase, 'plan-review')
  assert.match(pending.detail, /Plan review · Swapping the reasoning panel material/)

  collect(reducer, sess, [event('tool/result', { callId: 'plan-1' }, 3)])
  assert.equal(reducer.states()[0].state, PetState.THINKING)
})

test('tool/result returns to THINKING, then streaming sticker (01) returns', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'read' }, 2),
    event('tool/result', { callId: 'c1' }, 3),
    event('assistant/message', {}, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states.at(-1).state, PetState.THINKING)
  assert.equal(states.at(-1).mood, '01')
})

test('tool/result with error emits an ERROR pulse with TTL', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'bash' }, 2),
    event('tool/result', { callId: 'c1', error: { code: 'EXIT_1' } }, 3),
  ])
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.ok(pulse)
  assert.equal(pulse.state, PetState.ERROR)
  assert.equal(pulse.ttlMs, 3000)
})

test('tool/result with real DSH shape (message.source.callId) clears the open tool', () => {
  const reducer = new PetReducer()
  // DSH emits tool/result with the callId at message.source.callId, not at the
  // top level. If the reducer fails to clear the open tool, later streaming
  // output would stay stuck on Slacking (02) instead of Drawing (01).
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('tool/call', { callId: 'c1', name: 'grep' }, 2),
    event('tool/result', { message: { source: { callId: 'c1' } } }, 3),
    event('assistant/message', {}, 4),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states.at(-1).state, PetState.THINKING)
  assert.equal(states.at(-1).mood, '01')
  assert.equal(states.at(-1).phase, 'streaming')
})

test('todo/write emits a TASK message with progress', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('todo/write', {
      todos: [
        { status: 'completed', content: 'First thing' },
        { status: 'in_progress', content: 'Doing the second thing' },
        { status: 'pending', content: 'Third thing' },
      ],
    }, 2),
  ])
  const task = messages.find((m) => m.kind === PetMessageKind.TASK)
  assert.ok(task)
  assert.match(task.task, /Doing the second thing/)
  assert.deepEqual(task.progress, { completed: 1, total: 3, current: 2 })
})

test('turn/end blocked -> WAITING with sticker 05', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'blocked' } }, 2),
  ])
  assert.equal(state.state, PetState.WAITING)
  assert.equal(state.mood, '05')
})

test('turn/end completed -> SUCCESS pulse with IDLE resume', () => {
  const reducer = new PetReducer()
  const messages = collect(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.ok(pulse)
  assert.equal(pulse.state, PetState.SUCCESS)
  assert.equal(pulse.mood, '03')
  assert.equal(pulse.ttlMs, 5000)
  // The host falls back to these after the overlay expires.
  assert.equal(pulse.resumeState, PetState.IDLE)
  assert.equal(pulse.resumeMood, '06')
  // Completed turns are not retained in the persistent card deck. The host
  // adds the SUCCESS card back only until the pulse TTL expires.
  assert.deepEqual(reducer.states(), [])
})

test('turn/end aborted -> IDLE (Stopped)', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'aborted' } }, 2),
  ])
  assert.equal(state.state, PetState.IDLE)
  assert.equal(state.phase, 'turn-end')
  assert.deepEqual(reducer.states(), [])
})

// The public shape of states(): one live session = one entry, with the
// title/project/sticker/tip all in there; settled turns no longer take a slot.
// The empty case, the same-shape assertion and the settled omission are merged here.
test('states() exposes one entry per live session and drops settled turns', () => {
  assert.deepEqual(new PetReducer().states(), [], 'empty when there are no sessions')

  const reducer = new PetReducer()
  collect(reducer, session('completed'), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  collect(reducer, session('stopped'), [
    event('turn/start', {}, 3),
    event('turn/end', { reason: { kind: 'aborted' } }, 4),
  ])
  collect(reducer, session('s1', { header: { id: 's1', cwd: 'D:\\workspace\\company\\A07' } }), [
    event('turn/start', {}, 5),
    event('assistant/message', {}, 6),
    // session/title only writes the title, it must not change the sticker
    event('session/title', { title: 'Reviewing tooltip colors and overflow' }, 7),
  ])

  const states = reducer.states()
  assert.deepEqual(states.map((entry) => entry.sessionId), ['s1'], 'a settled turn must not hold a slot')
  const [entry] = states
  assert.equal(entry.state, PetState.THINKING)
  assert.equal(entry.mood, '01')
  assert.ok(entry.detail)
  assert.equal(entry.attention, false)
  assert.equal(entry.title, 'Reviewing tooltip colors and overflow')
  assert.equal(entry.project, 'A07')
})

test('background completion emits SUCCESS while another session needs attention', () => {
  const reducer = new PetReducer()
  const waiting = session('waiting')
  const background = session('background')
  collect(reducer, waiting, [
    event('turn/start'),
    event('tool/call', { callId: 'q', name: 'ask_user_question' }, 2),
  ])
  collect(reducer, background, [event('turn/start', {}, 3)])
  const messages = collect(reducer, background, [
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  assert.equal(reducer.states().find((entry) => entry.sessionId === 'waiting').state, PetState.WAITING)
  assert.ok(messages.some((message) => message.kind === PetMessageKind.PULSE && message.sessionId === 'background' && message.state === PetState.SUCCESS))
})

test('multi-session priority: WAITING beats WORKING beats THINKING', () => {
  const reducer = new PetReducer()
  const a = session('a')
  const b = session('b')
  const c = session('c')
  collect(reducer, a, [event('turn/start'), event('assistant/message', {}, 2)])
  collect(reducer, b, [event('turn/start'), event('tool/call', { callId: 'x', name: 'bash' }, 2)])
  const messages = collect(reducer, c, [event('turn/start'), event('turn/end', { reason: { kind: 'blocked' } }, 2)])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'c')
  assert.equal(state.state, PetState.WAITING)
})

test('subagents are ignored unless included', () => {
  const sub = session('sub', { header: { origin: 'subagent', delegationDepth: 1 } })
  const reducer = new PetReducer()
  assert.equal(collect(reducer, sub, [event('turn/start')]).length, 0)

  const withSub = new PetReducer({ includeSubagents: true })
  const state = latestState(withSub, sub, [event('turn/start')])
  assert.equal(state.state, PetState.THINKING)
})

test('identical consecutive events are deduplicated by signature', () => {
  const reducer = new PetReducer()
  const first = collect(reducer, session(), [event('turn/start')])
  assert.equal(first.filter((m) => m.kind === PetMessageKind.STATE).length, 1)
  const second = collect(reducer, session(), [event('turn/start')])
  assert.equal(second.length, 0)
})

test('disposeSession drops the record and re-renders', () => {
  const reducer = new PetReducer()
  const sess = session('x')
  collect(reducer, sess, [event('turn/start')])
  const messages = reducer.disposeSession(sess)
  assert.ok(messages.some((m) => m.kind === PetMessageKind.STATE))

  // Only that one session is dropped; the rest stay in the deck as usual
  collect(reducer, session('s1'), [event('turn/start', {}, 2)])
  collect(reducer, session('s2'), [event('turn/start', {}, 3)])
  reducer.disposeSession(session('s1'))
  const states = reducer.states()
  assert.equal(states.length, 1)
  assert.equal(states[0].sessionId, 's2')
})

test('moodFor maps phases to stickers', () => {
  assert.equal(moodFor(PetState.THINKING, 'streaming'), '01')
  assert.equal(moodFor(PetState.THINKING, 'step-start'), '04')
  assert.equal(moodFor(PetState.WORKING, 'tool-call'), '02')
  assert.equal(moodFor(PetState.WAITING, 'turn-end'), '05')
  assert.equal(moodFor(PetState.IDLE, 'turn-end'), '06')
  assert.equal(moodFor(PetState.ERROR, 'tool-error'), '02')
})

// ── chat-mode scenarios ─────────────────────────────────────────────────────
// A chat session is a read-only research front: it streams, searches/browses/
// reads, then goes IDLE while the target agent executes in the background.
// The pet needs no mode awareness — the event flow already distinguishes the
// phases — but these tests pin the chat-shaped flows so a future change to
// either side cannot silently mis-stage the pet.

test('chat research: streaming search/read flow ends IDLE with a SUCCESS pulse', () => {
  const reducer = new PetReducer()
  const chat = session('chat-1')
  const messages = collect(reducer, chat, [
    event('turn/start'),
    event('assistant/message', {}, 2),
    event('tool/call', { callId: 'c1', name: 'web_search' }, 3),
    event('tool/result', { callId: 'c1' }, 4),
    event('tool/call', { callId: 'c2', name: 'read' }, 5),
    event('tool/result', { callId: 'c2' }, 6),
    event('assistant/message', {}, 7),
    event('turn/end', { reason: { kind: 'completed' } }, 8),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(states[0].state, PetState.THINKING)
  assert.equal(states.find((m) => m.phase === 'streaming').mood, '01')
  assert.equal(states.find((m) => m.activity === 'searching').state, PetState.WORKING)
  // `turn/end completed` emits only a SUCCESS pulse; the durable state it
  // resumes to is IDLE (the pet falls back to it after the overlay TTL).
  assert.equal(states.at(-1).state, PetState.THINKING)
  const pulse = messages.find((m) => m.kind === PetMessageKind.PULSE)
  assert.equal(pulse.state, PetState.SUCCESS)
  assert.equal(pulse.resumeState, PetState.IDLE)
})

test('after delegation: the working agent outranks the idle chat session', () => {
  const reducer = new PetReducer()
  const chat = session('chat-2')
  const agent = session('agent-2')
  // Chat finishes researching and hands off (IDLE).
  collect(reducer, chat, [
    event('turn/start'),
    event('assistant/message', {}, 2),
    event('turn/end', { reason: { kind: 'completed' } }, 3),
  ])
  // The target agent starts executing in the background.
  const messages = collect(reducer, agent, [
    event('turn/start'),
    event('tool/call', { callId: 'x', name: 'bash' }, 2),
  ])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'agent-2')
  assert.equal(state.state, PetState.WORKING)
})

test('agent completes, then the review wake returns the pet to the chat session', () => {
  const reducer = new PetReducer()
  const chat = session('chat-3')
  const agent = session('agent-3')
  collect(reducer, chat, [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'completed' } }, 2),
  ])
  collect(reducer, agent, [
    event('turn/start'),
    event('tool/call', { callId: 'x', name: 'bash' }, 2),
    event('tool/result', { callId: 'x' }, 3),
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  // The host injects the review request into the chat session's inbox; the
  // chat turn starts and the pet switches back to it (THINKING > IDLE).
  const messages = collect(reducer, chat, [
    event('turn/start', {}, 5),
    event('assistant/message', {}, 6),
  ])
  const state = messages.filter((m) => m.kind === PetMessageKind.STATE).at(-1)
  assert.equal(state.sessionId, 'chat-3')
  assert.equal(state.state, PetState.THINKING)
  assert.equal(state.mood, '01')
})

test('ask_user_question tool/call -> WAITING sticker 05, result restores', () => {
  const reducer = new PetReducer()
  const sess = session()
  const messages = collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
  ])
  const waiting = messages.filter((m) => m.kind === PetMessageKind.STATE)[1]
  assert.equal(waiting.state, PetState.WAITING)
  assert.equal(waiting.mood, '05')
  assert.equal(waiting.phase, 'ask')
  assert.equal(reducer.states()[0].approval, false)
  const tail = collect(reducer, sess, [event('tool/result', { callId: 'q1' }, 3)])
  // After the answer returns, the pet goes back to THINKING.
  assert.equal(tail.filter((m) => m.kind === PetMessageKind.STATE).at(-1).state, PetState.THINKING)
})

test('approval/asked -> WAITING, approval/decided restores WORKING', () => {
  const reducer = new PetReducer()
  const sess = session('s1', { header: { cwd: 'C:\\work\\dsh-pet-remielle' } })
  const messages = collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'c', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }, 2),
    event('approval/asked', {
      id: 'a1',
      toolName: 'bash',
      callId: 'c',
      reason: 'escalate sandbox to danger-full-access: sync the plugin',
    }, 3),
  ])
  const states = messages.filter((m) => m.kind === PetMessageKind.STATE)
  const waiting = states.find((m) => m.phase === 'approval')
  assert.equal(waiting.state, PetState.WAITING)
  assert.equal(waiting.mood, '05')
  assert.equal(waiting.detail, 'dsh-pet-remielle · sync the plugin')
  assert.equal(reducer.states()[0].approval, true)
  assert.equal(reducer.states()[0].detail, 'dsh-pet-remielle · sync the plugin')
  const tail = collect(reducer, sess, [
    event('approval/decided', { id: 'a1', outcome: 'allow' }, 4),
    event('tool/result', { callId: 'c' }, 5),
  ])
  // approval/decided restores WORKING (the tool is still running)…
  const tailStates = tail.filter((m) => m.kind === PetMessageKind.STATE)
  assert.equal(tailStates[0].state, PetState.WORKING)
  // …then tool/result returns to THINKING.
  assert.equal(tailStates.at(-1).state, PetState.THINKING)
})

test('concurrent question and approval waits retain their independent actions', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
  ])
  let state = reducer.states()[0]
  assert.equal(state.phase, 'approval')
  assert.equal(state.approval, true)

  collect(reducer, sess, [event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 4)])
  state = reducer.states()[0]
  assert.equal(state.state, PetState.WAITING)
  assert.equal(state.phase, 'ask')
  assert.equal(state.approval, false)

  collect(reducer, sess, [event('tool/result', { callId: 'q1' }, 5)])
  state = reducer.states()[0]
  assert.equal(state.state, PetState.THINKING)
})

test('late interaction results do not resurrect a completed turn', () => {
  const reducer = new PetReducer()
  const sess = session()
  collect(reducer, sess, [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
    event('approval/asked', { id: 'a1', toolName: 'bash' }, 3),
    event('turn/end', { reason: { kind: 'completed' } }, 4),
  ])
  assert.deepEqual(reducer.states(), [])
  collect(reducer, sess, [
    event('tool/result', { callId: 'q1' }, 5),
    event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 6),
  ])
  assert.deepEqual(reducer.states(), [])
})

// Title folding: the host only hands over titles through session/title events, and
// the plugin backfills history via snapshotEvents(). One scenario per line, so a
// failure is readable straight from the assertion message.
test('states() folds session titles from the host log', () => {
  const fold = (sess, events) => {
    const reducer = new PetReducer()
    collect(reducer, sess, events)
    return reducer.states()[0]?.title
  }
  assert.equal(
    fold(session('s1', {
      snapshotEvents: () => [{ type: 'session/title', data: { title: 'Reviewing tooltip colors and overflow' } }],
    }), [event('turn/start')]),
    'Reviewing tooltip colors and overflow',
    'a title in the log should be folded out',
  )
  // A resumed old session: the title events were written into the log before the
  // plugin loaded, so take the last one
  assert.equal(
    fold(session('s1', {
      snapshotEvents: () => [
        { type: 'session/title', data: { title: 'Old title' } },
        { type: 'turn/start' },
        { type: 'session/title', data: { title: 'New title' } },
      ],
    }), [event('turn/start'), event('step/start', {}, 2)]),
    'New title',
    'takes the last title in the log',
  )
  // DSH already normalizes by maxTitleBytes when writing, and the plugin never
  // truncates a second time—the service rule and the log rule must agree, or the
  // title length of the same session would depend on whether the service loaded.
  const long = 'Long title '.repeat(90).trim()
  assert.equal(
    fold(session('s1', { snapshotEvents: () => [{ type: 'session/title', data: { title: long } }] }), [event('turn/start')]),
    long,
    'the title is kept verbatim',
  )
  // session.events is not a host API, so no title may be produced from it
  assert.equal(
    fold(session('s1', { events: [{ type: 'session/title', data: { title: 'a field that does not exist' } }] }), [event('turn/start')]),
    undefined,
    'no folding without snapshotEvents()',
  )
  // A throwing host must not break the whole message chain
  const reducer = new PetReducer()
  const messages = collect(reducer, session('s1', { snapshotEvents: () => { throw new Error('boom') } }), [event('turn/start')])
  assert.ok(messages.length > 0)
  assert.equal(reducer.states()[0].title, undefined, 'a throwing snapshotEvents degrades to no title')
})

test('states() folds the log once per session and keeps taking later titles', () => {
  const reducer = new PetReducer()
  let calls = 0
  // There is never a session/title in the log (the title has not been produced yet):
  // folding must not run on every event.
  const sess = session('s1', { snapshotEvents: () => { calls++; return [{ type: 'turn/start' }] } })
  collect(reducer, sess, [
    event('turn/start'),
    event('step/start', {}, 2),
    event('tool/call', { callId: 'c1', name: 'read' }, 3),
  ])
  assert.equal(calls, 1)

  // After one fold, a live session/title event must still be able to override
  const live = new PetReducer()
  const liveSess = session('s1', { snapshotEvents: () => [{ type: 'session/title', data: { title: 'Old title' } }] })
  collect(live, liveSess, [event('turn/start')])
  assert.equal(live.states()[0].title, 'Old title')
  collect(live, liveSess, [event('session/title', { title: 'Renamed title' }, 2)])
  assert.equal(live.states()[0].title, 'Renamed title')
})

// Card deck ordering: sessions that need a human (approval > question > ERROR) rank
// above background workflows; one batch of sessions is sorted at once so the order
// cannot drift between separate cases.
//
// Division of labour: the priority table itself is defined in exactly one place,
// test/session-order.test.js (which tests compareSessions directly). This is a
// **wiring guard rail**—events are fed in the shuffled order
// work/stream/err/ask/appr, and the assertion checks that states() really did sort
// through the comparator (it fails with no sorting at all), rather than restating
// the rules. The state/attention annotations in the second half are unrelated to
// ordering and are this case's own value.
test('states() ranks approval above ask above ERROR above background work', () => {
  const reducer = new PetReducer()
  collect(reducer, session('work'), [
    event('turn/start'),
    event('tool/call', { callId: 'c0', name: 'bash' }, 2),
  ])
  collect(reducer, session('stream'), [
    event('turn/start', {}, 3),
    event('assistant/message', {}, 4),
  ])
  collect(reducer, session('err'), [
    event('turn/start', {}, 5),
    event('turn/end', { reason: { kind: 'error' } }, 6),
  ])
  collect(reducer, session('ask'), [
    event('turn/start', {}, 7),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 8),
  ])
  collect(reducer, session('appr'), [
    event('turn/start', {}, 9),
    event('tool/call', { callId: 'c1', name: 'bash' }, 10),
    event('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }, 11),
  ])
  const states = reducer.states()
  assert.deepEqual(states.map((entry) => entry.sessionId), [
    'appr',
    'ask',
    'err',
    'work',
    'stream',
  ])
  const byId = Object.fromEntries(states.map((entry) => [entry.sessionId, entry]))
  assert.equal(byId.ask.state, PetState.WAITING)
  assert.equal(byId.ask.attention, true)
  assert.equal(byId.err.state, PetState.ERROR)
  assert.equal(byId.err.attention, true)
  assert.equal(byId.stream.state, PetState.THINKING)
  assert.equal(byId.stream.attention, false)
})

test('turn/end error -> durable ERROR attention', () => {
  const reducer = new PetReducer()
  const state = latestState(reducer, session(), [
    event('turn/start'),
    event('turn/end', { reason: { kind: 'error' } }, 2),
  ])
  assert.equal(state.state, PetState.ERROR)
  assert.equal(state.phase, 'turn-end')
  assert.equal(state.stage, 'Needs attention')
  const states = reducer.states()
  assert.equal(states.length, 1)
  assert.equal(states[0].attention, true)
})

// dismissError only handles the ERROR card that "needs a human": every other state
// and an unknown id must be a no-op, or one stray click would wipe a running
// session out of the deck.
test('dismissError clears only durable ERROR sessions', () => {
  const failed = (seq) => [
    event('turn/start', {}, seq),
    event('turn/end', { reason: { kind: 'error' } }, seq + 1),
  ]

  const solo = new PetReducer()
  collect(solo, session('s1'), failed(1))
  assert.equal(solo.states()[0].state, PetState.ERROR)
  assert.equal(solo.dismissError('s1').at(-1).state, PetState.IDLE)
  assert.deepEqual(solo.states(), [])

  // Background ERROR + foreground WAITING: only the background one is dropped
  const mixed = new PetReducer()
  collect(mixed, session('ask'), [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
  ])
  collect(mixed, session('err'), failed(3))
  assert.equal(mixed.states().some((entry) => entry.sessionId === 'err' && entry.state === PetState.ERROR), true)
  mixed.dismissError('err')
  assert.equal(mixed.states().some((entry) => entry.sessionId === 'err'), false)
  assert.equal(mixed.states()[0].sessionId, 'ask')
  assert.equal(mixed.states()[0].state, PetState.WAITING)

  // WAITING / WORKING / unknown id: always a no-op
  const live = new PetReducer()
  collect(live, session('ask'), [
    event('turn/start'),
    event('tool/call', { callId: 'q1', name: 'ask_user_question' }, 2),
  ])
  collect(live, session('work'), [
    event('turn/start', {}, 3),
    event('tool/call', { callId: 'c1', name: 'bash' }, 4),
  ])
  assert.deepEqual(live.dismissError('ask'), [])
  assert.deepEqual(live.dismissError('work'), [])
  assert.deepEqual(live.dismissError('missing'), [])
  assert.equal(live.states().find((entry) => entry.sessionId === 'ask').state, PetState.WAITING)
  assert.equal(live.states().find((entry) => entry.sessionId === 'work').state, PetState.WORKING)
})

