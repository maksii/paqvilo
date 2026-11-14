import { parse } from 'parse5';
import { stripLiquidLiteralBlocks } from '../../mirage/lib/liquid-source.mjs';

const performanceReference =
  'https://github.com/microsoft/power-platform-skills/blob/2eb182a8b7a2faa65bb2363139763291c920fbf3/plugins/power-pages/skills/analyze-performance/references/performance-reference.md';

export const contentRules = [
  {
    id: 'content.image-alt',
    title: 'Image alternative text needs review',
    severity: 'hint',
    category: 'accessibility',
    confidence: 'medium',
    message: 'A static image tag has no alt attribute. Review its accessible alternative.',
    remediation:
      'Describe informative images in alt text; use alt="" for decorative images. Validate the rendered page with accessibility tooling.',
    references: ['https://www.w3.org/WAI/tutorials/images/decision-tree/'],
  },
  {
    id: 'content.blocking-head-script',
    title: 'Head script can delay rendering',
    severity: 'hint',
    category: 'performance',
    confidence: 'high',
    message: 'An external JavaScript tag in an explicit head has no async, defer or module behavior.',
    remediation: 'Review script dependencies before using defer, async or modules, then measure the rendered page.',
    references: [performanceReference, 'https://web.dev/articles/render-blocking-resources'],
  },
  {
    id: 'content.fetchxml-all-attributes',
    title: 'FetchXML retrieves all attributes',
    severity: 'warning',
    category: 'performance',
    confidence: 'high',
    message: 'A FetchXML query explicitly requests every attribute.',
    remediation: 'Select the columns required by the consumer and verify behavior with representative data.',
    references: [
      performanceReference,
      'https://learn.microsoft.com/power-apps/developer/data-platform/fetchxml/select-columns',
    ],
  },
  {
    id: 'content.fetchxml-unbounded',
    title: 'FetchXML result bound needs review',
    severity: 'hint',
    category: 'performance',
    confidence: 'medium',
    message: 'A non-aggregate FetchXML query has neither an explicit count nor top bound.',
    remediation:
      'Review result size and paging requirements. Use an appropriate page size and paging cookie or a deliberate total-result cap.',
    references: [
      performanceReference,
      'https://learn.microsoft.com/power-apps/developer/data-platform/fetchxml/page-results',
    ],
  },
  {
    id: 'content.fetchxml-in-loop',
    title: 'FetchXML inside a Liquid loop needs review',
    severity: 'hint',
    category: 'performance',
    confidence: 'medium',
    message: 'A FetchXML query occurs inside a Liquid for loop and may run for each iteration.',
    remediation:
      'Review whether the query can run once or use a join. Confirm data dependencies and measured behavior before rewriting it.',
    references: [performanceReference],
  },
  {
    id: 'content.css-import',
    title: 'Runtime CSS import needs review',
    severity: 'hint',
    category: 'performance',
    confidence: 'high',
    message: 'A runtime stylesheet contains an import that can serialize stylesheet downloads.',
    remediation:
      'Consider build-time bundling or an appropriate stylesheet link, preserving cascade order and verifying the rendered result.',
    references: [performanceReference, 'https://developer.mozilla.org/en-US/docs/Web/CSS/@import'],
  },
];

// Removing text rather than replacing it would make source offsets misleading.
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

function ignoredMarkupRange(node, length) {
  if (node.nodeName !== '#comment' && !['script', 'style', 'textarea', 'template'].includes(node.tagName)) return null;
  const range = node.sourceCodeLocation;
  return range ? [range.startOffset, range.endOffset > range.startOffset ? range.endOffset : length] : null;
}

function blockingHeadScript(node, attributes, inHead) {
  if (node.tagName !== 'script' || !inHead) return false;
  const type = (attributes.get('type') ?? '').trim().toLowerCase();
  const javascript = !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type);
  return javascript && attributes.get('src')?.trim() && !attributes.has('async') && !attributes.has('defer');
}

