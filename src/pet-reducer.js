/**
 * Pure, testable state machine that turns DSH session events into pet
 * messages (state / pulse / task). The shape is:
 *
 *  - every rendered message carries a `mood` (remielle sticker id), derived
 *    from state + phase (THINKING -> '04', tools -> '02', ...);
 *  - assistant output streaming is tracked as a THINKING phase 'streaming'
 *    so the "Drawing" sticker shows while text is being written;
 *  - SUCCESS / ERROR are transient PULSE overlays with a TTL (the browser
 *    client shows them until the deadline, then falls back to durable state).
 */

import { createRequire } from 'node:module'
import {
  PetMessageKind,
  PetState,
  createMessage,
} from './protocol.js'
import {
  activityCopy,
  activityStage,
  statusCopy,
  taskCopy,
} from './status-copy.js'

const { compareSessions } = createRequire(import.meta.url)('./session-order.cjs')

const statePriority = Object.freeze({
  [PetState.WAITING]: 60,
  [PetState.ERROR]: 50,
  [PetState.WORKING]: 30,
  [PetState.THINKING]: 20,
  [PetState.IDLE]: 0,
  [PetState.DISCONNECTED]: -1,
})

const ASK_USER_TOOL = 'ask_user_question'
const PLAN_REVIEW_TOOL = 'exit_plan_mode'

function toolActivity(name) {
  const value = String(name || '').toLowerCase()
  if (/search|grep|find|glob|web|read|fetch|open/.test(value)) return 'searching'
  if (/write|edit|patch|replace|create|move|delete/.test(value)) return 'editing'
  if (/test|check|lint|build|verify/.test(value)) return 'testing'
  if (/shell|bash|exec|command|terminal|powershell/.test(value)) return 'commanding'
  return 'using-tool'
}

function sessionIdOf(session) {
  return String(session?.header?.id ?? session?.id ?? 'unknown-session')
}

export function isSubagent(session) {
  return session?.header?.origin === 'subagent'
    || Number(session?.header?.delegationDepth ?? 0) > 0
}

function cleanProjectName(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const pathParts = text.split(/[\\/]/u).filter(Boolean)
  const candidate = pathParts.length > 1 ? pathParts.at(-1) : text
  return candidate.replace(/\s+/gu, ' ').slice(0, 40) || undefined
}

/** Title normalization: DSH already normalizes titles by `maxTitleBytes` when it
 *  writes `session/title`, so this only trims and checks for emptiness, with no
 *  extra truncation (same stance as DSH's `foldSessionTitle`). */
function normalizeTitle(value) {
  return String(value ?? '').trim()
}

/**
 * Folds the newest title out of the session log (takes the last non-empty
 * `session/title`, same source as DSH's foldSessionTitle). The host Session's
 * public snapshot API is `snapshotEvents()`; `session.events` does not exist
 * (the internal log is not exposed), and relying only on live events would miss
 * titles written before the plugin loaded—exactly what happens to old sessions
 * that are resumed after a DSH restart, because title events are never replayed.
 *
 * Trade-off (a known deprecation risk): DSH's 2026-09-09 architecture note marks
 * the synchronous event reads (`snapshotEvents` / `eventAt` / `ownEvents`) as
 * `@deprecated`, stating "existing logic may stay for now, but new calls are
 * forbidden". This function is a new call introduced on 2026-09-15, so strictly
 * speaking it breaks that agreement. The only alternatives available at the time
 * were equally deprecated synchronous reads, or rebuilding the title by replaying
 * the event stream ourselves (which means maintaining a per-session cache, a cost
 * that does not pay for itself). Once DSH ships a real replacement (something
 * like `session.surface`), this should move over along with it.
 */
export function titleFromSessionLog(session) {
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    return undefined // a failed fold must not block event handling or snapshot building
  }
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== 'session/title') continue
    const text = normalizeTitle(events[i]?.data?.title)
    if (text) return text
  }
  return undefined
}

function conversationTitleOf(session, event) {
  if (event?.type === 'session/title') {
    const text = normalizeTitle(event?.data?.title)
    if (text) return text
  }
  return titleFromSessionLog(session)
}

/**
 * Project name for the bubble's second line: the host only hangs `cwd` off
 * `SessionHeader`—the `Session` class itself has no `cwd`/`title`/`name`/`context`,
 * and the header only carries version/id/createdAt/cwd/... as frozen creation
 * metadata; there is no cwd in the session event payloads either (`EpochHeader` /
 * `RequestContext` have none), so this is the only source.
 */
