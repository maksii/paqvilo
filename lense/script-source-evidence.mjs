import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { withFileSourceMap } from './source-map.mjs';
import { normalizeInspectionSourceRef } from './inspection-evidence.mjs';

const SCRIPT_SOURCE_EVIDENCE = Symbol('owned-script-source-evidence');
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Cache proof metadata on the same response Buffer, never from a second file read. */
export function scriptSourceBody(bytes, file, { sourceMaps = true, responseBody } = {}) {
  const body = responseBody ?? (sourceMaps ? withFileSourceMap(bytes, file) : bytes);
  if (bytes.length > 8 * 1024 * 1024 || body.length > 16 * 1024 * 1024) return body;
  const raw = bytes.toString('utf8'),
    sourceStart = raw.charCodeAt(0) === 0xfeff ? 1 : 0; // NOSONAR: UTF-16 code unit semantics are required
  const decoded = body.toString('utf8').replace(/^\uFEFF/, '');
  if (!decoded.startsWith(raw.slice(sourceStart))) return body;
  const lineStarts = [0];
  let linesTruncated = false;
  for (let index = 0; index < decoded.length; index++) {
    const code = decoded.charCodeAt(index); // NOSONAR: UTF-16 code unit semantics are required
    if (code === 13 && decoded.charCodeAt(index + 1) === 10) index++; // NOSONAR: UTF-16 code unit semantics are required
    if ([10, 13, 0x2028, 0x2029].includes(code)) {
      if (lineStarts.length >= 16384) {
        linesTruncated = true;
        break;
      }
      lineStarts.push(index + 1);
    }
  }
  Object.defineProperty(body, SCRIPT_SOURCE_EVIDENCE, {
    configurable: true,
    value: {
      contentRevision: hash(bytes),
      generatedHash: hash(decoded),
      responseHash: hash(body),
      sourceStart,
      sourceLength: raw.length,
      generatedLength: decoded.length,
      lineStarts,
      linesTruncated,
    },
  });
  return body;
}

/** A resource proves implementation bytes; only a later observed callsite can attribute DOM. */
export async function scriptResourceProof(inspector, file, body, route = '/') {
  const evidence = body?.[SCRIPT_SOURCE_EVIDENCE];
  if (!inspector || !evidence) return null;
  let index, canonical;
  try {
    index = await inspector.sourceIndexFor(route);
    canonical = fs.realpathSync.native(file);
  } catch {
    return null;
  }
  const matches = [...index.sources.values()].filter((source) => {
    if (source.contentRevision !== evidence.contentRevision || !source.file) return false;
    try {
      return fs.realpathSync.native(source.file) === canonical;
    } catch {
      return false;
    }
  });
  return scriptResourceProofFromSourceRefs(matches, body, index.sourceRevision);
}

