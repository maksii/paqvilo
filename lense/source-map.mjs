// Line-level source maps that point the code the browser runs back at the local source file, so a
// debugger (VS Code, DevTools) sets breakpoints in, and steps through, the files of the extract even
// though their URL online has another name.
import { pathToFileURL } from 'node:url';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(value) {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/**
 * Source map (as a `data:` URL) that maps each of `lineCount` lines onto the same line of `file`.
 * @param {string} file absolute path of the local source
 * @param {number} lineCount
 */
export function identityMapUrl(file, lineCount, sourceContent, { line = 0, column = 0, subsequentColumn = 0 } = {}) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 0)
    throw new RangeError('lineCount must be a non-negative integer');
  // fields per segment: generated column, source index, source line, source column - all relative
  // to the previous segment (the generated column restarts on every line)
  const first = vlq(0) + vlq(0) + vlq(line) + vlq(column);
  const next = ';' + vlq(0) + vlq(0) + vlq(1) + vlq(0);
  const second = ';' + vlq(0) + vlq(0) + vlq(1) + vlq(subsequentColumn - column);
  const map = {
    version: 3,
    sources: [pathToFileURL(file).href],
    names: [],
    mappings: lineCount ? first + (lineCount > 1 ? second + next.repeat(lineCount - 2) : '') : '',
  };
  if (sourceContent !== undefined) map.sourcesContent = [sourceContent];
  return `data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
}

export function hasSourceMap(text) {
  // Horizontal whitespace only: allowing newlines here makes a long blank file quadratic.
  // A directive may follow code on the same line (common in minified bundles).
  if (/\/\/[#@][^\S\r\n\u2028\u2029]*sourceMappingURL=\S+/.test(text)) return true;
  const block = /\/\*[#@]\s*sourceMappingURL=/g;
  const first = block.exec(text);
  // One forward search, even when thousands of malformed directives lack a closing comment.
  return first !== null && text.indexOf('*/', block.lastIndex) >= 0;
}

/** `body` (a JS file exactly as it is on disk) with a source map comment for `file` appended. */
export function withFileSourceMap(body, file) {
  const text = body.toString('utf8');
  if (hasSourceMap(text)) return body; // Includes inline maps whose data exceeds 4096 characters.
  let lineCount = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      lineCount++;
      if (text.charCodeAt(i + 1) === 10) i++;
    } else if (code === 10 || code === 0x2028 || code === 0x2029) lineCount++;
  }
  const comment = `\n//# sourceMappingURL=${identityMapUrl(file, lineCount, text)}\n`;
  return Buffer.concat([Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from(comment)]);
}

// Conservative upper bound for the inline JSON source and line map, including
// JSON escaping, UTF-8, base64 and the directive. Estimate before allocating a
// map: a newline-heavy source otherwise grows many times larger than its input.
export function fileSourceMapEstimate(text, file) {
  let bytes = 2,
    lines = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 || (code === 10 && text.charCodeAt(i - 1) !== 13) || code === 0x2028 || code === 0x2029) lines++;
    if (code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code === 34 || code === 92) bytes += 2;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
  }
  const fileBytes = Buffer.byteLength(JSON.stringify(pathToFileURL(file).href));
  return 128 + Math.ceil((bytes + lines * 5 + fileBytes + 256) / 3) * 4;
}