function projectNameOf(session) {
  return cleanProjectName(session?.header?.cwd)
}

function progressOf(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const completed = todos.filter((todo) => ['completed', 'complete', 'done'].includes(todo?.status)).length
  const currentIndex = todos.findIndex((todo) => todo?.status === 'in_progress')
  return {
    completed,
    total: todos.length,
    current: currentIndex >= 0 ? currentIndex + 1 : undefined,
  }
}

function clipLine(text, max = 80) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(String(raw ?? '')) } catch { return null }
}

function approvalReason(reason) {
  const value = String(reason ?? '').replace(/\s+/gu, ' ').trim()
  if (!value) return ''
  const match = value.match(/^escalate sandbox to \S+:\s*(.+)$/iu)
  return match ? match[1].trim() : value
}

function approvalContent(toolName, reason, argsRaw) {
  const why = clipLine(approvalReason(reason))
  if (why) return why
  const args = parseToolArgs(argsRaw)
  if (args && typeof args.justification === 'string' && args.justification.trim()) return clipLine(args.justification)
  if (args && typeof args.command === 'string' && args.command.trim()) return clipLine(args.command)
  if (args && typeof args.description === 'string' && args.description.trim()) return clipLine(args.description)
  return clipLine(toolName) || 'Waiting for approval'
}

