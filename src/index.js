/**
 * dsh-pet-remielle host half.
 *
 * Design:
 *  - listens to the real `session/event` / `session/disposed` bus (global
 *    scope, so it sees every session, not only scoped ones);
 *  - feeds events into the pure PetReducer, which emits typed messages;
 *  - keeps the latest state plus any active PULSE overlay, and serves them
 *    to the browser client over the webServer HTTP endpoints;
 *  - registers a persisted schemastery config namespace with live watch;
 *  - hosts a multi-pet registry (assets/pets/<id>/01..06.gif) with its own
 *    Settings section UI: enable/disable pets, rename, pick the active pet.
 *
 * No child process is spawned: the pet renders in the DSH web page, which
 * polls the state endpoint, or in an optional desktop floating window.
 */

import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { PetReducer, isSubagent, titleFromSessionLog } from './pet-reducer.js'
import { PetMessageKind, PetState, createMessage } from './protocol.js'
import { DesktopWindow } from './desktop-window.js'
import { electronArtifact, ensureElectronRuntime, missingRuntimeFiles } from './electron-fetch.mjs'
import {
  CHECK_ENDPOINT, UPDATE_ENDPOINT, PROGRESS_ENDPOINT, INFO_ENDPOINT,
  checkHandler, updateHandler, progressHandler, infoHandler, setSelfUpdateHooks, killActiveUpdate,
} from './self-update.js'
import {
  DEFAULT_PET_ID,
  DEFAULT_PETS,
  PET_MOODS,
  PET_MOOD_EXT,
  PET_MANIFEST,
  PET_ID_RE,
  buildRegistry,
  isValidPetId,
  parseAssetPath,
  parsePetManifest,
  upsertPet,
} from './pets.js'
import { createBalanceService, normalizeUsageMode } from './balance.js'
import { statusCopy } from './status-copy.js'
import { localHostOk } from './local-access.js'
import { TURN_WATCHDOG_INTERVAL_MS, createTurnWatchdog } from './turn-watchdog.js'

const { compareSessions } = createRequire(import.meta.url)('./session-order.cjs')

export const name = 'dsh-pet-remielle'
export const inject = ['sessions', 'credentials']
export const CONFIG_ENDPOINT = '/plugins/dsh-pet-remielle/config'
export const STATE_ENDPOINT = '/plugins/dsh-pet-remielle/state'
export const STREAM_ENDPOINT = '/plugins/dsh-pet-remielle/stream'
export const COMPLETION_ACK_ENDPOINT = '/plugins/dsh-pet-remielle/completion/ack'
export const SESSION_OPEN_ENDPOINT = '/plugins/dsh-pet-remielle/session/open'
export const SESSION_CURRENT_ENDPOINT = '/plugins/dsh-pet-remielle/session/current'
export const THEME_ENDPOINT = '/plugins/dsh-pet-remielle/theme'
export const PETS_ENDPOINT = '/plugins/dsh-pet-remielle/pets'
export const ASSETS_PREFIX = '/plugins/dsh-pet-remielle/assets'
export const PET_VIEW_ENDPOINT = '/plugins/dsh-pet-remielle/pet-view'
export const DESKTOP_ENDPOINT = '/plugins/dsh-pet-remielle/desktop'
export const PLUGIN_KEY = 'dsh-pet-remielle'
export const BALANCE_ENDPOINT = '/plugins/dsh-pet-remielle/balance'

const petEntry = Schema.object({
  id: Schema.string().required().pattern(PET_ID_RE).description('Pet id (the assets/pets/<id> directory name)'),
  name: Schema.string().required().description('Pet display name'),
  enabled: Schema.boolean().default(true).description('Whether this pet is enabled'),
})

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable desktop pet').volatile(),
  scale: Schema.number().min(0.5).max(2).step(0.05).default(1).role('slider').description('Character size').volatile(),
  mirror: Schema.boolean().default(false).description('Mirror the character horizontally').volatile(),
  bubbleScaleSync: Schema.boolean().default(true).description('Scale the message bubble together with the desktop pet (when off, the bubble uses a fixed size)').volatile(),
  bubbleScaleRatio: Schema.number().min(0.5).max(2).step(0.05).default(1).description('Bubble size relative to the desktop pet (applies when sync scaling is on, 1 = same ratio as the pet)').volatile(),
  bubbleFixedSize: Schema.number().min(0.5).max(2).step(0.05).default(1).description('Fixed bubble size (applies when sync scaling is off, 1 = base size)').volatile(),
  opacity: Schema.number().min(0.3).max(1).step(0.05).default(1).role('slider').description('Opacity').volatile(),
  locked: Schema.boolean().default(false).description('Lock position (drag disabled)').volatile(),
  paused: Schema.boolean().default(false).description('Pause animation').volatile(),
  hidden: Schema.boolean().default(false).description('Hide desktop pet').volatile(),
  includeSubagents: Schema.boolean().default(false).description('Allow sub-agents to take over the pet state').volatile(),
  showBubble: Schema.boolean().default(true).description('Show the status bubble above the pet (stage / todo / progress)').volatile(),
  showBubbleStatus: Schema.boolean().default(true).description('Show the session status in the bubble (task stage / progress)').volatile(),
  showBubbleUsage: Schema.boolean().default(false).description('Show the DeepSeek balance / today\'s usage in the bubble').volatile(),
  usageMode: Schema.string().default('ledger').description('How today\'s usage is measured: Ledger (ledger, no token) or Real-time token (token, needs a platform session token)').volatile(),
  platformToken: Schema.string().default('').role('secret').description('DEEPSEEK_PLATFORM_TOKEN platform session token (required by Real-time token mode; when empty it falls back to the DSH credential service)').volatile(),
  desktopMode: Schema.boolean().default(false).description('Desktop floating mode: show the pet in a separate always-on-top window (if Electron is missing when enabled, the runtime is downloaded automatically; if that download fails it falls back to the in-page pet)').volatile(),
  posX: Schema.number().default(null).description('Pet X position (null = use the default position)').volatile(),
  posY: Schema.number().default(null).description('Pet Y position (null = use the default position)').volatile(),
  desktopX: Schema.number().default(null).description('Desktop floating window X (remembered automatically, same coordinate space as the window bounds API; null = use the default position)').volatile(),
  desktopY: Schema.number().default(null).description('Desktop floating window Y (remembered automatically, same coordinate space as the window bounds API; null = use the default position)').volatile(),
  activePetId: Schema.string().default(DEFAULT_PET_ID).pattern(PET_ID_RE).description('The pet currently displayed').volatile(),
  pets: Schema.array(petEntry).default([{ id: DEFAULT_PET_ID, name: 'Remielle', enabled: true }]).description('Pet registry').volatile(),
}).description('A multi-pet web desktop pet driven by DeepSeek Harness session events')

export const defaults = Object.freeze({
  enabled: true,
  scale: 1,
  mirror: false,
  bubbleScaleSync: true,
  bubbleScaleRatio: 1,
  bubbleFixedSize: 1,
  opacity: 1,
  locked: false,
  paused: false,
  hidden: false,
  includeSubagents: false,
  showBubble: true,
  showBubbleStatus: true,
  showBubbleUsage: false,
  usageMode: 'ledger',
  platformToken: '',
  desktopMode: false,
  posX: null,
  posY: null,
  desktopX: null,
  desktopY: null,
  activePetId: DEFAULT_PET_ID,
  pets: DEFAULT_PETS,
})

export function publicConfig(config = {}) {
  return {
    enabled: config.enabled ?? defaults.enabled,
    scale: config.scale ?? defaults.scale,
    mirror: config.mirror ?? defaults.mirror,
    bubbleScaleSync: config.bubbleScaleSync ?? defaults.bubbleScaleSync,
    bubbleScaleRatio: config.bubbleScaleRatio ?? defaults.bubbleScaleRatio,
    bubbleFixedSize: config.bubbleFixedSize ?? defaults.bubbleFixedSize,
    opacity: config.opacity ?? defaults.opacity,
    locked: config.locked ?? defaults.locked,
    paused: config.paused ?? defaults.paused,
    hidden: config.hidden ?? defaults.hidden,
    includeSubagents: config.includeSubagents ?? defaults.includeSubagents,
    showBubble: config.showBubble ?? defaults.showBubble,
    showBubbleStatus: config.showBubbleStatus ?? defaults.showBubbleStatus,
    showBubbleUsage: config.showBubbleUsage ?? defaults.showBubbleUsage,
    usageMode: normalizeUsageMode(config.usageMode),
    platformToken: config.platformToken ?? defaults.platformToken,
    desktopMode: config.desktopMode ?? defaults.desktopMode,
    posX: config.posX ?? defaults.posX,
    posY: config.posY ?? defaults.posY,
    desktopX: config.desktopX ?? defaults.desktopX,
    desktopY: config.desktopY ?? defaults.desktopY,
  }
}

