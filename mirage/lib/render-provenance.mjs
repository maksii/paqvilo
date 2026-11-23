import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';

const buffers = new WeakMap();
const bindings = new WeakMap();
const objectSources = new WeakMap();
const PROVENANCE_ATTRIBUTE = 'data-paqvilo-source';

// What the toolkit adds to rendered portal output, shared by every live-versus-local comparison. Provenance annotations
// (data-paqvilo-source, data-paqvilo-script) sit on portal elements: the attribute is ignored and the element kept.
// Any other data-paqvilo-* attribute marks an element the toolkit injected (runtime and client scripts, form
// configuration, frame readiness, the PCF debugger), and data-sim-* attributes are local runtime annotations.
// Plain data, so in-page snapshot functions (page.evaluate) can receive the same definition.
export const TOOLKIT_MARKUP = Object.freeze({
  attributePattern: '^data-(?:paqvilo|sim)-',
  elementPattern: '^data-paqvilo-',
  annotations: Object.freeze([PROVENANCE_ATTRIBUTE, 'data-paqvilo-script']),
});
const toolkitAttribute = new RegExp(TOOLKIT_MARKUP.attributePattern, 'i'),
  toolkitElement = new RegExp(TOOLKIT_MARKUP.elementPattern, 'i');
/** True for an attribute only the toolkit adds to rendered markup. */
export const isToolkitAttribute = (name) => toolkitAttribute.test(name);
/** True for an element the toolkit injected, given its attribute names. */
export const isToolkitElement = (names) =>
  names.some((name) => toolkitElement.test(name) && !TOOLKIT_MARKUP.annotations.includes(name.toLowerCase()));
/** True for a response header only the local runtime sends: diagnostics, provenance, script proof and trace id. */
export const isToolkitHeader = (name) => /^x-(?:sim-|paqvilo-|trace-id$)/i.test(name);

export function scriptLineStarts(text, maxLines = 16384) {
  const lineStarts = [0];
  let truncated = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index);
    if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
      if (code === 13 && text.codePointAt(index + 1) === 10) index++;
      if (lineStarts.length >= maxLines) {
        truncated = true;
        break;
      }
      lineStarts.push(index + 1);
    }
  }
  return { lineStarts, linesTruncated: truncated };
}
function parsedInlineScript(raw, mappings) {
  const runs = [];
  let text = '',
    cursor = 0;
  for (const match of raw.matchAll(/\r\n?|\0/g)) {
    if (match.index > cursor) {
      runs.push({ start: cursor, end: match.index, generatedStart: text.length });
      text += raw.slice(cursor, match.index);
    }
    text += match[0] === '\0' ? '\uFFFD' : '\n';
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    runs.push({ start: cursor, end: raw.length, generatedStart: text.length });
    text += raw.slice(cursor);
  }
  const normalized = [];
  let mappingsTruncated = false;
  for (const mapping of mappings)
    for (const run of runs) {
      const start = Math.max(mapping.generatedStart, run.start),
        end = Math.min(mapping.generatedEnd, run.end);
      if (end <= start) continue;
      if (normalized.length >= 4096) {
        mappingsTruncated = true;
        continue;
      }
      normalized.push({
        ...mapping,
        generatedStart: run.generatedStart + start - run.start,
        generatedEnd: run.generatedStart + end - run.start,
        sourceStart: mapping.sourceStart + start - mapping.generatedStart,
        sourceEnd: mapping.sourceStart + end - mapping.generatedStart,
      });
    }
  return { text, mappings: normalized, mappingsTruncated };
}

// traces / span: the trace store and the page's render span; each invocation then opens a render-template span under the
// enclosing invocation's span (templateSpan), else under the render span.
export function createRenderTrace({
  sourceRevision = null,
  renderId = randomUUID(),
  limits = {},
  traces = null,
  span = null,
} = {}) {
  return {
    renderId,
    sourceRevision,
    traces,
    span,
    templateSpan: null,
    source: null,
    node: null,
    invocation: null,
    ordinal: 0,
    invocations: [],
    maxIntervals: limits.intervals ?? 50000,
    complete: true,
  };
}

function appendReplayRenderIntervals(state, trace) {
  // Text of another source that the code being rendered prints as it is (a snippet, a setting's value, a page copy
  // through an output): the place that printed it is that code, as the include tag is for an included template.
  const printed = new Map();
  const printedBy = (sourceRefId) => {
    if (!trace.source || !trace.invocation || !trace.node?.span || sourceRefId === trace.source.id) return null;
    if (!printed.has(sourceRefId)) {
      const callSite = renderCallSite({ source: trace.source, node: trace.node });
      let invocation = null;
      if (callSite && trace.invocations.length < trace.maxIntervals) {
        invocation = { id: ++trace.ordinal, parentId: trace.invocation.id, sourceRefId, callSite };
        trace.invocations.push(invocation);
      }
      printed.set(sourceRefId, invocation);
    }
    return printed.get(sourceRefId);
  };
  for (const original of state.replay.intervals) {
    if (state.intervals.length >= trace.maxIntervals) {
      trace.complete = false;
      break;
    }
    const invocation =
      original.mapping === 'literal' && original.invocationId == null && original.sourceRefId
        ? printedBy(original.sourceRefId)
        : null;
    const span = invocation ? { ...original, invocationId: invocation.id } : original;
    const recordContexts = trace.records?.length ? mergeRecordContexts(span.recordContexts, trace.records) : null;
    state.intervals.push({
      ...span,
      start: state.length + span.start,
      end: state.length + span.end,
      ...(recordContexts?.length ? { recordContexts } : {}),
    });
  }
}

/** Record contexts ({ sourceRefId }) of both lists, each source once, in order. */
export function mergeRecordContexts(...lists) {
  const seen = new Set(),
    merged = [];
  for (const list of lists)
    for (const context of list ?? [])
      if (context?.sourceRefId && !seen.has(context.sourceRefId)) {
        seen.add(context.sourceRefId);
        merged.push(context);
      }
  return merged;
}

// The source runs of a literal token's text ({ start, end } in the text, sourceStart in the parsed source), or null
// when the token's span does not account for every character of the text.
function literalRuns(span, text) {
  if (!span) return null;
  if (span.segments)
    return span.segments.reduce((total, run) => total + run.end - run.start, 0) === text.length &&
      span.segments.at(-1).end === text.length
      ? span.segments
      : null;
  return span.end - span.start === text.length ? [{ start: 0, end: text.length, sourceStart: span.start }] : null;
}

const IDENTITY_OFFSET_MAP = [{ start: 0, end: Number.MAX_SAFE_INTEGER, sourceStart: 0 }];

