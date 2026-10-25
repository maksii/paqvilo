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
    sourceStart = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const decoded = body.toString('utf8').replace(/^\uFEFF/, '');
  if (!decoded.startsWith(raw.slice(sourceStart))) return body;
  const lineStarts = [0];
  let linesTruncated = false;
  for (let index = 0; index < decoded.length; index++) {
    const code = decoded.charCodeAt(index);
    if (code === 13 && decoded.charCodeAt(index + 1) === 10) index++;
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
