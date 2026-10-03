/**
 * Structural guard for the settings page (PetsSection).
 *
 * Background: the pet card's "rename" and "status badge" once became dead code
 * because PetsSection hard-coded its own card (petCard/RenameButton/petBadge were
 * never called and the rename promised by the README vanished from the UI for
 * months). This file pins the key structure of the settings page:
 *   1. the tab list and their order (Appearance/Pets/Behavior/Desktop/About)
 *   2. pet cards must render the rename button and the status badge (guard
 *      against a dead-code regression)
 *   3. the no-release state of the update check must have visible feedback (no
 *      silent failure)
 *
 * PetsSection() is driven directly with a fake React (the same mechanism as
 * .global_ignored/settings-tree-probe.mjs); no browser is needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const CORE = new URL('../src/client.core.js', import.meta.url)
const src = readFileSync(CORE, 'utf8')
// client.core.js requires window.__rm2Markdown at the top level (supplied by the
// web client through build-client.mjs concatenation). The shared module is
// injected here because the sandbox runs src rather than the build artifact, so
// it has to be provided by hand.
const markdown = require('../src/markdown.cjs')

function makeReact({ tab, data, config, updMsg }) {
  const initial = [tab, data, null, false, config, false, null, false, updMsg]
  let cursor = 0
  return {
    React: {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
      },
      useState(seed) {
        const i = cursor++
        return [i < initial.length ? initial[i] : seed, () => {}]
      },
      useEffect() {},
      useRef(seed) { return { current: seed } },
    },
    reset() { cursor = 0 },
  }
}

function loadPetsSection() {
  const stubs = makeReact({ tab: 'appearance', data: null, config: null, updMsg: null })
  const sandbox = {
    React: stubs.React,
    require: (name) => {
      if (name === 'react') return stubs.React
      throw new Error('unexpected require: ' + name)
    },
    module: { exports: {} },
    RM_PLUGIN_VERSION: '0.0.0-test',
    __rm2Markdown: markdown,
    window: { addEventListener() {}, __rm2Markdown: markdown },
    document: {
      createElement: () => ({ style: {}, addEventListener() {}, contains() {}, appendChild() {}, textContent: '' }),
      body: null,
      addEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: () => new Promise(() => {}),
  }
  sandbox.globalThis = sandbox
  runInNewContext(src, sandbox, { filename: 'client.core.js' })
  if (typeof sandbox.PetsSection !== 'function') throw new Error('PetsSection was not exported to the sandbox global')
  return { sandbox, stubs }
}

function renderTab(tab, { data = null, config = null, updMsg = null } = {}) {
  const { sandbox, stubs } = loadPetsSection()
  const fresh = makeReact({ tab, data, config, updMsg })
  sandbox.React = fresh.React
  sandbox.require = (name) => { if (name === 'react') return fresh.React; throw new Error('require ' + name) }
  return sandbox.PetsSection()
}

function nameOf(type) {
  if (typeof type === 'string') return type
  if (typeof type === 'function') return type.name || 'anonymous'
  return String(type)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function collectTabLabels(tree) {
  const labels = []
  walk(tree, (node) => {
    if (nameOf(node.type) === 'button' && typeof node.children?.[0] === 'string' && node.props?.type === 'button') labels.push(node.children[0])
  })
  return labels
}

function collectStrings(tree) {
  const out = []
  walk(tree, (node) => {
    for (const child of node.children || []) {
      if (typeof child === 'string') out.push(child)
    }
  })
  return out
}

function collectComponents(tree, name) {
  const out = []
  walk(tree, (node) => {
    if (typeof node.type === 'function' && node.type.name === name) out.push(node.props)
  })
  return out
}

const SAMPLE_DATA = {
  activePetId: 'remielle',
  pets: [
    { id: 'remielle', name: 'Remielle', enabled: true, available: true, complete: true, previewMood: '06' },
    { id: 'broken', name: 'Pet with missing art', enabled: false, available: true, complete: false, previewMood: '01' },
  ],
}

test('settings tabs: five tabs in fixed order (Appearance/Pets/Behavior/Desktop/About)', () => {
  const tree = renderTab('appearance')
  const labels = collectTabLabels(tree).filter((l) => ['Appearance', 'Pets', 'Behavior', 'Desktop', 'About'].includes(l))
  assert.deepEqual(labels, ['Appearance', 'Pets', 'Behavior', 'Desktop', 'About'])
})

test('appearance tab field order (mirror stays below opacity)', () => {
  const tree = renderTab('appearance', { config: { scale: 1, opacity: 1, mirror: false } })
  const labels = collectComponents(tree, 'Field').map((p) => p.label).filter(Boolean)
  // bubbleScaleSync defaults to synced → the "bubble size relative to the pet"
  // sub-field is rendered too
  assert.deepEqual(labels, ['Character size', 'Bubble scales with pet', 'Bubble size relative to pet', 'Opacity', 'Mirror horizontally'])
})

test('settings title matches the nav label (Pet Management)', () => {
  const tree = renderTab('appearance')
  assert.ok(collectStrings(tree).includes('Pet Management'), 'the section title should match the left nav label')
})

test('pet cards render rename-on-double-click and status badges (no dead code fallback)', () => {
  const tree = renderTab('pets', { data: SAMPLE_DATA, config: {} })
  const renames = collectComponents(tree, 'RenameButton')
  assert.equal(renames.length, 2, 'every available pet name should be a rename entry point (double-click)')
  assert.deepEqual(renames.map((p) => p.pet.id), ['remielle', 'broken'])
  const strings = collectStrings(tree)
  assert.ok(strings.includes('Enabled'), 'a complete pet should show the "Enabled" badge')
  assert.ok(strings.includes('Missing art (needs 01–06 complete)'), 'a pet with missing art should show the missing-art badge instead of silently disabling the switch')
  const setActive = strings.filter((s) => s === 'Set as current')
  assert.equal(setActive.length, 0, 'a pet with missing art should not get a "Set as current" entry')
  assert.ok(!strings.includes('Rename'), 'there should no longer be a standalone "Rename" button — the entry point is double-clicking the name')
})

test('update check shows feedback when the repo has no release yet', () => {
  const tree = renderTab('about', { updMsg: 'no-release' })
  assert.ok(
    collectStrings(tree).some((s) => s.includes('The repository has not published any release yet')),
    'the no-release state must have visible copy and must not be silent',
  )
})

/**
 * Palette guards. The three real bugs recorded in the CHANGELOG (light-toned
 * borders / error color in dark mode, black-on-black primary button, white
 * primary-button text on a light hover background) all came from CSS variable
 * values and cannot be reproduced without a browser — so "no regression" can
 * only be pinned with source-level assertions.
 *
 * The **render-level** assertion for "controls carry the shared class name"
 * (the className prop) only proves the JSX passed a class name, not that the CSS
 * rule exists — delete the rule and the buttons still degrade all-green into
 * browser defaults and the rename box becomes a bare input. So the CSS base
 * itself is pinned below too.
 *
 * The same goes for the rename entry point: the fake React does not expand
 * function components, so the event bindings inside RenameButton are
 * unreachable and only source-level assertions work. This used to use a
 * [\s\S]{0,900} character window (which breaks after moving a few lines); it now
 * slices by function boundary, with no magic numbers.
 */