function appendMappedRenderIntervals(state, trace, text) {
  const span = trace.node.span;
  const runs = trace.node.mapping === 'literal' ? literalRuns(span, text) : null;
  const offsetMap = trace.source.offsetMap ?? (span?.segments ? IDENTITY_OFFSET_MAP : null);
  const maps =
    offsetMap && runs
      ? runs.flatMap((run) =>
          offsetMap.flatMap((map) => {
            const runEnd = run.sourceStart + run.end - run.start;
            const start = Math.max(run.sourceStart, map.start),
              end = Math.min(runEnd, map.end);
            return end > start
              ? [
                  {
                    start: state.length + run.start + start - run.sourceStart,
                    end: state.length + run.start + end - run.sourceStart,
                    sourceSpan: {
                      start: map.sourceStart + start - map.start,
                      end: map.sourceStart + end - map.start,
                    },
                  },
                ]
              : [];
          }),
        )
      : [{ start: state.length, end: state.length + text.length, sourceSpan: span }];
  const recordContexts = mergeRecordContexts(trace.records, trace.node.recordContexts);
  const records = recordContexts.length ? { recordContexts } : {};
  for (const mapped of maps)
    if (state.intervals.length < trace.maxIntervals)
      state.intervals.push({
        start: state.length,
        end: state.length + text.length,
        sourceRefId: trace.source.id,
        sourceSpan: trace.node.span,
        mapping: trace.node.mapping,
        invocationId: trace.invocation?.id,
        contributors: trace.node.contributors ?? [],
        ...records,
        ...mapped,
      });
    else trace.complete = false;
}

function appendRenderBufferValue(value, state, trace) {
  const text = String(value);
  if (state.replay) appendReplayRenderIntervals(state, trace);
  else if (trace.source && trace.node) appendMappedRenderIntervals(state, trace, text);
  // The data records the pushed text was rendered for (a loop item, a record member) name the elements a platform region
  // binds (withPlatformRegion); a replayed fragment brings the marks of its own rendering.
  if (state.replay?.marks?.length)
    for (const mark of state.replay.marks)
      state.marks.push({
        start: state.length + mark.start,
        end: state.length + mark.end,
        records: mergeRecordContexts(mark.records, trace.records),
      });
  else if (text && (trace.records?.length || trace.node?.recordContexts?.length))
    state.marks.push({
      start: state.length,
      end: state.length + text.length,
      records: mergeRecordContexts(trace.records, trace.node?.recordContexts),
    });
  state.length += text.length;
}

export function createRenderBuffer(context) {
  const trace = context?.provenance;
  const out = [];
  if (!trace) return out;
  const state = { trace, length: 0, intervals: [], replay: null, marks: [] };
  buffers.set(out, state);
  Object.defineProperty(out, 'push', {
    value(...values) {
      for (const value of values) appendRenderBufferValue(value, state, trace);
      return Array.prototype.push.apply(out, values);
    },
  });
  return out;
}
export function renderFragment(buffer) {
  return {
    text: buffer.join(''),
    intervals: buffers.get(buffer)?.intervals ?? [],
    complete: buffers.get(buffer)?.trace.complete ?? true,
    invocations: buffers.get(buffer)?.trace.invocations ?? [],
    ...(buffers.get(buffer)?.marks.length ? { marks: buffers.get(buffer).marks } : {}),
  };
}
export function appendRenderFragment(buffer, fragment) {
  const state = buffers.get(buffer);
  if (state) state.replay = fragment;
  try {
    buffer.push(fragment.text);
  } finally {
    if (state) state.replay = null;
  }
}

function renderCallSite(previous) {
  const callerSpan = previous.node?.span;
  const callerMap = previous.source?.offsetMap?.find(
    (map) => callerSpan && map.start <= callerSpan.start && map.end >= callerSpan.end,
  );
  if (previous.source?.offsetMap) {
    if (callerMap)
      return {
        start: callerMap.sourceStart + callerSpan.start - callerMap.start,
        end: callerMap.sourceStart + callerSpan.end - callerMap.start,
      };
    return null;
  }
  return callerSpan ?? null;
}

export async function withRenderSource(context, source, run) {
  const trace = context.provenance;
  if (!trace) return run();
  // The slot of the source this context renders (liquid.mjs renderSourceFragment), read by its first invocation only.
  const slot = context.renderSlot;
  context.renderSlot = null;
  const previous = {
    source: trace.source,
    node: trace.node,
    invocation: trace.invocation,
    templateSpan: trace.templateSpan,
  };
  const callSite = renderCallSite(previous);
  const invocation = {
    id: ++trace.ordinal,
    parentId: previous.invocation?.id ?? null,
    sourceRefId: source?.id ?? null,
    callSite,
  };
  if (trace.invocations.length < trace.maxIntervals) trace.invocations.push(invocation);
  else trace.complete = false;
  trace.source = source;
  trace.node = null;
  trace.invocation = invocation;
  // A source without a reference is named by its slot ('snippet Head/Bottom'); an empty source still gets its span (the
  // slot is real work), marked empty. Under an overflow handle (a full trace: traceId, no spanId) the store refuses the span.
  const parent = previous.templateSpan ?? trace.span;
  const sourceOrigin = () => {
    if (invocation.sourceRefId) return 'export';
    if (slot?.empty || slot?.missing) return 'missing';
    return 'built-in';
  };
  const span = parent?.traceId
    ? trace.traces.start({
        kind: 'render-template',
        name: source ? [source.kind, source.name].filter(Boolean).join(' ') || source.id : (slot?.name ?? 'template'),
        module: 'liquid',
        operation: 'render',
        parentSpanId: parent.spanId ?? null,
        traceId: parent.traceId,
        attributes: {
          sourceRefId: invocation.sourceRefId,
          // Where the template text came from (D-M-4, the Rendered tab): an exported source (resolvable through
          // /_sim/api/render-sources), a built-in template or layout, or a source the export lacks (an empty slot, a
          // missing include).
          sourceOrigin: sourceOrigin(),
          ...(callSite ? { callSite: `${callSite.start}-${callSite.end}` } : {}),
          ...(slot?.empty ? { empty: true } : {}),
        },
      })
    : null;
  if (span) trace.templateSpan = span;
  try {
    return await (span ? trace.traces.run(span, run) : run());
  } catch (error) {
    span?.fail(error);
    throw error;
  } finally {
    span?.end();
    Object.assign(trace, previous);
  }
}
export async function withRenderNode(context, span, mapping, run) {
  const trace = context.provenance;
  if (!trace) return run();
  const previous = trace.node;
  trace.node = { span, mapping };
  try {
    return await run();
  } finally {
    trace.node = previous;
  }
}
/** Appends `spans` to `target`, each moved `base` characters later. */
function pushShifted(target, spans, base) {
  for (const span of spans ?? []) target.push({ ...span, start: base + span.start, end: base + span.end });
}
export function joinRenderFragments(...parts) {
  let text = '';
  const intervals = [];
  let invocations = [];
  let complete = true;
  const marks = [];
  for (const part of parts) {
    if (typeof part === 'string') text += part;
    else if (part) {
      if (part.invocations?.length) invocations = part.invocations;
      if (part.complete === false) complete = false;
      pushShifted(intervals, part.intervals, text.length);
      pushShifted(marks, part.marks, text.length);
      text += part.text;
    }
  }
  return { text, intervals, invocations, complete, ...(marks.length ? { marks } : {}) };
}
/** A host edit preserves only the proved unchanged prefix/suffix, never a text-search reassociation. */
export function transformRenderFragment(fragment, text) {
  if (fragment.text === text) return fragment;
  let prefix = 0,
    suffix = 0;
  while (prefix < fragment.text.length && prefix < text.length && fragment.text[prefix] === text[prefix]) prefix++;
  while (
    suffix < fragment.text.length - prefix &&
    suffix < text.length - prefix &&
    fragment.text.at(-1 - suffix) === text.at(-1 - suffix)
  )
    suffix++;
  const delta = text.length - fragment.text.length;
  return {
    ...fragment,
    text,
    intervals: fragment.intervals.flatMap((span) => {
      if (span.end <= prefix) return [span];
      if (span.start >= fragment.text.length - suffix)
        return [{ ...span, start: span.start + delta, end: span.end + delta }];
      return [];
    }),
  };
}

