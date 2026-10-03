/**
 * The pure functions behind getting a GIF's current frame, and their degradation
 * behaviour.
 * The freeze chain itself (frame extraction with ImageDecoder) needs a secure
 * context and can only run in a real Chromium — see
 * .global_ignored/electron-gif-freeze-probe.cjs; what is guarded here is the
 * part that reproduces offline: frame index computation, duration summing, URL
 * detection, and the fact that nothing throws and degradation stays quiet when
 * WebCodecs is unavailable.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const gif = require('../src/gif-frame.cjs')

test('totalDuration sums positive finite frame delays only', () => {
  assert.equal(gif.totalDuration([30, 30, 30]), 90)
  assert.equal(gif.totalDuration([]), 0)
  assert.equal(gif.totalDuration(null), 0)
  assert.equal(gif.totalDuration([30, 'x', -5, 0, Number.NaN, 20]), 50)
})

test('indexAt maps elapsed ms onto the frame that is on screen', () => {
  const d = [30, 30, 30, 30] // 120ms per loop, 30ms per frame
  assert.equal(gif.indexAt(d, 0), 0, 'at the very start it is the first frame')
  assert.equal(gif.indexAt(d, 29), 0)
  assert.equal(gif.indexAt(d, 30), 1, 'the frame only changes once the first frame duration has passed')
  assert.equal(gif.indexAt(d, 31), 1)
  assert.equal(gif.indexAt(d, 119), 3)
})

test('indexAt wraps around and tolerates odd input (measured on stickers: 30ms/frame, 120 and 160 frames)', () => {
  const d = new Array(120).fill(30) // 06.gif: 120 frames = a 3.6s loop
  assert.equal(gif.indexAt(d, 120 * 30), 0, 'after a full loop it is back to the first frame')
  assert.equal(gif.indexAt(d, 120 * 30 + 45), 1)
  assert.equal(gif.indexAt(d, 3600 * 3 + 45), 1, 'after several loops it still takes the modulus of the whole loop')
  assert.equal(gif.indexAt(d, -15), 119, 'a negative moment wraps back to the last frame of the previous loop')
  assert.equal(gif.indexAt(d, Number.NaN), 0)
  assert.equal(gif.indexAt(d, undefined), 0)
  assert.equal(gif.indexAt([], 5), 0)
  assert.equal(gif.indexAt([0, 0], 5), 0, 'all-zero durations must not divide by zero')
})

test('indexAt honours uneven frame delays', () => {
  const d = [10, 50, 200, 40] // a 300ms loop
  assert.equal(gif.indexAt(d, 0), 0)
  assert.equal(gif.indexAt(d, 10), 1)
  assert.equal(gif.indexAt(d, 59), 1)
  assert.equal(gif.indexAt(d, 60), 2)
  assert.equal(gif.indexAt(d, 259), 2)
  assert.equal(gif.indexAt(d, 260), 3)
  assert.equal(gif.indexAt(d, 299), 3)
  assert.equal(gif.indexAt(d, 300), 0)
})

test('isGif only accepts gif urls so PNG stickers take the first-frame fallback', () => {
  assert.equal(gif.isGif('/plugins/dsh-pet-remielle/assets/remielle/06.gif'), true)
  assert.equal(gif.isGif('https://host/pet.GIF?t=1'), true)
  assert.equal(gif.isGif('/plugins/dsh-pet-remielle/assets/remielle/pics/1.png'), false)
  assert.equal(gif.isGif('data:image/png;base64,AAAA'), false)
  assert.equal(gif.isGif(''), false)
  assert.equal(gif.isGif(null), false)
})

test('freeze/warm/timeline degrade to null when WebCodecs is unavailable', async () => {
  // Node has no ImageDecoder: this assertion also covers the insecure-context
  // case of "a plain http LAN address"
  assert.equal(gif.supported(), false)
  assert.equal(await gif.freeze('https://host/06.gif', 1234), null)
  assert.equal(await gif.warm('https://host/06.gif'), null)
  assert.equal(await gif.timeline('https://host/06.gif'), null)
  assert.equal(await gif.freeze('https://host/pics/1.png', 10), null, 'a non-GIF yields to the fallback directly')
})

test('watch/livedMs stay inert without a real image element', () => {
  assert.equal(gif.livedMs(null), 0)
  assert.equal(gif.livedMs({}), 0)
  gif.watch(null) // must not throw
  gif.watch({})
})
