/**
 * Pet window main script — spawned by src/desktop-window.js.
 *
 * CommonJS on purpose: Electron's ESM main script support is unreliable on
 * Windows (crashes with exit -1 during app startup), while .cjs works.
 *
 * Configuration arrives via environment variables (DSH_PET_URL,
 * DSH_WEB_URL, DSH_PET_PARENT_PID): passing extra CLI args to a spawned
 * Electron on Windows crashes with exit -1, while env is stable.
 *
 * Creates a frameless, transparent, always-on-top window that loads the
 * plugin's pet-view page (pet GIF + status bubble over the SSE stream).
 * The window watches the parent host pid and quits when the host exits, so
 * closing DSH tears the pet down without leaving a stray process.
 */

const { app, BrowserWindow, ipcMain, screen, session, shell } = require('electron')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const petWindowPaths = require('./pet-window-paths.cjs')

// Electron raises a 'textured' deprecation warning on macOS for transparent windows
// (transparent:true). It is harmless (the window works fine) but the child process forwards it
// on stderr into the host terminal, creating noise.
// Disable DeprecationWarning printing to keep the terminal clean; it affects no functionality.
process.noDeprecation = true

// userData directory (follow-up to issue #21): move it off %TEMP% to a stable location, and
// guarantee only one pet-window process uses it at a time.
// ① Still isolated from the host: sharing the default %APPDATA%/Electron locks the disk cache
//     and serves stale responses (historical bug: the pet page kept running the old
//     right-click logic that had been deleted), so it must be a separate directory.
// ② No longer under %TEMP%: system disk cleanup deletes the whole directory, taking the
//     Electron cache and the renderer's localStorage position fallback with it.
// ③ When the stable directory is held by another live instance (the host watchdog has a
//     delay, so restarting the host quickly makes them overlap), back off to a sibling
//     directory carrying our own pid, so two processes never share one Chromium profile and
//     re-introduce the stale cache problem from ①.
// See pet-window-paths.cjs for the detection and the lock read/write details (pure logic,
// unit-testable).
const appDataDir = app.getPath('appData')
const userData = petWindowPaths.resolveUserDataDir({
  appDataDir,
  pid: process.pid,
  occupantPid: petWindowPaths.readOccupantPid(petWindowPaths.lockPathOf(appDataDir)),
})
app.setPath('userData', userData.dir)
if (userData.fallback) {
  console.error(`dsh-pet-window: userData dir busy (pid ${userData.occupantPid}), falling back to ${userData.dir}`)
}
if (userData.ownsLock) petWindowPaths.writeLock(userData.lockPath, process.pid)

const url = process.env.DSH_PET_URL
const parentPid = Number(process.env.DSH_PET_PARENT_PID || 0)

// Window position from the last close (the host's config.desktopX/desktopY arrive via
// DSH_PET_POS_X/Y).
// Same space as the bounds API (see the force-device-scale-factor comment below): physical
// pixels on non-macOS, logical points on macOS — saving (getPosition) and restoring (the x/y
// constructor) go through the same API, so the space is self-consistent. After changing
// monitors/resolution it may land off-screen; after creating the window it is clamped to the
// nearest workArea.
const envPosX = Number(process.env.DSH_PET_POS_X)
const envPosY = Number(process.env.DSH_PET_POS_Y)
const persistedPos = Number.isFinite(envPosX) && Number.isFinite(envPosY)
  ? { x: Math.round(envPosX), y: Math.round(envPosY) }
  : null

// That vendor runtime misreports scaleFactor as 1.1 on some 100%-scaled machines, making the
// DIP↔physical conversion lossy: the window inflates by ~1.1x on every reposition and drag
// coordinates drift.
// The real screen scale is decided by the system; forcing it to 1 here keeps every bounds
// conversion lossless.
// macOS is the exception: Electron on darwin automatically renders at Retina backing-store
// size, and forcing dsf=1 would draw content at 1x physical pixels while the window size is
// computed in points, so it is only forced on non-macOS (macOS uses native logical points, see
// the darwin branch of scaleRoot below).
const isMac = process.platform === 'darwin'
if (!isMac) {
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
}

// Content size locked at drag-position time (same as the BrowserWindow constructor
// arguments), preventing any bounds round-trip error from accumulating into a changed window
// size.
const PET_CONTENT_W = 400
const PET_CONTENT_H = 520

