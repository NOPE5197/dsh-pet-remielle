/**
 * Markdown renderer for release notes (shared by the settings page "About" tab
 * and the one-click update's update card).
 *
 * A GitHub release body is markdown and used to be shown as plain text in a
 * <pre>, which mashed headings/lists/links into a single line. This implements a
 * sufficient subset: headings, lists, code blocks / inline code, quotes, thematic
 * breaks, bold and italic, strikethrough, links.
 *
 * Safety contract: escape the whole thing as HTML first and only then apply the
 * markdown transforms (the escaped &lt; and friends cannot be reinterpreted a
 * second time); link targets only allow http(s)/mailto and everything else is
 * forced to '#' — the release body comes from a remote source and cannot be
 * trusted.
 *
 * The file uses .cjs: the package is "type":"module", so host ESM can only get
 * the exports through createRequire; the web client concatenates it before
 * client.core.js via scripts/build-client.mjs and reaches it through
 * window.__rm2Markdown. It is pure, so it is unit testable without a DOM stub
 * (see test/markdown.test.js).
 */
;(function (global) {
  'use strict'

  function mdEscapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function mdSafeUrl(url) {
    var u = String(url || '').trim()
    return /^(https?:\/\/|mailto:)/i.test(u) ? u.replace(/"/g, '%22') : '#'
  }
  function mdInline(text) {
    var s = mdEscapeHtml(text)
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>' })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + mdSafeUrl(u) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    return s
  }
  function renderMarkdown(src) {
    var lines = String(src || '').split(/\r?\n/)
    var html = []
    var inCode = false
    var listTag = null
    var para = []
    function flushPara() { if (para.length) { html.push('<p>' + para.join('<br>') + '</p>'); para = [] } }
    function closeList() { if (listTag) { html.push('</' + listTag + '>'); listTag = null } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (/^\s*```/.test(line)) {
        if (inCode) { html.push('</code></pre>'); inCode = false }
        else { flushPara(); closeList(); html.push('<pre><code>'); inCode = true }
        continue
      }
      if (inCode) { html.push(mdEscapeHtml(line)); continue }
      var h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) { flushPara(); closeList(); var lv = h[1].length; html.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>'); continue }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr>'); continue }
      var ul = line.match(/^\s*[-*+]\s+(.*)$/)
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
      if (ul || ol) {
        flushPara()
        var want = ul ? 'ul' : 'ol'
        if (listTag !== want) { closeList(); html.push('<' + want + '>'); listTag = want }
        html.push('<li>' + mdInline((ul || ol)[1]) + '</li>')
        continue
      }
      var q = line.match(/^\s*>\s?(.*)$/)
      if (q) { flushPara(); closeList(); html.push('<blockquote>' + mdInline(q[1]) + '</blockquote>'); continue }
      if (!line.trim()) { flushPara(); closeList(); continue }
      para.push(mdInline(line))
    }
    if (inCode) html.push('</code></pre>')
    flushPara(); closeList()
    return html.join('')
  }

  global.__rm2Markdown = {
    mdEscapeHtml: mdEscapeHtml,
    mdSafeUrl: mdSafeUrl,
    mdInline: mdInline,
    renderMarkdown: renderMarkdown,
  }
  // There is a window in a browser script / build concatenation, so module.exports
  // must not be written, or it would overwrite the client bundle's
  // module.exports. A Node require has no window and can be treated as a CJS export.
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = global.__rm2Markdown
  }
})(typeof window !== 'undefined' ? window : globalThis)
