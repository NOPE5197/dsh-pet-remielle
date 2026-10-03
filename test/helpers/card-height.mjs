/**
 * The card deck's real card height lives in CSS: the test stub's offsetHeight is only an
 * approximation and must not be used as the card height.
 * The web client writes it in the inline CSS string in client.core.js, the desktop client in
 * the <style> block of pet-view.html — writing the regex twice on each side is bound to drift,
 * so it lives here and is shared.
 *
 * The min-height trap: the CSS rule is normally written as `height:91px;min-height:91px`, and
 * the browser renders max(height, min-height) when the two disagree. Matching only with
 * /(?<!-)height:/ (a negative lookbehind that skips min-height) means the assertion stays
 * green after changing height without the other, or after changing only min-height — even
 * though the real card height did change. So both are taken here and a mismatch throws
 * directly: an inconsistent declaration is suspicious in itself and the test must not
 * silently pick one to believe.
 */

/** Extract the declaration body of the `.rm2-pet-bubbles .rm2-pet-bubble` rule from a source file. */
function bubbleRule(src) {
  return /\.rm2-pet-bubbles \.rm2-pet-bubble\s*\{[^}]*\}/.exec(src)?.[0] ?? ''
}

function pxOf(rule, prop) {
  return Number(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(rule)?.[1])
}

export function cardHeightOf(src, where = '') {
  const rule = bubbleRule(src)
  const at = where ? ` (${where})` : ''
  const height = pxOf(rule, 'height')
  const minHeight = pxOf(rule, 'min-height')
  if (!Number.isFinite(height) && !Number.isFinite(minHeight)) {
    throw new Error(`cardHeightOf${at}: no height/min-height found for .rm2-pet-bubbles .rm2-pet-bubble`)
  }
  if (Number.isFinite(height) && Number.isFinite(minHeight) && height !== minHeight) {
    throw new Error(
      `cardHeightOf${at}: inconsistent card height declarations — height=${height}px but min-height=${minHeight}px; ` +
      'the browser renders the larger of the two, so an assertion must not pick just one',
    )
  }
  return Number.isFinite(minHeight) ? minHeight : height
}