function applyOneRenderEdit(result, edit) {
  const delta = edit.text.length - (edit.end - edit.start),
    intervals = [];
  for (const span of result.intervals) {
    if (span.end <= edit.start) intervals.push(span);
    else if (span.start >= edit.end) intervals.push({ ...span, start: span.start + delta, end: span.end + delta });
    else {
      if (span.start < edit.start)
        intervals.push({
          ...span,
          end: edit.start,
          sourceSpan: { ...span.sourceSpan, end: span.sourceSpan.start + edit.start - span.start },
        });
      if (span.end > edit.end)
        intervals.push({
          ...span,
          start: edit.start + edit.text.length,
          end: span.end + delta,
          sourceSpan: { ...span.sourceSpan, start: span.sourceSpan.start + edit.end - span.start },
        });
    }
  }
  for (const span of edit.intervals ?? [])
    intervals.push({ ...span, start: span.start + edit.start, end: span.end + edit.start });
  return { ...result, text: result.text.slice(0, edit.start) + edit.text + result.text.slice(edit.end), intervals };
}

export function applyRenderEdits(fragment, edits) {
  let result = fragment;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = applyOneRenderEdit(result, edit);
  return result;
}

// Elements whose content the HTML tokenizer reads as text (parse5 with scripting enabled), so a `<` inside is no tag.
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
]);
const isSpace = (char) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';

function scanAttributeValue(text, at) {
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, at + 1);
    return end < 0 ? null : { value: text.slice(at + 1, end), next: end + 1 };
  }
  let end = at;
  while (end < text.length && !isSpace(text[end]) && text[end] !== '>') end++;
  return { value: text.slice(at, end), next: end };
}

const skipSpaces = (text, from) => {
  let index = from;
  while (index < text.length && isSpace(text[index])) index++;
  return index;
};

// One attribute whose name starts at `at`: { name, value, next } (`next` follows the name or the value), or null when
// its quoted value is unterminated.
function scanAttribute(text, at) {
  let index = at + 1;
  while (index < text.length && !isSpace(text[index]) && !'/>='.includes(text[index])) index++;
  const name = text.slice(at, index).toLowerCase();
  let cursor = skipSpaces(text, index);
  if (text[cursor] !== '=') return { name, value: '', next: index };
  cursor = skipSpaces(text, cursor + 1);
  const scanned = scanAttributeValue(text, cursor);
  if (!scanned) return null;
  return { name, value: scanned.value, next: scanned.next };
}

// One start tag at `at` (text[at] is '<' followed by a letter): { start, end, tag, attributes }, or null when unterminated.
function scanStartTag(text, at) {
  let index = at + 1;
  while (index < text.length && !isSpace(text[index]) && text[index] !== '/' && text[index] !== '>') index++;
  const tag = text.slice(at + 1, index).toLowerCase(),
    attributes = [];
  for (;;) {
    while (index < text.length && (isSpace(text[index]) || text[index] === '/')) index++;
    if (index >= text.length) return null;
    if (text[index] === '>') return { start: at, end: index + 1, tag, attributes };
    const attribute = scanAttribute(text, index);
    if (!attribute) return null;
    attributes.push({ name: attribute.name, value: attribute.value });
    index = attribute.next;
  }
}

// Where the scan resumes after a comment, a declaration, a processing instruction or an end tag at `open`; -1 for a
// start tag candidate or a lone `<`.
function skipMarkup(text, open, next) {
  if (text.startsWith('<!--', open)) {
    const end = text.indexOf('-->', open + 4);
    return end < 0 ? text.length : end + 3;
  }
  if (next === '!' || next === '?' || next === '/') {
    const end = text.indexOf('>', open + 1);
    return end < 0 ? text.length : end + 1;
  }
  return -1;
}

// Where the scan resumes after a raw-text element's start tag: at its end tag, or the end of the text.
function rawTextEnd(text, tag, from) {
  const close = new RegExp(String.raw`</${tag}[\s/>]`, 'gi');
  close.lastIndex = from;
  const found = close.exec(text);
  return found ? found.index : text.length;
}

/** The start tags of HTML text as the HTML tokenizer reads them, outside comments and raw-text element content. */
export function scanStartTags(text) {
  const tags = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) break;
    const next = text[open + 1] ?? '';
    const skipped = skipMarkup(text, open, next);
    if (skipped >= 0) index = skipped;
    else if (/[A-Za-z]/.test(next)) {
      const tag = scanStartTag(text, open);
      if (!tag) break;
      tags.push(tag);
      index = RAW_TEXT_ELEMENTS.has(tag.tag) ? rawTextEnd(text, tag.tag, tag.end) : tag.end;
    } else index = open + 1;
  }
  return tags;
}

function lastStartingAtOrBefore(rows, offset) {
  let low = 0,
    high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].start <= offset) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

/**
 * Platform intervals ({ mapping: 'platform', start, end, tag, attributes, component, sourceRefIds, contextSourceRefId,
 * recordContexts }) for the start tags of `text` (at `offset` in the buffer) that the platform generated: every tag
 * whose opening `<` no interval of an exported source (and no inner platform region) already accounts for.
 * `platform` is { component, sourceRefIds?, contextSourceRefId?, recordContexts? } or a function of the scanned tag that
 * returns one (null leaves the tag unbound). `intervals` are the buffer's intervals over the text, `marks` its record
 * marks ({ start, end, records }).
 */
