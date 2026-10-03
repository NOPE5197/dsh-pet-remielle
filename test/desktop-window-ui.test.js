/**
 * Cross-client wiring, geometry and theme checks for the desktop UI, run once as part of the
 * regular unit tests. The Electron backend and process lifecycle are verified by
 * test/platform/desktop-window.test.js.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { cardHeightOf } from './helpers/card-height.mjs'

test('pet-view ships the stacked bubble deck and a single page-switch dot', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // Bubble zoom goes through the shared bubbleZoomOf, planReviewOf goes through the shared
  // __order, and tip copy goes through the shared bubble-title.cjs — their arithmetic and copy
  // are covered by test/pet-tip.test.js, test/session-order.test.js and
  // test/bubble-title.test.js, so only structural guardrails are kept here.
  assert.match(html, /SESSION_OPEN_ENDPOINT/)
  assert.doesNotMatch(html, /id="dot1"/, 'the page-switch indicator should be a single dot and must not regress to the multi-id version')
  // The bubble card copy/styles were extracted into the shared module bubble-title.cjs: both
  // clients only call it and no longer carry a copy each. The copy itself is asserted
  // behaviourally, function by function, against the pure functions in
  // test/bubble-title.test.js (planSummaryOf / tipTextOf); here only the structure is pinned —
  // the shared module exists, both clients call it, neither keeps a copy.
  // (Earlier there were two literal assertions here, match(shared, /PLAN_MARKER…/) /
  // match(shared, /…click to open…/), duplicating those behavioural assertions; renaming a
  // string went red for nothing, so they were removed.)
  const shared = readFileSync(new URL('../src/bubble-title.cjs', import.meta.url), 'utf8')
  // Consumers must load the shared script; whether the host registers the route is covered by
  // host-transport's real route tests.
  assert.match(html, /\/plugins\/dsh-pet-remielle\/bubble-title\.js/)
  for (const [name, src] of [['pet-view.html', html], ['client.core.js', readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')]]) {
    assert.match(src, /__bubbleTitle\.applyCardChrome\(/, `${name} should call the shared applyCardChrome`)
    assert.match(src, /__bubbleTitle\.applyBackboardChrome\(/, `${name} should call the shared applyBackboardChrome`)
    assert.doesNotMatch(src, /click to open Approve \/ Request changes/, `${name} must not carry its own copy of the plan-review tip`)
    // No CSS rule consumes the plan-review / approval class names, and classNameOf no longer
    // produces them; the guardrail pins "no regression": if anyone writes the ' plan-review'
    // literal back into either client's source, this goes red.
    // The literal is deliberately asserted here rather than some expression shape — classNameOf
    // is a `function classNameOf(view, index)` declaration in the shared module, and shapes
    // like /classNameOf\s*=\s*'rm2-pet-bubble'\s*+/ do not exist in any source, so such an
    // assertion would never fail and look like coverage while covering nothing.
    assert.doesNotMatch(src, /' plan-review'/, `${name} must not carry its own copy of the plan-review class name`)
  }
  assert.match(html, /clearPulse:\s*true/)
  // The SSE subscription carries ?client=pet: the host uses it to exclude the pet window from the
  // session-action replay count (matching the contract of streamClientOf in index.js),
  // otherwise the "no web client online" check could never hold.
  assert.match(html, /\/plugins\/dsh-pet-remielle\/stream\?client=pet/)
  // The desktop window only displays reminders; it does not replace the background DSH tab's
  // automatic mark-as-read. Completion state is only cleared when that tab becomes visible
  // again, or when the user explicitly clicks the completion card.
  assert.doesNotMatch(html, /autoAckedCompletions/)
  assert.doesNotMatch(html, /acknowledgeCompletion\(currentSessionId\)/)
  assert.match(html, /requestSessionOpen\(el\.targetSessionId, el\.completed\)/)
  assert.match(html, /if \(el\.completed\) acknowledgeCompletion\(el\.targetSessionId\)/)
  assert.match(html, /entry\.state === 'ERROR' && targetSessionOf\(entry\) === currentSessionId/)
  // The approval card's hover tip copy branches are covered by test/bubble-title.test.js
  // (tipTextOf); here only two things are pinned: the tip is carried by the hand-drawn overlay
  // (the native title no longer scales with zoom and was abandoned), and the tip module really
  // is wired up.
  assert.match(html, /id="bubbleDot" title=""/)
  assert.doesNotMatch(html, /Click to see the balance~/)
  assert.match(html, /\/plugins\/dsh-pet-remielle\/pet-tip\.js/)
  assert.match(html, /__rm2PetTip/)
  assert.doesNotMatch(html, /Allow once: click the round checkmark to confirm/)
  // While the pet is held down, a snapshot apply must not flip grabbing back to grab
  assert.match(html, /lockedNow \? 'default' : dragState \? 'grabbing' : 'grab'/)
  // Releasing trusts only pointerup/cancel + capture, no longer guessing the release from the
  // mousemove buttons
  assert.match(html, /setPointerCapture\(e\.pointerId\)/)
  assert.match(html, /addEventListener\('pointerup'/)
  assert.match(html, /addEventListener\('pointercancel'/)
  assert.doesNotMatch(html, /e\.buttons & 1/)
  // The exposed amount of the second layer = card height − lift amount, and that must hold on
  // both clients, so **both card heights have to be pinned**.
  // The true card height lives in CSS (the harness stub's offsetHeight=68 is only an
  // approximation), so it is parsed from each client's CSS instead of hardcoding 91 — hardcode
  // it and changing the CSS keeps the assertion green while both clients have already drifted.
  // The parsing function lives in test/helpers/card-height.mjs: each client has its own CSS
  // rule, and writing the regex twice is bound to drift.
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const liftOf = (src) => Number(/STACK_LIFT_PX = (\d+)/.exec(src)?.[1])
  assert.equal(liftOf(shared), 80)
  assert.doesNotMatch(html, /STACK_LIFT_PX = \d+/, 'pet-view.html must no longer carry its own lift constant')
  assert.doesNotMatch(core, /STACK_LIFT_PX = \d+/, 'client.core.js must no longer carry its own lift constant')
  assert.equal(cardHeightOf(html, 'pet-view.html'), 91, 'desktop client card height')
  assert.equal(cardHeightOf(core, 'client.core.js'), 91, 'web client card height')
  // Both lift sites (the fake-backboard branch and the ternary branch) must reference the
  // constant and must not hardcode a value.
  const calls = [...shared.matchAll(/style\.marginTop = [^\n]*/g)].map((match) => match[0])
  assert.equal(calls.length, 2, 'the shared module should have two marginTop call sites')
  for (const call of calls) {
    assert.match(call, /STACK_LIFT_PX/, `the call site must reference the constant: ${call}`)
    assert.doesNotMatch(call, /'-\d+px'/, `the call site must not hardcode the lift amount: ${call}`)
  }
})