/** Configuration sent to browser settings pages; secret values are write-only. */
export function clientConfig(config = {}) {
  const value = publicConfig(config)
  const { platformToken, ...safe } = value
  return {
    ...safe,
    platformTokenConfigured: typeof platformToken === 'string' && platformToken.length > 0,
  }
}

function localSettingsScope(value) {
  return {
    get: () => value,
    watch: () => () => {},
  }
}

function readConfig(config = {}) {
  const value = {}
  for (const key of Object.keys(defaults)) {
    const current = config[key]
    const raw = current && typeof current.get === 'function' ? current.get() : current
    value[key] = raw ?? defaults[key]
  }
  return value
}

export function createSettingsScope(ctx, config = {}, eventCtx = ctx) {
  const forms = ctx.settings
  const get = () => readConfig(config)
  if (typeof forms?.register === 'function') {
    const scope = forms.register(PLUGIN_KEY, Config, { base: publicConfig(get()), applies: 'live' })
    // DSH's resolve path is `schema(base+section)`: since 0.4.3 schema fields carry
    // .volatile() (schemastery resolves every field into a cosmokit volatile wrapper
    // object with the value hidden inside wrapper.get()), and DSH's scope.get()
    // returns that wrapper as-is — so plain property access from the plugin gets
    // an object instead of the value (observed: pets became a non-array, usageMode
    // became '[object Object]', which emptied the pet list). Unwrap everything back
    // to real values before handing it to plugin code; watch/update keep DSH's own
    // implementation.
    return {
      ...scope,
      get: () => readConfig(scope.get()),
      // The next/prev values handed to the watch callback are the same DSH-resolved
      // wrapper layer (see above), so unwrap them too — otherwise checks like
      // `next.desktopMode === false` never hold.
      watch: (listener) => scope.watch((next, prev) => listener(readConfig(next), readConfig(prev))),
    }
  }
  if (typeof forms?.describe !== 'function') return localSettingsScope(publicConfig(get()))
  const dispose = forms.configure?.({ auto: false }, eventCtx.fiber)
  if (dispose) {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
    else if (typeof eventCtx.effect === 'function') eventCtx.effect(() => dispose)
  }
  return {
    get,
    watch(listener) {
      return eventCtx.on('loader/volatile-update', () => listener(get()))
    },
    update(patch) {
      return forms.update(PLUGIN_KEY, patch)
    },
  }
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Loopback + same-origin guard shared by every host endpoint. */
function localOnly(req, res) {
  if (localHostOk(req)) return true
  jsonResponse(res, 403, { error: 'local access only' })
  return false
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8192) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('patch must be an object')
  return value
}

/**
 * Fields that may be PATCHed through the config endpoint. The remaining schema
 * fields (`activePetId` / `pets`) go through the pet registry endpoint and are
 * not listed here. The field list is spread across four places — schema /
 * defaults / publicConfig / this allowlist — and adding a field most easily
 * misses one of them; `test/host-snapshot.test.js` pins all four together with
 * a set difference.
 */
export const CONFIG_PATCH_FIELDS = Object.freeze([
  'enabled', 'scale', 'mirror', 'bubbleScaleSync', 'bubbleScaleRatio', 'bubbleFixedSize',
  'opacity', 'locked', 'paused', 'hidden', 'includeSubagents', 'showBubble', 'showBubbleStatus',
  'showBubbleUsage', 'usageMode', 'platformToken', 'desktopMode', 'posX', 'posY',
  'desktopX', 'desktopY',
])