export function platformTagIntervals(text, platform, { offset = 0, intervals = [], marks = [] } = {}) {
  const tags = scanStartTags(text);
  const owned = new Set();
  for (const span of intervals) {
    if (span.mapping !== 'platform' && !span.sourceRefId) continue;
    let index = lastStartingAtOrBefore(tags, span.start - offset - 1) + 1;
    for (; index < tags.length && tags[index].start + offset < span.end; index++) owned.add(index);
  }
  const sortedMarks = [...marks].sort((a, b) => a.start - b.start);
  const result = [];
  tags.forEach((tag, index) => {
    if (owned.has(index)) return;
    const descriptor = typeof platform === 'function' ? platform(tag) : platform;
    if (!descriptor?.component?.key) return;
    const start = tag.start + offset;
    const at = lastStartingAtOrBefore(sortedMarks, start);
    const mark = sortedMarks[at];
    // Records whose values the start tag itself writes (an attribute value from a placement, an ad, a poll).
    const inner = [];
    for (let next = at + 1; next < sortedMarks.length && sortedMarks[next].start < tag.end + offset; next++)
      inner.push(sortedMarks[next].records);
    const recordContexts = mergeRecordContexts(
      descriptor.recordContexts,
      mark && mark.end > start ? mark.records : null,
      ...inner,
    );
    const id = tag.attributes.find((attribute) => attribute.name === 'id');
    result.push({
      start,
      end: tag.end + offset,
      mapping: 'platform',
      tag: tag.tag,
      attributes: id && !id.value.includes('&') ? [id] : [],
      component: descriptor.component,
      sourceRefIds: [...new Set((descriptor.sourceRefIds ?? []).filter(Boolean))],
      ...(descriptor.contextSourceRefId ? { contextSourceRefId: descriptor.contextSourceRefId } : {}),
      ...(recordContexts.length ? { recordContexts } : {}),
    });
  });
  return result;
}

/** A fragment of platform-generated markup: every start tag bound to the platform component that generated it. */
export function platformFragment(text, platform) {
  const value = String(text ?? '');
  return { text: value, intervals: value ? platformTagIntervals(value, platform) : [] };
}

/** The same fragment with platform intervals added for the start tags no exported source accounts for. */
export function withPlatformTags(fragment, platform) {
  const added = platformTagIntervals(fragment.text, platform, {
    intervals: fragment.intervals,
    marks: fragment.marks,
  });
  return added.length ? { ...fragment, intervals: [...fragment.intervals, ...added] } : fragment;
}

/**
 * Runs `run` (which renders into `out`) as a platform region: afterwards every start tag it wrote that no exported
 * source accounts for is bound to `platform` ({ component, sourceRefIds? } or a function of the tag). The context of a
 * region is the exported source that rendered it, or that of the enclosing region.
 */
export async function withPlatformRegion(context, out, platform, run) {
  const trace = context?.provenance,
    state = buffers.get(out);
  if (!trace || !state) return run();
  const startLength = state.length,
    startIndex = out.length,
    startIntervals = state.intervals.length,
    startMarks = state.marks.length;
  const contextSourceRefId = trace.source?.id ?? trace.platformContext ?? null;
  const previous = trace.platformContext;
  trace.platformContext = contextSourceRefId;
  try {
    return await run();
  } finally {
    trace.platformContext = previous;
    const text = out.slice(startIndex).join('');
    if (text.length === state.length - startLength) {
      const withContext = (descriptor) =>
        descriptor && !descriptor.contextSourceRefId && contextSourceRefId
          ? { ...descriptor, contextSourceRefId }
          : descriptor;
      const added = platformTagIntervals(
        text,
        typeof platform === 'function' ? (tag) => withContext(platform(tag)) : withContext(platform),
        { offset: startLength, intervals: state.intervals.slice(startIntervals), marks: state.marks.slice(startMarks) },
      );
      for (const span of added)
        if (state.intervals.length < trace.maxIntervals) state.intervals.push(span);
        else trace.complete = false;
    }
  }
}

const recordSources = new WeakMap();
/** Names the data records ({ sourceRefId }) an object of the Liquid model stands for (a web link, a page, a marker). */
export function setRecordSources(object, records) {
  const list = (records ?? []).filter((record) => record?.sourceRefId);
  if (object && typeof object === 'object' && list.length) recordSources.set(object, list);
}
export const recordSourcesOf = (object) =>
  object && typeof object === 'object' ? (recordSources.get(object) ?? null) : null;

/** Runs `run` with `records` added to the data records the current output is rendered for. */
export async function withRenderRecords(context, records, run) {
  const trace = context?.provenance;
  if (!trace || !records?.length) return run();
  const previous = trace.records;
  trace.records = mergeRecordContexts(previous, records);
  try {
    return await run();
  } finally {
    trace.records = previous;
  }
}

/**
 * The one edit ({ start, end, text } in `before`) that turns `before` into `after`, for a host change of one contiguous
 * region (an inserted or replaced element). The unchanged prefix ends after a tag's `>` and the unchanged suffix starts
 * at a `<`, so an edit never splits a start tag between old and new markup (an inserted `<li>` before an existing
 * `<li>` is the inserted element, not a rotation of the two).
 */
export function markupEdit(before, after) {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  if (prefix === before.length && prefix === after.length) return null;
  while (prefix > 0 && before[prefix - 1] !== '>') prefix--;
  let suffix = 0;
  while (suffix < limit - prefix && before.at(-1 - suffix) === after.at(-1 - suffix)) suffix++;
  while (suffix > 0 && before[before.length - suffix] !== '<') suffix--;
  return { start: prefix, end: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
}
export function setBindingFragment(scope, name, fragment) {
  if (!bindings.has(scope)) bindings.set(scope, new Map());
  if (fragment) bindings.get(scope).set(String(name).toLowerCase(), fragment);
  else bindings.get(scope).delete(String(name).toLowerCase());
}
export function getBindingFragment(context, name) {
  if (!/^[\w-]+$/.test(name ?? '')) return null;
  for (const scope of context.scopes) if (scope.has(name)) return bindings.get(scope)?.get(name.toLowerCase()) ?? null;
  return null;
}
export function setObjectSource(object, properties, source) {
  if (!source) return;
  if (!objectSources.has(object)) objectSources.set(object, new Map());
  for (const property of properties) objectSources.get(object).set(property, source);
}
export function objectSourceFragment(object, property, value) {
  const source = objectSources.get(object)?.get(property);
  if (!source || typeof value !== 'string' || (source.renderedText ?? source.text) !== value) return null;
  const offsets = source.offsetMap ?? [{ start: 0, end: value.length, sourceStart: 0 }];
  return {
    text: value,
    intervals: offsets.map((offset) => ({
      start: offset.start,
      end: offset.end,
      sourceRefId: source.id,
      sourceSpan: { start: offset.sourceStart, end: offset.sourceStart + offset.end - offset.start },
      mapping: 'literal',
    })),
  };
}
export const getObjectSource = (object, property) => objectSources.get(object)?.get(property) ?? null;

function overlappingIntervals(intervals, start, end) {
  let low = 0,
    high = intervals.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (intervals[mid].end <= start) low = mid + 1;
    else high = mid;
  }
  const result = [];
  for (let i = low; i < intervals.length && intervals[i].start < end; i++) result.push(intervals[i]);
  return result;
}

function addRenderBinding(state, binding, inertTemplateId) {
  state.entries.push({ ...binding, ...(inertTemplateId ? { inertTemplateId } : {}) });
}

function isExecutableInlineScript(node, inertTemplateId, location, endTag) {
  return (
    node.tagName === 'script' &&
    !inertTemplateId &&
    location &&
    endTag &&
    !node.attrs.some((attr) => attr.name === 'src') &&
    /^(?:module|(?:text|application)\/(?:java|ecma)script)?$/i.test(
      node.attrs.find((attr) => attr.name === 'type')?.value ?? '',
    )
  );
}

