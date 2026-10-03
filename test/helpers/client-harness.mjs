import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const CLIENT = new URL('../../lib/client.js', import.meta.url)
export const CLIENT_CORE = new URL('../../src/client.core.js', import.meta.url)
export const STATUS_COPY = new URL('../../src/status-copy.js', import.meta.url)

export function createHarness(initialCurrent = 'other', autoSelect = true, snapshotItems = [], modernNavigation = false, withLayout = true) {
  const elements = []
  const fetches = []
  const opened = []
  const timers = []
  const cleanups = []
  let nextTimer = 0
  const styleWrites = []
  let current = initialCurrent
  let sessionListener
  let stream
  let visibilityState = 'visible'
  let focused = true
  let activePanelId = null
  const documentListeners = new Map()

  function element(tag = 'div') {
    let node
    const state = {
      tag,
      children: [],
      listeners: new Map(),
      style: new Proxy({}, {
        set(target, key, value) {
          styleWrites.push({ element: node, key, value })
          target[key] = value
          return true
        },
      }),
      dataset: {},
      className: '',
      textContent: '',
      parentNode: null,
    }
    node = new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key]
        if (key === 'appendChild') return (child) => {
          child.parentNode = node
          target.children.push(child)
          return child
        }
        if (key === 'remove') return () => {
          if (!target.parentNode) return
          target.parentNode.children = target.parentNode.children.filter((child) => child !== node)
        }
        if (key === 'addEventListener') return (name, listener) => {
          const listeners = target.listeners.get(name) ?? []
          listeners.push(listener)
          target.listeners.set(name, listeners)
        }
        if (key === 'setAttribute') return () => {}
        if (key === 'contains') return () => true
        if (key === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 180, height: 180 })
        if (key === 'scrollWidth' || key === 'offsetWidth') {
          const own = String(target.textContent || '').length * 12
          const children = target.children.reduce((total, child) => total + Number(child.scrollWidth || 0), 0)
          return Math.max(own, children, 16)
        }
        if (key === 'offsetHeight' || key === 'clientHeight') return 68
        if (key === 'classList') return {
          add(name) { if (!target.className.includes(name)) target.className += ` ${name}` },
          remove(name) { target.className = target.className.split(/\s+/).filter((value) => value && value !== name).join(' ') },
          toggle(name, force) {
            if (force) this.add(name)
            else this.remove(name)
          },
        }
        return () => node
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    })
    elements.push(node)
    return node
  }

  const body = element('body')
  const head = element('head')
  const allowClicks = []
  // The approval buttons keep their Chinese labels on purpose: the plugin's allow-once
  // matcher is bilingual input matching against the DSH host DOM, so keeping the fixture
  // Chinese proves that branch still resolves after the UI copy is translated.
  const allowBtn = {
    textContent: ' 允许一次 ',
    innerText: ' 允许一次 ',
    getAttribute() { return '' },
    click() { allowClicks.push('allow') },
  }
  const rejectBtn = {
    textContent: '拒绝',
    innerText: '拒绝',
    getAttribute() { return '' },
    click() { allowClicks.push('reject') },
  }
  const approvalPanel = {
    querySelectorAll(sel) {
      if (String(sel).includes('button')) return [rejectBtn, allowBtn]
      return []
    },
  }
  // A second approval panel, hung under **another** session root (otherConversationFrame).
  //
  // It must carry a clickable button. Previously querySelectorAll here always returned [],
  // with the reason written as "with multiple panels nothing is clicked, so no button is
  // needed" — that reason only holds for the document-level gate, and it is fatal for the
  // session-scoped branch: when the root has no clickable button, approvalPanels()
  // collects other session roots too, and the result is **exactly** the same as collecting
  // only the current root, so deleting
  // `if (sessionId && rootSession !== sessionId) continue` would not be caught
  // (mutation check: changing it to `if (false) continue` leaves all 287 cases green). The
  // button label differs from the correct one, so clicking the wrong root is recorded as a
  // different click and the assertion turns red.
  const otherAllowBtn = {
    textContent: '允许一次（other 会话）',
    innerText: '允许一次（other 会话）',
    getAttribute() { return '' },
    click() { allowClicks.push('allow-other') },
  }
  const otherApprovalPanel = {
    querySelectorAll(sel) {
      if (String(sel).includes('button')) return [otherAllowBtn]
      return []
    },
  }
  const conversationFrame = {
    getAttribute(name) { return name === 'data-conversation-session' ? current : '' },
    querySelectorAll(sel) {
      if (sel === '[data-approval-key]') return [approvalPanel]
      return []
    },
  }
  const otherConversationFrame = {
    getAttribute(name) { return name === 'data-conversation-session' ? 'other-session' : '' },
    querySelectorAll(sel) {
      if (sel === '[data-approval-key]') return [otherApprovalPanel]
      return []
    },
  }
  // By default, simulate a new host whose page has the [data-conversation-session] scope, so
  // approvalPanels takes the scoped branch. Tests can use setApprovalDom to switch to "no
  // scope + document-level panels" to cover the never-exercised panels.length === 1 gate.
  let scopedRoots = [otherConversationFrame, conversationFrame]
  let loosePanels = [otherApprovalPanel, approvalPanel]
  const document = {
    body,
    head,
    documentElement: element('html'),
    get visibilityState() { return visibilityState },
    hasFocus: () => focused,
    createElement: (tag) => element(tag),
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) ?? []
      listeners.push(listener)
      documentListeners.set(name, listeners)
    },
    removeEventListener(name, listener) {
      documentListeners.set(name, (documentListeners.get(name) ?? []).filter((entry) => entry !== listener))
    },
    querySelector(sel) {
      return sel === '[data-conversation-session]' ? conversationFrame : sel === '[data-approval-key]' ? approvalPanel : null
    },
    querySelectorAll(sel) {
      if (sel === '[data-conversation-session]') return scopedRoots
      return sel === '[data-approval-key]' ? loosePanels : []
    },
  }
  class EventSourceStub {
    constructor() { stream = this }
    close() {}
  }
  const windowListeners = new Map()
  const beacons = []
  class BlobStub {
    constructor(parts) { this.parts = parts }
  }
  const navigatorStub = {
    // sendBeacon records the request body; a test can unset sendBeacon to verify the
    // keepalive-fetch fallback
    sendBeacon: (url, blob) => { beacons.push({ url, body: String(blob?.parts?.[0] ?? '') }); return true },
  }
  const window = {
    __ModuleLoader__: { load(entry) { window.factory = entry.factory } },
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: { setItem() {} },
    addEventListener(name, listener) {
      const listeners = windowListeners.get(name) ?? []
      listeners.push(listener)
      windowListeners.set(name, listeners)
    },
    removeEventListener(name, listener) {
      windowListeners.set(name, (windowListeners.get(name) ?? []).filter((entry) => entry !== listener))
    },
    setInterval() { return 1 },
    clearInterval() {},
    setTimeout(listener) {
      const id = ++nextTimer
      timers.push({ id, listener, cancelled: false })
      return id
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id)
      if (timer) timer.cancelled = true
    },
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    dispatchEvent() {},
  }
  const fetch = async (url, options = {}) => {
    fetches.push({ url, options })
    if (String(url).endsWith('/state')) return { ok: true, json: async () => null }
    return { ok: true, json: async () => ({ ok: true }) }
  }

  const code = readFileSync(CLIENT, 'utf8')
  new Function('window', 'document', 'EventSource', 'fetch', 'navigator', 'Blob', code)(window, document, EventSourceStub, fetch, navigatorStub, BlobStub)
  const moduleExports = window.factory((id) => {
    if (id === 'react') return { createElement: () => ({}), Fragment: Symbol('Fragment') }
    throw new Error(`unexpected require: ${id}`)
  })
  const slots = {
    inject(name, callback) { callback(); return () => {} },
    register() { return () => {} },
  }
  const openSession = (sessionId) => {
    opened.push(sessionId)
    if (autoSelect) {
      current = sessionId
      sessionListener?.()
    }
  }
  const sessions = {
    list: {
      getSnapshot: () => modernNavigation
        ? { byId: { ...snapshotItems, ...(current ? { [current]: { id: current, retainedBy: { mainView: 1 } } } : {}) } }
        : { current, byId: snapshotItems },
      subscribe(listener) {
        sessionListener = listener
        return () => { if (sessionListener === listener) sessionListener = undefined }
      },
    },
    ...(modernNavigation ? {} : { open: openSession }),
  }
  const uiWorkspace = { openSession }
  const panelListeners = new Set()
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener) },
    },
  }
  moduleExports.apply({
    slots,
    sessions,
    get(name) {
      if (modernNavigation && name === 'uiWorkspace') return uiWorkspace
      if (name === 'layout') return withLayout ? layout : undefined
      return undefined
    },
    effect: (callback) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  })

  function send(snapshot) {
    stream.onmessage({ data: JSON.stringify(snapshot) })
  }
  function card(title) {
    const titleNode = elements.find((node) => node.className === 'rm2-pet-bubble-title' && node.textContent === title)
    assert.ok(titleNode, `missing card title ${title}`)
    return titleNode.parentNode.parentNode
  }
  function click(node) {
    const listener = node.listeners.get('click')?.[0]
    assert.ok(listener, 'missing click listener')
    listener({ preventDefault() {}, stopPropagation() {} })
  }
  function select(sessionId) {
    current = sessionId
    sessionListener?.()
  }
  function flushTitleTimers() {
    const queued = timers.splice(0)
    for (const timer of queued) {
      if (!timer.cancelled) timer.listener()
    }
  }
  function dispatchWindowEvent(name) {
    for (const listener of windowListeners.get(name) ?? []) listener({})
  }
  function dispatchDocumentEvent(name) {
    for (const listener of documentListeners.get(name) ?? []) listener({})
  }
  function setVisibility(next) {
    visibilityState = next
    dispatchDocumentEvent('visibilitychange')
  }
  function setPanelActive(next) {
    activePanelId = next ? 'plugins' : null
    for (const listener of panelListeners) listener()
  }
  function setFocus(next) {
    focused = next
    dispatchWindowEvent(next ? 'focus' : 'blur')
  }
  return { allowClicks, beacons, card, click, dispatchDocumentEvent, dispatchWindowEvent, dispose: () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }, elements, fetches, navigator: navigatorStub, opened, panel: approvalPanel, otherPanel: otherApprovalPanel, select, send, setApprovalDom: (next) => { if (Array.isArray(next.scopedRoots)) scopedRoots = next.scopedRoots; if (Array.isArray(next.loosePanels)) loosePanels = next.loosePanels }, setFocus, setPanelActive, setVisibility, styleWrites, flushTitleTimers }
}

export const base = {
  ok: true,
  enabled: true,
  bubble: true,
  petId: 'remielle',
  mood: '06',
  opacity: 1,
  scale: 1,
  sessions: [],
}