function emitMarkupDiagnostics(unit, emit, text, node, inHead) {
  const location = node.sourceCodeLocation?.startTag;
  if (!location || /{{|{%/.test(text.slice(location.startOffset, location.endOffset))) return;
  const attributes = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
  if (node.tagName === 'img' && !attributes.has('alt'))
    emit('content.image-alt', unit, undefined, location.startOffset);
  if (blockingHeadScript(node, attributes, inHead))
    emit('content.blocking-head-script', unit, undefined, location.startOffset);
}

function scanMarkup(unit, emit, text) {
  const document = parse(text, { sourceCodeLocationInfo: true });
  const queue = [{ node: document, explicitHead: false }];
  const ignoredRanges = [];
  while (queue.length) {
    const { node, explicitHead } = queue.pop();
    const location = node.sourceCodeLocation?.startTag;
    const inHead = explicitHead || (node.tagName === 'head' && Boolean(location));
    const range = ignoredMarkupRange(node, text.length);
    if (range) ignoredRanges.push(range);
    emitMarkupDiagnostics(unit, emit, text, node, inHead);
    // Template content is inert until instantiated; its accessibility is runtime work.
    for (const child of node.childNodes ?? []) queue.push({ node: child, explicitHead: inHead });
  }
  return maskRanges(text, ignoredRanges);
}

function maskRanges(text, ranges) {
  let from = 0;
  const parts = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start < from) continue;
    parts.push(text.slice(from, start), blank(text.slice(start, end)));
    from = end;
  }
  return parts.join('') + text.slice(from);
}

function attributesOf(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return attributes;
}

function liquidLoopTokens(source) {
  const tokens = [];
  for (let from = 0; from < source.length;) {
    const start = source.indexOf('{%', from);
    if (start < 0) break;
    const end = source.indexOf('%}', start + 2);
    if (end < 0) break;
    const tag = /^-?\s*(for|endfor)\b/i.exec(source.slice(start + 2, end));
    if (tag) tokens.push({ index: start, kind: tag[1].toLowerCase() });
    from = end + 2;
  }
  return tokens;
}

function* fetchQueries(source) {
  let opening;
  let nested = false;
  // Never search the remaining document repeatedly for a missing closing tag.
  for (const tag of source.matchAll(/<\/?fetch\b[^<>]*>/gi)) {
    if (!tag[0].startsWith('</')) {
      if (opening) nested = true;
      else opening = tag;
    } else if (opening) {
      if (!nested)
        yield {
          index: opening.index,
          attributes: opening[0].slice(6, -1),
          text: source.slice(opening.index, tag.index + tag[0].length),
        };
      opening = undefined;
      nested = false;
    }
  }
}

function scanFetchXml(unit, emit, source) {
  const loopTokens = liquidLoopTokens(source);
  let loopIndex = 0;
  let loopDepth = 0;
  for (const match of fetchQueries(source)) {
    while (loopIndex < loopTokens.length && loopTokens[loopIndex].index < match.index) {
      loopDepth = Math.max(0, loopDepth + (loopTokens[loopIndex].kind === 'for' ? 1 : -1));
      loopIndex += 1;
    }
    const attributes = attributesOf(match.attributes);
    // Dynamic attributes can supply bounds/aggregate behavior that source cannot resolve.
    const dynamic = /{{|{%/.test(match.attributes);
    if (/<all-attributes\b[^<>]*>/i.test(match.text) || /\ball-attributes\s*=\s*(["'])true\1/i.test(match.text)) {
      emit('content.fetchxml-all-attributes', unit, undefined, match.index);
    }
    if (
      !dynamic &&
      attributes.get('aggregate')?.toLowerCase() !== 'true' &&
      !attributes.has('count') &&
      !attributes.has('top')
    ) {
      emit('content.fetchxml-unbounded', unit, undefined, match.index);
    }
    if (loopDepth > 0) emit('content.fetchxml-in-loop', unit, undefined, match.index);
  }
}

function cssQuotedEnd(text, start) {
  let index = start + 1;
  while (index < text.length && text[index] !== text[start]) index += text[index] === '\\' ? 2 : 1;
  return Math.min(index + 1, text.length);
}

function scanCss(unit, emit, text) {
  const ranges = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (text[index] === '"' || text[index] === "'") {
      index = cssQuotedEnd(text, index);
    } else {
      index++;
      continue;
    }
    ranges.push([start, index]);
  }
  const source = maskRanges(text, ranges);
  for (const match of source.matchAll(/@import\b/gi)) emit('content.css-import', unit, undefined, match.index);
}

// Above this many unmatched open elements, parse5 tree building is too slow for the unit.
const MAX_UNMATCHED_ELEMENTS = 1000;
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const rawTextElements = new Set(['script', 'style']);

function commentEnd(text, tags) {
  const end = text.indexOf('-->', tags.lastIndex);
  // An unclosed comment runs to the end of the document.
  tags.lastIndex = end < 0 ? text.length : end + 3;
}

function rawTextEnd(text, tags, name) {
  const close = new RegExp(String.raw`</${name}(?=[\s/>])`, 'gi');
  close.lastIndex = tags.lastIndex;
  const match = close.exec(text);
  // The closing tag is read again by the tag scan; an unclosed raw-text element runs to the end.
  tags.lastIndex = match ? match.index : text.length;
}

function depthAfterTag(text, tags, match, depth) {
  if (match[0] === '<!--') {
    commentEnd(text, tags);
    return depth;
  }
  const name = match[2].toLowerCase();
  if (match[1]) return Math.max(0, depth - 1);
  if (rawTextElements.has(name)) rawTextEnd(text, tags, name);
  return voidElements.has(name) ? depth : depth + 1;
}

// One linear pass over the tags, so the budget check cannot itself become the slow step.
function unmatchedDepth(text) {
  const tags = /<!--|<(\/?)([a-z][a-z0-9-]*)(?=[\s/>])[^<>]*>/gi;
  let depth = 0;
  for (let match = tags.exec(text); match && depth <= MAX_UNMATCHED_ELEMENTS; match = tags.exec(text)) {
    depth = depthAfterTag(text, tags, match, depth);
  }
  return depth;
}

// Liquid runs on the server, so FetchXML bodies stay visible even where HTML masking hides their markup.
function liquidFetchXmlRanges(text) {
  const ranges = [];
  let start;
  for (const match of text.matchAll(/{%-?\s*(end)?fetchxml\b/gi)) {
    if (!match[1]) start ??= match.index;
    else if (start !== undefined) {
      ranges.push([start, match.index + match[0].length]);
      start = undefined;
    }
  }
  return ranges;
}

function restoreLiquidFetchXml(masked, text) {
  const parts = [];
  let from = 0;
  for (const [start, end] of liquidFetchXmlRanges(text)) {
    parts.push(masked.slice(from, start), text.slice(start, end));
    from = end;
  }
  parts.push(masked.slice(from));
  return parts.join('');
}

function scanHtml(unit, emit, text) {
  if (unmatchedDepth(text) > MAX_UNMATCHED_ELEMENTS) {
    // Without a parse tree, script and comment text cannot be separated from markup, so the raw source is scanned.
    scanFetchXml(unit, emit, text);
    return false;
  }
  scanFetchXml(unit, emit, restoreLiquidFetchXml(scanMarkup(unit, emit, text), text));
  return true;
}

/** Returns the units whose markup was skipped, so the caller can record why the web-content domain is incomplete. */
export function analyzeContent(units, emit) {
  const skipped = [];
  for (const unit of units) {
    const text = stripLiquidLiteralBlocks(unit.text);
    if (unit.kind === 'html') {
      if (!scanHtml(unit, emit, text)) skipped.push({ file: unit.file, reason: 'html-structure-budget' });
    } else if (unit.kind === 'css') {
      scanCss(unit, emit, text);
    }
  }
  return skipped;
}