function collectInlineScriptMappings(state, start, end) {
  const mappings = [];
  for (const span of overlappingIntervals(state.intervals, start, end)) {
    if (span.mapping !== 'literal' || !span.sourceSpan) continue;
    const source = state.index.sources.get(span.sourceRefId),
      mappedStart = Math.max(start, span.start),
      mappedEnd = Math.min(end, span.end);
    const sourceStart = span.sourceSpan.start + mappedStart - span.start,
      sourceEnd = sourceStart + mappedEnd - mappedStart;
    if (
      !source ||
      source.ambiguous ||
      state.fragment.text.slice(mappedStart, mappedEnd) !== source.text.slice(sourceStart, sourceEnd)
    )
      continue;
    mappings.push({
      generatedStart: mappedStart - start,
      generatedEnd: mappedEnd - start,
      sourceRefId: source.id,
      sourceStart,
      sourceEnd,
    });
    const { text: _text, file: _file, sourceDir: _root, ...ref } = source; // NOSONAR: binding is excluded from the rest object or is a placeholder
    state.refs.set(ref.id, ref);
  }
  return mappings;
}

function addInlineScriptDebugUrl(script, body, mappings, index) {
  const debugUrl = [...body.matchAll(/(?:^|\n)\/\/# sourceURL=(\S+)/g)].at(-1)?.[1];
  if (!debugUrl) return;
  try {
    const url = new URL(debugUrl);
    if (
      url.protocol === 'file:' &&
      (!url.search || /^\?inline=\d+$/.test(url.search)) &&
      mappings.some((mapping) => {
        const file = index.sources.get(mapping.sourceRefId)?.file;
        return file && pathToFileURL(file).pathname === url.pathname;
      })
    ) {
      script.debugUrl = url.href.split('?')[0];
      script.debugUrlKey = createHash('sha256').update(debugUrl).digest('hex');
    }
  } catch {
    /* An authored URL cannot grant a local source mapping. */
  }
}

function processInlineScriptNode(node, location, endTag, inertTemplateId, state) {
  if (!isExecutableInlineScript(node, inertTemplateId, location, endTag)) return true;
  const body = state.fragment.text.slice(location.endOffset, endTag.startOffset),
    mappings = collectInlineScriptMappings(state, location.endOffset, endTag.startOffset);
  if (!mappings.length) return true;
  // A document can hold more inline scripts than this many proofs: the rest run without one, and the proof says so.
  if (state.scripts.length >= 128) {
    state.scriptProofsOmitted++;
    return true;
  }
  const id = state.proofId + ':script:' + state.scripts.length;
  const parsed = parsedInlineScript(body, mappings);
  const actualText = (node.childNodes ?? []).map((child) => (child.nodeName === '#text' ? child.value : '')).join('');
  if (actualText !== parsed.text) return false;
  const script = {
    id,
    generatedHash: createHash('sha256').update(parsed.text, 'utf8').digest('hex'),
    hashAlgorithm: 'sha256-utf8',
    mappings: parsed.mappings,
    mappingsTruncated: parsed.mappingsTruncated,
    ...scriptLineStarts(parsed.text),
  };
  addInlineScriptDebugUrl(script, body, mappings, state.index);
  state.scripts.push(script);
  const existing = node.sourceCodeLocation.attrs?.['data-paqvilo-script'];
  if (existing) state.edits.push({ start: existing.startOffset, end: existing.endOffset, text: '' });
  const at = location.endOffset - 1;
  state.edits.push({ start: at, end: at, text: ` data-paqvilo-script="${id}"` });
  return true;
}

// A document can hold more elements than this many bindings: the rest stay unbound and the proof says it is incomplete.
const MAX_BINDINGS = 20000;
const RELEVANT_ATTRIBUTE =
  /^(?:id|name|type|data-(?:entityname|formid|viewid|listid|control-id|control-name|pcf-schema|pcf-control|pcf-name))$/;

/**
 * Where the marker attribute goes: before the `>` of the start tag, and before a solidus that closes the tag
 * (`<br/>`, `<img src="x" />`). A solidus that ends an unquoted attribute value (`<a href=/contact/>`) belongs to the
 * value: a marker put in front of it would change the value.
 */
function markerOffset(node, location, text) {
  const close = location.endOffset - 1;
  if (text[close - 1] !== '/') return close;
  for (const attribute of Object.values(node.sourceCodeLocation.attrs ?? {}))
    if (attribute.endOffset === close) return close;
  return close - 1;
}

// One id per bound element of a document: 64 random bits in base64url (11 characters, never a `:`, so never equal to
// a script proof's or a local head asset's id). Nothing in it is sequential or shared with another element, so the id
// one element carries says nothing about the id of any other. The bits are drawn in batches of BINDING_ID_BATCH ids
// (one call per 2048 elements), and an id is never handed out twice in one document.
const BINDING_ID_BYTES = 8,
  BINDING_ID_BATCH = 2048;
const nextBindingId = (state) => {
  const at = state.ordinal++ % BINDING_ID_BATCH;
  if (at === 0) state.bindingIdBytes = randomBytes(BINDING_ID_BYTES * BINDING_ID_BATCH);
  state.bindingIds ??= new Set();
  let id = state.bindingIdBytes.toString('base64url', at * BINDING_ID_BYTES, (at + 1) * BINDING_ID_BYTES);
  while (state.bindingIds.has(id)) id = randomBytes(BINDING_ID_BYTES).toString('base64url');
  state.bindingIds.add(id);
  return id;
};

function stampNode(node, location, state, id) {
  const existing = node.sourceCodeLocation.attrs?.[PROVENANCE_ATTRIBUTE];
  if (existing) state.edits.push({ start: existing.startOffset, end: existing.endOffset, text: '' });
  const at = markerOffset(node, location, state.fragment.text);
  state.edits.push({ start: at, end: at, text: ` ${PROVENANCE_ATTRIBUTE}="${id}"` });
}

function rememberSourceRef(state, source) {
  const { text: _text, file: _file, sourceDir: _root, ...ref } = source; // NOSONAR: binding is excluded from the rest object or is a placeholder
  state.refs.set(source.id, ref);
}

/**
 * The data records behind what the spans wrote (a web link, a site marker, a page of the breadcrumb, a website
 * language): named beside the source as context of the binding just added.
 */
function addRecordContexts(state, spans) {
  const entry = state.entries.at(-1);
  const seen = new Set((entry.contexts ?? []).map((context) => context.sourceRefId));
  for (const span of spans)
    for (const record of span.recordContexts ?? []) {
      const source = state.index.sources.get(record.sourceRefId);
      if (!source || seen.has(source.id) || seen.size >= 24) continue;
      seen.add(source.id);
      entry.contexts ??= [];
      entry.contexts.push({ sourceRefId: source.id, relationship: 'data-record' });
      rememberSourceRef(state, source);
    }
}

/** A region of a source with its 1-based line and column, from line starts computed once per source. */
function sourceRegion(state, source, start, end) {
  let starts = state.lineStarts.get(source.id);
  if (!starts) {
    starts = [0];
    for (const match of source.text.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
    state.lineStarts.set(source.id, starts);
  }
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= start) low = middle;
    else high = middle - 1;
  }
  return { start, end, line: low + 1, column: start - starts[low] + 1 };
}

function bindPlatformNode(node, location, contributing, inertTemplateId, state) {
  const platforms = contributing.filter(
    (span) =>
      span.mapping === 'platform' &&
      span.start === location.startOffset &&
      span.end === location.endOffset &&
      // parse5 gives SVG elements their mixed-case names (foreignObject); the producer names the tag as written.
      String(span.tag).toLowerCase() === node.tagName.toLowerCase(),
  );
  if (state.channel !== 'mirage-render' || platforms.length !== 1) return false;
  const span = platforms[0],
    attributes = span.attributes ?? [],
    sourceIds = (span.sourceRefIds ?? []).filter((id) => state.index.sources.has(id));
  if (
    !span.component?.key ||
    !attributes.every((attribute) =>
      node.attrs.some((actual) => actual.name === attribute.name && actual.value === attribute.value),
    )
  )
    return false;
  const id = nextBindingId(state);
  // The Liquid tag of the hosting source that rendered the component (its entityform, entitylist or include tag),
  // as the renderer recorded it. The component's configuration is its source; this is the place in a template or
  // page copy that asks for it.
  const host = span.host && state.index.sources.has(span.host.sourceRefId) ? span.host : null;
  const hostContext = host
    ? {
        sourceRefId: host.sourceRefId,
        region: sourceRegion(state, state.index.sources.get(host.sourceRefId), host.start, host.end),
      }
    : null;
  const contexts = [];
  if (span.contextSourceRefId)
    contexts.push(
      hostContext && hostContext.sourceRefId === span.contextSourceRefId
        ? hostContext
        : { sourceRefId: span.contextSourceRefId },
    );
  if (hostContext && hostContext.sourceRefId !== span.contextSourceRefId) contexts.push(hostContext);
  addRenderBinding(
    state,
    {
      id,
      tag: node.tagName,
      attributes,
      mapping: 'platform',
      component: span.component,
      sourceRefIds: sourceIds,
      ...(contexts.length ? { contexts } : {}),
    },
    inertTemplateId,
  );
  for (const sourceId of [...sourceIds, span.contextSourceRefId, hostContext?.sourceRefId].filter(Boolean)) {
    const source = state.index.sources.get(sourceId);
    if (source) rememberSourceRef(state, source);
  }
  addRecordContexts(state, [span]);
  stampNode(node, location, state, id);
  return true;
}

function isExactLiteralSource(span, location, state) {
  const source = state.index.sources.get(span.sourceRefId);
  const sourceStart = span.sourceSpan?.start + location.startOffset - span.start;
  return Boolean(
    source &&
    !source.ambiguous &&
    Number.isSafeInteger(sourceStart) &&
    source.text.slice(sourceStart, sourceStart + location.endOffset - location.startOffset) ===
      state.fragment.text.slice(location.startOffset, location.endOffset),
  );
}

function addLiteralInvocationContexts(span, state) {
  const contexts = [];
  let invocation = state.invocations.get(span.invocationId);
  const seen = new Set();
  while (invocation?.parentId && contexts.length < 16 && !seen.has(invocation.parentId)) {
    seen.add(invocation.parentId);
    const parent = state.invocations.get(invocation.parentId);
    const contextSource = parent && state.index.sources.get(parent.sourceRefId);
    if (contextSource) {
      contexts.push({ sourceRefId: contextSource.id, region: invocation.callSite, invocationId: parent.id });
      const { text: _text, file: _file, sourceDir: _root, ...ref } = contextSource; // NOSONAR: binding is excluded from the rest object or is a placeholder
      state.refs.set(ref.id, ref);
    }
    invocation = parent;
  }
  if (contexts.length) state.entries.at(-1).contexts = contexts;
}

function bindLiteralNode(node, location, contributing, inertTemplateId, state, enabled) {
  const spans = contributing.filter(
    (span) => span.start <= location.startOffset && span.end >= location.endOffset && span.mapping === 'literal',
  );
  if (!enabled || spans.length !== 1) return false;
  const span = spans[0];
  if (!isExactLiteralSource(span, location, state)) return false;
  const source = state.index.sources.get(span.sourceRefId);
  const sourceStart = span.sourceSpan?.start + location.startOffset - span.start;
  const id = nextBindingId(state);
  const attrs = (node.attrs ?? []).filter((a) => RELEVANT_ATTRIBUTE.test(a.name));
  const region = sourceRegion(state, source, sourceStart, sourceStart + location.endOffset - location.startOffset);
  addRenderBinding(
    state,
    {
      id,
      tag: node.tagName,
      attributes: attrs,
      sourceRefId: source.id,
      region,
      invocationId: span.invocationId,
      mapping: 'literal',
    },
    inertTemplateId,
  );
  addLiteralInvocationContexts(span, state);
  addRecordContexts(state, [span]);
  rememberSourceRef(state, source);
  stampNode(node, location, state, id);
  return true;
}

/**
 * A start tag one source wrote with Liquid inside it (`<a href="{{ url }}" class="x">`): its first and last
 * characters are literals of the same source in the same invocation, and everything between them came from that
 * source's own Liquid code. The tag is that source's tag: the region runs from its `<` to its `>` in the file.
 */
function bindTemplateTagNode(node, location, contributing, inertTemplateId, state) {
  if (contributing.length < 2) return false;
  const first = contributing[0],
    last = contributing.at(-1);
  if (first.mapping !== 'literal' || last.mapping !== 'literal' || !first.sourceSpan || !last.sourceSpan) return false;
  if (first.start > location.startOffset || last.end < location.endOffset) return false;
  const source = state.index.sources.get(first.sourceRefId);
  if (!source || source.ambiguous) return false;
  for (let i = 0; i < contributing.length; i++) {
    const span = contributing[i];
    if (span.sourceRefId !== first.sourceRefId || span.invocationId !== first.invocationId) return false;
    // Output without an interval between two spans has no known writer.
    if (i > 0 && span.start > contributing[i - 1].end) return false;
  }
  const text = state.fragment.text;
  const head = text.slice(location.startOffset, first.end),
    headStart = first.sourceSpan.start + location.startOffset - first.start;
  const tail = text.slice(last.start, location.endOffset),
    tailStart = last.sourceSpan.start;
  if (
    !Number.isSafeInteger(headStart) ||
    !Number.isSafeInteger(tailStart) ||
    tailStart + tail.length <= headStart ||
    source.text.slice(headStart, headStart + head.length) !== head ||
    source.text.slice(tailStart, tailStart + tail.length) !== tail
  )
    return false;
  const id = nextBindingId(state);
  addRenderBinding(
    state,
    {
      id,
      tag: node.tagName,
      attributes: [],
      sourceRefId: source.id,
      region: sourceRegion(state, source, headStart, tailStart + tail.length),
      invocationId: first.invocationId,
      mapping: 'literal',
      dynamic: true,
    },
    inertTemplateId,
  );
  addLiteralInvocationContexts(first, state);
  addRecordContexts(state, contributing);
  rememberSourceRef(state, source);
  stampNode(node, location, state, id);
  return true;
}

function bindDerivedNode(node, location, contributing, inertTemplateId, state) {
  if (state.channel !== 'mirage-render') return false;
  const known = contributing.filter((span) => state.index.sources.has(span.sourceRefId));
  const contributors = [
    ...new Set(
      contributing
        .flatMap((span) => [span.sourceRefId, ...(span.contributors ?? [])])
        .filter((id) => state.index.sources.has(id)),
    ),
  ];
  if (!contributors.length) return false;
  const id = nextBindingId(state);
  const conflicting = contributors.some((sourceId) => state.index.sources.get(sourceId)?.ambiguous);
  // One source's Liquid code wrote the whole start tag: the region is that code (an output, a tag, a filter chain).
  const writers = new Set(known.map((span) => span.sourceRefId));
  const writer = writers.size === 1 ? state.index.sources.get(known[0].sourceRefId) : null;
  const spans = known.map((span) => span.sourceSpan).filter(Boolean);
  const located =
    !conflicting &&
    writer &&
    spans.length === known.length &&
    spans.every((span) => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end));
  addRenderBinding(
    state,
    {
      id,
      tag: node.tagName,
      attributes: (node.attrs ?? []).filter((a) => /^(?:id|name|type)$/.test(a.name)),
      mapping: conflicting ? 'conflicting' : 'derived',
      sourceRefIds: contributors,
      ...(located
        ? {
            sourceRefId: writer.id,
            region: sourceRegion(
              state,
              writer,
              Math.min(...spans.map((span) => span.start)),
              Math.max(...spans.map((span) => span.end)),
            ),
          }
        : {}),
    },
    inertTemplateId,
  );
  if (located && known[0].invocationId != null) addLiteralInvocationContexts(known[0], state);
  addRecordContexts(state, contributing);
  for (const sourceId of contributors) rememberSourceRef(state, state.index.sources.get(sourceId));
  stampNode(node, location, state, id);
  return true;
}

