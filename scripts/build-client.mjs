/**
 * Build the browser client bundle: wrap src/client.core.js in the web
 * shell's module loader. Sticker GIFs are NOT inlined anymore — the host
 * serves them at /plugins/dsh-pet-remielle/assets/<petId>/<mood>.gif so
 * pets can be added at runtime without rebuilding (see src/pets.js).
 *
 * Run with: node scripts/build-client.mjs  (or `pnpm build:client`)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outFile = resolve(root, 'lib', 'client.js')
const pkgFile = resolve(root, 'package.json')
const pluginId = 'dsh-pet-remielle'

/**
 * Read a source segment from src and normalize its line endings to LF.
 *
 * A Windows workspace checkout is CRLF, while the '\n' inside the banner / separator /
 * footer is LF, so concatenating them as-is produces a bundle with mixed line endings —
 * in git it flips between "all LF" and "mixed" and diffs drown in line-ending noise.
 * Normalizing to LF here keeps the artifact's line endings uniform; .gitattributes does
 * the final normalization.
 */
const readSrc = (name) => readFileSync(resolve(root, 'src', name), 'utf8').replace(/\r\n/g, '\n')

const core = readSrc('client.core.js')
// The shared bubble ordering logic (one implementation for the desktop floating window
// and the web client) is concatenated before the core code, so window.__rm2SessionOrder
// is already in place when client.core.js runs.
const order = readSrc('session-order.cjs')
const tip = readSrc('pet-tip.cjs')
// Grabbing the current GIF frame (for the pause freeze): one implementation shared with
// the desktop window, concatenated before the core code.
const gifFrame = readSrc('gif-frame.cjs')
// Title throttling and state copy for bubble session cards (approval / plan review / done):
// one implementation shared with the desktop window.
const bubbleTitle = readSrc('bubble-title.cjs')
// Markdown rendering for release notes (shared by the settings "About" tab and the update
// card): a pure function, web client only.
const markdown = readSrc('markdown.cjs')
const { version } = JSON.parse(readFileSync(pkgFile, 'utf8'))
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {
const module = { exports: {} }
const exports = module.exports
const RM_PLUGIN_VERSION = ${JSON.stringify(String(version || '0.0.0'))}
`
const footer = 'return module.exports\n} })'

const output = `${banner}${order}\n${tip}\n${gifFrame}\n${bubbleTitle}\n${markdown}\n${core}\n${footer}\n`

// Concatenation-order guard: these shared modules must come before client.core.js,
// otherwise they do not exist yet when core reaches the `window.__rm2Xxx` consumers —
// the fail-early guard would throw and the whole pet module would go dead.
//
// Kept in the build rather than in a unit test: getting the order wrong fails the build
// outright (the artifact is never written), whereas a unit test only notices on the next
// `pnpm test` and is easy to misread as "I changed src but forgot to build". The
// test/client-interactions.test.js case below only exercises the real bundle, it does not
// re-assert this order.
const mountAt = output.indexOf('function mountPet')
if (mountAt === -1) {
  throw new Error('build-client: mountPet not found in client.core.js, cannot verify concatenation order')
}
for (const marker of ['__rm2SessionOrder', '__rm2PetTip', '__rm2GifFrame', '__rm2BubbleTitle', '__rm2Markdown']) {
  // Anchor on the assignment where the module publishes its implementation, not on the
  // bare marker. The bare marker also shows up in core's consumer-side guards
  // (`if (!__md) throw new Error('__rm2Markdown is missing…')`), so indexOf would match
  // that one inside core first — and it is always before mountPet. That would let a real
  // ordering bug ("the module was concatenated after core") pass unnoticed and the build
  // would succeed, only exploding when a browser loads the artifact. The markdown
  // consumer sits at line 287 of core, about 800 lines before mountPet, which is exactly
  // an instance of that trap.
  const at = output.indexOf(`global.${marker} = `)
  if (at === -1) throw new Error(`build-client: no publication statement for ${marker} in the output`)
  if (at > mountAt) throw new Error(`build-client: ${marker} must be concatenated before mountPet (currently ${at} > ${mountAt})`)
}

writeFileSync(outFile, output)
console.log(`lib/client.js written (${Math.round(Buffer.byteLength(output) / 1024)} KiB)`)