// Bounds of one export's script hash index (scriptHashIndex): sources considered, characters hashed in total, inline
// script bodies taken from one template.
const SCRIPT_HASH_INDEX_LIMITS = Object.freeze({ sources: 8192, characters: 64 * 1024 * 1024, perTemplate: 64 });
const JAVASCRIPT_FILE = /\.[cm]?js$/i;
const JAVASCRIPT_TYPE = /^(?:text|application)\/(?:x-)?(?:java|ecma)script\b/i;
const LIQUID = /\{\{|\{%/;

// Line starts of a script as V8 counts lines (LF, CR, CRLF, LS, PS), bounded like scriptSourceBody.
function scriptLineStarts(text) {
  const lineStarts = [0];
  let linesTruncated = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index); // NOSONAR: UTF-16 code unit semantics are required
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++; // NOSONAR: UTF-16 code unit semantics are required
    if ([10, 13, 0x2028, 0x2029].includes(code)) {
      if (lineStarts.length >= 16384) {
        linesTruncated = true;
        break;
      }
      lineStarts.push(index + 1);
    }
  }
  return { lineStarts, linesTruncated };
}

/**
 * The text the browser parses for `text.slice(start, end)` of a source, with mappings back to that source. An inline
 * script's text goes through the HTML parser, which turns CRLF and a lone CR into LF: each run between line breaks maps
 * one to one, so no mapping ever spans a changed character. An external script is parsed as served.
 */
function parsedScriptText(text, start, end, inline) {
  if (!inline) {
    const parsed = text.slice(start, end);
    return {
      parsed,
      mappings: parsed.length
        ? [{ generatedStart: 0, generatedEnd: parsed.length, sourceStart: start, sourceEnd: end }]
        : [],
    };
  }
  let parsed = '';
  const mappings = [];
  let runStart = start;
  const close = (at) => {
    if (at > runStart)
      mappings.push({
        generatedStart: parsed.length,
        generatedEnd: parsed.length + at - runStart,
        sourceStart: runStart,
        sourceEnd: at,
      });
    parsed += text.slice(runStart, at);
  };
  for (let index = start; index < end; index++) {
    if (text.charCodeAt(index) !== 13) continue; // NOSONAR: UTF-16 code unit semantics are required
    close(index);
    if (text.charCodeAt(index + 1) === 10 && index + 1 < end) {
      // NOSONAR: UTF-16 code unit semantics are required
      runStart = index + 1; // The LF stays and maps to itself.
    } else {
      mappings.push({
        generatedStart: parsed.length,
        generatedEnd: parsed.length + 1,
        sourceStart: index,
        sourceEnd: index + 1,
      });
      parsed += '\n';
      runStart = index + 1;
    }
  }
  close(end);
  return { parsed, mappings };
}

// The executable inline script bodies of an HTML source without Liquid: [start, end) of each body in the source text.
function templateScriptBodies(text, limit) {
  const bodies = [];
  let truncated = false;
  // A script element ends at `</script` followed by anything up to `>` (the parser ignores what stands there).
  for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const kind = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim();
    if (kind && !JAVASCRIPT_TYPE.test(kind) && kind.toLowerCase() !== 'module') continue;
    if (LIQUID.test(attributes) || LIQUID.test(match[2]) || !match[2].trim()) continue;
    if (bodies.length >= limit) {
      truncated = true;
      break;
    }
    // `attributes` holds no `>`: the first one ends the start tag.
    const start = match.index + match[0].indexOf('>') + 1;
    bodies.push({ start, end: start + match[2].length });
  }
  return { bodies, truncated };
}

// Where the parsed text of each script of an export source starts and ends, and whether the HTML parser reads it.
function scriptCandidates(source, limits) {
  const text = source.text;
  const field = source.fieldPath?.[0];
  if (source.kind === 'webfile' && field === '$content') {
    if (!JAVASCRIPT_FILE.test(source.file ?? source.url ?? '') && !JAVASCRIPT_TYPE.test(source.mimeType ?? ''))
      return { candidates: [], truncated: false };
    // The browser drops a byte order mark before it parses the script.
    return {
      candidates: [{ start: text.charCodeAt(0) === 0xfeff ? 1 : 0, end: text.length, inline: false }], // NOSONAR: UTF-16 code unit semantics are required
      truncated: false,
    };
  }
  if (field === 'customjavascript') {
    // The portal writes the field into an inline script: as it is, or without the blank lines around it.
    const leading = text.length - text.trimStart().length,
      trailing = text.trimEnd().length;
    const candidates = [{ start: 0, end: text.length, inline: true }];
    if (leading || trailing !== text.length) candidates.push({ start: leading, end: trailing, inline: true });
    return { candidates: candidates.filter((item) => item.end > item.start), truncated: false };
  }
  if (source.kind === 'webtemplate' && field === 'source') {
    const { bodies, truncated } = templateScriptBodies(text, limits.perTemplate);
    return { candidates: bodies.map((body) => ({ ...body, inline: true })), truncated };
  }
  return { candidates: [], truncated: false };
}

