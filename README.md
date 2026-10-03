# dsh-pet-remielle · Remielle Desktop Pet

[![npm version](https://img.shields.io/npm/v/dsh-pet-remielle)](https://www.npmjs.com/package/dsh-pet-remielle)
[![awesome dsh plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A multi-pet web desktop pet **driven by real DSH session events** — the pet follows DeepSeek Harness task progress in real time and presents it with sticker animations + status bubbles.

- Multi-pet registry + status bubbles (project / phase / tasks / progress reported in real time)
- SSE live push + an optional desktop floating window (bundled Electron, transparent and always-on-top)
- Double-click drawing integration: a thick brush reveals the artwork (Drawing → Pleased → fade-out)
- One-click version check + incremental update
- Settings panel: Pet Management (tabbed) + a plugin configuration card

> Compatible with DeepSeek Harness (including its forks) web profile; desktop floating mode is off by default and can be enabled on demand. Desktop mode requires DSH `>= 0.1.2-alpha.1` to provide an authenticated root URL carrying a token.

---

## Features

| Capability | Details |
|---|---|
| State source | Real DSH `session/event` events, no DOM scraping |
| State machine | Pure-function `PetReducer` (with mood mapping, unit-tested) |
| Message protocol | Typed protocol (protocol.js) |
| Configuration | schemastery persistence + a settings card |
| Multi-session priority | Approval > plan review > waiting for an answer > completion reminder > waiting/error > current session > state priority > recency. Hysteresis only stabilizes the top two; the third and later still rotate by recency |
| Live push | SSE stream (auto-reconnect + polling fallback) |
| Status bubble | Both the in-page pet and the desktop floating window use an adaptive two-layer card deck: a top status card + a `+N` summary backboard; message + detail (project · completed x/y · phase) |
| Session actions | Identical on web and desktop: clicking the card / `?` / `!` opens the matching session, `✓` allows once; with no web client online, clicking a card/icon opens the DSH page in the system browser |
| Completion reminders | A background completion keeps its green dot until handled; the current session in a foreground-only tab is cleared automatically (even while the desktop floating window is up), background tabs never clear it ahead of you; the desktop floating window only shows the reminder — opening that session (in-page jump, browser open, or clicking the desktop completion card) clears it just the same. The already-open session shows no unread green dot (current Host lifetime only) |
| Error reminders | A failed background turn (model call failure, etc.) keeps its pink mark until that conversation is opened; a failure in the current session never becomes a reminder. Clicking the bubble to jump, or opening the conversation from the sidebar, dismisses it. Approvals and questions are unaffected |
| Balance | With both status and usage on, clicking the left dot of the bubble or scrolling the wheel switches to the balance page (60s auto-refresh, rolling-number animation, network blips fall back to the last known balance); it stays on the current page and never falls back automatically |
| Today's usage | Either of two modes: ledger (token-free, accumulates balance deltas) / real-time token (the platform cost API returns the real amount directly, exact) |
| Desktop float | Bundled Electron transparent always-on-top window (opt-in, off by default) |
| Multi-pet | Settings → Pet Management (registry + switch the current pet) |
| Version update | Built-in check + one-click incremental update |

---

## Sticker (mood) → State Mapping

| Sticker | Preview | Trigger |
|---|---|---|
| 01 Drawing | <img src="assets/pets/remielle/01.gif" width="56" alt="01 Drawing"/> | THINKING + streaming: streaming output (writing a reply), double-click drawing |
| 02 Slacking | <img src="assets/pets/remielle/02.gif" width="56" alt="02 Slacking"/> | WORKING / ERROR: tool calls (search/edit/test/command) |
| 03 Pleased | <img src="assets/pets/remielle/03.gif" width="56" alt="03 Pleased"/> | PULSE SUCCESS: turn completed, drawing finished, click interaction |
| 04 Thinking | <img src="assets/pets/remielle/04.gif" width="56" alt="04 Thinking"/> | THINKING: turn/step start, reasoning, result compilation |
| 05 Waiting | <img src="assets/pets/remielle/05.gif" width="56" alt="05 Waiting"/> | WAITING: answering a question, waiting for approval, plan review, turn blocked |
| 06 Idle | <img src="assets/pets/remielle/06.gif" width="56" alt="06 Idle"/> | IDLE / DISCONNECTED: idle, after a turn ends |

When multiple sessions run concurrently, the top task is selected by `approval > plan review > waiting for an answer > completion reminder > waiting/error > current session > state priority > recency`; every other session is represented by a clickable `+N` summary backboard. Sub-agents are ignored by default (can be enabled in settings).

### Pet Definition Convention

```
assets/pets/<id>/01.gif  Drawing (output/drawing)
assets/pets/<id>/02.gif  Slacking (tools/errors)
assets/pets/<id>/03.gif  Pleased (completion/interaction)
assets/pets/<id>/04.gif  Thinking
assets/pets/<id>/05.gif  Waiting
assets/pets/<id>/06.gif  Idle
```

Optional extensions (do not affect completeness validation):
```
assets/pets/<id>/07.gif           Extra sticker slot
assets/pets/<id>/pet-manifest.json  Per-sticker alignment offsets + artwork count
assets/pets/<id>/pics/<n>.png      Artwork images (pop up at random on double-click, n starts at 1)
```

`id` may contain only letters, digits, underscores and hyphens. Built-in pet: **Remielle** (remielle, see `NOTICE` for asset copyright).

---

## Installation

For **DSH / DeepSeek Harness** (including Fairy and other DSH-based forks) web profile.

```powershell
# Option 1: npm registry (recommended, one-click incremental update)
dsh plugin --profile web add dsh-pet-remielle

# Option 2: GitHub repository (build install, no version check)
dsh plugin --profile web add github:Gin-7/dsh-pet-remielle

# Option 3: local directory (development and debugging, link install)
dsh plugin --profile web add D:\path\to\dsh-pet-remielle

# Option 4: GitHub Release tgz
dsh plugin --profile web add "C:\Users\you\Downloads\dsh-pet-remielle-<version>.tgz"
```

Plugin row id: `dsh-pet-remielle`. Uninstalling restores everything, no leftovers.

---

## Updating

The plugin ships a built-in "Pet Management → Update" page plus an update bubble in the bottom-right corner: it checks GitHub for the newest version and offers a one-click update as soon as a new release appears.

| Install type | Version | Update method |
|---|---|---|
| Local link (link) | ≥ 0.3.0 | One-click `git pull` (incremental) |
| npm registry (registry) | ≥ 0.3.0 | One-click `pnpm update dsh-pet-remielle` (incremental) |
| Any type | < 0.3.0 | **Auto-update is not supported**: the package name changed at 0.3.0, so the old version must be fully uninstalled and then reinstalled |

> Note: **package name / row id changed** before 0.3.0 (before 0.2.0 it was `@dsh-external/dsh-client-ui-pet-remielle`; from 0.2.0–0.3.0 it was `dsh-pet-remielle`). A plain `git pull`/`pnpm update` cannot cross that change, so anything below 0.3.0 **must be uninstalled before the new version is installed** (otherwise you hit load errors such as `loaded without registering … via __ModuleLoader__.load`). The commands are:

```powershell
# Uninstall using the old row id you actually installed (run whichever applies)
dsh plugin --profile web remove @dsh-external/dsh-client-ui-pet-remielle   # 0.2.0 and earlier
dsh plugin --profile web remove dsh-pet-remielle                            # after 0.2.0

# Reinstall the latest version (npm or GitHub both work)
dsh plugin --profile web add dsh-pet-remielle
# or: dsh plugin --profile web add github:Gin-7/dsh-pet-remielle
```

> In "Settings → Pet Management → Update", clicking "Update now" on a version below 0.3.0 shows the same uninstall/reinstall guidance instead of overwriting the installation in place.

---

## Desktop Floating Mode (optional)

`desktopMode` is off by default. Once enabled, the Electron runtime is used to launch a **transparent, always-on-top, frameless** standalone window that shows the pet.

- The window supports dragging (position remembered automatically), wheel zoom, double-click drawing, and a right-click menu.
- Status/balance bubbles match the web client: stacked session cards, single-dot switching, the same hint text and click behavior; `✓` still performs "Allow once".
- Known limitation: the green-dot "needs attention" feed comes from the web sidebar and is only synced to the desktop window **while the web client is online**. New reminders that appear while the page is closed may not show up in the desktop bubble; they become visible the next time you open the page — keeping the page open during normal use means you are unaffected.
- The desktop window compensates its UI size from the system scale factor, so it looks the same size as the web client.
- Double-click drawing: the artwork shows in a **separate small window in the top-right corner of the desktop**, a thick brush reveals it back and forth along the diagonal, and it ends with "Pleased → fade-out".
- The right-click menu is exactly the same as on the web client (see "Usage" below).
- Closing it or switching back returns to the in-page pet automatically; it closes when the DSH host exits (it disappears within at most 1 second after the host is gone).
- The desktop window's Electron data directory is pinned to the system application-data directory (Windows `%APPDATA%\dsh-pet-remielle`; macOS / Linux use their own application-data directories) and is **never placed in the temp directory** — `%TEMP%` gets wiped by system disk cleanup, cache included. Only one desktop window may hold it at a time: when another live instance is detected (the host just restarted and the old window has not finished exiting), it automatically backs off to a pid-suffixed sibling directory, so the two never share the same Chromium cache.

**Electron runtime sources (probed in order)**: `DSH_PET_ELECTRON` environment variable → `vendor/electron-<platform>-<arch>/` (this directory is not in Git; the package matching the current system is downloaded automatically) → an already-installed system Electron → if none is found, in-page display only.

> **First run**: if desktop floating mode is enabled but no Electron runtime can be found on this machine, you are **prompted to download and install it** (it needs your confirmation, because the Electron runtime is about 100–220 MB, largest on Windows); if the download fails it falls back to in-page display automatically, and nothing else is affected. You can also manually extract any matching platform's Electron release into `vendor/electron-<platform>-<arch>/`, or set `DSH_PET_ELECTRON` to an existing electron executable (Windows: `electron.exe`; macOS: `Electron.app/Contents/MacOS/Electron`; Linux: `electron`).

### Platform support

| Platform | Desktop floating window | In-page pet |
|---|---|---|
| Windows x64 | ✓ (Electron transparent always-on-top window) | Hidden automatically in desktop mode |
| macOS (arm64 / x64) | ✓ (automatically downloads the matching darwin Electron) | Hidden automatically in desktop mode |
| Linux x64 | ✓ (automatically downloads the matching linux Electron) | Hidden automatically in desktop mode |

---

## Usage

- **Single-click the pet**: cycle to a random sticker mood.
- **Double-click the pet**: enter the drawing animation; when the drawing finishes the artwork pops up on screen (top-right corner) and then fades out.
- **Right-click the pet**: the **same menu** in-page and in the desktop window (same width, same order, sliders aligned left and right) — character size / opacity / mirror horizontally / lock position / pause animation / show bubble / draw / reset position / desktop floating mode. "Reset position" clears both the in-page and the desktop-window position in one go; "Pause animation" freezes on the **currently displayed frame** (not the first frame) — exact on a secure context (`127.0.0.1` / `localhost` / https), while a plain-HTTP LAN address falls back to the first frame; un-pausing makes the GIF replay from frame 0 (inherent browser behavior when re-assigning `src`; `<img>` cannot seek to a given frame).
- **Settings-page only**: enable / hide desktop pet, Pet Management, respond to sub-agents, usage mode and the platform token, bubble sub-items and the fine-grained bubble scaling options — either they are low-frequency, or turning them off would take their own entry point with them (so they are not in the right-click menu).
- **Both clients share one theme source**: the menu and bubbles use **the same colors** in-page and in the desktop window, and both follow the same theme source — the web client reports the host theme (`body[data-ds-dark-theme]`) to the host, and the desktop window colours itself from that report; when no web client is online (or the report has expired) the desktop window falls back to the **system** light/dark setting, which stays a sensible default for a standalone window. Items, order and geometry parameters match item by item as well (the check mark on a toggle row never changes that row's height), and a cross-file assertion pins the colors on both clients.
- **Bubble paging**: with both status and usage on, clicking the left dot or scrolling the wheel on the bubble switches between the status card and the balance page; it stays on the current page and never falls back automatically.
- **Scroll wheel (on the pet)**: adjust the character size.
- The in-page pet menu can also bring the desktop window back up.

---

## Balance & Today's Usage

With both status and usage on, clicking the left dot of the bubble or scrolling the wheel on the bubble shows your DeepSeek account balance and today's spending (the bubble shows "DeepSeek Balance ¥X" + "Today's usage ¥X · off-peak/peak hours", with the period color-coded: green for off-peak, red for peak). With usage only, the bubble goes straight to the balance page. It stays on the current page and never auto-returns to status.

- **Balance**: from the official API `api.deepseek.com/user/balance` (credential `DEEPSEEK_API_KEY`). Auto-refreshes every 60 seconds; it is fetched once when you switch to the balance page; there is a rolling-number animation when the balance changes; transient network blips automatically keep the last known balance instead of erroring.
- **Today's usage · ledger (default, token-free)**: after each balance observation the balance delta is accumulated automatically and persisted to `$DSH_HOME/.dshp-usage.json`, resetting and archiving automatically across day boundaries. No extra token is needed, but this is an estimate — spending incurred while DSH is closed is missed.
- **Today's usage · real-time token (exact)**: after you configure the platform session token `DEEPSEEK_PLATFORM_TOKEN`, it connects straight to the platform cost API (`platform.deepseek.com/api/v0/usage/by_api_key/cost`) and reads the **real amount** the platform computes per hour — no local pricing table, so DeepSeek price changes are followed automatically:
  - The bubble also shows the current period (off-peak / peak): on weekdays the peak hours are 9:00–12:00 and 14:00–18:00 (Beijing time), while **Saturdays, Sundays and Chinese statutory holidays are off-peak all day** (weekends that are make-up workdays are also billed as off-peak, matching the official rule). The holiday calendar falls back to a built-in table and silently refreshes public calendar data in the background (cached at `$DSH_HOME/.dshp-holidays-<year>.json`), issuing a year-only request on first use or after expiry
  - Falls back to ledger mode automatically when the token is missing or invalid

**Switching usage mode**: Settings → Pet Management → Behavior → "Usage mode" (ledger / real-time token). This is a configuration item rather than a live tweak, so it is reachable only through the settings page.

> How to obtain `DEEPSEEK_PLATFORM_TOKEN`: sign in to platform.deepseek.com → F12 DevTools → Network → open the "Usage" page → copy the `Authorization` header value of the `api/v0/usage/...` request → configure it in the DSH credentials service.

---

## Configuration (Settings → Plugins → Remielle Desktop Pet)

| Field | Default | Description |
|---|---|---|
| enabled | true | Enable the desktop pet (disabling hides it immediately, re-enabling restores it) |

All other appearance/behavior options (character size, opacity, mirror, lock, bubbles, usage mode, desktop float, pause, hide, …) live in one place — "Settings → Pet Management" — and are no longer duplicated on the plugin configuration card; the **instantly visible and high-frequency** ones also appear in the right-click menu (see the list in "Usage") — both clients share one skeleton and one set of names, so changing one means changing the other.

## Settings → Pet Management

The pet registry is an independent tab, sitting alongside **Appearance / Pets / Behavior / Desktop / About** as the fifth tab.

- Enable/disable pets, set as current, rename, add a new pet; pets with a missing directory or missing images show the reason on the card (and the enable switch is disabled at the same time).
- Behavior page: enable / lock / pause animation / hide / respond to sub-agents / show bubble / **usage mode**.
- "Update": shows the current version, check for updates, one-click update, view the upgrade notes.
- "Feedback": shows the pet version, submit bugs / feature requests.

---

## Development

```powershell
npm install
node scripts/build-client.mjs    # Build lib/client.js (version number injected from package.json)
npm test                          # node --test unit tests
npm run check                     # Syntax check
```

### Directory Structure

```
src/
├── index.js          # Host: config, event wiring, config/state/balance/pets/assets/desktop endpoints, self-update routes
├── balance.js        # Balance service: balance fetch (retry/cache/blip tolerance), today's usage in two modes (ledger/platform cost API)
├── holidays.js       # Holiday calendar: peak/off-peak period decision (weekends/statutory holidays off-peak all day), built-in table + remote refresh + disk cache
├── self-update.js    # Version check + one-click update (direct GitHub + HTTP proxy fallback; git pull / pnpm update)
├── pet-reducer.js    # Pure state machine: session events → state/pulse/task (unit-tested)
├── protocol.js       # Typed protocol: PetState / PetMood / PetMessageKind
├── pets.js           # Pet registry: directory discovery/merge/validation (unit-tested)
├── status-copy.js    # Remielle-flavored status copy (replaceable as a whole)
├── turn-watchdog.js  # Turn-hang watchdog: fallback for "session force-killed then stuck in the analyzing phase"
├── desktop-window.js # Desktop mode: Electron discovery + window process management (unit-tested)
├── electron-fetch.mjs # Download and extract the Electron runtime for the current platform/arch
├── pet-window.cjs    # Desktop mode: Electron main (transparent always-on-top window + artwork window in the screen's top-right corner)
├── pet-window-paths.cjs # Pet-window userData directory decision (isolated from the host's Electron)
├── pet-preload.cjs   # Pet-window preload: page ↔ main-process bridge (click-through, drag, hit rects, menu expand)
├── pet-view.html     # Desktop mode: pet window page (GIF + bubble + SSE + drawing + balance bubble)
├── balance-widget.js # Balance controller (client): fetch/rolling animation, rendered into the pet's own bubble
└── client.core.js    # Browser side: pet UI + settings (wrapped at build time)

# .cjs modules shared by both clients (the package is "type":"module"; the host
# picks the exports up through createRequire). The web side concatenates them in
# front of client.core.js via scripts/build-client.mjs; the desktop side serves them
# from host-registered routes via <script src> — one implementation, so the copy and
# geometry on the two clients can never drift apart.
├── session-order.cjs # Deck ordering (approval > plan review > waiting for an answer > completion card > attention …)
├── pet-tip.cjs       # Page-switch dot hover copy, tip viewport clamping, bubble zoom resolution
├── gif-frame.cjs     # The GIF's "frame at this moment" (for right-click pause; the canvas only ever paints frame 0)
├── bubble-title.cjs  # Bubble session-card presentation layer: title throttling, width measurement, copy and class names for the approval / plan review / done states
└── markdown.cjs      # Markdown rendering for release notes (escape first, then transform; only http(s)/mailto links pass)

lib/client.js         # Build artifact (version injected, ready to use after install)
assets/pets/remielle/ # Remielle assets (GIFs + artwork)
scripts/build-client.mjs
test/                 # node --test
```

> The `.cjs` suffix exists so that the host's ESM can pick the exports up through `createRequire`; the public URL is still `.js`
> (a browser `<script>` does not honour `.cjs` extension semantics). When adding a module shared by both clients, remember to add it to **both**
> the concatenation list in `scripts/build-client.mjs` **and** the host's route registration. Use
> `test/host-transport.test.js` to verify that the real route returns the script, then have
> `test/desktop-window-ui.test.js` check the page's script src and the shared-module calls.

### Publishing to npm

```powershell
npm login
pnpm version patch    # Bump the version
pnpm pack --dry-run   # Check what will be published (no node_modules / vendor)
pnpm publish
```

> Published content is limited by the `files` field: `src/`, `lib/client.js`, `assets/`, `scripts/`, `test/`, `cordis.patch.yml`, `NOTICE`, `README.md`. `vendor/` (the Electron runtime) is not published; desktop mode downloads it on demand.

---

## License & Asset Copyright

The code is distributed under the MIT License; the Remielle character art and the GIF/artwork assets are copyrighted by miHoYo (HoYoverse),
**and commercial use and redistribution of the assets is prohibited**. See `NOTICE` for details.