// Read the real system DPI scale from the registry (96=100%); any failure returns null and
// the caller falls back.
// Why the screen API cannot be trusted: once the
// appendSwitch('force-device-scale-factor','1') above takes effect,
// screen.getPrimaryDisplay().scaleFactor is pinned to 1 as well (measured: on a 200% screen
// it returns 2 without the switch and 1 with it), so computing compensation from it is always
// 1 and completely ineffective — that is exactly the root cause of the desktop pet halving its
// physical size on high-scale screens. Hence read the registry's AppliedDPI (REG_DWORD,
// hexadecimal such as 0xc0=192), which is unaffected by the force-dsf switch.
function readSystemScaleFactor() {
  // The registry is Windows-only; other platforms fall back immediately and the caller uses
  // the screen API as the backstop.
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop\\WindowMetrics', '/v', 'AppliedDPI'],
      { encoding: 'utf8' }
    )
    const m = /AppliedDPI\s+REG_DWORD\s+(0x[0-9a-fA-F]+)/i.exec(out)
    const dpi = m ? Number.parseInt(m[1], 16) : NaN
    return Number.isFinite(dpi) && dpi > 0 ? dpi / 96 : null
  } catch {
    return null
  }
}

if (!url) {
  console.error('dsh-pet-window: missing DSH_PET_URL')
  app.exit(1)
}

app.whenReady().then(() => {
  // The DSH Desktop host wraps every WebServer route (including this plugin's pet-view and
  // the host API) in a desktopBrowserAccess admission check: only requests carrying the
  // renderer-specific header are recognized as its own renderer process and let through, all
  // others are treated as an ordinary browser — with the host's "Browser access" disabled
  // everything gets 403 "forbidden" (symptom: after the desktop window pops up the pet
  // disappears, leaving only the word forbidden). This window is an independent Electron
  // process and the host only injects into its own renderer, so it adds the header itself on
  // the session for same-origin requests; the header name/value arrive via env from the host
  // context and are not installed when absent (plain web host).
  const rendererHeaderName = process.env.DSH_PET_RENDERER_HEADER_NAME
  const rendererHeaderValue = process.env.DSH_PET_RENDERER_HEADER_VALUE
  let carrierOrigin = ''
  try { carrierOrigin = new URL(url).origin } catch { /* url already passed the earlier check */ }
  if (rendererHeaderName && rendererHeaderValue && carrierOrigin) {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const requestHeaders = { ...details.requestHeaders }
      for (const key of Object.keys(requestHeaders)) {
        if (key.toLowerCase() === rendererHeaderName.toLowerCase()) delete requestHeaders[key]
      }
      try {
        if (new URL(details.url).origin === carrierOrigin) requestHeaders[rendererHeaderName] = rendererHeaderValue
      } catch { /* do not inject for an invalid URL */ }
      callback({ requestHeaders })
    })
  }
  // UI scale compensation: the force-device-scale-factor=1 above pins rendering to 100%; on a
  // high-scale screen (real scale R, e.g. 200%) a web client element's physical size =
  // CSS×R, so without compensation the desktop pet would only be half that size.
// Coordinate-system facts (measured with a Per-Monitor-V2 aware process on a 200% screen):
  // with force-dsf=1, BrowserWindow bounds, getCursorScreenPoint and display.workArea all
  // belong to the same physical-pixel world and pass through 1:1 — the earlier "bounds = a
  // mirror world of physical×R" conclusion was an artifact of a DPI-unaware measuring process
  // whose readings Windows virtualized by ÷R, and is now discarded.
// So taking the zoom factor as R satisfies all of: window physical = PET_CONTENT×R (the web
  // client baseline), CSS viewport = physical/R = PET_CONTENT (layout unchanged), element
// physical = CSS×R, same as the web.
// R cannot come from the screen API: force-dsf=1 pins scaleFactor to 1 as well (see the
  // readSystemScaleFactor comment), so the real value is read from the registry first and
  // only falls back to the primary display's scaleFactor; R is clamped to [0.5,2] (the upper
  // bound keeps the window from exceeding a normal display under extreme scaling).