/** The binding of a served node by the caller's mapping, or null (adding the sources it names to `used`). */
function servedBinding(node, served, id, sourceOf, used, state) {
  if (served.mapping === 'aligned' || served.mapping === 'generated' || served.mapping === 'drift')
    return servedSourceBinding(node, served, id, sourceOf, used, state);
  if (served.mapping === 'conflict') return servedConflictBinding(node, served, id, sourceOf, used);
  if (served.mapping === 'shell')
    return {
      id,
      tag: node.tagName,
      attributes: [],
      mapping: 'platform',
      origin: 'served',
      component: { kind: 'platform-shell', key: 'platform-shell:page', name: 'Page shell' },
      sourceRefIds: [],
    };
  return null;
}

// A served node aligned with one exported source region: literal when the text matches, else derived or drifted.
function servedSourceBinding(node, served, id, sourceOf, used, state) {
  const source = sourceOf(served.sourceRefId);
  if (!source || !served.region) return null;
  used.push(source);
  const region = sourceRegion(state, source, served.region.start, served.region.end);
  return served.mapping === 'aligned'
    ? {
        id,
        tag: node.tagName,
        attributes: (node.attrs ?? []).filter((a) => RELEVANT_ATTRIBUTE.test(a.name)),
        sourceRefId: source.id,
        region,
        mapping: 'literal',
        origin: 'served',
        ...(served.placement ? { placement: served.placement } : {}),
        ...(served.dynamic ? { dynamic: true } : {}),
        ...(served.oneOf ? { oneOf: served.oneOf } : {}),
      }
    : {
        id,
        tag: node.tagName,
        attributes: [],
        sourceRefId: source.id,
        sourceRefIds: [source.id],
        region,
        mapping: 'derived',
        origin: 'served',
        ...(served.liquid?.length ? { liquid: served.liquid } : {}),
        // The served document holds this element where the local source holds nothing: the deployed copy differs.
        ...(served.mapping === 'drift' ? { drift: true } : {}),
      };
}

