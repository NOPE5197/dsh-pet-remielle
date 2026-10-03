/**
 * Behaviour unit tests for the markdown renderer of release notes
 * (src/markdown.cjs).
 *
 * This implementation used to be inlined in client.core.js, so the unit tests
 * had to slice the source out between the `// ---- md render begin ----`
 * markers and evaluate it in a vm — the test hung on "what the source looks
 * like" and broke as soon as a marker changed. After extracting it into a
 * standalone .cjs it can simply be required, with not one assertion removed.
 *
 * The security surface is this file's focus: a release body comes from GitHub
 * remote and cannot be trusted, so the order of "escape the whole thing as HTML
 * first, then apply the markdown transforms" and the link protocol allowlist must
 * be pinned by behavioural assertions, not left to code review alone.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { mdEscapeHtml, mdInline, mdSafeUrl, renderMarkdown } = require('../src/markdown.cjs')

test('block syntax: headings, lists, quote, rule and paragraphs', () => {
  const html = renderMarkdown('# v0.5.0\n\n## Fixes\n\n- Fixed the **contrast** problem\n- See the `hover` rule\n\n1. First step\n2. Second step\n\n> Note\n\n---\n\nFirst body line\nSecond body line')
  assert.ok(html.includes('<h1>v0.5.0</h1>'), 'h1 should render')
  assert.ok(html.includes('<h2>Fixes</h2>'), 'h2 should render')
  assert.ok(html.includes('<ul><li>'), 'an unordered list should render as ul/li')
  assert.ok(html.includes('<ol><li>First step</li><li>Second step</li></ol>'), 'an ordered list should render as ol/li')
  assert.ok(html.includes('<strong>contrast</strong>'), 'bold should render')
  assert.ok(html.includes('<code>hover</code>'), 'inline code should render')
  assert.ok(html.includes('<blockquote>Note</blockquote>'), 'a quote should render')
  assert.ok(html.includes('<hr>'), 'a thematic break should render')
  // A newline inside a paragraph is a soft break → <br>; only a blank line starts
  // a new paragraph
  assert.ok(html.includes('<p>First body line<br>Second body line</p>'), 'a single newline inside a paragraph should fold into <br>, a blank line starts a paragraph')
  // Switching list type must close the previous list; there must be no
  // <ul>…<ol> nesting
  assert.ok(!/<ul>[^<]*<ol>/.test(html.replace(/<li>[^<]*<\/li>/g, '')), 'switching list type must first close the previous list')
})

test('inline emphasis: bold / italic / strikethrough do not eat each other', () => {
  assert.ok(mdInline('**bold**').includes('<strong>bold</strong>'), 'bold')
  assert.ok(mdInline('*italic*').includes('<em>italic</em>'), 'italic')
  assert.ok(mdInline('~~struck~~').includes('<del>struck</del>'), 'strikethrough')
  // ** bold must not be eaten by the * italic rule that runs first
  assert.ok(mdInline('**bold** tail').includes('<strong>bold</strong> tail'), '**…** must stay paired and must not be split by the single-star rule')
})

test('fenced code block content is escaped and never parsed as markdown', () => {
  const code = renderMarkdown('```\n**not bold** <img>\n```')
  assert.ok(code.includes('<pre><code>'), 'a fenced code block should render as pre>code')
  assert.ok(code.includes('**not bold**') && !code.includes('<strong>'), 'code block content must not be parsed as markdown')
  assert.ok(code.includes('&lt;img&gt;'), 'code block content must be escaped')
  // An unclosed fence: the tags must still be closed at the end of the file
  assert.ok(renderMarkdown('```\nunclosed').endsWith('</code></pre>'), 'an unclosed fence must be completed at the end')
})

test('XSS: escape happens before every markdown transform', () => {
  const xss = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](javascript:x)')
  assert.ok(!xss.includes('<script>'), 'HTML tags must be escaped into literal text')
  assert.ok(xss.includes('&lt;script&gt;'), 'the escaped tag should be visible as plain text')
  assert.ok(!xss.includes('href="javascript:'), 'javascript: links must be rejected')
  assert.ok(mdInline('<b>&</b>').includes('&lt;b&gt;&amp;&lt;/b&gt;'), 'the whole thing must be HTML-escaped before any inline transform')
  // With the escape order wrong there is a chance that "&lt;script&gt;" gets
  // reinterpreted as a tag by a later rule
  assert.equal(mdEscapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'entities and quotes must both be escaped')
})

test('mdSafeUrl only allows http(s) and mailto', () => {
  assert.equal(mdSafeUrl('javascript:alert(1)'), '#')
  assert.equal(mdSafeUrl('data:text/html,<script>'), '#')
  assert.equal(mdSafeUrl('  https://ok.example.com/a  '), 'https://ok.example.com/a', 'surrounding whitespace should be trimmed first')
  assert.equal(mdSafeUrl('https://ok.example.com/a'), 'https://ok.example.com/a')
  assert.equal(mdSafeUrl('mailto:a@b.c'), 'mailto:a@b.c')
  assert.equal(mdSafeUrl('HTTPS://OK.EXAMPLE.COM/A'), 'HTTPS://OK.EXAMPLE.COM/A', 'the protocol check should be case-insensitive')
  assert.equal(mdSafeUrl('https://a.com/"onload="x'), 'https://a.com/%22onload=%22x', 'quotes inside the URL must be percent-escaped, otherwise they can break out of the attribute')
  assert.equal(mdSafeUrl(''), '#')
  assert.equal(mdSafeUrl(null), '#')
})

test('rendered links are rel-protected', () => {
  const html = renderMarkdown('[click me](https://github.com/x)')
  assert.ok(html.includes('target="_blank"'), 'an external link should open in a new page')
  assert.ok(html.includes('rel="noopener noreferrer"'), 'an external link must carry noopener noreferrer, otherwise the target page can manipulate this page')
})

test('empty and non-string input degrade instead of throwing', () => {
  assert.equal(renderMarkdown(''), '')
  assert.equal(renderMarkdown(null), '')
  assert.equal(renderMarkdown(undefined), '')
  // The entry point is String(src || ''): falsy non-strings such as 0 degrade to
  // an empty string too, and not throwing is all that is required.
  // The caller baseUpdateNotes() only ever passes strings anyway.
  assert.equal(renderMarkdown(0), '')
  assert.equal(renderMarkdown(12.5), '<p>12.5</p>', 'a truthy non-string should render as a string')
})