export function createConfigHandler(settings) {
  const allowed = new Set(CONFIG_PATCH_FIELDS)
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method === 'GET') {
      jsonResponse(res, 200, clientConfig(settings.get()))
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const value = await readJsonBody(req)
      if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('patch contains an unknown setting')
      await settings.update(value)
      jsonResponse(res, 200, clientConfig(settings.get()))
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

export function applyCompletionAck(completionQueue, pulse, sessionId, { clearPulse = false } = {}) {
  completionQueue.delete(sessionId)
  if (clearPulse && pulse?.sessionId === sessionId && pulse.state === PetState.SUCCESS) return null
  return pulse
}

export function createCompletionAckHandler({ acknowledge, broadcast = () => {} }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) throw new Error('sessionId must be a non-empty string')
      acknowledge(sessionId, { clearPulse: body.clearPulse === true })
      broadcast()
      jsonResponse(res, 200, { ok: true })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Slot for the latest undelivered session-action: when no web client was
 * online (`delivered === 0`), a desktop bubble-card click would be silently
 * lost. The action is stashed here and replayed exactly once to the next SSE
 * subscriber (stream handshake), so the browser still lands on the chat.
 */
export function createPendingActionStore() {
  let pending = null
  return {
    stash: (action) => { pending = action },
    /** Take-and-clear: returns the stashed action or null. */
    take: () => { const action = pending; pending = null; return action },
  }
}

/**
 * Subscriber type from a stream request url. The desktop pet window
 * identifies itself with ?client=pet; everything else (including malformed
 * urls) is treated as a web client.
 * @param reqUrl - raw request url (path + query).
 */
export function streamClientOf(reqUrl) {
  try {
    return new URL(reqUrl ?? '/', 'http://localhost').searchParams.get('client') === 'pet' ? 'pet' : 'web'
  } catch {
    return 'web'
  }
}

export function createSessionOpenHandler({ notify, onUndelivered }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (!sessionId) throw new Error('sessionId must be a non-empty string')
      const action = {
        protocolVersion: 1,
        kind: 'session-action',
        sessionId,
        approve: body.approve === true,
        // Completion-card click: the web client needs `completed` to decide whether
        // to acknowledge along with it
        completed: body.completed === true,
      }
      // delivered=false: no web client is currently subscribed to SSE, so the
      // desktop "allow once" broadcast has no receiver — the caller can tell
      // success from silent loss this way.
      const delivered = notify(action) > 0
      // Nobody online: stash the newest action and replay it to the next SSE
      // subscriber during the stream handshake (cold-start fallback).
      // approve:true is never stashed — approvals are highly time-sensitive, and
      // auto-approving a possibly stale request after a long offline spell of the
      // web client risks more than it gains; better not to replay (the desktop
      // client can raise it again) than to delay execution. Navigation actions
      // (approve:false) carry no such risk, so they are stashed as usual.
      if (!delivered && !action.approve && typeof onUndelivered === 'function') onUndelivered(action)
      jsonResponse(res, 200, { ok: true, delivered })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Per-browser-tab current-session state. A single global lastReported value lets a
 * hidden tab clear the visible tab's selection; keeping one short-lived record per
 * client avoids that cross-tab race while retaining the existing TTL fallback.
 */
export function createCurrentSessionStore({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  const reports = new Map()
  const keyOf = (clientId) => typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 128
    ? clientId
    : 'legacy'
  const prune = (timestamp) => {
    for (const [key, report] of reports) {
      if (timestamp - report.at >= ttlMs) reports.delete(key)
    }
  }
  return {
    accept(clientId, sessionId) {
      const timestamp = now()
      prune(timestamp)
      const key = keyOf(clientId)
      const previous = reports.get(key)
      reports.set(key, { sessionId, at: timestamp })
      return { changed: !previous || previous.sessionId !== sessionId }
    },
    current() {
      const timestamp = now()
      prune(timestamp)
      let latest = null
      for (const report of reports.values()) {
        if (!report.sessionId || (latest && latest.at > report.at)) continue
        latest = report
      }
      return latest?.sessionId || ''
    },
  }
}

/**
 * Web-client current-session uplink: POST { sessionId, clientId } (empty string clears).
 * Fire-and-forget, but when the value really changes the second argument of
 * `accept` hands `changed` to the caller: the desktop window's "current session
 * read" state depends entirely on `currentSessionId` in the host snapshot, so
 * without an explicit broadcast here it would have to wait for the next
 * arbitrary broadcast or for its own 5-second poll, making the completion-card
 * green dot lag half a beat behind the web client.
 * @param accept - (sessionId, { changed, clientId }) => void; changed = this tab's reported value differs.
 * @param store - injectable per-tab state store; a dedicated one is created for this handler when omitted.
 */
export function createSessionCurrentHandler({ accept, store = createCurrentSessionStore() }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      if (typeof body.sessionId !== 'string') throw new Error('sessionId must be a string')
      const clientId = typeof body.clientId === 'string' ? body.clientId : ''
      const { changed } = store.accept(clientId, body.sessionId)
      accept(body.sessionId, { changed, clientId })
      jsonResponse(res, 200, { ok: true })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Normalizing the host theme value: only 'dark' / 'light' are accepted; an
 * empty value means "clear the report" (the desktop window falls back to the
 * system theme). Any other value raises an error instead of being silently
 * treated as empty — a client typo (say 'Dark') would quietly skew the palette,
 * and that kind of mistake is nearly invisible until the two clients are
 * compared side by side in screenshots.
 */
export function normalizeHostTheme(value) {
  if (value === '' || value === undefined || value === null) return ''
  if (value === 'dark' || value === 'light') return value
  throw new Error("theme must be 'dark', 'light' or ''")
}

/**
 * Web-client host-theme uplink: POST { theme: 'dark' | 'light' | '', clientId } (empty string = clear).
 * The desktop floating window is a standalone Electron window and cannot read the
 * host page's body[data-ds-dark-theme], so the theme can only be reported by the
 * web client: while a web client is online the desktop window follows the host
 * theme and both clients share the same menu/bubble colors; with no web client
 * online (or an expired report) the snapshot carries no hostTheme and the desktop
 * window falls back to the system theme. Fire-and-forget, and when the value
 * really changes the second argument of `accept` hands `changed` to the caller to broadcast.
 * @param accept - (theme, { changed, clientId }) => void; changed = the effective theme differs from the last one.
 */
export function createThemeHandler({ accept, ttlMs = 10 * 60 * 1000, now = () => Date.now() }) {
  const reports = new Map()
  const keyOf = (clientId) => typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 128
    ? clientId
    : 'legacy'
  const currentTheme = (timestamp) => {
    for (const [key, report] of reports) {
      if (timestamp - report.at >= ttlMs) reports.delete(key)
    }
    let latest = null
    for (const report of reports.values()) {
      if (!report.theme || (latest && latest.at > report.at)) continue
      latest = report
    }
    return latest?.theme || ''
  }
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const theme = normalizeHostTheme(body.theme)
      const clientId = typeof body.clientId === 'string' ? body.clientId : ''
      const timestamp = now()
      const previous = currentTheme(timestamp)
      const key = keyOf(clientId)
      if (theme) reports.set(key, { theme, at: timestamp })
      else reports.delete(key)
      const next = currentTheme(timestamp)
      accept(next, { changed: next !== previous, clientId })
      jsonResponse(res, 200, { ok: true })
    } catch (error) {
      jsonResponse(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Scan assets/pets/ for pet directories and their GIF files.
 * @param root - the absolute assets/pets directory.
 * @returns discovery entries `[{ id, gifs }]`.
 */
export async function scanPetDirs(root) {
  let names
  try {
    names = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory() || !isValidPetId(entry.name)) continue
    const dir = join(root, entry.name)
    let gifs = []
    let manifest = { pics: 0 }
    try {
      const files = await readdir(dir)
      gifs = files.filter((f) => f.endsWith(PET_MOOD_EXT))
      if (files.includes(PET_MANIFEST)) {
        manifest = parsePetManifest(await readFile(join(dir, PET_MANIFEST), 'utf8'))
      }
      // Count artwork pics automatically: however many pics/<n>.png files there
      // are is how many the gallery shows, so dropping images straight into the
      // pics/ folder is enough — no manual edit of pet-manifest.json needed.
      let pics = 0
      try {
        pics = (await readdir(join(dir, 'pics'))).filter((f) => /^\d{1,3}\.png$/i.test(f)).length
      } catch { /* no pics directory */ }
      if (pics > 0) manifest.pics = pics
    } catch {
      gifs = []
    }
    out.push({ id: entry.name, gifs, manifest })
  }
  return out
}

/**
 * The pets endpoint: GET the merged registry view; PATCH /pets/<id> with
 * `{ enabled?, name?, active? }` to enable/disable, rename, or activate one
 * pet. All mutations go through settings.update, so they persist and the
 * settings watch refreshes the registry.
 */
export function createPetsHandler({ settings, refreshRegistry }) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const rest = pathname.slice(PETS_ENDPOINT.length)
    if (req.method === 'GET') {
      if (rest !== '' && rest !== '/') {
        jsonResponse(res, 404, { error: 'not found' })
        return
      }
      jsonResponse(res, 200, { ok: true, ...(await refreshRegistry()) })
      return
    }
    if (req.method !== 'PATCH') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const id = rest.startsWith('/') ? decodeURIComponent(rest.slice(1)) : null
    if (!id || !isValidPetId(id)) {
      jsonResponse(res, 404, { error: 'unknown pet' })
      return
    }
    try {
      const value = await readJsonBody(req)
      if (Object.keys(value).some((key) => !['enabled', 'name', 'active'].includes(key))) {
        throw new Error('patch contains an unknown field')
      }
      const current = settings.get()
      const next = { ...current, pets: upsertPet(current.pets ?? [], { id, ...value }) }
      if (value.active === true) next.activePetId = id
      await settings.update(next)
      jsonResponse(res, 200, { ok: true, ...(await refreshRegistry()) })
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Serve one pet's mood sticker: GET /assets/<petId>/<mood>.gif.
 * `parseAssetPath` is the traversal gate; missing files answer 404.
 */
export function createAssetsHandler(petsRoot) {
  return async (req, res) => {
    if (!localOnly(req, res)) return
    if (req.method !== 'GET') {
      jsonResponse(res, 405, { error: 'method not allowed' })
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const parsed = parseAssetPath(pathname, ASSETS_PREFIX)
    if (!parsed) {
      jsonResponse(res, 404, { error: 'not found' })
      return
    }
    let file
    let type
    if (parsed.kind === 'pic') {
      file = join(petsRoot, parsed.petId, 'pics', `${parsed.index}.png`)
      type = 'image/png'
    } else {
      file = join(petsRoot, parsed.petId, `${parsed.mood}${PET_MOOD_EXT}`)
      type = 'image/gif'
    }
    try {
      const data = await readFile(file)
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=3600',
        'content-length': data.length,
      })
      res.end(data)
    } catch {
      jsonResponse(res, 404, { error: 'not found' })
    }
  }
}

/**
 * A session's title: prefer the authoritative value from the `sessionTitle`
 * service; when that service is not loaded or is isolated, cordis's property
 * access throws outright (optional chaining cannot catch it), and failing
 * silently means no title at all — so fall back to deriving one from the
 * session log directly. Old sessions whose title was written before the plugin
 * loaded (sessions resumed after a DSH restart) never replay `session/title`,
 * so their title only exists in the log.
 */
export function readSessionTitle(ctx, sessionId) {
  let session
  try {
    session = ctx?.sessions?.get?.(sessionId)
  } catch {
    return undefined
  }
  if (!session) return undefined
  try {
    const title = ctx.sessionTitle?.get?.(session)?.title
    const text = title ? String(title).trim() : ''
    if (text) return text
  } catch { /* service unavailable: fall through to the log-derived title */ }
  // Deriving the title can itself throw (an implementation detail of
  // `snapshotEvents()`); the exception must not escape into snapshot building.
  try {
    return titleFromSessionLog(session)
  } catch {
    return undefined
  }
}

/**
 * When "Respond to sub-agents" is switched off, also drop the sub-session
 * completion cards still sitting in the queue. Those cards were enqueued while
 * the switch was still on, and the web client's synthetic-card filter cannot
 * reach the host queue, so they would stay visible until clicked away or until
 * that session becomes active again. The decision uses the host's own recorded
 * id set rather than a live Session: short-lived sub-sessions are often
 * disposed before the switch is turned off, so no Session can be fetched then
 * and deciding by it would miss entries.
 * @param completionQueue - the host completion-reminder queue (keys are real sessionIds).
 * @param isSubagentSession - whether that sessionId belongs to a sub-session.
 * @returns whether any entry was really removed (the caller decides whether to broadcast).
 */
export function dropSubagentCompletions(completionQueue, isSubagentSession) {
  let dropped = false
  for (const sessionId of [...completionQueue.keys()]) {
    let subagent = false
    try {
      subagent = isSubagentSession(sessionId) === true
    } catch {
      continue
    }
    if (subagent) {
      completionQueue.delete(sessionId)
      dropped = true
    }
  }
  return dropped
}

/**
 * Build the pet snapshot served to the browser: the active PULSE overlay
 * wins while its deadline is live, otherwise the reducer's latest state.
 * `petId` (the active pet) rides along so the client can resolve sticker
 * URLs; it resolves through the registry, not the raw config.
 */
export function createStateSnapshot({ getLatest, getPulse, getConfig, getPetId, getDesktopActive, getWebClients, getActivePet, getStates, getCompletions, getCurrent, getTheme, getSessionTitle }) {
  const petIdOf = typeof getPetId === 'function' ? getPetId : () => DEFAULT_PET_ID
  const desktopActiveOf = typeof getDesktopActive === 'function' ? getDesktopActive : () => false
  const webClientsOf = typeof getWebClients === 'function' ? getWebClients : () => 0
  const activePetOf = typeof getActivePet === 'function' ? getActivePet : () => undefined
  const statesOf = typeof getStates === 'function' ? getStates : () => []
  const completionsOf = typeof getCompletions === 'function' ? getCompletions : () => []
  const currentOf = typeof getCurrent === 'function' ? getCurrent : () => undefined
  const themeOf = typeof getTheme === 'function' ? getTheme : () => ''
  const titleOf = typeof getSessionTitle === 'function' ? getSessionTitle : () => undefined
  const withTitle = (entry) => {
    if (!entry || entry.title) return entry
    const sid = entry.targetSessionId || entry.sessionId
    const title = sid ? titleOf(sid) : undefined
    return title ? { ...entry, title } : entry
  }
  return () => {
    const config = publicConfig(getConfig())
    const now = Date.now()
    const pulse = getPulse()
    const base = getLatest()
    const activePulse = pulse && pulse.until > now ? pulse : undefined
    const source = activePulse ?? base
    // One entry per tracked session for the stacked-bubble view. The active
    // PULSE overlay (success / error flash) overrides its own session's entry
    // so the flash lands on the right bubble, not on the primary.
    const stateEntries = statesOf()
    let pulseMatched = false
    const sessions = stateEntries.map((entry) => {
      if (activePulse && activePulse.sessionId === entry.sessionId) {
        pulseMatched = true
        return withTitle({
          ...entry,
          state: activePulse.state,
          mood: activePulse.mood ?? entry.mood,
          phase: activePulse.phase ?? entry.phase,
          message: activePulse.message ?? entry.message,
          detail: activePulse.detail ?? entry.detail,
          title: activePulse.title ?? entry.title,
          approval: entry.approval === true,
          planReview: entry.planReview === true,
          ask: entry.ask === true,
          completed: activePulse.state === PetState.SUCCESS,
          pulseUntil: activePulse.until,
        })
      }
      return withTitle(entry)
    })
    // Completed sessions are absent from reducer.states(). Add the transient
    // pulse card while it is live; persistent reminders are merged below.
    if (activePulse && activePulse.sessionId && !pulseMatched) {
      sessions.push(withTitle({
        sessionId: activePulse.sessionId,
        state: activePulse.state,
        mood: activePulse.mood ?? '06',
        phase: activePulse.phase ?? 'pulse',
        message: activePulse.message ?? '',
        detail: activePulse.detail ?? 'DSH',
        project: activePulse.project,
        task: activePulse.task,
        progress: activePulse.progress,
        attention: activePulse.state === PetState.WAITING || activePulse.state === PetState.ERROR,
        approval: false,
        ask: false,
        planReview: false,
        completed: activePulse.state === PetState.SUCCESS,
        updatedAt: now,
        pulseUntil: activePulse.until,
        title: activePulse.title,
      }))
    }
    for (const completion of completionsOf()) {
      const liveIndex = sessions.findIndex((entry) => entry.sessionId === completion.sessionId)
      if (liveIndex >= 0) {
        const live = sessions[liveIndex]
        if (live.state === PetState.SUCCESS && live.pulseUntil > now) {
          sessions[liveIndex] = {
            ...live,
            targetSessionId: completion.sessionId,
            completionNotification: true,
          }
        }
        continue
      }
      sessions.push(withTitle({
        ...completion,
        sessionId: `completion:${completion.sessionId}`,
        targetSessionId: completion.sessionId,
        state: PetState.SUCCESS,
        mood: completion.mood ?? '03',
        completed: true,
        completionNotification: true,
        attention: false,
        approval: false,
        ask: false,
        planReview: false,
      }))
    }
    const currentId = currentOf() || undefined
    sessions.sort((left, right) => compareSessions(left, right, currentId))
    return {
      ok: true,
      enabled: config.enabled === true,
      scale: config.scale,
      mirror: config.mirror === true,
      bubbleScaleSync: config.bubbleScaleSync !== false,
      bubbleScaleRatio: config.bubbleScaleRatio,
      bubbleFixedSize: config.bubbleFixedSize,
      opacity: config.opacity,
      locked: config.locked === true,
      bubble: config.showBubble !== false,
      // Clients read showBubble uniformly (same name as the config field);
      // bubble is the legacy alias, kept for compatibility
      showBubble: config.showBubble !== false,
      showBubbleStatus: config.showBubbleStatus !== false,
      showBubbleUsage: config.showBubbleUsage === true,
      usageMode: config.usageMode ?? 'ledger',
      // platformToken does not go into the /state snapshot: the snapshot is
      // broadcast over SSE to every subscriber (any web tab, the desktop
      // window), so carrying the token in plain text would scatter the platform
      // credential to every page that receives the snapshot.
      // /config also only returns clientConfig: the settings page learns whether
      // a token is configured, but never receives the token itself.
      // The balance service still reads the token via settings.get(); the only
      // way to write it is a PATCH to /config.
      paused: config.paused === true,
      hidden: config.hidden === true,
      desktopActive: desktopActiveOf(),
      // Number of web-client subscribers (excluding the desktop pet window): the
      // desktop client uses it to tell whether a web page is open, so the idle
      // bubble stops reopening the system browser.
      webClients: webClientsOf(),
      desktopMode: config.desktopMode === true,
      petId: petIdOf() ?? DEFAULT_PET_ID,
      // The "session the user is looking at", reported by the web client; an
      // empty string clears it and falls back to missing (omitted during JSON
      // serialization)
      currentSessionId: currentOf() || undefined,
      // The host theme reported by the web client ('dark' / 'light'); a missing
      // field means no web client is online or the report expired, and the
      // desktop floating window falls back to the system theme. The desktop
      // window is a separate window and cannot read the host page's theme itself.
      hostTheme: themeOf() || undefined,
      posX: config.posX ?? null,
      posY: config.posY ?? null,
      pics: activePetOf()?.pics ?? 0,
      state: source?.state ?? PetState.IDLE,
      mood: activePulse?.mood ?? source?.mood ?? '06',
      phase: source?.phase ?? 'no-session',
      message: activePulse?.message ?? source?.message ?? 'Remielle is idling~',
      detail: activePulse?.detail ?? source?.detail ?? 'DSH',
      project: base?.project ?? undefined,
      task: base?.task ?? undefined,
      progress: base?.progress ?? undefined,
      pulseUntil: activePulse ? activePulse.until : 0,
      sessions,
      updatedAt: now,
      ts: now,
    }
  }
}

/**
 * Server-Sent Events hub for the pet state stream.
 *
 * A fresh subscriber immediately receives the current snapshot (so the
 * EventSource handshake doubles as a state read), then every `broadcast()`
 * pushes the latest snapshot. Heartbeat comment frames keep proxies from
 * timing the connection out; `close()` ends every client.
 *
 * Subscribers carry a client type: `add(res, { client: 'pet' })` marks the
 * desktop pet window, which keeps a permanent subscription but drops any
 * frame carrying a `kind` field. `notify()` therefore counts only web
 * clients as delivered — otherwise a running desktop window would make
 * every session-action look delivered and starve the pending-action replay.
 */
export function createStreamHub({ serve, onClientsChanged }) {
  const clients = new Map() // res -> { client: 'pet' | 'web' }
  // Notify the caller whenever the subscriber set changes (connect / disconnect /
  // failed cleanup): the snapshot's webClients comes from here, and without it
  // "is a web page open" would only be known at the next broadcast (both the idle
  // bubble and auto-read rely on it).
  const notifyClientsChanged = typeof onClientsChanged === 'function' ? onClientsChanged : () => {}
  const drop = (res) => {
    if (!clients.delete(res)) return
    notifyClientsChanged()
  }
  const send = (res, payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      drop(res)
    }
  }
  const heartbeat = setInterval(() => {
    for (const res of [...clients.keys()]) {
      try {
        res.write(': ping\n\n')
      } catch {
        drop(res)
      }
    }
  }, 25000)
  heartbeat.unref?.()
  return {
    add(res, { client } = {}) {
      clients.set(res, { client: client === 'pet' ? 'pet' : 'web' })
      try {
        res.write('retry: 3000\n\n')
        send(res, serve())
      } catch {
        drop(res)
      }
      res.on?.('close', () => drop(res))
      res.on?.('error', () => drop(res))
      notifyClientsChanged()
    },
    broadcast() {
      const payload = serve()
      for (const res of [...clients.keys()]) send(res, payload)
    },
    /**
     * Push an arbitrary message (e.g. download progress / session-action) to
     * every client. Returns the number of WEB clients reached — pet-window
     * subscribers still receive the frame (their page ignores kind frames)
     * but never count as delivered.
     */
    notify(payload) {
      let delivered = 0
      for (const [res, meta] of [...clients]) {
        try {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          if (meta.client !== 'pet') delivered++
        } catch {
          drop(res)
        }
      }
      return delivered
    },
    get size() {
      return clients.size
    },
    /** Number of web-client subscribers (excluding the desktop pet window): the authoritative signal for "is a web page open". */
    get webSize() {
      let total = 0
      for (const meta of clients.values()) if (meta.client !== 'pet') total++
      return total
    },
    close() {
      clearInterval(heartbeat)
      for (const res of [...clients.keys()]) {
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
      clients.clear()
      notifyClientsChanged()
    },
  }
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

function mount(ctx, config = {}, eventCtx = ctx) {
  const logger = ctx.logger ?? console
  const settings = createSettingsScope(ctx, config, eventCtx)
  const base = publicConfig(settings.get())

  const resolveCredential = (name) => {
    const cred = eventCtx.credentials ?? ctx.credentials
    if (!cred || typeof cred.resolve !== 'function') return Promise.resolve(null)
    try {
      return cred.resolve(name)
    } catch (err) {
      return Promise.reject(err)
    }
  }
  const balanceService = createBalanceService({
    resolveCredential,
    getPlatformToken: () => String(settings.get().platformToken || ''),
    log: (code, error) => logger.error?.(`dsh-pet-remielle: ${code} ${error}`),
  })
  let usageModeNow = normalizeUsageMode(settings.get().usageMode)

  const petsRoot = fileURLToPath(new URL('../assets/pets/', import.meta.url))

  const reducer = new PetReducer({ includeSubagents: base.includeSubagents === true })
  let latest = createMessage(PetMessageKind.STATE, {
    state: PetState.IDLE,
    mood: '06',
    phase: 'plugin-start',
    stage: 'Idle',
    message: 'Remielle is idling~',
    detail: 'DSH · waiting for the next task',
  })
  let pulse = null
  // The web client reports the current session per tab (empty string = clear):
  // kept in memory only and carried out naturally with the next snapshot/SSE; the
  // report itself is fire-and-forget and triggers no broadcast. Each tab stores
  // it independently so a hidden tab's clear cannot wipe the visible tab; when a
  // page crashes or is killed the TTL still backstops it, preventing a stale
  // currentSessionId from keeping on mis-topping or mis-auto-acking. The TTL is
  // 10 minutes, far larger than the normal interval between tab switches.
  const CURRENT_SESSION_TTL_MS = 10 * 60 * 1000
  const currentSessionStore = createCurrentSessionStore({ ttlMs: CURRENT_SESSION_TTL_MS })
  // The host theme reported by the web client ('dark' / 'light'; empty string =
  // cleared / never reported): the desktop floating window is a separate window
  // and cannot reach the host page's body[data-ds-dark-theme], so this report is
  // the only way to match the web client's colors.
  // Like currentSessionId it carries a TTL: when a page is killed its pagehide
  // clear-report never runs, and without a TTL the desktop window would keep
  // hanging on an expired host palette. Theme changes are far sparser than
  // session switches (the web client also renews with a 5-minute heartbeat), so
  // a 10-minute TTL is comfortably enough.
  const HOST_THEME_TTL_MS = 10 * 60 * 1000
  let reportedHostTheme = ''
  let reportedHostThemeAt = 0
  // Completed turns stay visible until the user opens their conversation.
  const completionQueue = new Map()
  // sessionIds seen in the event stream and judged to be sub-sessions. When
  // "Respond to sub-agents" is switched off this set drives the cleanup of the
  // leftover completion cards in the queue — it cannot rely on a live Session:
  // short-lived sub-sessions are often disposed before the switch is turned off.
  const subagentSessionIds = new Set()

  const onMessage = (message) => {
    if (message.kind === PetMessageKind.PULSE) {
      pulse = { ...message, until: Date.now() + (message.ttlMs ?? 3000) }
      if (message.state === PetState.SUCCESS && message.sessionId) {
        completionQueue.set(message.sessionId, {
          sessionId: message.sessionId,
          // Same copy pool as the reducer's SUCCESS text (status-copy.js success);
          // the seed is the sessionId to stay deterministic (Date.now() differs
          // every time). Differing from the reducer/client-side variant is
          // allowed; pool consistency is guaranteed by the anti-drift test.
          message: message.message ?? statusCopy('success', message.sessionId ?? ''),
          detail: message.detail ?? 'Task complete',
          project: message.project,
          title: message.title,
          task: message.task,
          progress: message.progress,
          phase: 'turn-end',
          updatedAt: Date.now(),
          completedAt: Date.now(),
        })
      }
      // The durable state beneath the overlay: after the pulse expires the
      // pet falls back to what the reducer remembered at pulse time.
      latest = {
        protocolVersion: message.protocolVersion,
        kind: PetMessageKind.STATE,
        timestamp: Date.now(),
        sessionId: message.sessionId,
        state: message.resumeState ?? PetState.IDLE,
        mood: message.resumeMood ?? '06',
        phase: message.phase ?? 'pulse-end',
        message: message.resumeMessage ?? 'Remielle is idling~',
        detail: message.resumeDetail ?? 'DSH',
        task: latest.task,
        progress: latest.progress,
        project: latest.project,
      }
      return
    }
    if (message.kind === PetMessageKind.TASK) {
      // Attach task/progress to the durable state snapshot.
      latest = { ...latest, task: message.task, progress: message.progress, project: message.project }
      return
    }
    if (message.kind === PetMessageKind.STATE) {
      latest = message
      if (
        message.sessionId
        && message.state !== PetState.IDLE
        && message.state !== PetState.DISCONNECTED
      ) {
        completionQueue.delete(message.sessionId)
      }
    }
  }

  const settingsNow = () => settings.get()

  // Registry: merged view of discovered pet dirs + persisted config. Refreshed
  // on boot, on every config change, and on each registry request; the state
  // snapshot reads the last resolved active pet synchronously.
  let registry = { activePetId: DEFAULT_PET_ID, pets: [] }
  let refreshing = null
  const refreshRegistry = () => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const dirs = await scanPetDirs(petsRoot)
        const config = settings.get()
        registry = buildRegistry(dirs, config.pets ?? [], config.activePetId)
      } catch (error) {
        logger.error?.(`dsh-pet-remielle: registry refresh failed: ${String(error)}`)
      } finally {
        refreshing = null
      }
      return registry
    })()
    return refreshing
  }

  // webClients has to read the hub from inside the snapshot, while the hub needs
  // that same snapshot to serve — break the cycle with a late binding.
  let hubRef = null
  // The current session reported by the web client: per-tab TTL, so no zombie
  // ids linger after a host exit or a page crash. The snapshot and the
  // "failure in the current session counts as read" check share this one source.
  const currentSessionNow = () => currentSessionStore.current()
  const serveState = createStateSnapshot({
    getLatest: () => latest,
    getPulse: () => pulse,
    getConfig: settingsNow,
    getPetId: () => registry.activePetId,
    getDesktopActive: () => desktopActive,
    getWebClients: () => (hubRef ? hubRef.webSize : 0),
    getActivePet: () => registry.pets.find((pet) => pet.id === registry.activePetId),
    getStates: () => reducer.states(),
    getCompletions: () => [...completionQueue.values()],
    getCurrent: () => currentSessionNow(),
    getTheme: () => (Date.now() - reportedHostThemeAt < HOST_THEME_TTL_MS ? reportedHostTheme : ''),
    getSessionTitle: (sessionId) => readSessionTitle(ctx, sessionId),
  })

  const hub = createStreamHub({
    serve: serveState,
    // Recompute the snapshot whenever a subscriber connects or disconnects:
    // webClients changed, and both the idle bubble and auto-read read it.
    onClientsChanged: () => { if (hubRef) hubRef.broadcast() },
  })
  hubRef = hub
  // Clicked-card fallback for when no web client is online: only the newest
  // action is kept, replayed to the next SSE subscriber during the handshake
  const pendingActions = createPendingActionStore()

  let desktopActive = false

  // Observe every DSH session. Loader entries may live inside a scoped
  // composition, so use the unscoped root bus and dispose explicitly.
  // Completion-reminder cleanup does not depend on the reducer's "selected
  // render": when a session restarts or is destroyed the queue is cleared right
  // here — otherwise, while a higher-priority anchor masks it, an old
  // completion card would come back to life after an aborted turn; in the
  // one-shot sub-agent case (destroyed as soon as it finishes) the green dot
  // would also linger forever.
  const completionSessionIdOf = (session) => {
    const id = String(session?.header?.id ?? session?.id ?? '')
    return id || null
  }
  const dropCompletion = (session) => {
    const id = completionSessionIdOf(session)
    if (!id || !completionQueue.delete(id)) return
    // The bookkeeping set follows the queue: once the card is gone there is no
    // need to remember that it was a sub-session, so the set stays the same
    // order of magnitude as the queue.
    subagentSessionIds.delete(id)
    hub.broadcast()
  }
  const dismissErrorIfNeeded = (sessionId) => {
    if (!sessionId) return
    const hadError = reducer.states().some((entry) => entry.sessionId === sessionId && entry.state === PetState.ERROR)
    if (!hadError) return
    for (const message of reducer.dismissError(sessionId)) onMessage(message)
    // #render only emits a message when the selected-session signature changes, so
    // dismissing a background ERROR may return [], but states() has already lost
    // that card — the snapshot must be pushed anyway.
    hub.broadcast()
  }
  const offEvent = eventCtx.on('session/event', (session, event) => {
    const eventType = String(event?.type ?? '')
    // Sub-session id bookkeeping: used to clean up leftover completion cards when
    // "Respond to sub-agents" is switched off (see subagentSessionIds).
    if (isSubagent(session)) {
      const subagentId = completionSessionIdOf(session)
      if (subagentId) subagentSessionIds.add(subagentId)
    }
    // Watchdog liveness: any event refreshes that session's "last activity"
    // timestamp; a turn/end has wrapped the turn up, so the entry is removed and
    // no longer takes part in hang detection.
    watchdog.feed(completionSessionIdOf(session))
    if (eventType === 'turn/end') watchdog.end(completionSessionIdOf(session))
    if (eventType === 'turn/start' || eventType === 'tool/call') dropCompletion(session)
    const outgoing = [...reducer.handle(session, event)]
    const sessionId = completionSessionIdOf(session)
    const currentFailed = eventType === 'turn/end'
      && sessionId
      && sessionId === currentSessionNow()
      && reducer.states().some((entry) => entry.sessionId === sessionId && entry.state === PetState.ERROR)
    // The failure happens while the person is already in that conversation: it
    // counts as read on the spot and does not enter the pink mark.
    if (currentFailed) outgoing.push(...reducer.dismissError(sessionId))
    for (const message of outgoing) onMessage(message)
    if (outgoing.length || currentFailed || eventType === 'session/title') hub.broadcast()
  }, { global: true })
  const offDisposed = eventCtx.on('session/disposed', (session) => {
    dropCompletion(session)
    watchdog.end(completionSessionIdOf(session))
    for (const message of reducer.disposeSession(session)) {
      onMessage(message)
      hub.broadcast()
    }
  }, { global: true })

  // Turn-hang watchdog: when the GUI force-kills a session DSH does not re-emit
  // turn/end on the live bus (it only repairs when cold-reading the log), so the
  // event stream stops abruptly and the reducer stays stuck in THINKING
  // ("Analyzing") forever. Scan every 30 seconds: a session in THINKING/WORKING
  // with no event for more than 3 minutes gets a synthesized
  // turn/end{kind:'aborted'} that reuses the existing wrap-up path to return to
  // IDLE "Stopped" (no seq is passed, so record.lastSeq stays unchanged; the
  // stopped copy seed falls back stably through status-copy's seedNumber).
  // WAITING/ERROR may legitimately wait a long time (approval / waiting for an
  // answer), so they are never treated as hung.
  // Hard-coding turn number 0 is safe: the reducer's aborted branch only reads
  // reason.kind and does not validate the turn number (see the turn/end branch of
  // pet-reducer.js).
  const watchdog = createTurnWatchdog()
  const watchdogTimer = setInterval(() => {
    for (const sessionId of watchdog.tick(reducer.states())) {
      watchdog.end(sessionId)
      logger.info?.(`dsh-pet-remielle: turn hung with no events, force-ending session ${sessionId} as aborted`)
      for (const message of reducer.handle(
        { header: { id: sessionId } },
        { type: 'turn/end', data: { turn: 0, reason: { kind: 'aborted' } } },
      )) {
        onMessage(message)
        hub.broadcast()
      }
    }
  }, TURN_WATCHDOG_INTERVAL_MS)
  watchdogTimer.unref?.() // belt and braces: never block process exit even if the host skips the dispose hook below

  const unwatch = settings.watch((next) => {
    const includeSubagents = next.includeSubagents === true
    const wasIncluding = reducer.includeSubagents === true
    for (const message of reducer.setIncludeSubagents(includeSubagents)) {
      onMessage(message)
      hub.broadcast()
    }
    // The switch went from on to off: sub-session completion cards enqueued while
    // it was on must be withdrawn too (the web client's filter only covers
    // synthetic cards).
    if (wasIncluding && !includeSubagents) {
      if (dropSubagentCompletions(completionQueue, (sessionId) => subagentSessionIds.has(sessionId))) {
        hub.broadcast()
      }
    }
    // Invalidate the balance cache when the usage mode switches so the next request
    // is computed with the new mode immediately
    const mode = normalizeUsageMode(next.usageMode)
    if (mode !== usageModeNow) {
      usageModeNow = mode
      balanceService.invalidate()
    }
    // enabled/scale/opacity/locked are read live by the client on every poll.
    refreshRegistry().then(() => hub.broadcast())
  })

  void refreshRegistry()

  if (typeof ctx.inject === 'function') {
    // Only webServer is injected. Adding connection would make the entire callback
    // (which registers all 20 routes) not run on hosts without that service, and
    // the plugin would silently go completely limp — see the dshWebUrl note below.
    ctx.inject(['webServer'], (httpCtx) => {
      const port = httpCtx.webServer.port

      // ---- desktop pet window (transparent always-on-top Electron) ----
      let desktop = undefined
      const stopDesktop = (reason) => {
        desktop?.stop(reason)
        desktop = undefined
        if (desktopActive) {
          desktopActive = false
          hub.broadcast()
        }
      }
      const origin = `http://127.0.0.1:${port}`
      const desktopUrl = `${origin}${PET_VIEW_ENDPOINT}`
      // Since DSH 0.1.2-alpha.1 the web shell root path needs a process token,
      // so we go through connection's authenticatedUrl. connection is an
      // **optional dependency**: the previous version wrote it into
      // ctx.inject(['webServer', 'connection']), but cordis's inject only runs
      // the callback when every service is available — and this whole block holds
      // all 20 webServer.register calls, so on a host without a connection service
      // the plugin does not merely lose one endpoint, it fails to register the
      // entire route table, with no error at all. The commit's intent was only to
      // put the token on the desktop url; it must not gate the whole table, so
      // injection goes back to webServer only and connection is fetched via get().
      // Fault tolerance is kept as well: if authenticatedUrl throws, fall back to
      // the bare origin — one exception while fetching a url must not take the
      // whole desktop-window startup flow down with it.
      const dshWebUrl = () => {
        try {
          const connection = httpCtx.get('connection')
          return typeof connection?.authenticatedUrl === 'function'
            ? connection.authenticatedUrl(origin)
            : origin
        } catch (error) {
          logger.warn?.(`dsh-pet-remielle: dshWebUrl() failed, falling back to origin (${String(error)})`)
          return origin
        }
      }
      // The DSH Desktop host wraps every WebServer route in a desktopBrowserAccess
      // gate (only requests carrying the renderer-specific header pass; with
      // "browser access" off everything else gets 403 "forbidden"). The
      // standalone desktop pet Electron window must fetch rendererHeader from
      // the host context and let the window process inject it itself
      // (pet-window.cjs, the same mechanism DSH Desktop's own renderer uses);
      // a plain web host has no such service and get returning undefined simply
      // skips it.
      let desktopRendererHeader = null
      try {
        const access = httpCtx.get('desktopBrowserAccess')
        if (access?.rendererHeader?.name && access?.rendererHeader?.value) {
          desktopRendererHeader = { name: access.rendererHeader.name, value: access.rendererHeader.value }
        }
      } catch { /* no such service (plain web host) */ }
      const onDesktopExit = (owner) => {
        // stop() clears the old instance's child first, but the old Electron's exit
        // event may arrive late; only the instance still held by the host's
        // desktop reference may tear down the current window.
        if (desktop !== owner) return
        desktop = undefined
        if (desktopActive) { desktopActive = false; hub.broadcast() }
      }
      let confirmSent = false // prevent duplicate confirm dialogs
      const startDesktop = (allowFetch = false) => {
        if (desktop) return
        // Boot-time call: respect the setting (desktopMode may be false).
        // User-action calls (watch / /desktop/start): the caller already
        // verified desktopMode flipped to true, so skip this guard —
        // settings.get() may still reflect the OLD value at this point.
        if (!allowFetch && settings.get().desktopMode === false) return
        /** Create a DesktopWindow, attach it, and broadcast state. */
        const spawnWindow = () => {
          let w
          try {
            w = new DesktopWindow({ url: desktopUrl, webUrl: dshWebUrl(), logger, onExit: onDesktopExit, posX: settings.get().desktopX, posY: settings.get().desktopY, rendererHeader: desktopRendererHeader })
          } catch (error) {
            logger.error?.(`dsh-pet-remielle: failed to create the desktop window: ${String(error)}`)
            return false
          }
          if (!w.backend) return false
          desktop = w
          try {
            w.start()
          } catch (error) {
            logger.error?.(`dsh-pet-remielle: failed to start the desktop window process: ${String(error)}`)
            desktop = undefined
            return false
          }
          if (!desktopActive) { desktopActive = true; hub.broadcast() }
          return true
        }
        if (spawnWindow()) return
        // No Electron runtime yet.  Only fetch on demand when the user
        // *actively* turns desktop mode on (settings toggle or in-page
        // "open desktop window"); boot-time call stays on the in-page pet.
        if (!allowFetch) {
          logger.info?.('dsh-pet-remielle: desktop pet window unavailable (no backend), browser pet stays')
          return
        }
        if (confirmSent) return // already waiting for user confirmation
        confirmSent = true
        // Log every missing file at once: with a partial vendor/ tree, "no backend"
        // alone would not show which piece is missing.
        const missing = missingRuntimeFiles(electronArtifact().vendorDir, process.platform)
        logger.info?.(`dsh-pet-remielle: no Electron backend — requesting user confirmation to fetch (bundled root missing: ${missing.length ? missing.join(', ') : 'nothing, other candidates empty'})`)
        hub.notify({ protocolVersion: 1, kind: 'download', phase: 'confirm' })
      }
      // Only react when desktopMode itself flips: the watch fires on every
      // config change (scale/opacity/locked/bubble from wheel zoom, sliders
      // or the in-page menu), and starting the desktop window on those would
      // yank the pet out of the page against the user's choice.
      let desktopModeNow = settings.get().desktopMode === false ? false : true
      const unwatchDesktop = settings.watch((next) => {
        const mode = next.desktopMode === false ? false : true
        if (mode === desktopModeNow) return
        desktopModeNow = mode
        if (mode === false) stopDesktop('settings-change')
        else startDesktop(true)
      })
      startDesktop()

      /** Actually perform the Electron download with SSE progress pushes. */
      let downloading = false
      const runDownload = () => {
        if (downloading) return
        downloading = true
        hub.notify({ protocolVersion: 1, kind: 'download', phase: 'start', percent: 0 })
        ensureElectronRuntime({
          onProgress: (m) => {
            logger.info?.(`dsh-pet-remielle: ${m}`)
            const pct = /(\d+)%/.exec(m)
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'progress', percent: pct ? Number(pct[1]) : -1, text: m })
          },
        })
          .then((exe) => {
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'done', percent: 100 })
            logger.info?.(`dsh-pet-remielle: Electron ready at ${exe}, starting desktop window`)
            downloading = false
            confirmSent = false
            if (desktop) return // already running
            // Open the window directly using the known path instead of
            // relying on resolveBackend() which re-scans and may not
            // find the freshly installed runtime in time.
            const petWindowCjs = new URL('../src/pet-window.cjs', import.meta.url)
            const backend = { kind: 'electron', command: exe, args: [petWindowCjs.href.startsWith('file://') ? fileURLToPath(petWindowCjs) : String(petWindowCjs)] }
            const w = new DesktopWindow({ url: desktopUrl, webUrl: dshWebUrl(), logger, onExit: onDesktopExit, backend, posX: settings.get().desktopX, posY: settings.get().desktopY, rendererHeader: desktopRendererHeader })
            desktop = w
            w.start()
            if (!desktopActive) { desktopActive = true; hub.broadcast() }
          })
          .catch((error) => {
            hub.notify({ protocolVersion: 1, kind: 'download', phase: 'error', text: error.message })
            downloading = false
            confirmSent = false
            logger.info?.(`dsh-pet-remielle: desktop window unavailable — ${error.message} (browser pet stays)`)
          })
      }

      // ---- endpoints ----
      let petViewHtml = null
      const readPetView = async () => {
        if (petViewHtml) return petViewHtml
        petViewHtml = await readFile(new URL('../src/pet-view.html', import.meta.url), 'utf8')
        return petViewHtml
      }
      let balanceWidgetJs = null
      const readBalanceWidget = async () => {
        if (balanceWidgetJs) return balanceWidgetJs
        balanceWidgetJs = await readFile(new URL('../src/balance-widget.js', import.meta.url), 'utf8')
        return balanceWidgetJs
      }
      let sessionOrderJs = null
      const readSessionOrder = async () => {
        if (sessionOrderJs) return sessionOrderJs
        sessionOrderJs = await readFile(new URL('../src/session-order.cjs', import.meta.url), 'utf8')
        return sessionOrderJs
      }
      let petTipJs = null
      const readPetTip = async () => {
        if (petTipJs) return petTipJs
        petTipJs = await readFile(new URL('../src/pet-tip.cjs', import.meta.url), 'utf8')
        return petTipJs
      }
      let gifFrameJs = null
      const readGifFrame = async () => {
        if (gifFrameJs) return gifFrameJs
        gifFrameJs = await readFile(new URL('../src/gif-frame.cjs', import.meta.url), 'utf8')
        return gifFrameJs
      }
      let bubbleTitleJs = null
      const readBubbleTitle = async () => {
        if (bubbleTitleJs) return bubbleTitleJs
        bubbleTitleJs = await readFile(new URL('../src/bubble-title.cjs', import.meta.url), 'utf8')
        return bubbleTitleJs
      }

      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CONFIG_ENDPOINT, handler: createConfigHandler(settings) }),
        'dsh-pet-remielle: local settings endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: STATE_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          jsonResponse(res, 200, serveState())
        } }),
        'dsh-pet-remielle: local state endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: COMPLETION_ACK_ENDPOINT,
          handler: createCompletionAckHandler({
            acknowledge: (sessionId, opts) => {
              pulse = applyCompletionAck(completionQueue, pulse, sessionId, opts)
              subagentSessionIds.delete(sessionId)
            },
            broadcast: () => hub.broadcast(),
          }),
        }),
        'dsh-pet-remielle: completion notification acknowledgement',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: SESSION_OPEN_ENDPOINT,
          handler: createSessionOpenHandler({
            notify: (payload) => {
              const delivered = hub.notify(payload)
              if (payload?.sessionId) dismissErrorIfNeeded(payload.sessionId)
              return delivered
            },
            onUndelivered: (action) => pendingActions.stash(action),
          }),
        }),
        'dsh-pet-remielle: desktop session open/approve bridge',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: SESSION_CURRENT_ENDPOINT,
          handler: createSessionCurrentHandler({
            store: currentSessionStore,
            accept: (sessionId, { changed }) => {
              dismissErrorIfNeeded(sessionId)
              // Broadcast as soon as the value changes: the desktop window only learns which
              // session you are looking at from currentSessionId in the snapshot,
              // so without a broadcast it has to wait for the next arbitrary
              // broadcast or for its own 5-second poll (the green dot then
              // disappears half a beat later than in the web client).
              if (changed) hub.broadcast()
            },
          }),
        }),
        'dsh-pet-remielle: web client current-session uplink',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'exact',
          path: THEME_ENDPOINT,
          handler: createThemeHandler({
            accept: (theme, { changed }) => {
              reportedHostTheme = theme
              // A cleared report (empty string) refreshes the timestamp too: the
              // cleared state is itself a valid state
              reportedHostThemeAt = Date.now()
              // Broadcast as soon as the value changes: the desktop floating
              // window decides its menu/bubble palette from hostTheme in the
              // snapshot, so it must follow immediately when the host theme
              // switches, otherwise the two clients look mismatched for a while.
              if (changed) hub.broadcast()
            },
          }),
        }),
        'dsh-pet-remielle: web client host-theme uplink',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: BALANCE_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          try {
            const payload = await balanceService.getBalance(settings.get().usageMode)
            jsonResponse(res, 200, payload)
          } catch (err) {
            jsonResponse(res, 200, { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
          }
        } }),
        'dsh-pet-remielle: balance endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: STREAM_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          sseHeaders(res)
          // The subscriber type goes into the hub: ?client=pet (the desktop pet
          // window) does not count toward delivered, otherwise its permanent
          // subscription would make every session-action look "delivered" and
          // turn the stashed-action fallback into dead code.
          const client = streamClientOf(req.url)
          hub.add(res, { client })
          // The action from a clicked card with no web client online is replayed
          // here: a new web subscriber receives the newest session-action during
          // the handshake. The desktop pet window drops frames carrying a kind —
          // skip the replay so its reconnect cannot swallow the stashed action.
          if (client !== 'pet') {
            const replay = pendingActions.take()
            if (replay) {
              try {
                res.write(`data: ${JSON.stringify(replay)}\n\n`)
              } catch {
                // Client already disconnected: roll the stash back and leave the action for
                // the next web subscriber, so a take-then-write failure cannot
                // silently lose the action.
                pendingActions.stash(replay)
              }
            }
          }
        } }),
        'dsh-pet-remielle: local state stream endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: PET_VIEW_ENDPOINT, handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const html = await readPetView()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        } }),
        'dsh-pet-remielle: pet window view',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/balance-widget.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readBalanceWidget()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: balance bubble client script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/session-order.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readSessionOrder()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: shared bubble order script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/pet-tip.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readPetTip()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: shared pet tip script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/gif-frame.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readGifFrame()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: shared gif frame script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: '/plugins/dsh-pet-remielle/bubble-title.js', handler: async (req, res) => {
          if (!localOnly(req, res)) return
          const js = await readBubbleTitle()
          res.writeHead(200, {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(js)
        } }),
        'dsh-pet-remielle: shared bubble card script',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: DESKTOP_ENDPOINT,
          handler: async (req, res) => {
            if (!localOnly(req, res)) return
            if (req.method !== 'POST') {
              jsonResponse(res, 405, { ok: false, error: 'method not allowed (POST only)' })
              return
            }
            let action = 'unknown'
            try {
              action = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'unknown'
            } catch {
              /* keep unknown */
            }
            if (action === 'start') startDesktop(true)
            else if (action === 'stop') stopDesktop('in-page menu')
            else if (action === 'confirm-download') runDownload()
            // The cancel-download branch responds itself and must return: falling through
            // to the bottom would jsonResponse a second time →
            // ERR_HTTP_HEADERS_SENT (the host log warned repeatedly in practice).
            else if (action === 'cancel-download') { confirmSent = false; jsonResponse(res, 200, { ok: true }); return }
            else {
              jsonResponse(res, 400, { ok: false, error: 'expected /desktop/start, /desktop/stop, /desktop/confirm-download, or /desktop/cancel-download' })
              return
            }
            jsonResponse(res, 200, { ok: true, desktopActive })
          },
        }),
        'dsh-pet-remielle: desktop window start/stop/confirm-download',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: PETS_ENDPOINT,
          handler: createPetsHandler({ settings, refreshRegistry }),
        }),
        'dsh-pet-remielle: pets registry endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({
          kind: 'prefix',
          path: ASSETS_PREFIX,
          handler: createAssetsHandler(petsRoot),
        }),
        'dsh-pet-remielle: pet sticker assets',
      )
      // ---- self-update routes (version check + one-click update) ----
      // One-click update replaces files inside the plugin directory: stop the desktop
      // pet window first and wait for the process to exit — electron.exe running
      // from the vendor/ directory locks those files and causes pnpm/git EPERM
      setSelfUpdateHooks({
        stopDesktopWindow: async (reason = 'self-update') => {
          const w = desktop
          await w?.stop(reason)
          if (w && desktopActive) { desktopActive = false; hub.broadcast() }
        },
        // Wrap-up after a successful update: the bundled Electron runtime was replaced
        // by pnpm, so leaving desktop mode on would mean "no pet on either
        // client" after the restart. Switch back to the web pet automatically;
        // the returned note is shown in the update card.
        onUpdateSuccess: () => {
          if (settings.get().desktopMode !== false) {
            void settings.update({ desktopMode: false })
            return 'Desktop floating mode was on: its Electron runtime is removed by the update, so the web pet has been restored automatically. You can turn it back on after the restart (the runtime will be downloaded again).'
          }
          return null
        },
      })
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: CHECK_ENDPOINT, handler: checkHandler }),
        'dsh-pet-remielle: version check endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: UPDATE_ENDPOINT, handler: updateHandler }),
        'dsh-pet-remielle: one-click update endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: PROGRESS_ENDPOINT, handler: progressHandler }),
        'dsh-pet-remielle: live update progress endpoint',
      )
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: INFO_ENDPOINT, handler: infoHandler }),
        'dsh-pet-remielle: install info endpoint',
      )
      httpCtx.effect(() => () => {
        unwatchDesktop()
        stopDesktop('dsh-host-stop')
        // Kill an in-flight pnpm/git when the host exits: an orphan process keeps
        // rewriting node_modules and leaves it half-finished, which crashes the
        // plugin the next time it loads
        killActiveUpdate()
      })
    })
  }

  ctx.effect(() => () => {
    clearInterval(watchdogTimer)
    offEvent?.()
    offDisposed?.()
    unwatch()
    hub.close()
  })
}

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => mount(settingsCtx, config, ctx))
    return
  }
  mount(ctx, config)
}

export {
  PetMessageKind,
  PetReducer,
  PetState,
}