// A served node that two or more exported sources claim.
function servedConflictBinding(node, served, id, sourceOf, used) {
  const sources = (served.sourceRefIds ?? []).map(sourceOf).filter(Boolean);
  if (sources.length < 2) return null;
  used.push(...sources);
  return {
    id,
    tag: node.tagName,
    attributes: [],
    mapping: 'conflicting',
    origin: 'served',
    sourceRefIds: sources.map((source) => source.id),
  };
}

/** The contexts of a served node that name an exported source and region (adding those sources to `used`). */
function servedContexts(served, sourceOf, used, state) {
  const contexts = [];
  for (const context of served.contexts ?? []) {
    const source = sourceOf(context.sourceRefId);
    if (!source || !context.region) continue;
    used.push(source);
    contexts.push({
      sourceRefId: source.id,
      region: sourceRegion(state, source, context.region.start, context.region.end),
    });
  }
  return contexts;
}

/**
 * A binding the caller worked out for this start tag by other means than render intervals (Lense aligning a served
 * live document with the export, lense/response-alignment.mjs). `tagBindings` maps a start tag's offset to
 * `{ end, tag, mapping, ... }`; the tag must be exactly the one the caller saw.
 */
function bindServedNode(node, location, inertTemplateId, state) {
  const served = state.tagBindings?.get(location.startOffset);
  if (!served || served.end !== location.endOffset || served.tag !== node.tagName.toLowerCase()) return false;
  const sourceOf = (sourceRefId) => {
    const source = state.index.sources.get(sourceRefId);
    return source && !source.ambiguous ? source : null;
  };
  const id = nextBindingId(state);
  const used = [];
  const binding = servedBinding(node, served, id, sourceOf, used, state);
  if (!binding) return false;
  const contexts = servedContexts(served, sourceOf, used, state);
  if (contexts.length) binding.contexts = contexts;
  addRenderBinding(state, binding, inertTemplateId);
  for (const source of used) rememberSourceRef(state, source);
  stampNode(node, location, state, id);
  return true;
}

function visitRenderNode(node, inertTemplateId, state, inert) {
  const location = node.sourceCodeLocation?.startTag,
    endTag = node.sourceCodeLocation?.endTag;
  // A script inside a template element is not run when the document loads, bound template or not.
  if (!processInlineScriptNode(node, location, endTag, inertTemplateId ?? (inert ? 'inert' : null), state)) return;
  if (!location || !node.tagName) return;
  const contributing = overlappingIntervals(state.intervals, location.startOffset, location.endOffset);
  if (state.entries.length >= MAX_BINDINGS) {
    state.complete = false;
    state.omitted++;
    return;
  }
  let bound = bindPlatformNode(node, location, contributing, inertTemplateId, state);
  if (!bound) bound = bindLiteralNode(node, location, contributing, inertTemplateId, state, true);
  if (!bound) bound = bindTemplateTagNode(node, location, contributing, inertTemplateId, state);
  if (!bound) bound = bindServedNode(node, location, inertTemplateId, state);
  if (!bound) bound = bindDerivedNode(node, location, contributing, inertTemplateId, state);
  if (!bound) state.unbound++;
}