function planReviewContent(argsRaw) {
  const args = parseToolArgs(argsRaw)
  const markdown = String(args?.plan ?? '').replace(/\r\n?/g, '\n').trim()
  if (!markdown) return 'Plan review'
  const heading = markdown.match(/^#\s+(.+)$/mu)
  if (heading) return clipLine(heading[1]) || 'Plan review'
  const paragraph = markdown.split(/\n\s*\n/u).map((part) => part.trim()).find(Boolean)
  return clipLine(paragraph || markdown) || 'Plan review'
}

function detailFor(record, stage = record.payload.stage) {
  const approval = record.waits?.find((wait) => wait.kind === 'approval')
  if (approval) {
    const parts = []
    if (record.project) parts.push(record.project)
    parts.push(approval.payload.preview || approval.payload.toolName || 'Waiting for approval')
    return parts.join(' · ')
  }
  const planReview = record.waits?.find((wait) => wait.kind === 'plan-review')
  if (planReview) {
    const parts = []
    if (record.project) parts.push(record.project)
    parts.push('Plan review')
    if (planReview.payload.preview && planReview.payload.preview !== 'Plan review') parts.push(planReview.payload.preview)
    return parts.join(' · ')
  }
  const parts = []
  if (record.project) parts.push(record.project)
  if (record.progress?.total) parts.push(`${record.progress.completed}/${record.progress.total} steps done`)
  if (record.task) parts.push(record.task)
  else if (stage) parts.push(stage)
  return parts.join(' · ') || stage || 'DSH task'
}

/** Remielle sticker for the current durable state + phase. */
export function moodFor(state, phase) {
  // Streaming output (writing the reply) → Drawing; any other thinking → Thinking
  if (state === PetState.THINKING && phase === 'streaming') return '01'
  if (state === PetState.THINKING) return '04'
  if (state === PetState.WAITING) return '05'
  if (state === PetState.IDLE) return '06'
  if (state === PetState.DISCONNECTED) return '06'
  // WORKING (tool busy) and ERROR both show as "Slacking".
  return '02'
}

export class PetReducer {
  constructor({ includeSubagents = false } = {}) {
    this.includeSubagents = includeSubagents
    this.sessions = new Map()
    this.clock = 0
    this.selectedSessionId = undefined
    this.outputSignature = undefined
  }

  setIncludeSubagents(value) {
    const includeSubagents = value === true
    if (includeSubagents === this.includeSubagents) return []
    this.includeSubagents = includeSubagents
    if (!includeSubagents) {
      for (const [sessionId, record] of this.sessions) {
        if (record.subagent) this.sessions.delete(sessionId)
      }
    }
    return this.#render()
  }

  handle(session, event) {
    if (!event || typeof event.type !== 'string') return []
    const subagent = isSubagent(session)
    if (!this.includeSubagents && subagent) return []

    const sessionId = sessionIdOf(session)
    const record = this.#record(sessionId)
    record.subagent = subagent
    record.lastSeq = Number(event.seq ?? record.lastSeq)
    record.project = projectNameOf(session) ?? record.project
    // A title can only come from a session/title event: take it straight off the
    // event when there is one, and fold each session's log at most once (titleFolded
    // is set afterwards)—otherwise sessions that "never get a title" would rescan
    // the whole log on every event (snapshotEvents drops its cache on every append,
    // so the cost is O(n²)). A rename dispatches a new session/title event, which
    // still goes through the first branch.
    // We still set titleFolded when folding throws (snapshotEvents' rare
    // exceptions): this is a hot path hit by every event, and we refuse to rescan
    // the log over and over just to retry—the host-side readSessionTitle retries
    // every frame, so the two stances are deliberately different; a real
    // session/title event will still update the title.
    if (event.type === 'session/title' || !record.titleFolded) {
      record.title = conversationTitleOf(session, event) ?? record.title
      record.titleFolded = true
    }

    switch (event.type) {
      case 'turn/start':
        record.turnActive = true
        record.openTools.clear()
        record.askTools.clear()
        record.planTools.clear()
        record.waits.length = 0
        record.savedState = undefined
        record.savedPayload = undefined
        record.task = undefined
        record.progress = undefined
        this.#update(record, PetState.THINKING, {
          phase: 'turn-start',
          stage: 'Preparing',
          message: statusCopy('preparing', event.seq),
        })
        return this.#render()

      case 'step/start':
        if (!record.turnActive || record.openTools.size > 0) return []
        this.#update(record, PetState.THINKING, {
          phase: 'step-start',
          stage: 'Analyzing',
          message: statusCopy('thinking', event.seq),
        })
        return this.#render()

      case 'assistant/chunk': {
        if (!record.turnActive || record.openTools.size > 0) return []
        const chunkType = String(event.data?.chunk?.type ?? 'text-delta')
        if (chunkType === 'reasoning-delta') {
          // Reasoning chunk (in the think phase) → Thinking 04
          this.#update(record, PetState.THINKING, {
            phase: 'think',
            stage: 'Reasoning',
            message: statusCopy('thinking', event.seq),
          })
        } else if (chunkType === 'tool-call-delta') {
          // Streaming tool-call frame → Slacking 02 (the following tool/call event
          // continues/confirms it)
          this.#update(record, PetState.WORKING, {
            phase: 'tool-call',
            stage: 'Using tools',
            message: statusCopy('working', event.seq),
          })
        } else {
          // text-delta (default): real output → Drawing 01
          this.#update(record, PetState.THINKING, {
            phase: 'streaming',
            stage: 'Responding',
            message: statusCopy('streaming', event.seq),
          })
        }
        return this.#render()
      }

      case 'assistant/message':
        if (!record.turnActive || record.openTools.size > 0) return []
        this.#update(record, PetState.THINKING, {
          phase: 'streaming',
          stage: 'Responding',
          message: statusCopy('streaming', event.seq),
        })
        return this.#render()

      case 'tool/call': {
        const callId = String(event.data?.callId ?? `seq-${String(event.seq ?? 'unknown')}`)
        const name = String(event.data?.name ?? 'tool')
        record.openTools.set(callId, { name, args: event.data?.arguments })
        // Plan review is presented through the user-questions waterfall, so it never
        // emits approval/asked; but the tool/call for exit_plan_mode is the stable
        // host signal that it has entered a waiting period.
        if (name === PLAN_REVIEW_TOOL) {
          record.planTools.add(callId)
          this.#enterWait(record, {
            kind: 'plan-review',
            id: callId,
            payload: {
              phase: 'plan-review',
              stage: 'Plan review',
              toolName: name,
              preview: planReviewContent(event.data?.arguments),
              message: 'Plan review',
            },
          })
          return this.#render()
        }
        // Asking the human a question is a "waiting" state, not "Slacking".
        if (name === ASK_USER_TOOL) {
          record.askTools.add(callId)
          this.#enterWait(record, {
            kind: 'ask',
            id: callId,
            payload: {
              phase: 'ask',
              stage: 'Waiting for answer',
              toolName: name,
              message: statusCopy('waiting', event.seq),
            },
          })
          return this.#render()
        }
        const activity = toolActivity(name)
        this.#update(record, PetState.WORKING, {
          phase: 'tool-call',
          activity,
          stage: activityStage(activity),
          toolName: name,
          message: activityCopy(activity, event.seq),
        })
        return this.#render()
      }

      case 'tool/result':
        return this.#toolResult(record, event)

      case 'todo/write':
        return this.#todo(record, event)

      case 'approval/asked': {
        // Waiting for the human to confirm/deny a tool approval.
        const toolName = String(event.data?.toolName ?? 'tool')
        const approvalId = String(event.data?.id ?? `seq-${String(event.seq ?? 'unknown')}`)
        const callId = event.data?.callId ? String(event.data.callId) : ''
        let argsRaw
        if (callId && record.openTools.has(callId)) argsRaw = record.openTools.get(callId).args
        else {
          for (const entry of record.openTools.values()) {
            if (entry.name === toolName) { argsRaw = entry.args; break }
          }
        }
        this.#enterWait(record, {
          kind: 'approval',
          id: approvalId,
          payload: {
            phase: 'approval',
            stage: 'Waiting for approval',
            toolName,
            preview: approvalContent(toolName, event.data?.reason, argsRaw),
            message: statusCopy('waiting', event.seq),
          },
        })
        return this.#render()
      }

      case 'approval/decided':
        // Approval resolved: restore whatever the pet was doing underneath.
        this.#exitWait(record, 'approval', String(event.data?.id ?? ''))
        return this.#render()

      case 'turn/end':
        return this.#turnEnd(record, event)

      default:
        return []
    }
  }

  disposeSession(session) {
    const sessionId = sessionIdOf(session)
    const existed = this.sessions.delete(sessionId)
    if (!existed) return []
    return this.#render()
  }

  /**
   * Opening the session counts as having read it: only durable ERROR is closed
   * out (a failed turn/end), back to IDLE, and the card deck stops rendering it.
   * WAITING (approval/question) and tool-error pulses do not go through here.
   */
  dismissError(sessionId) {
    const record = this.sessions.get(String(sessionId ?? ''))
    if (!record || record.state !== PetState.ERROR) return []
    this.#update(record, PetState.IDLE, {
      phase: 'turn-end',
      stage: 'Stopped',
      message: statusCopy('stopped'),
    })
    return this.#render()
  }

  /**
   * One renderable state per active or attention-needing session. IDLE and
   * DISCONNECTED records remain internally tracked for primary-state fallback,
   * but are omitted from the card deck so completed/stopped turns disappear.
   * A SUCCESS pulse is emitted for every completed turn; the Host persists
   * its reminder independently until the conversation is opened.
   */
  states() {
    const out = []
    for (const record of this.sessions.values()) {
      if ([PetState.IDLE, PetState.DISCONNECTED].includes(record.state)) continue
      out.push({
        sessionId: record.id,
        state: record.state,
        mood: moodFor(record.state, record.payload.phase),
        phase: record.payload.phase ?? '',
        message: record.payload.message ?? '',
        detail: detailFor(record),
        project: record.project,
        title: record.title,
        task: record.task,
        progress: record.progress,
        // Only an unresolved approval wait may render the actionable ✓.
        // Generic WAITING (ask_user_question) and ERROR must not inherit it.
        approval: record.waits.some((wait) => wait.kind === 'approval'),
        // Plan review is an independent user decision gate; it reuses neither the
        // plain-approval nor the plain-question fields.
        planReview: record.waits.some((wait) => wait.kind === 'plan-review'),
        // Waiting for the user to answer (ask_user_question) is exposed on its own,
        // so bubble sorting can place it below approvals and above completions.
        ask: record.waits.some((wait) => wait.kind === 'ask'),
        attention: record.state === PetState.WAITING || record.state === PetState.ERROR,
        updatedAt: record.updatedAt,
      })
    }
    out.sort((left, right) => compareSessions(left, right))
    return out
  }

  #toolResult(record, event) {
    const callId = String(event.data?.message?.source?.callId
      ?? event.data?.message?.toolCallId
      ?? event.data?.message?.callId
      ?? event.data?.callId
      ?? '')
    const knownTool = callId ? record.openTools.has(callId) || record.askTools.has(callId) || record.planTools.has(callId) : false
    if (!record.turnActive && !knownTool) return []
    const wasAsk = callId ? record.askTools.has(callId) : false
    const wasPlanReview = callId ? record.planTools.has(callId) : false
    if (wasAsk) record.askTools.delete(callId)
    if (wasPlanReview) record.planTools.delete(callId)
    if (callId) record.openTools.delete(callId)
    // An answered question or plan review ends the waiting state; restore what
    // the pet was doing underneath (e.g. THINKING while streaming the answer).
    if (wasAsk || wasPlanReview) {
      this.#exitWait(record, wasPlanReview ? 'plan-review' : 'ask', callId)
      return this.#render()
    }
    const next = record.openTools.size > 0 ? PetState.WORKING : PetState.THINKING
    const nextPayload = {
      phase: 'tool-result',
      activity: next === PetState.WORKING
        ? toolActivity(record.openTools.values().next().value?.name)
        : undefined,
      stage: next === PetState.WORKING
        ? activityStage(toolActivity(record.openTools.values().next().value?.name))
        : 'Wrapping up',
      message: next === PetState.WORKING
        ? activityCopy(toolActivity(record.openTools.values().next().value?.name), event.seq)
        : statusCopy('result', event.seq),
    }
    this.#update(record, next, nextPayload)
    if (!event.data?.error) return this.#render()

    // Symmetric with the success path: a background tool error also emits a pulse,
    // so it is no longer swallowed wholesale by the global WAITING/ERROR anchor
    // (the anchor state is restored from the pulse's resume* fields)
    const selection = this.#select()
    const pulse = createMessage(PetMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: PetState.ERROR,
      mood: moodFor(PetState.ERROR, 'tool-error'),
      ttlMs: 3000,
      resumeState: selection.record.state,
      resumeMood: moodFor(selection.record.state, selection.record.payload.phase),
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      message: statusCopy('toolError', event.seq),
      detail: detailFor(record),
      errorCode: event.data.error.code,
    })
    if ([PetState.WAITING, PetState.ERROR].includes(selection.record.state)) {
      return [...this.#render(selection), pulse]
    }
    this.#remember(selection)
    return [pulse]
  }

  #todo(record, event) {
    const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
    const current = todos.find((todo) => todo?.status === 'in_progress')
      ?? todos.find((todo) => todo?.status === 'pending')
    const progress = progressOf(todos)
    if (!current?.content && !progress) return []
    const nextTask = current?.content ? String(current.content) : record.task
    const unchanged = nextTask === record.task
      && progress?.completed === record.progress?.completed
      && progress?.total === record.progress?.total
    if (unchanged) return []
    record.task = nextTask
    record.progress = progress
    record.updatedAt = ++this.clock
    const selection = this.#select()
    if (selection.record.id !== record.id) return this.#render(selection)
    return [createMessage(PetMessageKind.TASK, {
      sessionId: record.id,
      sourceSeq: event.seq,
      task: record.task,
      progress: record.progress,
      project: record.project,
      message: taskCopy(record.task),
      detail: detailFor(record, 'Executing'),
    })]
  }

  #turnEnd(record, event) {
    record.turnActive = false
    record.openTools.clear()
    record.askTools.clear()
    record.planTools.clear()
    record.waits.length = 0
    record.savedState = undefined
    record.savedPayload = undefined
    const kind = String(event.data?.reason?.kind ?? 'completed')

    if (kind === 'blocked') {
      this.#update(record, PetState.WAITING, {
        phase: 'turn-end',
        stage: 'Waiting for approval',
        message: statusCopy('waiting', event.seq),
      })
      return this.#render()
    }

    if (kind === 'aborted') {
      this.#update(record, PetState.IDLE, {
        phase: 'turn-end',
        stage: 'Stopped',
        message: statusCopy('stopped', event.seq),
      })
      return this.#render()
    }

    if (kind === 'disposed') {
      // The session was destroyed/recycled (dsh-agent-loop ends the turn with
      // cancel({kind:'disposed'})): silently go back to idle instead of producing a
      // misleading "needs attention" error card; the session/disposed event right
      // after removes the record, so this only owns the transitional state inside
      // the event window.
      this.#update(record, PetState.IDLE, {
        phase: 'turn-end',
        stage: 'Stopped',
        message: statusCopy('stopped', event.seq),
      })
      return this.#render()
    }

    if (kind !== 'completed') {
      this.#update(record, PetState.ERROR, {
        phase: 'turn-end',
        stage: 'Needs attention',
        reasonKind: kind,
        message: kind === 'max-tokens'
          ? statusCopy('limit', event.seq)
          : statusCopy('error', event.seq),
      })
      return this.#render()
    }

    this.#update(record, PetState.IDLE, {
      phase: 'turn-end',
      stage: 'Done',
      message: statusCopy('idle', event.seq),
    })
    const selection = this.#select()
    const pulse = createMessage(PetMessageKind.PULSE, {
      sessionId: record.id,
      sourceSeq: event.seq,
      state: PetState.SUCCESS,
      mood: '03',
      ttlMs: 5000,
      resumeState: selection.record.state,
      resumeMood: moodFor(selection.record.state, selection.record.payload.phase),
      resumeMessage: selection.record.payload.message,
      resumeDetail: detailFor(selection.record),
      phase: 'turn-end',
      message: statusCopy('success', event.seq),
      detail: detailFor(record, 'Turn complete'),
      project: record.project,
      title: record.title,
    })
    if ([PetState.WAITING, PetState.ERROR].includes(selection.record.state)) {
      return [...this.#render(selection), pulse]
    }
    this.#remember(selection)
    return [pulse]
  }

  #record(sessionId) {
    let record = this.sessions.get(sessionId)
    if (record) return record
    record = {
      id: sessionId,
      state: PetState.IDLE,
      payload: { phase: 'session-created', message: 'Remielle is idling~' },
      turnActive: false,
      openTools: new Map(),
      askTools: new Set(),
      planTools: new Set(),
      waits: [],
      savedState: undefined,
      savedPayload: undefined,
      task: undefined,
      progress: undefined,
      project: undefined,
      title: undefined,
      titleFolded: false,
      subagent: false,
      lastSeq: -1,
      updatedAt: ++this.clock,
    }
    this.sessions.set(sessionId, record)
    return record
  }

  #update(record, state, payload) {
    record.state = state
    record.payload = payload
    record.updatedAt = ++this.clock
  }

  /** Enter an identified human wait, remembering what to restore later. */
  #enterWait(record, wait) {
    if (record.waits.length === 0) {
      record.savedState = record.state
      record.savedPayload = record.payload
    }
    const existing = record.waits.findIndex((entry) => entry.kind === wait.kind && entry.id === wait.id)
    if (existing >= 0) record.waits.splice(existing, 1)
    record.waits.push(wait)
    record.state = PetState.WAITING
    record.payload = this.#waitPayload(record)
    record.updatedAt = ++this.clock
  }

  /** Resolve one identified wait and restore work only after all waits settle. */
  #exitWait(record, kind, id) {
    const index = record.waits.findIndex((wait) => wait.kind === kind && wait.id === id)
    if (index < 0) return
    record.waits.splice(index, 1)
    record.updatedAt = ++this.clock
    if (record.waits.length > 0) {
      record.state = PetState.WAITING
      record.payload = this.#waitPayload(record)
      return
    }
    record.state = record.savedState ?? PetState.THINKING
    record.payload = record.savedPayload ?? { phase: 'wait-end', message: 'Remielle is idling~' }
    record.savedState = undefined
    record.savedPayload = undefined
  }

  #waitPayload(record) {
    return record.waits.find((wait) => wait.kind === 'approval')?.payload
      ?? record.waits.at(-1)?.payload
      ?? { phase: 'wait-end', message: 'Remielle is idling~' }
  }

  #select() {
    const records = [...this.sessions.values()]
    if (records.length === 0) {
      return {
        record: {
          id: 'dsh-host',
          state: PetState.IDLE,
          payload: { phase: 'no-session', message: 'Remielle is idling~' },
          updatedAt: ++this.clock,
        },
      }
    }
    records.sort((left, right) => {
      const priority = (statePriority[right.state] ?? 0) - (statePriority[left.state] ?? 0)
      return priority || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
    })
    return { record: records[0] }
  }

  #render(selection = this.#select()) {
    const signature = this.#signature(selection.record)
    if (signature === this.outputSignature) return []
    this.#remember(selection)
    return [createMessage(PetMessageKind.STATE, {
      sessionId: selection.record.id,
      state: selection.record.state,
      mood: moodFor(selection.record.state, selection.record.payload.phase),
      ...selection.record.payload,
      task: selection.record.task,
      progress: selection.record.progress,
      project: selection.record.project,
      title: selection.record.title,
      detail: detailFor(selection.record),
    })]
  }

  #remember(selection) {
    this.selectedSessionId = selection.record.id
    this.outputSignature = this.#signature(selection.record)
  }

  #signature(record) {
    return [
      record.id,
      record.state,
      record.payload.phase ?? '',
      record.payload.activity ?? '',
      record.payload.toolName ?? '',
      record.payload.preview ?? '',
      record.payload.message ?? '',
      record.project ?? '',
      record.task ?? '',
      record.progress?.completed ?? '',
      record.progress?.total ?? '',
    ].join('|')
  }
}

export { statePriority, toolActivity }