test('palette guards: no non-existent CSS vars, primary button readable in both themes', () => {
  // Base rules: .rm2-pet-btn is the style source for every settings-page button
  // and .rm2-pet-input is the rename editor's input box. Both live in the CSS
  // array injected by client.core.js.
  assert.ok(src.includes("'.rm2-pet-btn{"), 'the injected CSS array must define .rm2-pet-btn (with hover/disabled states)')
  assert.ok(src.includes("'.rm2-pet-input{"), 'the injected CSS array must define .rm2-pet-input')
  // The rename entry point is "double-click the name", not a standalone button
  // (the interaction promised by the README)
  const renameBody = /function RenameButton[\s\S]*?\n\}/.exec(src)?.[0]
  assert.ok(renameBody, 'RenameButton must be locatable')
  assert.ok(renameBody.includes('onDoubleClick'), 'the rename entry point must be double-clicking the name (onDoubleClick)')
  // var(--border-color/--danger-color/--surface-color) are non-existent
  // variables that always fall through to the light fallback, so in the dark
  // theme every border/error color ends up light-toned. Regression forbidden.
  assert.ok(!/var\(--(border|danger|surface)-color/.test(src), 'the non-existent --border-color/--danger-color/--surface-color variables are forbidden')
  // The primary button's text color must not use --dsw-alias-brand-primary-invert:
  // measured, it has the same value as brand-primary in the light theme (both
  // near-black #0f1115) → black on black, unreadable. The correct choice is
  // bg-layer-1 (naturally the inverse of the theme's accent).
  assert.ok(!/rm2-pet-btn-primary\{[^}]*brand-primary-invert/.test(src), '.rm2-pet-btn-primary must not use brand-primary-invert as its text color (same value as the background)')
  assert.ok(/rm2-pet-btn-primary\{[^}]*color:var\(--dsw-alias-bg-layer-1/.test(src), 'the primary button text color must use bg-layer-1 (the theme inverse)')
  // The primary button's hover must write the accent background back: the
  // primary button element also carries .rm2-pet-btn, and
  // .rm2-pet-btn:hover:not(:disabled) (specificity 0,3,0) beats
  // .rm2-pet-btn-primary (0,1,0), swapping the hover background for light grey
  // → white text on a light background collides. The hover rule must write
  // brand-primary back at equal specificity.
  assert.ok(/rm2-pet-btn-primary:hover:not\(:disabled\)\{background:var\(--dsw-alias-brand-primary/.test(src), 'the primary button hover must write brand-primary back as the background (otherwise .rm2-pet-btn:hover swaps in a light grey → collision)')
})

test('rendered pet-card buttons use the shared classes', () => {
  const data = {
    activePetId: 'remielle',
    pets: [...SAMPLE_DATA.pets, { id: 'spare', name: 'Spare pet', enabled: false, available: true, complete: true, previewMood: '01' }],
  }
  const tree = renderTab('pets', { data, config: {} })
  const buttons = []
  walk(tree, (node) => {
    // The fake React does not expand function components, so the button inside
    // RenameButton is only covered by the source-level assertion (the test
    // above); what is asserted here are the buttons inlined in PetsSection.
    if (nameOf(node.type) === 'button' && typeof node.children?.[0] === 'string') buttons.push({ label: node.children[0], className: node.props?.className || '' })
  })
  const setActive = buttons.find((b) => b.label === 'Set as current')
  assert.ok(setActive, 'the spare pet should render a "Set as current" button')
  assert.ok(setActive.className.includes('rm2-pet-btn'), 'the "Set as current" button must carry the rm2-pet-btn class')
})

/**
 * The wiring of release notes through the markdown renderer.
 *
 * The rendering behaviour itself (headings/lists/links/XSS escape order/protocol
 * allowlist) is asserted directly against the shared module src/markdown.cjs by
 * test/markdown.test.js; only the call sites are pinned here. This file used to
 * also carry 4 character-window regexes ([\s\S]{0,2200} and friends) and a
 * "replace first, then grep" text heuristic — the window was so wide that a few
 * extra lines upstream caused both false positives and misses, so all of them
 * were removed.
 */
test('release notes render as markdown, not plain <pre>', () => {
  assert.ok(src.includes("'.rm2-md p{"), 'the .rm2-md typography styles must be injected (release notes are no longer a bare pre)')
  // The settings page "About" tab: escape first, then insert innerHTML; it must
  // not fall back to plain text
  assert.ok(
    /dangerouslySetInnerHTML:\s*\{\s*__html:\s*renderMarkdown\(updInfo\.notes\)/.test(src),
    'the settings page release notes must be rendered through renderMarkdown',
  )
})

/**
 * Three product contracts of the update dialog: a permanent "Manual update
 * (GitHub)", linking to the repository home instead of releases, and process
 * output kept as plain text (see the matching CHANGELOG entries).
 *
 * Only source assertions are possible: rendering the update card depends on the
 * whole family of updateState / latestInfo / updateHandler, and building them
 * drifts more easily than the assertions themselves. This file used to carry 20+
 * of them — pixel-level styles (max-height:120px), character-window regexes
 * ([\s\S]{0,1600}), the polling period `}, 1000)`. Styles are part of manual
 * acceptance and the window regexes break on every re-layout, so all were
 * removed.
 */
test('update card keeps a permanent manual-update button and never markdown-izes process logs', () => {
  assert.ok(
    src.includes("var PROGRESS_ENDPOINT = '/plugins/dsh-pet-remielle/update-progress'"),
    'the client must define the update-progress endpoint',
  )
  const cardRegion = /function renderUpdateCard[\s\S]*?function openUpdateCard/.exec(src)?.[0]
  assert.ok(cardRegion, 'renderUpdateCard must be locatable')
  assert.ok(cardRegion.includes('Manual update (GitHub)'), 'the permanent button must be inside renderUpdateCard')
  assert.ok(!cardRegion.includes('View on GitHub'), '"View on GitHub" inside the dialog must be merged with the manual update button (avoid two buttons pointing at the release page)')
  // Permanent = the button is created outside the state branch (guarded by
  // needsCleanReinstall, not locked into some phase)
  assert.ok(/if \(!latestInfo\.needsCleanReinstall\) \{[\s\S]*?var manualBtn/.test(src), 'the manual update button must be rendered outside the state branch (permanent)')
  assert.ok(cardRegion.includes("window.open('https://github.com/Gin-7/dsh-pet-remielle', '_blank')"), 'the manual update button must link to the repository home')
  assert.ok(!cardRegion.includes('/releases'), 'the update dialog must no longer link to the releases page')
  // The update output is a process log: keep it monospace plain text and never
  // markdown-ize it (after escaping it would be reflowed by <p>/<br>)
  assert.ok(!/renderMarkdown\(updateState\.output/.test(src), 'the update output must stay a plain-text pre')
})

/**
 * The timeout copy. pnpm / mirror details must be removed from the failure hint —
 * users only care about "the network is slow" and "what to do next"; spelling
 * out pnpm add / npmmirror / resuming only confuses them further.
 *
 * It really runs after slicing by function name: the copy has several branches
 * (timeout / unknown error) that grep cannot cover completely, while the slice
 * only depends on the function name and not on the line numbers inside it.
 */
test('friendlyUpdateError turns a stalled update into a short actionable hint', () => {
  const fn = /function friendlyUpdateError[\s\S]*?\n\}/.exec(src)?.[0]
  assert.ok(fn, 'friendlyUpdateError must be sliceable from the source')
  assert.ok(!fn.includes('npmmirror'), 'the failure hint must no longer spell out the mirror option (converged to manual update + GitHub button)')
  assert.ok(!fn.includes('pnpm add'), 'the failure hint must no longer spell out the pnpm add command (converged to manual update + GitHub button)')
  const sandbox = {}
  runInNewContext(fn + '; this.__f = friendlyUpdateError', sandbox)
  const timedOut = sandbox.__f('resolved 9\n[timeout: no output for 60s — the update process looks hung]')
  assert.ok(timedOut.includes('The network is slow and the download timed out'), 'the timeout error must explain the cause')
  assert.ok(timedOut.includes('Manual update'), 'the timeout error must suggest updating manually')
  assert.ok(!timedOut.includes('resume'), 'it must no longer claim a retry can resume (pnpm does not cache unfinished downloads)')
  assert.ok(!timedOut.includes('npmmirror'), 'it must no longer offer a mirror option')
  assert.equal(sandbox.__f('EPERM: resource busy'), 'EPERM: resource busy\n\n💡 Consider updating manually.', 'an ordinary error appends one manual-update suggestion')
})