test('desktop idle-bubble click defers to an open web client but says so', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // With a web client online, openExternal must not be called again (the browser does not reuse
  // an existing tab, they just pile up); webClients comes from the SSE subscriber count in the
  // host snapshot.
  assert.match(html, /if \(!\(lastSnapshot && lastSnapshot\.webClients > 0\)\) __tip\.openIdleDshPage\(window\.petBridge\)/)
  // But "not opening it" is not the same as "not responding". This path used to return
  // directly, making the click completely silent, and the user could not tell whether it hung
  // or was blocked. It must give one line saying where to look — and this criterion itself has
  // a known gap (Chromium's tab discarding freezes background tabs, the SSE connection does not
  // close and the subscriber count runs high), which is exactly why the hint matters even more
  // once the user sees "nothing happened when I clicked".
  assert.match(html, /else showTransientTip\(el\.node, /)
  assert.match(html, /function showTransientTip\(anchor, text, ms\)/, 'the one-shot tip helper must exist')
  // The hint must be restored after use, otherwise it pollutes the card's later hover tooltip.
  assert.match(html, /if \(had\) anchor\.dataset\.rm2Tip = prev/)
  assert.match(html, /else delete anchor\.dataset\.rm2Tip/)
})

test('pet-view menu expands to the work-area box and restores on close', () => {
  // Opening the menu measures off-screen first, then positions: the menu must not flash at the
  // fixed default position during the window grow ipc round trip. The landing-spot computation
  // (anchor on the character / bounding box / MENU_GLOW / the 400×520 anchor box) is pet-view
  // html's internal geometry; it varies with the Chromium version and the zoom convention and
  // is not a good assertion target. What is pinned here is only "the main process really does
  // catch it" — the renderer and preload sides are verified by test/pet-preload.test.js, which
  // injects a fake electron through vm and calls the methods for real (channel names +
  // argument normalization + promise returns), which is stronger than matching source strings,
  // so those three are no longer asserted again here.
  const petWindow = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.match(petWindow, /ipcMain\.handle\('get-work-area'/)
  assert.match(petWindow, /ipcMain\.handle\('menu-expand', async \(_event, cssLeft, cssTop, cssRight, cssBottom\)/)
  assert.match(petWindow, /ipcMain\.handle\('menu-restore'/)
  // Growing the window must really enlarge it and make it resizable, otherwise the menu is
  // clipped by the window bounds even when its positioning is correct
  assert.match(petWindow, /setResizable\(true\)/)
  assert.match(petWindow, /setContentBounds\(bounds\)/)
  // uiZoom injection: the renderer computes coordinates with the scale factor, so the main
  // process must push down the very same value
  assert.match(petWindow, /insertCSS\(`:root\{--rm2-ui-zoom:/)
})

// The position persistence chain (issue #21): all three keys must be present at once —
// main-process positioning at creation + renderer write-back at drag end + preload channel;
// missing one link breaks the memory.
test('pet window position persistence is wired across main, preload and renderer', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // Restore clamping must be "the virtual desktop union + a minimum visible margin" and not
  // whole-window clamping to a single screen's workArea: the pet image hugs the window bottom,
  // so dragging it to the top edge of the screen necessarily pushes part of the window
  // off-screen (a measured y=-381), and whole-window clamping would drag it back to y=0, which
  // shows up as "the position is not remembered" (follow-up to issue #21).
  assert.match(main, /for \(const d of screen\.getAllDisplays\(\)\)/)
  assert.match(main, /ipcMain\.handle\('get-initial-position', \(\) => persistedPos\)/)
  // Main-process fallback write-back (issue #21 "sometimes it does not remember"): the
  // drag-end IPC is the moment the renderer is guaranteed to send, so the main process PATCHes
  // the host config directly there and the renderer's fetch has a fallback when it fails.
  // But it must require a "real drag" (drag non-null): the renderer sends drag-end for any
  // left-button release, and when the menu grows the window at the right edge it shifts x, so
  // an unconditional write-back stores the grown coordinate (which shows up as "y is
  // remembered but x is lost", follow-up feedback on issue #21).
  assert.match(main, /const wasDragging = drag !== null/)
  assert.match(main, /if \(wasDragging\) persistPosition\(\)/)
  assert.match(main, /desktopX: Math\.round\(x\), desktopY: Math\.round\(y\)/)
  // DSH Desktop renderer admission header: when the host env supplies the header name/value,
  // the main process must self-inject it into same-origin requests before creating the window
  // (otherwise everything gets 403 forbidden while DSH Desktop has "Browser access" off).
  assert.match(main, /session\.defaultSession\.webRequest\.onBeforeSendHeaders/)
  // preload: both IPC channels are exposed to the renderer
  assert.match(preload, /getInitialPosition: \(\) => ipcRenderer\.invoke\('get-initial-position'\)/)
  assert.match(preload, /getPosition: \(\) => ipcRenderer\.invoke\('get-position'\)/)
  // Renderer: write-back only happens at the end of a drag (moved and not locked), and the
  // position is the host coordinate
  assert.match(html, /dragState && dragState\.moved && !lockedNow/)
  assert.match(html, /desktopX: pos\.x, desktopY: pos\.y/)
})

// The userData directory of pet-window (follow-up to issue #21): the original implementation
// landed in %TEMP%, which system disk cleanup deletes as a whole directory (taking the Electron
// cache and the renderer's localStorage position fallback with it); sharing the host's default
// %APPDATA%/Electron locks the disk cache and serves stale responses. It now uses a stable
// directory plus an occupancy marker, backing off to a sibling directory carrying the pid when
// a live instance holds the stable one. The decision details are covered by
// test/pet-window-paths.test.js; here we pin that the main process really wires up this chain —
// and also pin the "host watchdog" criterion and interval, which is the other half of the
// overlapping-window problem.
test('pet window userData is stable, host-isolated and held by one instance at a time', () => {
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /getPath\('temp'\)/, 'userData must no longer live in %TEMP%')
  assert.match(main, /require\('\.\/pet-window-paths\.cjs'\)/, 'the directory choice must go through the shared module')
  assert.match(main, /app\.setPath\('userData', userData\.dir\)/, 'the main process must really set the chosen directory as userData')
  // Host watchdog: only ESRCH means the host is gone (EPERM = the process is still there, and
  // treating it as "exited" makes the desktop window disappear on its own), polled every
  // 1000ms — after the host exits the window lingers at most 1 second.
  assert.match(main, /return Boolean\(error && error\.code === 'ESRCH'\)/)
  assert.match(main, /\}, 1000\)/)
  assert.doesNotMatch(main, /\}, 3000\)/, 'the watchdog interval should not go back to 3000ms')
})

// The right-click menus must have the same skeleton, the **same order**, the same names and the
// same write targets on both clients.
// Historical disease: the web client once only had "Pause animation / Reset position / Desktop
// floating mode" while the desktop client only had "Draw / Usage mode / Switch to web mode" —
// the same config displayed under different names on the two sides. There was also a period
// where only one side's geometry/items were changed while the other side's click handlers were
// not updated, and nobody noticed (the change only landed on one side).
// So this makes three layers of assertions, and breaking any one of them goes red:
//   ① the items and their order are equal (not merely the same set of items)
//   ② each item writes back the same config key (same-named items write the same config, so
//     one side cannot write A while the other writes B)
//   ③ the write targets of the key items are pinned one by one (otherwise both sides writing
//     the same wrong thing still counts as "consistent")
test('in-page and desktop right-click menus keep the same rows, order and write targets', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')

  // The menu is an IIFE closure, so the menu-building function body can only be sliced out by
  // adjacent function names. A broken boundary throws right there (instead of silently
  // returning an empty array and letting the later assertions pass for nothing).
  const slice = (src, from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to, a + 1)
    assert.ok(a >= 0 && b > a, `menu slice failed, the test boundary names must follow the source: ${from} .. ${to}`)
    return src.slice(a, b)
  }
  const webBody = slice(core, 'function buildMenuContent()', 'function menuBoxOf(')
  const deskBody = slice(html, 'function buildMenu() {', 'function menuBoxOf(')

  // The item constructors: makeToggleRow/makeActionRow/makeSliderRow on the web client,
  // menuRow/menuSliderRow on the desktop client. The status row's copy is assembled
  // dynamically and is not an item.
  const WEB_ROW = /(?:makeToggleRow|makeActionRow|makeSliderRow)\(\s*'([^']+)'/g
  const DESK_ROW = /(?:menuRow|menuSliderRow)\(\s*'([^']+)'/g
  const rowsOf = (body, re) => [...body.matchAll(re)].map((m) => m[1])

  // The items, their order and the config keys they write back are all expressed by this one
  // table. Item names used to be written 2~3 times each across EXPECTED, the write-back
  // comparison and the per-item pinning, so changing one menu item meant changing three
  // places; now only here.
  //
  // An empty keys list means "the menu construction does not write config" — the writes of
  // "Draw" and "Reset position" live in their own action functions (playDraw / resetPos /
  // window close); both clients consistently do not write there, and this pins it so that
  // neither side can later sneak in a direct config write.
  const MENU = [
    { label: 'Character size', keys: ['scale'] },
    { label: 'Opacity', keys: ['opacity'] },
    { label: 'Mirror horizontally', keys: ['mirror'] },
    { label: 'Lock position', keys: ['locked'] },
    { label: 'Pause animation', keys: ['paused'] },
    { label: 'Show bubble', keys: ['showBubble', 'showBubbleStatus', 'showBubbleUsage'] },
    { label: 'Draw', keys: [] },
    { label: 'Reset position', keys: [] },
    { label: 'Desktop floating mode', keys: ['desktopMode'] },
  ]

  // ① Items and order: both clients must match the table (not merely the same set of items, the
  // same order)
  const labels = MENU.map((row) => row.label)
  assert.deepEqual(rowsOf(webBody, WEB_ROW), labels, 'the web client right-click menu items/order do not match the convention')
  assert.deepEqual(rowsOf(deskBody, DESK_ROW), labels, 'the desktop client right-click menu items/order do not match the convention')

  // The config keys written back per item: the web client writes patchConfig('x', v) /
  // patchConfigFields({ x: v }), the desktop client writes patchConfig({ x: v }), and "Show
  // bubble" additionally uses body.x = ... for the two sub-switches. Take the slice from "this
  // item's label to the next item's label" to decide, so the two sides are comparable.
  const writesOf = (body, re) => {
    const rowLabels = rowsOf(body, re)
    const marks = [...body.matchAll(re)].map((m) => m.index)
    const keys = marks.map((at, i) => {
      const chunk = body.slice(at, i + 1 < marks.length ? marks[i + 1] : body.length)
      const found = new Set()
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*'([A-Za-z]+)'/g)) found.add(m[1])
      for (const m of chunk.matchAll(/patchConfig(?:Fields)?\(\s*\{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/body = \{([\s\S]*?)\}/g)) {
        for (const k of m[1].matchAll(/([A-Za-z]+)\s*:/g)) found.add(k[1])
      }
      for (const m of chunk.matchAll(/\bbody\.([A-Za-z]+)\s*=/g)) found.add(m[1])
      return [...found].sort()
    })
    return Object.fromEntries(rowLabels.map((l, i) => [l, keys[i]]))
  }
  const webWrites = writesOf(webBody, WEB_ROW)
  const deskWrites = writesOf(deskBody, DESK_ROW)

  // ② + ③ pinned in a single loop: both clients write back the same set of keys, and it is
  // exactly the agreed set. Writing "both clients agree" and "equals the convention" as two
  // separate assertions would miss "both sides wrong together" — and that is precisely the bug
  // that happened historically (a same-named item writing A on one side and B on the other).
  for (const { label, keys } of MENU) {
    assert.deepEqual(webWrites[label], keys, `web client config keys written back by "${label}"`)
    assert.deepEqual(deskWrites[label], keys, `desktop client config keys written back by "${label}"`)
  }

  // Items deemed "settings-page only" must not flow back into either client's menu
  assert.doesNotMatch(core, /Row\('Usage mode'/)
  assert.doesNotMatch(html, /menuRow\('Usage mode'|menuRow\('Switch to web mode'/)
})

// "Reset position" must cover both the in-page coordinates and the desktop window coordinates,
// and on the desktop side it must also clear the renderer's localStorage fallback save —
// otherwise the next launch moves the window to that stale save and undoes the reset.
test('reset position covers both position stores and clears the localStorage fallback', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/pet-window.cjs', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/pet-preload.cjs', import.meta.url), 'utf8')
  const ALL_FOUR = /\{\s*posX: null,\s*posY: null,\s*desktopX: null,\s*desktopY: null\s*\}/
  assert.match(core, ALL_FOUR, 'the web client "Reset position" should clear all four coordinates')
  // The "Reset position" button on the settings page once wrongly hit /desktop/start, so
  // pressing it actually brought up the desktop window
  assert.doesNotMatch(core, /DESKTOP_ENDPOINT \+ '\/start'/)
  assert.match(html, /localStorage\.removeItem\('dsh-pet-window-pos'\)/)
  assert.match(html, /window\.petBridge\.resetPosition\(\)/)
  assert.match(preload, /resetPosition: \(\) => ipcRenderer\.invoke\('reset-position'\)/)
  assert.match(main, /ipcMain\.handle\('reset-position'/)
  assert.match(main, ALL_FOUR)
  // Clicking reset while the menu is still open: menuBase must be invalidated first, otherwise
  // closeMenu → menu-restore would move the window back to the pre-reset position
  assert.match(main, /ipcMain\.handle\('reset-position'[\s\S]{0,200}menuBase = null/)
})

// Pause must stop on the "current frame". canvas.drawImage(animated GIF) only ever paints the
// first frame in Chromium (measured on vendor/electron-win32-x64: 20 samples across 462ms
// have identical signatures and all equal frame 0), so both clients have to go through the
// gif-frame frame-grabbing chain and keep the first-frame fallback (no ImageDecoder in a
// non-secure context).
test('pause freezes on the current frame through the shared gif-frame helper', () => {
  // The frame-grabbing arithmetic itself is covered by test/gif-frame.test.js; here only two
  // things are pinned: "both clients really wire up this chain" and "the host really serves
  // that script", without repeating the implementation details.
  for (const [name, file] of [
    ['the web client', '../src/client.core.js'],
    ['the desktop client', '../src/pet-view.html'],
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /__gifFrame\.isGif\(/, `${name} should only take the frame-grabbing path for GIFs`)
    assert.match(src, /__gifFrame\.freeze\(/, `${name} should call freeze to grab the current frame`)
  }
  // The desktop client needs the script tag and the host needs to serve that script, otherwise
  // the whole frame-grabbing chain fails silently
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(html, /\/plugins\/dsh-pet-remielle\/gif-frame\.js/)
  assert.match(index, /'\/plugins\/dsh-pet-remielle\/gif-frame\.js'/)
})

/**
 * The dark palette of both clients must be triggered by the same source. The desktop floating
 * window is an independent Electron window and cannot read the host page's
 * body[data-ds-dark-theme]; it can only consume the hostTheme reported by the web client —
 * without that link it follows the system theme, and "system dark + DSH light theme" becomes
 * the most common scenario where the two clients' menus/bubbles have different colors.
 */
function desktopThemeOf(theme, systemDark) {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  const block = html.match(/var systemDarkQuery = [\s\S]*?^\s*syncHostTheme\(''\)/m)
  assert.ok(block, 'missing syncHostTheme block in pet-view.html')
  const attrs = {}
  vm.runInNewContext(`${block[0]}\nsyncHostTheme(${JSON.stringify(theme)})`, {
    document: { documentElement: { setAttribute: (key, value) => { attrs[key] = value } } },
    window: { matchMedia: () => ({ matches: systemDark, addEventListener() {} }) },
  })
  return attrs['data-host-theme']
}

test('desktop pet view takes dark from the host report and falls back to the system', () => {
  const html = readFileSync(new URL('../src/pet-view.html', import.meta.url), 'utf8')
  // Dark rules only listen to the attribute; a prefers-color-scheme media query is no longer
  // allowed: when the media query and the attribute both match, which one wins depends on
  // source order, so having both rule sets is equivalent to rolling the palette dice by rule
  // order.
  assert.equal(
    /@media\s*\(prefers-color-scheme:\s*dark\)/.test(html),
    false,
    'pet-view.html must no longer use a dark media query (it uses html[data-host-theme] reconciled by syncHostTheme instead)',
  )
  for (const selector of ['.menu', '.rm2-pet-bubble', '.rm2-pet-tip', '.rm2-pet-toast']) {
    assert.ok(
      html.includes(`html[data-host-theme="dark"] ${selector} {`),
      `${selector} is missing its dark rule (it should be written as html[data-host-theme="dark"] ${selector} { … })`,
    )
  }
  // The snapshot field is the desktop window's only source of the host theme; without that
  // link the styles above never apply
  assert.match(html, /syncHostTheme\(snapshot\.hostTheme\)/)

  // Really execute the extracted reconciliation logic: the host report wins, and only with no
  // report (missing field / empty string) does the system preference get a say
  assert.equal(desktopThemeOf('dark', false), 'dark', 'a dark host must not be flipped back by a light system')
  assert.equal(desktopThemeOf('light', true), 'light', 'a light host must not be flipped back by a dark system')
  assert.equal(desktopThemeOf('', true), 'dark', 'with no report it should fall back to the dark system')
  assert.equal(desktopThemeOf('', false), 'light')
  assert.equal(desktopThemeOf(undefined, true), 'dark', 'a missing field (no web client online) should fall back to the dark system')
  assert.equal(desktopThemeOf('Dark', true), 'dark', 'an invalid value counts as "not reported"')
})

// Storage / cleanup / TTL / rejecting bad values on the host side are already covered
// behaviourally by the "theme uplink" and "snapshot carries reported host theme" tests in
// test/host-transport.test.js; here only the three web-client-specific things are pinned.
test('host theme uplink is wired end to end between web client and host', () => {
  const core = readFileSync(new URL('../src/client.core.js', import.meta.url), 'utf8')
  // The endpoint must match the host's exported THEME_ENDPOINT
  assert.match(core, /var THEME_ENDPOINT = '\/plugins\/dsh-pet-remielle\/theme'/)
  // A host theme switch = adding/removing data-ds-dark-theme on body, so attribute changes must
  // be observed instead of read once at startup
  assert.match(core, /attributeFilter: \['data-ds-dark-theme'\]/)
  // Clear the report when the web client closes so the desktop window falls back to the system
  // theme
  assert.match(core, /function clearReportedHostTheme\(\)/)
})
