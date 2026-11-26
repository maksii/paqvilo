import { parse } from 'parse5';

// Where and how the toolkit adds its own markup (runtime, adapters, local head assets, frame readiness) to a rendered
// document. The places are the parse5 source locations of the document's real elements, never the first text that
// looks like a tag: a record value printed into an attribute can hold `<head>`, `<body>` or `</body>`, and an insertion
// there would close the attribute with its own quotes and turn the rest of the value into live markup.

/**
 * The insertion points of `html`: `headStart` (after the head start tag), `bodyStart` (after the body start tag) and
 * `bodyEnd` (before the body end tag), each -1 when the document does not write that tag as source text (an implied
 * head or body). With `scripts`, also `scriptStarts` (the start offsets of the script elements outside template
 * contents) and `firstScript`, the first of them (-1 without one).
 */
export function documentAnchors(html, { scripts = false } = {}) {
  const tree = parse(String(html), { sourceCodeLocationInfo: true });
  const root = tree.childNodes.find((node) => node.tagName === 'html');
  const element = (name) => root?.childNodes.find((node) => node.tagName === name)?.sourceCodeLocation;
  const head = element('head'),
    body = element('body');
  const anchors = {
    headStart: head?.startTag?.endOffset ?? -1,
    bodyStart: body?.startTag?.endOffset ?? -1,
    bodyEnd: body?.endTag?.startOffset ?? lastEndTag(String(html), tree, '</body>'),
  };
  if (scripts) {
    anchors.scriptStarts = scriptStarts(tree);
    anchors.firstScript = -1;
    for (const start of anchors.scriptStarts)
      if (anchors.firstScript < 0 || start < anchors.firstScript) anchors.firstScript = start;
  }
  return anchors;
}

/**
 * The offset of the last `endTag` (lower case, e.g. `</body>`) of `text` that the tokenizer reads as a tag, which the
 * tree builder may still ignore (a `</body>` inside an unclosed table): one that no text node, comment or other tag of
 * `tree` holds (script text, an attribute value). -1 without one.
 */
function lastEndTag(text, tree, endTag) {
  const lower = text.toLowerCase();
  let at = lower.lastIndexOf(endTag);
  if (at < 0) return -1;
  const ranges = markupRanges(tree);
  const inside = (offset) => {
    let low = 0,
      high = ranges.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (ranges[mid].start <= offset) low = mid + 1;
      else high = mid;
    }
    const range = ranges[low - 1];
    // A tag that starts at the offset is the end tag itself; text that starts there holds it.
    return Boolean(range) && offset < range.end && (range.text || range.start < offset);
  };
  while (at >= 0 && inside(at)) at = at > 0 ? lower.lastIndexOf(endTag, at - 1) : -1;
  return at;
}

/** The source ranges of a tree's text and comment nodes (text) and element tags, sorted; they never overlap. */
function markupRanges(tree) {
  const ranges = [],
    pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const location = node.sourceCodeLocation;
    if (location && (node.nodeName === '#text' || node.nodeName === '#comment'))
      ranges.push({ start: location.startOffset, end: location.endOffset, text: true });
    for (const tag of [location?.startTag, location?.endTag])
      if (tag) ranges.push({ start: tag.startOffset, end: tag.endOffset, text: false });
    for (const child of node.childNodes ?? []) pending.push(child);
    if (node.content) pending.push(node.content);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The start offsets of the script elements of a tree; template contents (node.content) are not walked. */
function scriptStarts(tree) {
  const starts = new Set(),
    pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    const start = node.tagName === 'script' ? node.sourceCodeLocation?.startTag?.startOffset : undefined;
    if (start !== undefined) starts.add(start);
    for (const child of node.childNodes ?? []) pending.push(child);
  }
  return starts;
}

/** `html` with `text` inserted at `offset`. */
export const insertAt = (html, offset, text) => html.slice(0, offset) + text + html.slice(offset);

// The attribute names render-provenance.mjs scriptNonceInjectedAttribute issues.
const SCRIPT_MARKER = /^data-paqvilo-nonce-injected-[0-9a-f]{24}$/;

/**
 * The text an injector puts directly after `<script` in each script tag it writes: ` <marker>` for a response whose
 * rendered scripts were decided under a nonce policy (render-provenance.mjs nonceInjectedScripts gives the nonce to these
 * scripts only), else nothing.
 */
export function scriptMarker(marker) {
  if (!marker) return '';
  if (!SCRIPT_MARKER.test(marker)) throw new TypeError('Invalid injected script marker');
  return ` ${marker}`;
}