/**
 * Finalize only after Liquid evaluation. No wrappers and no parse/serialize rewriting.
 * `tagBindings` (optional) carries bindings found outside the render trace, by start-tag offset; see bindServedNode.
 */
export function finalizePortalProvenance({
  fragment,
  index,
  proofId = randomUUID(),
  channel = 'mirage-render',
  tagBindings = null,
}) {
  const tree = parse(fragment.text, { sourceCodeLocationInfo: true });
  const edits = [],
    entries = [],
    scripts = [];
  const refs = new Map();
  const invocations = new Map((fragment.invocations ?? []).map((item) => [item.id, item]));
  const intervals = [...fragment.intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const state = {
    fragment,
    index,
    edits,
    entries,
    scripts,
    refs,
    invocations,
    intervals,
    proofId,
    channel,
    tagBindings,
    ordinal: 0,
    lineStarts: new Map(),
    // Elements left without a binding: none could be made (unbound) or the binding limit was reached (omitted).
    unbound: 0,
    omitted: 0,
    scriptProofsOmitted: 0,
    complete: fragment.complete !== false,
  };
  const pending = [{ node: tree, inertTemplateId: null, inert: false }];
  while (pending.length) {
    const { node, inertTemplateId, inert } = pending.pop(),
      previous = entries.length;
    visitRenderNode(node, inertTemplateId, state, inert);
    for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--)
      pending.push({ node: node.childNodes[i], inertTemplateId, inert });
    // The content of a template element: bound to the template element's own identity when it has one. A template
    // element without a binding (its tag came from a source the export does not hold) still has content to name.
    // A template that declares a shadow root is not held back: the parser attaches its content to the host as a
    // shadow tree, where it is live markup like any other (its scripts run).
    const shadowMode = node.content
      ? ((node.attrs ?? []).find((attr) => attr.name === 'shadowrootmode')?.value ?? '').toLowerCase()
      : '';
    if (shadowMode === 'open') pending.push({ node: node.content, inertTemplateId, inert });
    // A closed shadow root is a boundary nothing outside its component reads: its content gets no marks, which only
    // the component itself could see.
    else if (shadowMode === 'closed') continue;
    else if (node.content)
      pending.push({
        node: node.content,
        inertTemplateId: entries.length > previous ? entries.at(-1).id : inertTemplateId,
        inert: true,
      });
  }
  let html = fragment.text;
  for (const edit of edits.sort(/* NOSONAR: preserve in-place sorting */ (a, b) => b.start - a.start))
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end);
  const result = {
    html,
    provenance: {
      version: 1,
      channel,
      proofId,
      sourceRevision: index.sourceRevision,
      bindings: entries,
      sourceRefs: [...refs.values()],
      scriptProofs: scripts,
      complete: state.complete,
      unbound: state.unbound,
      omitted: state.omitted,
      ...(state.scriptProofsOmitted ? { scriptProofsOmitted: state.scriptProofsOmitted } : {}),
    },
  };
  result.provenance = refreshScriptProofLocations(html, result.provenance);
  return result;
}

/** Revalidate known script identities after explicit host HTML edits; never search by source text. */
function indexScriptNode(node, nodes) {
  if (node.tagName !== 'script') return;
  const id = node.attrs.find((attr) => attr.name === 'data-paqvilo-script')?.value;
  if (id) nodes.set(id, nodes.has(id) ? null : node);
}

function refreshedScriptProof(script, nodes) {
  const node = nodes.get(script.id),
    start = node?.sourceCodeLocation?.startTag,
    end = node?.sourceCodeLocation?.endTag;
  if (!start || !end) return null;
  const actualText = (node.childNodes ?? []).map((child) => (child.nodeName === '#text' ? child.value : '')).join('');
  if (createHash('sha256').update(actualText, 'utf8').digest('hex') !== script.generatedHash) return null;
  return {
    ...script,
    documentStart: { line: start.endLine - 1, column: start.endCol - 1 },
    documentEnd: { line: end.startLine - 1, column: end.startCol - 1 },
  };
}

export function refreshScriptProofLocations(html, proof) {
  if (!proof.scriptProofs?.length) return proof;
  const nodes = new Map(),
    tree = parse(html, { sourceCodeLocationInfo: true }),
    pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    indexScriptNode(node, nodes);
    for (const child of node.childNodes ?? []) pending.push(child);
    // A script of a declared shadow root has a proof and stands in its template's content.
    if (node.content) pending.push(node.content);
  }
  const scripts = [];
  for (const script of proof.scriptProofs) {
    const refreshed = refreshedScriptProof(script, nodes);
    if (refreshed) scripts.push(refreshed);
  }
  return { ...proof, scriptProofs: scripts };
}

/**
 * Appends component output that the current node rendered (a Liquid component tag): the interval the node's own output
 * gets (as a plain push records it, so the hosting source stays attributed) and, over it, the fragment's intervals
 * (platform intervals of the component's elements, literal intervals of exported text inside it).
 */
export function appendHostedRenderFragment(buffer, fragment) {
  const state = buffers.get(buffer);
  if (state?.trace.source && state.trace.node) appendMappedRenderIntervals(state, state.trace, fragment.text);
  appendRenderFragment(buffer, fragment);
}

/**
 * applyRenderEdits for edits that remove or replace text inside start tags (an attribute the host moves elsewhere): a
 * platform interval that contains an edit keeps covering its, now shorter or longer, start tag; every other interval is
 * cut around the edit. Edits are { start, end, text } in the fragment's text and must not overlap.
 */
export function applyElementRenderEdits(fragment, edits) {
  let intervals = fragment.intervals ?? [],
    marks = fragment.marks ?? null,
    text = fragment.text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    const delta = edit.text.length - (edit.end - edit.start);
    intervals = intervals.flatMap((span) => {
      if (span.end <= edit.start) return [span];
      if (span.start >= edit.end) return [{ ...span, start: span.start + delta, end: span.end + delta }];
      if (span.mapping === 'platform')
        return span.start < edit.start && span.end > edit.end ? [{ ...span, end: span.end + delta }] : [];
      const pieces = [];
      if (span.start < edit.start)
        pieces.push({
          ...span,
          end: edit.start,
          ...(span.sourceSpan
            ? { sourceSpan: { ...span.sourceSpan, end: span.sourceSpan.start + edit.start - span.start } }
            : {}),
        });
      if (span.end > edit.end)
        pieces.push({
          ...span,
          start: edit.start + edit.text.length,
          end: span.end + delta,
          ...(span.sourceSpan
            ? { sourceSpan: { ...span.sourceSpan, start: span.sourceSpan.start + edit.end - span.start } }
            : {}),
        });
      return pieces;
    });
    if (marks)
      marks = marks.flatMap((mark) => {
        if (mark.end <= edit.start) return [mark];
        if (mark.start >= edit.end) return [{ ...mark, start: mark.start + delta, end: mark.end + delta }];
        return mark.start <= edit.start && mark.end >= edit.end ? [{ ...mark, end: mark.end + delta }] : [];
      });
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  return { ...fragment, text, intervals, ...(marks ? { marks } : {}) };
}