// Not adopting "drop force-dsf and let Electron render at the real scale": under
  // non-integer scaling the DIP↔physical round trip has truncation error and the drag
  // closed loop drifts continuously again (see the drag-move dedupe comment); keep dsf=1's
  // lossless conversion and compensate on top.
// Limitation: with different scales per monitor, the primary display wins; no dynamic
// switching across displays.
// macOS: Electron renders in logical points and automatically scales by the Retina backing
  // store factor; no need to force 1x or to compensate, window and content are both
// 400×520 logical points.
// Other platforms follow readSystemScaleFactor (Windows) → screen.scaleFactor fallback.
  const scaleRoot = isMac ? 1 : Math.min(2, Math.max(0.5, readSystemScaleFactor() || screen.getPrimaryDisplay().scaleFactor || 1))
  const uiZoom = scaleRoot
  const petW = Math.round(PET_CONTENT_W * uiZoom)
  const petH = Math.round(PET_CONTENT_H * uiZoom)
  const win = new BrowserWindow({
    width: petW,
    height: petH,
    // With persisted coordinates, position the window at creation (Electron does not apply fit
    // clamping to an explicit x/y); without them keep the original behavior: auto-fit into
    // the workArea, with a tall window clamped to the bottom (the historical default
    // position).
    ...(persistedPos ? { x: persistedPos.x, y: persistedPos.y } : {}),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'pet-preload.cjs'),
    },
  })
  // Measured: when constructed without x/y, Electron auto-fits the window into the workArea;
  // when the window is taller than the work area it gets clamped to the bottom. Explicit
  // coordinates via setBounds are exempt from this clamping, so the full size is restored
  // immediately after creation at the current position. Persisted coordinates are only
  // clamped for "reachability": take the union of all display bounds (the virtual desktop) and
  // guarantee at least a KEEP margin of the window stays inside that union. Clamping the whole
  // window to a single screen's workArea is wrong — the pet image hugs the window bottom
  // (.pet is flex-end), so dragging the image to the top edge of the screen necessarily pushes
  // the top of the window off-screen (a measured saved value was y=-381), and whole-window
  // clamping would drag the window back to y=0, which shows up as "the position is not
  // remembered" (follow-up to issue #21: the position is lost after switching modes).
  {
    let [px, py] = win.getPosition()
    if (persistedPos) {
      try {
        let u0x = Infinity, u0y = Infinity, u1x = -Infinity, u1y = -Infinity
        for (const d of screen.getAllDisplays()) {
          u0x = Math.min(u0x, d.bounds.x)
          u0y = Math.min(u0y, d.bounds.y)
          u1x = Math.max(u1x, d.bounds.x + d.bounds.width)
          u1y = Math.max(u1y, d.bounds.y + d.bounds.height)
        }
        const KEEP = 80 // margin of the window kept inside the virtual desktop (physical pixels), so it can still be grabbed
        const loX = u0x - petW + KEEP, hiX = u1x - KEEP
        const loY = u0y - petH + KEEP, hiY = u1y - KEEP
        // When the virtual desktop is tiny (< 2*KEEP) the bounds may invert; take the midpoint and degrade to a single-point clamp
        const cx = loX > hiX ? (loX + hiX) / 2 : null
        const cy = loY > hiY ? (loY + hiY) / 2 : null
        px = cx !== null ? cx : Math.min(Math.max(px, loX), hiX)
        py = cy !== null ? cy : Math.min(Math.max(py, loY), hiY)
      } catch { /* keep the original coordinates when display enumeration fails */ }
    }
    win.setBounds({ x: px, y: py, width: petW, height: petH })
  }

  // Click-through: transparent margins must not block the desktop. Renderer
  // mousemove + { forward: true } does not work on Windows when only the
  // wallpaper is behind the window, so the main process polls the cursor
  // against hit rects reported by the page.
  let clickThrough = false
  let forceInteractive = false
  let hitRects = null
  let hitTimer = null
  function ensureHitTimer() {
    if (hitTimer != null) return
    hitTimer = setInterval(syncIgnore, 16)
  }
  function stopHitTimer() {
    if (hitTimer == null) return
    clearInterval(hitTimer)
    hitTimer = null
  }
  function applyIgnore(on) {
    on = Boolean(on)
    if (on === clickThrough) return
    clickThrough = on
    if (clickThrough) ensureHitTimer()
    else stopHitTimer()
    try {
      win.setIgnoreMouseEvents(on, { forward: true })
    } catch {
      win.setIgnoreMouseEvents(on)
    }
  }
  function cursorHits() {
    if (forceInteractive) return true
    if (!hitRects || hitRects.length === 0) return false
    const pt = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    // hitRects are reported by the renderer in CSS px; the cursor and bounds are both
    // physical pixels (force-dsf=1 passes through), so subtracting gives the physical offset
    // inside the window — divide by uiZoom to get back to CSS.
    const x = (pt.x - b.x) / uiZoom
    const y = (pt.y - b.y) / uiZoom
    for (const r of hitRects) {
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return true
    }
    return false
  }
  function syncIgnore() {
    if (!win || win.isDestroyed()) return
    if (forceInteractive) {
      applyIgnore(false)
      return
    }
    // Only recover interactivity. Leaving the pet is driven by renderer
    // mousemove; Windows will not forward those events over the wallpaper.
    if (clickThrough && cursorHits()) applyIgnore(false)
  }
  ipcMain.on('set-click-through', (_event, on) => {
    if (forceInteractive) return
    applyIgnore(Boolean(on))
  })
  ipcMain.on('force-interactive', (_event, on) => {
    forceInteractive = Boolean(on)
    if (forceInteractive) applyIgnore(false)
    else syncIgnore()
  })
  ipcMain.on('hit-rects', (_event, rects) => {
    if (!Array.isArray(rects)) return
    hitRects = []
    for (const r of rects) {
      if (!r) continue
      const x = Number(r.x)
      const y = Number(r.y)
      const w = Number(r.w)
      const h = Number(r.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue
      if (w < 1 || h < 1) continue
      hitRects.push({ x, y, w, h })
    }
    syncIgnore()
  })

  // JS-driven dragging from the pet image: closed-loop absolute positioning.
  // The renderer only signals drag lifecycle; the main process keeps the
  // window pinned at (cursor - grab offset). Some Electron/Windows builds
  // return PHYSICAL pixels from getCursorScreenPoint() while bounds APIs are
  // DIP; the ratio is measured at drag start from the known on-page grab
  // point (cursorDip ≈ windowPos + clientX/Y), so either convention works.
  let drag = null
  ipcMain.on('drag-start', (_event, clientX, clientY) => {
    clientX = Number(clientX) || 0
    clientY = Number(clientY) || 0
    const [x, y] = win.getPosition()
    const physical = screen.getCursorScreenPoint()
    // The grab offset is reported in CSS px; multiply by uiZoom to convert into the physical
    // pixel world (same system as bounds)
    const dipX = x + clientX * uiZoom
    const dipY = y + clientY * uiZoom
    // Under force-dsf=1 the cursor and bounds are both physical pixels, so physical/dipX is
    // always 1; this self-calibration is only a fallback for differences across
    // Electron/Windows builds (see the English drag-start comment above), clamped to
    // [0.25,4] so a bogus measurement cannot amplify displacement.
    const clamp = (v) => Math.min(4, Math.max(0.25, v))
    // The ratio is measured independently per axis; when the grab point is too close to the
    // edge (divisor too small) that axis falls back to 1.
    const sx = clientX > 4 && Math.abs(physical.x - dipX) > 1 ? clamp(physical.x / dipX) : 1
    const sy = clientY > 4 && Math.abs(physical.y - dipY) > 1 ? clamp(physical.y / dipY) : 1
    drag = { ox: clientX * uiZoom, oy: clientY * uiZoom, sx: sx, sy: sy, tx: NaN, ty: NaN }
  })
  ipcMain.on('drag-move', () => {
    if (!drag) return
    const pt = screen.getCursorScreenPoint()
    const nx = Math.round(pt.x / drag.sx - drag.ox)
    const ny = Math.round(pt.y / drag.sy - drag.oy)
    // Key: dedupe on "did the target change" rather than on the value read back by
    // getPosition(). Under non-integer scaling (e.g. 110%) a DIP→physical→DIP read-back has
    // truncation error, so the read-back value is always 1px off the target; retrying on that
    // basis makes every synthesized mousemove push the window another 1 physical pixel to
    // the bottom-right, which shows up as continuous drift while the button is held without
    // moving.
    if (nx === drag.tx && ny === drag.ty) return
    drag.tx = nx
    drag.ty = ny
    win.setBounds({ x: nx, y: ny, width: petW, height: petH })
  })
  // Position persistence fallback (issue #21 "sometimes it does not remember"): writing back
  // originally had only one path, the renderer's pointerup, so losing any link in the chain
  // (moved not set, fetch silently swallowed, quitting right after the drag) loses the save.
  // The only IPC the renderer always sends is dragEnd (endPetDrag calls it unconditionally),
  // so the main process PATCHes the host config directly at drag-end as a fallback. The
  // /plugins endpoint only validates the loopback origin and needs no token (proof: the
  // renderer's relative fetch passes without a query either).
  // It writes the same coordinates as the renderer, so it is idempotent; skipped when the
  // coordinates are unchanged.
  const hostOrigin = new URL(url).origin
  let lastSavedPos = null
  // PATCH the host config (the /plugins endpoint only validates the loopback origin, no token
  // needed). The 2s timeout avoids hanging the caller on a network error.
  function patchHostConfig(body, label) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    return fetch(`${hostOrigin}/plugins/dsh-pet-remielle/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    }).catch((err) => {
      console.error(`dsh-pet-window: ${label} failed: ${err.message}`)
    }).finally(() => clearTimeout(timer))
  }
  function persistPosition() {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const body = { desktopX: Math.round(x), desktopY: Math.round(y) }
    if (lastSavedPos && lastSavedPos.desktopX === body.desktopX && lastSavedPos.desktopY === body.desktopY) return
    lastSavedPos = body
    void patchHostConfig(body, 'persist position')
  }

  ipcMain.on('drag-end', () => {
    // The renderer's endPetDrag sends drag-end for "any left-button release": clicking a menu
    // item or a bubble counts too. And when the menu grows the window at the right edge it
    // shifts x left (the pet does not visually move), so what getPosition reads then is the
    // grown coordinate — an unconditional write-back would store that grown x, which shows up
    // as "y is remembered (the menu does not change y) but x is lost". Only a real drag (drag
    // non-null) is allowed to write the save.
    const wasDragging = drag !== null
    drag = null
    if (wasDragging) persistPosition()
  })

  // Return current window position for persistence.
  ipcMain.handle('get-position', () => {
    const [x, y] = win.getPosition()
    return { x: Math.round(x), y: Math.round(y) }
  })

  // The renderer asks "was this window already positioned by the host's persisted
  // coordinates": if so the renderer skips its localStorage moveTo fallback (the stale save
  // would fight the host coordinates), otherwise the old behavior is kept.
  ipcMain.handle('get-initial-position', () => persistedPos)

  // Right-click menu: the renderer picks the landing spot inside the work area with the same
  // right→left→up formula as the web client, then grows the window to the bounding box of
  // menu + glow. Prefer only increasing width/height (origin unchanged): .pet anchors
  // 400×520 at the top-left, so growing right/down leaves the content's on-screen position
  // unchanged. Only flipping to the left at the right edge decreases x, and dx/dy are
  // returned so the renderer can push .pet back. Under force-dsf=1 bounds and workArea are
  // both physical pixels, so CSS values are first multiplied by uiZoom.
  let menuBase = null
  ipcMain.handle('get-work-area', () => {
    const b = win.getContentBounds()
    let wa = null
    try { wa = screen.getDisplayMatching(b).workArea } catch { /* fall back to the current window when there is no work area */ }
    if (!wa) {
      return { left: 0, top: 0, right: b.width / uiZoom, bottom: b.height / uiZoom }
    }
    return {
      left: (wa.x - b.x) / uiZoom,
      top: (wa.y - b.y) / uiZoom,
      right: (wa.x + wa.width - b.x) / uiZoom,
      bottom: (wa.y + wa.height - b.y) / uiZoom,
    }
  })
  const applyShiftInPage = (dx, dy) => {
    const dxN = Number(dx) || 0
    const dyN = Number(dy) || 0
    return win.webContents.executeJavaScript(
      `void (window.__rm2ApplyPetShift && window.__rm2ApplyPetShift(${dxN},${dyN}))`,
    ).catch(() => {})
  }
  // With resizable:false Windows often ignores setBounds' x and only changes the width from the
  // current top-left; and for a transparent window at opacity:0, DWM may still snap the
  // position back to the pre-hide bounds when it is revealed again.
  const applyBounds = (bounds) => {
    if (win.isDestroyed()) return
    let locked = false
    try { locked = !win.isResizable(); if (locked) win.setResizable(true) } catch { locked = false }
    try {
      win.setContentBounds(bounds)
    } finally {
      try { if (locked) win.setResizable(false) } catch { /* do not throw even if the restore fails */ }
    }
  }
  const withHiddenMove = async (originMoves, run) => {
    if (originMoves && !win.isDestroyed()) {
      try { win.setOpacity(0) } catch { /* setOpacity still works on a transparent window */ }
    }
    try {
      await run()
      // Wait only one frame so DWM absorbs bounds+shift; writing bounds after revealing moves
      // the window while visible = flicker.
      if (originMoves) await new Promise((r) => setTimeout(r, 16))
    } finally {
      if (originMoves && !win.isDestroyed()) {
        try { win.setOpacity(1) } catch { /* must reveal, otherwise the pet disappears */ }
      }
    }
  }
  ipcMain.handle('menu-expand', async (_event, cssLeft, cssTop, cssRight, cssBottom) => {
    const b = win.getContentBounds()
    const left = Math.round((Number(cssLeft) || 0) * uiZoom)
    const top = Math.round((Number(cssTop) || 0) * uiZoom)
    const right = Math.round((Number(cssRight) || 0) * uiZoom)
    const bottom = Math.round((Number(cssBottom) || 0) * uiZoom)
    let x = Math.min(0, left)
    let y = Math.min(0, top)
    let rgt = Math.max(b.width, right)
    let bot = Math.max(b.height, bottom)
    let wa = null
    try { wa = screen.getDisplayMatching(b).workArea } catch { /* grow by the requested values when the query throws */ }
    if (wa) {
      const waL = wa.x - b.x
      const waT = wa.y - b.y
      const waR = wa.x + wa.width - b.x
      const waB = wa.y + wa.height - b.y
      x = Math.max(x, waL)
      y = Math.max(y, waT)
      rgt = Math.min(Math.max(rgt, b.width), waR)
      bot = Math.min(Math.max(bot, b.height), waB)
      if (x > 0) x = 0
      if (y > 0) y = 0
      if (rgt < b.width) rgt = b.width
      if (bot < b.height) bot = b.height
    }
    const nb = { x: b.x + x, y: b.y + y, width: rgt - x, height: bot - y }
    const dx = Math.round(-x / uiZoom)
    const dy = Math.round(-y / uiZoom)
    if (nb.width === b.width && nb.height === b.height && x === 0 && y === 0) {
      return { width: Math.round(b.width / uiZoom), height: Math.round(b.height / uiZoom), dx: 0, dy: 0 }
    }
    if (menuBase == null) menuBase = { x: b.x, y: b.y, width: b.width, height: b.height }
    const originMoves = x !== 0 || y !== 0
    await withHiddenMove(originMoves, async () => {
      if (originMoves) await applyShiftInPage(dx, dy)
      applyBounds(nb)
      if (originMoves) applyBounds(nb)
    })
    return {
      width: Math.round(nb.width / uiZoom),
      height: Math.round(nb.height / uiZoom),
      dx,
      dy,
    }
  })
  ipcMain.handle('menu-restore', async () => {
    if (menuBase == null || win.isDestroyed()) return
    const base = menuBase
    menuBase = null
    const b = win.getContentBounds()
    const originMoved = base.x !== b.x || base.y !== b.y
    await withHiddenMove(originMoved, async () => {
      // Move the window back first (the page shift is still in place, so the visual position is
      // correct), then clear the shift. Clearing the shift first without writing x back would
      // leave the pet on the left side of the grown window.
      applyBounds(base)
      if (originMoved) await applyShiftInPage(0, 0)
      applyBounds(base)
    })
  })

  // Right-click menu "Reset position": move the window back to the default landing spot and
  // clear the host's persisted coordinates.
  // The default landing spot replicates Electron's behavior when "creating the window without
  // x/y" (centered on the primary display's work area, pinned to the bottom when the window is
  // taller than the work area), matching the result of the size restore after construction.
  // menuBase and the page shift must be cleared first: the menu is still open when this item is
  // clicked, so the following closeMenu → menu-restore would move the window back to the
  // pre-reset position and the reset would be wasted.
  // posX/posY are cleared as well — the in-page pet and the desktop window are two independent
  // position stores, and clearing only one makes "Reset position" stop working after switching
  // modes.
  ipcMain.handle('reset-position', async () => {
    if (!win || win.isDestroyed()) return null
    menuBase = null
    let x = 0
    let y = 0
    try {
      const wa = screen.getPrimaryDisplay().workArea
      x = Math.round(wa.x + (wa.width - petW) / 2)
      y = petH > wa.height
        ? Math.round(wa.y + wa.height - petH)
        : Math.round(wa.y + (wa.height - petH) / 2)
    } catch { /* fall back to (0,0) when display enumeration fails: move at least once, do not let the user think nothing happened */ }
    const next = { x, y, width: petW, height: petH }
    const b = win.getContentBounds()
    const originMoves = b.x !== x || b.y !== y
    await withHiddenMove(originMoves, async () => {
      applyBounds(next)
      if (originMoves) await applyShiftInPage(0, 0)
      applyBounds(next)
    })
    lastSavedPos = null // allow the next real drag to save again
    void patchHostConfig({ posX: null, posY: null, desktopX: null, desktopY: null }, 'reset position')
    return next
  })

  // Clicking a bubble card with no web client online: the renderer only signals, and the URL
  // arrives from the host via DSH_WEB_URL (desktop mode requires the token-bearing root path of
  // DSH 0.1.2-alpha.1+).
  // Using href rather than origin: the token is on the query, and a 303 cookie swap would drop
  // the other parameters too.
  ipcMain.handle('open-dsh-page', () => {
    try {
      const target = new URL(process.env.DSH_WEB_URL || new URL('/', url).origin)
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
      return shell.openExternal(target.href)
    } catch {
      return Promise.resolve(false)
    }
  })

  // Draw-artwork popup: a separate transparent always-on-top window parked at
  // the desktop (screen) top-right, so the painting never covers the pet or
  // its bubble. The page streams frames as data URLs.
  const ART_HTML = '<html><body style="margin:0;background:transparent;overflow:hidden"><img id="art" style="width:100%;height:100%;display:block;border-radius:10px"></body></html>'
  let artWin = null
  let artPending = null
  let artLoaded = false
  function artSet(dataUrl) {
    if (!artWin || artWin.isDestroyed()) return
    if (!artLoaded) {
      artPending = dataUrl
      return
    }
    artWin.webContents.executeJavaScript(`document.getElementById('art').src = ${JSON.stringify(dataUrl)}`).catch(() => {})
  }
  ipcMain.on('artwork-open', (_event, w, h) => {
    // The renderer reports the size in CSS px; under force-dsf=1, 1 CSS px of artWin content = 1
    // physical pixel, so not multiplying by uiZoom would make it display smaller than the web
    // client on high-scale screens; scale it by the same factor as the main window.
    w = Math.max(60, Math.round((Number(w) || 220) * uiZoom))
    h = Math.max(60, Math.round((Number(h) || 220) * uiZoom))
    if (artWin && !artWin.isDestroyed()) { artWin.setBounds({ width: w, height: h }); return }
    const work = screen.getPrimaryDisplay().workArea
    artWin = new BrowserWindow({
      width: w,
      height: h,
      // workArea and window positioning are both physical pixels, so compute the docking spot
      // directly (leaving a 24px physical gap at the top right).
      x: Math.round(work.x + work.width - 24 - w),
      y: Math.round(work.y + 24),
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: { sandbox: true },
    })
    artWin.setAlwaysOnTop(true, 'screen-saver')
    artWin.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
    artWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ART_HTML))
    artWin.webContents.once('did-finish-load', () => {
      artLoaded = true
      artWin.show()
      if (artPending) {
        artWin.webContents.executeJavaScript(`document.getElementById('art').src = ${JSON.stringify(artPending)}`).catch(() => {})
        artPending = null
      }
    })
    artWin.on('closed', () => { artWin = null; artPending = null; artLoaded = false })
  })
  ipcMain.on('artwork-set', (_event, dataUrl) => artSet(String(dataUrl)))
  // Reopening with repeated double-clicks: clear the picture and reset the fade state. If the
  // reopen happens during the previous picture's pleased hold/fade, the img src still holds
  // the old image and opacity may already be 0 — without the cleanup the old painting flashes
  // before the new round finishes loading, and the new painting can even stay invisible after
  // pushing frames because opacity=0.
  const ART_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  ipcMain.on('artwork-clear', () => {
    artPending = null
    if (!artWin || artWin.isDestroyed() || !artLoaded) return
    artWin.webContents.executeJavaScript(
      `const i=document.getElementById('art');i.style.transition='none';i.style.opacity='1';i.src=${JSON.stringify(ART_BLANK)}`
    ).catch(() => {})
  })
  ipcMain.on('artwork-fade', () => {
    if (!artWin || artWin.isDestroyed() || !artLoaded) return
    artWin.webContents.executeJavaScript(
      `const i=document.getElementById('art');i.style.transition='opacity 0.8s ease-out';i.style.opacity='0'`
    ).catch(() => {})
  })
  ipcMain.on('artwork-close', () => {
    if (artWin && !artWin.isDestroyed()) artWin.close()
    artWin = null
    artPending = null
    artLoaded = false
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })

  win.loadURL(url)
  // zoom must be set after navigation completes: a setZoomFactor call before loadURL is reset
  // to 1 when the navigation commits (measured live: the content is not zoomed, the artwork is
  // only half its size, and the drag self-calibration then measures a wrong factor of ~0.54,
  // amplifying displacement almost twofold so a single drag flies off screen), hence it is
  // attached after navigation completes.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(uiZoom)
    // Shadow CSS inversely scales by 1/zoom so the transparent window's glow does not inflate
    // with DPI.
    win.webContents.insertCSS(`:root{--rm2-ui-zoom:${uiZoom};}`).catch(() => {})
  })
  win.webContents.on('did-fail-load', (_e, code, desc, furl) => console.log('[pet] FAIL:', code, desc, furl))
  win.webContents.on('console-message', (_e, level, msg) => console.log('[pet-console]', level, String(msg).slice(0, 160)))
  win.once('ready-to-show', () => {
    win.show()
    // On show, Electron may apply one more fit clamp to a window outside the work area; restate
    // the full size once the display has settled, as a fallback.
    setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        const [lx, ly] = win.getPosition()
        win.setBounds({ x: lx, y: ly, width: petW, height: petH })
      } catch { /* window destruction race, ignore */ }
    }, 250)
  })
  win.on('closed', () => {
    stopHitTimer()
    app.quit()
  })

  // Watchdog: when the DSH host process goes away, take the pet with it.
  // Semantics of kill(pid, 0): ESRCH = the process does not exist; EPERM = it exists but the
  // signal may not be sent — the latter is precisely proof that the parent is still alive and
  // must never be treated as "the host has exited" and kill the window (under the DSH Desktop
  // NodeService host this showed up as the desktop window disappearing seconds after popping
  // up).
  // Polling tightened from 3000ms to 1000ms: after the host exits the window lingers at most 1
  // second (users perceive this as "they exit together"), and it also shortens the userData
  // overlap window when "the host restarted but the old window has not left yet" — the shorter
  // the overlap, the less often the fallback-directory path is triggered.
  if (parentPid) {
    const hostGone = () => {
      try {
        process.kill(parentPid, 0)
        return false
      } catch (error) {
        // Only ESRCH means the host is gone; every other error such as EPERM counts as still running,
        // keep watching.
        return Boolean(error && error.code === 'ESRCH')
      }
    }
    const timer = setInterval(() => {
      if (!hostGone()) return
      clearInterval(timer)
      console.error('dsh-pet-window: host process gone, exiting')
      app.quit()
    }, 1000)
    timer.unref?.()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

// Release the userData occupancy marker so the next launch can reuse the stable directory.
// Delete it only when we are the marker's owner (releaseLock checks the pid internally): a
// fallback instance never wrote a marker in the first place, and a marker left behind by a
// force-killed process is judged idle on the next launch because its pid is dead, so no extra
// fallback is needed here.
app.on('will-quit', () => {
  if (userData.ownsLock) petWindowPaths.releaseLock(userData.lockPath, process.pid)
})
