import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';

const buffers = new WeakMap();
const bindings = new WeakMap();
const objectSources = new WeakMap();
const PROVENANCE_ATTRIBUTE = 'data-paqvilo-source';

export function scriptLineStarts(text, maxLines = 16384) {
  const lineStarts = [0];
  let truncated = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 || code === 10 || code === 0x2028 || code === 0x2029) {
      if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
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

export function createRenderTrace({ sourceRevision = null, renderId = randomUUID(), limits = {} } = {}) {
  return {
    renderId,
    sourceRevision,
    source: null,
    node: null,
    invocation: null,
    ordinal: 0,
    invocations: [],
    maxIntervals: limits.intervals ?? 50000,
    complete: true,
  };
}
export function createRenderBuffer(context) {
  const trace = context?.provenance;
  const out = [];
  if (!trace) return out;
  const state = { trace, length: 0, intervals: [], replay: null };
  buffers.set(out, state);
  Object.defineProperty(out, 'push', {
    value(...values) {
      for (const value of values) {
        const text = String(value);
        if (state.replay) {
          for (const span of state.replay.intervals) {
            if (state.intervals.length >= trace.maxIntervals) {
              trace.complete = false;
              break;
            }
            state.intervals.push({ ...span, start: state.length + span.start, end: state.length + span.end });
          }
        } else if (trace.source && trace.node) {
          const span = trace.node.span;
          const maps =
            trace.source.offsetMap && trace.node.mapping === 'literal' && span && span.end - span.start === text.length
              ? trace.source.offsetMap.flatMap((map) => {
                  const start = Math.max(span.start, map.start),
                    end = Math.min(span.end, map.end);
                  return end > start
                    ? [
                        {
                          start: state.length + start - span.start,
                          end: state.length + end - span.start,
                          sourceSpan: {
                            start: map.sourceStart + start - map.start,
                            end: map.sourceStart + end - map.start,
                          },
                        },
                      ]
                    : [];
                })
              : [{ start: state.length, end: state.length + text.length, sourceSpan: span }];
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
                ...mapped,
              });
            else trace.complete = false;
        }
        state.length += text.length;
      }
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
export async function withRenderSource(context, source, run) {
  const trace = context.provenance;
  if (!trace) return run();
  const previous = { source: trace.source, node: trace.node, invocation: trace.invocation };
  const callerSpan = previous.node?.span;
  const callerMap = previous.source?.offsetMap?.find(
    (map) => callerSpan && map.start <= callerSpan.start && map.end >= callerSpan.end,
  );
  const callSite = previous.source?.offsetMap
    ? callerMap
      ? {
          start: callerMap.sourceStart + callerSpan.start - callerMap.start,
          end: callerMap.sourceStart + callerSpan.end - callerMap.start,
        }
      : null
    : (callerSpan ?? null);
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
  try {
    return await run();
  } finally {
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
export function joinRenderFragments(...parts) {
  let text = '';
  const intervals = [];
  let invocations = [];
  let complete = true;
  for (const part of parts) {
    if (typeof part === 'string') text += part;
    else if (part) {
      if (part.invocations?.length) invocations = part.invocations;
      if (part.complete === false) complete = false;
      for (const span of part.intervals ?? [])
        intervals.push({ ...span, start: text.length + span.start, end: text.length + span.end });
      text += part.text;
    }
  }
  return { text, intervals, invocations, complete };
}
export function composeRenderFragments(strings, ...values) {
  return joinRenderFragments(...strings.flatMap((text, i) => [text, values[i] ?? '']));
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
export function applyRenderEdits(fragment, edits) {
  let result = fragment;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
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
    result = { ...result, text: result.text.slice(0, edit.start) + edit.text + result.text.slice(edit.end), intervals };
  }
  return result;
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

/** Finalize only after Liquid evaluation. No wrappers and no parse/serialize rewriting. */
export function finalizePortalProvenance({ fragment, index, proofId = randomUUID(), channel = 'mirage-render' }) {
  const tree = parse(fragment.text, { sourceCodeLocationInfo: true });
  const edits = [],
    entries = [],
    scripts = [];
  const refs = new Map();
  const invocations = new Map((fragment.invocations ?? []).map((item) => [item.id, item]));
  const intervals = [...fragment.intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  let complete = fragment.complete !== false;
  const overlaps = (start, end) => {
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
  };
  const visit = (node, inertTemplateId) => {
    const addBinding = (binding) => entries.push({ ...binding, ...(inertTemplateId ? { inertTemplateId } : {}) });
    const location = node.sourceCodeLocation?.startTag;
    const endTag = node.sourceCodeLocation?.endTag;
    if (
      node.tagName === 'script' &&
      !inertTemplateId &&
      location &&
      endTag &&
      !node.attrs.some((attr) => attr.name === 'src') &&
      /^(?:|module|(?:text|application)\/(?:java|ecma)script)$/i.test(
        node.attrs.find((attr) => attr.name === 'type')?.value ?? '',
      )
    ) {
      const body = fragment.text.slice(location.endOffset, endTag.startOffset),
        mappings = [];
      for (const span of overlaps(location.endOffset, endTag.startOffset)) {
        if (span.mapping !== 'literal' || !span.sourceSpan) continue;
        const source = index.sources.get(span.sourceRefId),
          start = Math.max(location.endOffset, span.start),
          end = Math.min(endTag.startOffset, span.end);
        const sourceStart = span.sourceSpan.start + start - span.start,
          sourceEnd = sourceStart + end - start;
        if (
          !source ||
          source.ambiguous ||
          fragment.text.slice(start, end) !== source.text.slice(sourceStart, sourceEnd)
        )
          continue;
        mappings.push({
          generatedStart: start - location.endOffset,
          generatedEnd: end - location.endOffset,
          sourceRefId: source.id,
          sourceStart,
          sourceEnd,
        });
        const { text: _text, file: _file, sourceDir: _root, ...ref } = source;
        refs.set(ref.id, ref);
      }
      if (mappings.length && scripts.length < 128) {
        const id = proofId + ':script:' + scripts.length;
        const parsed = parsedInlineScript(body, mappings);
        const actualText = (node.childNodes ?? [])
          .map((child) => (child.nodeName === '#text' ? child.value : ''))
          .join('');
        if (actualText !== parsed.text) return;
        const script = {
          id,
          generatedHash: createHash('sha256').update(parsed.text, 'utf8').digest('hex'),
          hashAlgorithm: 'sha256-utf8',
          mappings: parsed.mappings,
          mappingsTruncated: parsed.mappingsTruncated,
          ...scriptLineStarts(parsed.text),
        };
        const debugUrl = [...body.matchAll(/(?:^|\n)\/\/# sourceURL=(\S+)/g)].at(-1)?.[1];
        if (debugUrl)
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
        scripts.push(script);
        const existing = node.sourceCodeLocation.attrs?.['data-paqvilo-script'];
        if (existing) edits.push({ start: existing.startOffset, end: existing.endOffset, text: '' });
        const at = location.endOffset - 1;
        edits.push({ start: at, end: at, text: ` data-paqvilo-script="${id}"` });
      }
    }
    if (location && node.tagName) {
      let bound = false;
      const contributing = overlaps(location.startOffset, location.endOffset);
      if (entries.length >= 5000) {
        complete = false;
        return;
      }
      const platforms = contributing.filter(
        (span) =>
          span.mapping === 'platform' &&
          span.start === location.startOffset &&
          span.end === location.endOffset &&
          span.tag === node.tagName,
      );
      if (channel === 'mirage-render' && platforms.length === 1) {
        const span = platforms[0];
        const attributes = span.attributes ?? [];
        const sourceIds = (span.sourceRefIds ?? []).filter((id) => index.sources.has(id));
        if (
          span.component?.key &&
          attributes.every((attribute) =>
            node.attrs.some((actual) => actual.name === attribute.name && actual.value === attribute.value),
          )
        ) {
          const id = proofId + ':' + randomUUID();
          addBinding({
            id,
            tag: node.tagName,
            attributes,
            mapping: 'platform',
            component: span.component,
            sourceRefIds: sourceIds,
            ...(span.contextSourceRefId ? { contexts: [{ sourceRefId: span.contextSourceRefId }] } : {}),
          });
          for (const sourceId of [...sourceIds, span.contextSourceRefId].filter(Boolean)) {
            const source = index.sources.get(sourceId);
            if (!source) continue;
            const { text: _text, file: _file, sourceDir: _root, ...ref } = source;
            refs.set(sourceId, ref);
          }
          const end = location.endOffset - 1;
          edits.push({ start: end, end, text: ` ${PROVENANCE_ATTRIBUTE}="${id}"` });
          bound = true;
        }
      }
      const spans = contributing.filter(
        (s) => s.start <= location.startOffset && s.end >= location.endOffset && s.mapping === 'literal',
      );
      if (!bound && spans.length === 1) {
        const span = spans[0],
          source = index.sources.get(span.sourceRefId);
        const sourceStart = span.sourceSpan?.start + location.startOffset - span.start;
        if (
          source &&
          !source.ambiguous &&
          Number.isSafeInteger(sourceStart) &&
          source.text.slice(sourceStart, sourceStart + location.endOffset - location.startOffset) ===
            fragment.text.slice(location.startOffset, location.endOffset)
        ) {
          const id = proofId + ':' + randomUUID();
          const attrs = (node.attrs ?? []).filter((a) =>
            /^(?:id|name|type|data-(?:entityname|formid|viewid|listid|control-id|control-name|pcf-schema|pcf-control|pcf-name))$/.test(
              a.name,
            ),
          );
          const region = { start: sourceStart, end: sourceStart + location.endOffset - location.startOffset };
          const prefix = source.text.slice(0, sourceStart);
          region.line = prefix.split(/\r\n|\r|\n/).length;
          region.column = sourceStart - Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
          addBinding({
            id,
            tag: node.tagName,
            attributes: attrs,
            sourceRefId: source.id,
            region,
            invocationId: span.invocationId,
            mapping: 'literal',
          });
          const contexts = [];
          let invocation = invocations.get(span.invocationId);
          const seen = new Set();
          while (invocation?.parentId && contexts.length < 16 && !seen.has(invocation.parentId)) {
            seen.add(invocation.parentId);
            const parent = invocations.get(invocation.parentId);
            const contextSource = parent && index.sources.get(parent.sourceRefId);
            if (contextSource) {
              contexts.push({ sourceRefId: contextSource.id, region: invocation.callSite, invocationId: parent.id });
              const { text: _text, file: _file, sourceDir: _root, ...ref } = contextSource;
              refs.set(ref.id, ref);
            }
            invocation = parent;
          }
          if (contexts.length) entries.at(-1).contexts = contexts;
          const { text: _text, file: _file, sourceDir: _root, ...publicRef } = source;
          refs.set(source.id, publicRef);
          // Remove preexisting reserved attributes, then insert ours immediately before the closing delimiter.
          const existing = node.sourceCodeLocation.attrs?.[PROVENANCE_ATTRIBUTE];
          if (existing) edits.push({ start: existing.startOffset, end: existing.endOffset, text: '' });
          const end = location.endOffset - (fragment.text[location.endOffset - 2] === '/' ? 2 : 1);
          edits.push({ start: end, end, text: ` ${PROVENANCE_ATTRIBUTE}="${id}"` });
          bound = true;
        }
      }
      if (channel === 'mirage-render' && !bound) {
        const contributors = [
          ...new Set(
            contributing
              .flatMap((span) => [span.sourceRefId, ...(span.contributors ?? [])])
              .filter((id) => index.sources.has(id)),
          ),
        ];
        if (contributors.length) {
          const id = proofId + ':' + randomUUID();
          addBinding({
            id,
            tag: node.tagName,
            attributes: (node.attrs ?? []).filter((a) => /^(?:id|name|type)$/.test(a.name)),
            mapping: contributors.some((sourceId) => index.sources.get(sourceId)?.ambiguous)
              ? 'conflicting'
              : 'derived',
            sourceRefIds: contributors,
          });
          for (const sourceId of contributors) {
            const { text: _text, file: _file, sourceDir: _root, ...ref } = index.sources.get(sourceId);
            refs.set(sourceId, ref);
          }
          const end = location.endOffset - (fragment.text[location.endOffset - 2] === '/' ? 2 : 1);
          edits.push({ start: end, end, text: ` ${PROVENANCE_ATTRIBUTE}="${id}"` });
        }
      }
    }
  };
  const pending = [{ node: tree, inertTemplateId: null }];
  while (pending.length) {
    const { node, inertTemplateId } = pending.pop(),
      previous = entries.length;
    visit(node, inertTemplateId);
    for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--)
      pending.push({ node: node.childNodes[i], inertTemplateId });
    if (node.content && entries.length > previous)
      pending.push({ node: node.content, inertTemplateId: entries.at(-1).id });
  }
  let html = fragment.text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
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
      complete,
    },
  };
  result.provenance = refreshScriptProofLocations(html, result.provenance);
  return result;
}

/** Revalidate known script identities after explicit host HTML edits; never search by source text. */
export function refreshScriptProofLocations(html, proof) {
  if (!proof.scriptProofs?.length) return proof;
  const nodes = new Map(),
    tree = parse(html, { sourceCodeLocationInfo: true }),
    pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'script') {
      const id = node.attrs.find((attr) => attr.name === 'data-paqvilo-script')?.value;
      if (id) nodes.set(id, nodes.has(id) ? null : node);
    }
    for (const child of node.childNodes ?? []) pending.push(child);
  }
  const scripts = [];
  for (const script of proof.scriptProofs) {
    const node = nodes.get(script.id),
      start = node?.sourceCodeLocation?.startTag,
      end = node?.sourceCodeLocation?.endTag;
    if (!start || !end) continue;
    const actualText = (node.childNodes ?? []).map((child) => (child.nodeName === '#text' ? child.value : '')).join('');
    if (createHash('sha256').update(actualText, 'utf8').digest('hex') !== script.generatedHash) continue;
    scripts.push({
      ...script,
      documentStart: { line: start.endLine - 1, column: start.endCol - 1 },
      documentEnd: { line: end.startLine - 1, column: end.startCol - 1 },
    });
  }
  return { ...proof, scriptProofs: scripts };
}
