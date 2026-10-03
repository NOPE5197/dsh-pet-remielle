/**
 * Pet window preload — bridges the pet-view page to the main process.
 *
 * - setClickThrough(on): toggles window mouse-event pass-through for the
 *   transparent regions (the pet image itself stays interactive).
 * - dragStart/dragMove/dragEnd(): JS-driven dragging from the pet image only
 *   (the old whole-window -webkit-app-region drag made far-away empty space
 *   draggable). The main process positions the window relative to the live
 *   cursor, so renderer screenX deltas never accumulate DPI rounding error.
 *
 * Sandboxed preloads may require('electron') for contextBridge/ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petBridge', {
  setClickThrough: (on) => ipcRenderer.send('set-click-through', Boolean(on)),
  setForceInteractive: (on) => ipcRenderer.send('force-interactive', Boolean(on)),
  setHitRects: (rects) => ipcRenderer.send('hit-rects', rects),
  dragStart: (clientX, clientY) => ipcRenderer.send('drag-start', Number(clientX) || 0, Number(clientY) || 0),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getPosition: () => ipcRenderer.invoke('get-position'),
  // Whether this window was already positioned by the host's persisted coordinates
  // (null = no, so the renderer may use the localStorage fallback)
  getInitialPosition: () => ipcRenderer.invoke('get-initial-position'),
  // Right-click menu "Reset position": clear the host's persisted coordinates and move the
  // window back to the default landing spot, resolves {x,y}
  resetPosition: () => ipcRenderer.invoke('reset-position'),
  // Right-click menu: work-area coordinates + bounding-box window growth, invoke returns
  // {width,height,dx,dy}
  getWorkArea: () => ipcRenderer.invoke('get-work-area'),
  menuExpand: (left, top, right, bottom) => ipcRenderer.invoke(
    'menu-expand',
    Number(left) || 0,
    Number(top) || 0,
    Number(right) || 0,
    Number(bottom) || 0,
  ),
  menuRestore: () => ipcRenderer.invoke('menu-restore'),
  // Clicking a card with no web client online: ask the main process to open the DSH web client
  // in the system browser (the URL is decided by the main process)
  openDshPage: () => ipcRenderer.invoke('open-dsh-page'),
  // Drawing artwork: shown in a separate window at the desktop top-right (never covers the bubble)
  artworkOpen: (w, h) => ipcRenderer.send('artwork-open', Number(w) || 240, Number(h) || 240),
  artworkSet: (dataUrl) => ipcRenderer.send('artwork-set', String(dataUrl)),
  artworkClear: () => ipcRenderer.send('artwork-clear'),
  artworkFade: () => ipcRenderer.send('artwork-fade'),
  artworkClose: () => ipcRenderer.send('artwork-close'),
})