// Adds the parsed text of each candidate script of one source (`text`, normalized as `ref`) to `byHash`.
function indexCandidates(byHash, text, ref, candidates) {
  for (const candidate of candidates) {
    const { parsed, mappings } = parsedScriptText(text, candidate.start, candidate.end, candidate.inline);
    if (!parsed.trim()) continue;
    const key = hash(parsed);
    const previous = byHash.get(key);
    if (previous) {
      // The same text twice in one source is still one source, but not one place: a callsite cannot be located.
      if (
        previous.conflict ||
        previous.ref.id !== ref.id ||
        previous.mappings[0]?.sourceStart !== mappings[0]?.sourceStart
      )
        byHash.set(key, { conflict: true });
      continue;
    }
    byHash.set(key, {
      ref,
      mappings: mappings.map((mapping) => ({ ...mapping, sourceRefId: ref.id })),
      ...scriptLineStarts(parsed),
    });
  }
}

/**
 * The scripts of an export by the hash the browser reports for parsed code (SHA-256 of the UTF-8 text, as
 * `Debugger.scriptParsed` gives it): web files with JavaScript content, the custom JavaScript of pages, forms, lists
 * and form steps, and the inline scripts of web templates without Liquid. `index` is a portal source index
 * (`sources`, `sourceRevision`). A hash that two different places of the export produce is a conflict and proves
 * nothing. Bounded by SCRIPT_HASH_INDEX_LIMITS; `truncated` says a source was left out.
 * Returns `{ sourceRevision, byHash: Map<hash, entry | { conflict: true }>, sourceLines: Map<ref id, line starts>,
 * truncated }`, where an entry has `ref` (the
 * normalized source ref), `lineStarts`, `linesTruncated` and `mappings` (generated offsets to source offsets).
 */
export function scriptHashIndex(index, limits = SCRIPT_HASH_INDEX_LIMITS) {
  const byHash = new Map(),
    // The line starts of each indexed source's own text by ref id (the export's file as it is on disk, CRLF included),
    // so a located callsite is named by the line and column of the file the developer opens.
    sourceLines = new Map();
  let considered = 0,
    characters = 0,
    truncated = false;
  for (const source of index?.sources?.values?.() ?? []) {
    if (!source || source.ambiguous || typeof source.text !== 'string' || !source.text) continue;
    const { candidates, truncated: partial } = scriptCandidates(source, limits);
    if (partial) truncated = true;
    if (!candidates.length) continue;
    if (considered >= limits.sources || characters + source.text.length > limits.characters) {
      truncated = true;
      continue;
    }
    considered++;
    characters += source.text.length;
    const ref = normalizeInspectionSourceRef(source);
    if (!ref) continue;
    sourceLines.set(ref.id, scriptLineStarts(source.text).lineStarts);
    indexCandidates(byHash, source.text, ref, candidates);
  }
  return {
    sourceRevision: typeof index?.sourceRevision === 'string' ? index.sourceRevision : null,
    byHash,
    sourceLines,
    truncated,
  };
}

/** Reuse an already imported semantic resource identity with the exact raw/fulfilled byte pair. */
export function scriptResourceProofFromSourceRefs(sourceRefs, body, sourceRevision) {
  const evidence = body?.[SCRIPT_SOURCE_EVIDENCE];
  if (!evidence || typeof sourceRevision !== 'string') return null;
  const matches = sourceRefs.filter((ref) => ref?.contentRevision === evidence.contentRevision);
  if (matches.length !== 1) return null;
  const sourceRef = normalizeInspectionSourceRef(matches[0]);
  if (!sourceRef?.ref || !(sourceRef.sourceKey ?? sourceRef.key)) return null;
  const proofId = 'script:' + randomUUID();
  return {
    version: 1,
    channel: 'lense-script-resource',
    proofId,
    sourceRevision,
    sourceRefs: [sourceRef],
    scriptProofs: [
      {
        id: proofId,
        external: true,
        generatedHash: evidence.generatedHash,
        responseHash: evidence.responseHash,
        hashAlgorithm: 'sha256-utf8',
        lineStarts: evidence.lineStarts,
        linesTruncated: evidence.linesTruncated,
        mappings: [
          {
            generatedStart: 0,
            generatedEnd: evidence.sourceLength - evidence.sourceStart,
            sourceRefId: sourceRef.id,
            sourceStart: evidence.sourceStart,
            sourceEnd: evidence.sourceLength,
          },
        ],
      },
    ],
    complete: !evidence.linesTruncated,
  };
}
