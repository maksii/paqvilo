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

function scanMarkup(unit, emit, text) {
  const document = parse(text, { sourceCodeLocationInfo: true });
  const queue = [{ node: document, explicitHead: false }];
  const ignoredRanges = [];
  while (queue.length) {
    const { node, explicitHead } = queue.pop();
    const location = node.sourceCodeLocation?.startTag;
    const inHead = explicitHead || (node.tagName === 'head' && Boolean(location));
    if (node.nodeName === '#comment' || ['script', 'style', 'textarea', 'template'].includes(node.tagName)) {
      const range = node.sourceCodeLocation;
      if (range)
        ignoredRanges.push([range.startOffset, range.endOffset > range.startOffset ? range.endOffset : text.length]);
    }
    const attributes = new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
    const dynamicTag = location && /{{|{%/.test(text.slice(location.startOffset, location.endOffset));
    if (node.tagName === 'img' && location && !dynamicTag && !attributes.has('alt')) {
      emit('content.image-alt', unit, undefined, location.startOffset);
    }
    if (node.tagName === 'script' && location && inHead && !dynamicTag) {
      const type = (attributes.get('type') ?? '').trim().toLowerCase();
      const javascript = !type || /^(?:text|application)\/(?:java|ecma)script$/.test(type);
      if (javascript && attributes.get('src')?.trim() && !attributes.has('async') && !attributes.has('defer')) {
        emit('content.blocking-head-script', unit, undefined, location.startOffset);
      }
    }
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
    if (/<all-attributes\b[^<>]*\/?\s*>/i.test(match.text) || /\ball-attributes\s*=\s*(["'])true\1/i.test(match.text)) {
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

function scanCss(unit, emit, text) {
  const ranges = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      while (index < text.length && text[index] !== quote) index += text[index] === '\\' ? 2 : 1;
      index = Math.min(index + 1, text.length);
    } else {
      index++;
      continue;
    }
    ranges.push([start, index]);
  }
  const source = maskRanges(text, ranges);
  for (const match of source.matchAll(/@import\b/gi)) emit('content.css-import', unit, undefined, match.index);
}

export function analyzeContent(units, emit) {
  for (const unit of units) {
    const text = stripLiquidLiteralBlocks(unit.text);
    if (unit.kind === 'html') {
      scanFetchXml(unit, emit, scanMarkup(unit, emit, text));
    } else if (unit.kind === 'css') {
      scanCss(unit, emit, text);
    }
  }
}
