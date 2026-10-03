/**
 * Desktop floating window preload bridge (src/pet-preload.cjs).
 *
 * This layer is the only channel between the renderer page and the main process, and it is
 * also the security boundary: what contextBridge exposes, which IPC channel each method sends
 * on, and how arguments are normalized are all decided here. Previously the only coverage was
 * three source-string matches in test/platform/desktop-window.test.js — which missed argument
 * normalization (`Boolean(on)`, `Number(x) || 0`) and could not stop a method from being deleted
 * or renamed.
 *
 * The source only does require('electron') and then calls exposeInMainWorld once, so injecting a
 * fake electron into vm is enough to capture the exposed object and call the methods directly,
 * asserting the IPC channels and arguments without any DOM stub.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')

/** Load a preload, capturing the petBridge it exposes and every IPC call. */
function loadPreload() {
  const sent = []
  const invoked = []
  let exposed = null
  let exposedName = null
  const ipcRenderer = {
    send: (channel, ...args) => sent.push({ channel, args }),
    invoke: (channel, ...args) => {
      invoked.push({ channel, args })
      return Promise.resolve({})
    },
  }
  const contextBridge = {
    exposeInMainWorld: (name, api) => { exposedName = name; exposed = api },
  }
  const sandbox = {
    require: (name) => {
      if (name === 'electron') return { contextBridge, ipcRenderer }
      throw new Error(`unexpected require: ${name}`)
    },
    module: { exports: {} },
    console,
  }
  runInNewContext(SRC, sandbox, { filename: 'pet-preload.cjs' })
  return { bridge: exposed, exposedName, sent, invoked, lastSend: () => sent.at(-1), lastInvoke: () => invoked.at(-1) }
}

test('exposes exactly one petBridge namespace', () => {
  const { bridge, exposedName } = loadPreload()
  assert.equal(exposedName, 'petBridge', 'the renderer should see exactly one petBridge')
  assert.ok(bridge, 'exposeInMainWorld must really have been called')
  // The method set is the contract between the renderer and the main process: delete one and
  // the renderer sees undefined, add one and there is an extra channel nobody reviewed. Any
  // addition or removal is pointed out here immediately.
  assert.deepEqual(Object.keys(bridge).sort(), [
    'artworkClear', 'artworkClose', 'artworkFade', 'artworkOpen', 'artworkSet',
    'dragEnd', 'dragMove', 'dragStart',
    'getInitialPosition', 'getPosition', 'getWorkArea',
    'menuExpand', 'menuRestore',
    'openDshPage', 'resetPosition',
    'setClickThrough', 'setForceInteractive', 'setHitRects',
  ])
})

test('click-through and force-interactive are coerced to booleans', () => {
  const { bridge, lastSend } = loadPreload()
  for (const [method, channel] of [['setClickThrough', 'set-click-through'], ['setForceInteractive', 'force-interactive']]) {
    bridge[method](1)
    assert.deepEqual(lastSend(), { channel, args: [true] }, `${method} should send true`)
    bridge[method](0)
    assert.deepEqual(lastSend(), { channel, args: [false] })
    bridge[method]('truthy string')
    assert.deepEqual(lastSend(), { channel, args: [true] }, `${method} must normalize with Boolean() and must not send a string to the main process`)
    bridge[method](undefined)
    assert.deepEqual(lastSend(), { channel, args: [false] })
  }
})

test('drag coordinates are coerced to finite numbers, missing becomes 0', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.dragStart(120, 240)
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [120, 240] })
  // The main process computes the window displacement from these values; a NaN/undefined passed
  // along makes the window fly off-screen
  bridge.dragStart(undefined, null)
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [0, 0] }, 'missing arguments must become 0, not NaN')
  bridge.dragStart('80', 'not-a-number')
  assert.deepEqual(lastSend(), { channel: 'drag-start', args: [80, 0] })
})

test('dragMove and dragEnd are plain signals with no payload', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.dragMove()
  assert.deepEqual(lastSend(), { channel: 'drag-move', args: [] })
  bridge.dragEnd()
  assert.deepEqual(lastSend(), { channel: 'drag-end', args: [] })
})

test('hit rects are forwarded verbatim, not normalised', () => {
  const { bridge, lastSend } = loadPreload()
  const rects = [{ x: 1, y: 2, w: 3, h: 4 }, { x: 5, y: 6, w: 7, h: 8 }]
  bridge.setHitRects(rects)
  assert.equal(lastSend().channel, 'hit-rects')
  assert.equal(lastSend().args[0], rects, 'hit rects are an array and must be forwarded verbatim (the main process pairs and compares them in order)')
})

test('query bridges invoke their channel and return the promise', async () => {
  const { bridge, lastInvoke } = loadPreload()
  const cases = [
    ['getPosition', 'get-position'],
    ['getInitialPosition', 'get-initial-position'],
    ['resetPosition', 'reset-position'],
    ['getWorkArea', 'get-work-area'],
    ['menuRestore', 'menu-restore'],
    ['openDshPage', 'open-dsh-page'],
  ]
  for (const [method, channel] of cases) {
    const result = bridge[method]()
    assert.deepEqual(lastInvoke(), { channel, args: [] }, `${method} should invoke ${channel}`)
    assert.ok(result && typeof result.then === 'function', `${method} must return the invoke promise to the renderer`)
    await result
  }
})

test('menuExpand forwards four coerced coordinates', () => {
  const { bridge, lastInvoke } = loadPreload()
  bridge.menuExpand(10, 20, 30, 40)
  assert.deepEqual(lastInvoke(), { channel: 'menu-expand', args: [10, 20, 30, 40] })
  // Missing arguments are treated as 0 by the main process, which degenerates the bounding box
  // into the top-left origin and flashes the menu at the corner of the screen
  bridge.menuExpand(5, undefined, null, 'x')
  assert.deepEqual(lastInvoke(), { channel: 'menu-expand', args: [5, 0, 0, 0] })
})

test('artwork window defaults to 240x240 and coerces the rest', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.artworkOpen(400, 300)
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [400, 300] })
  bridge.artworkOpen()
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [240, 240] }, 'missing arguments must fall back to 240')
  bridge.artworkOpen('300', 'x')
  assert.deepEqual(lastSend(), { channel: 'artwork-open', args: [300, 240] })
})

test('artwork data url is stringified, lifecycle calls carry no payload', () => {
  const { bridge, lastSend } = loadPreload()
  bridge.artworkSet({ raw: 'data:image/png;base64,AAA' })
  assert.equal(lastSend().channel, 'artwork-set')
  assert.equal(lastSend().args[0], '[object Object]', 'a non-string input must be caught by String() and must not hand the object straight to the main process')

  for (const [method, channel] of [
    ['artworkClear', 'artwork-clear'],
    ['artworkFade', 'artwork-fade'],
    ['artworkClose', 'artwork-close'],
  ]) {
    bridge[method]()
    assert.deepEqual(lastSend(), { channel, args: [] })
  }
})
