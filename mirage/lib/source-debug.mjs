import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';
import YAML from 'yaml';
import { AsyncLocalStorage } from 'node:async_hooks';
import { identityMapUrl } from '../../lense/source-map.mjs';

const debugging = new AsyncLocalStorage();
// A runtime request owns its debugger policy, including nested templates and controls.
// Concurrent runtimes must never share a mutable process-wide switch.
export const runWithSourceDebugging = (enabled, run) => debugging.run(enabled, run);

export function exportFieldFile(record, suffix) {
  const field = { 'source.html': 'source', 'copy.html': 'copy', 'custom_javascript.js': 'customjavascript' }[suffix];
  const file = record?._profileSourceFiles?.[field] ?? record?._file;
  if (!file) return null;
  const side = file.replace(/\.ya?ml$/i, '.' + suffix);
  if (!record?._profileSourceFiles?.[field] && side !== file && fs.existsSync(side)) return side;
  const value = record?.[field] ?? record?.['adx_' + field] ?? record?.['mspp_' + field];
  return field ? { file, field, value } : file;
}

export function debugScript(body, target, { line = 0, column = 0, source, inline } = {}) {
  if (debugging.getStore() === false) return body;
  if (!body || !target) return body;
  const file = typeof target === 'string' ? target : target.file;
  const sourceUrl = pathToFileURL(file);
  if (inline !== undefined) sourceUrl.searchParams.set('inline', String(inline));
  const text = String(body);
  if (/\/\/[#@]\s*sourceMappingURL=/.test(text)) return text;
  void source; // NOSONAR: void is intentional here
  const sourceText = fs.readFileSync(file, 'utf8');
  let subsequentColumn = 0;
  if (target.field) {
    let scalar;
    if (/\.ya?ml$/i.test(file)) {
      const document = YAML.parseDocument(sourceText, { keepSourceTokens: true, uniqueKeys: false });
      YAML.visit(document, {
        Pair(_key, pair) {
          if (
            [target.field, 'adx_' + target.field, 'mspp_' + target.field].includes(pair.key?.value) &&
            pair.value?.type === 'BLOCK_LITERAL' &&
            (target.value === undefined || pair.value.value === target.value)
          )
            scalar ??= pair.value;
        },
      });
    }
    // Encoded/folded fields are not line-preserving. Name their export without
    // inventing identity mappings to unrelated lines in the containing document.
    if (!scalar) return text + `\n//# sourceURL=${sourceUrl.href}\n`;
    if (scalar) {
      const offset = sourceText.indexOf(scalar.srcToken.source, scalar.range[0]);
      if (offset >= 0) {
        const prefix = sourceText.slice(0, offset),
          indent = /^[ \t]*/.exec(scalar.srcToken.source)[0].length;
        line += prefix.split(/\r\n?|\n/).length - 1;
        column += indent;
        subsequentColumn = indent;
      }
    }
  }
  return (
    text +
    `\n//# sourceURL=${sourceUrl.href}\n//# sourceMappingURL=${identityMapUrl(file, text.split(/\r\n?|\n/).length, sourceText, { line, column, subsequentColumn })}\n`
  );
}

/** Append debugger metadata only to executable inline script bodies. */
export function debugMarkup(source, file, { onEdits } = {}) {
  if (debugging.getStore() === false) return source;
  if (!source || !file || !/<script\b/i.test(String(source))) return source;
  const text = String(source),
    tree = parseFragment(markupOutsideLiquid(text), { sourceCodeLocationInfo: true }),
    patches = [];
  let inline = 0;
  const visit = (node) => {
    if (node.tagName === 'script' && !node.attrs.some((attr) => attr.name === 'src')) {
      const type = node.attrs.find((attr) => attr.name === 'type')?.value ?? '';
      const loc = node.sourceCodeLocation;
      if (loc?.endTag && /^(?:module|(?:text|application)\/(?:java|ecma)script)?$/i.test(type)) {
        const body = text.slice(loc.startTag.endOffset, loc.endTag.startOffset);
        patches.push({
          from: loc.startTag.endOffset,
          to: loc.endTag.startOffset,
          body: debugScript(body, file, {
            line: loc.startTag.endLine - 1,
            column: loc.startTag.endCol - 1,
            source: text,
            inline: ++inline,
          }),
        });
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(tree);
  let result = text;
  patches.sort((a, b) => b.from - a.from);
  for (const patch of patches) result = result.slice(0, patch.from) + patch.body + result.slice(patch.to);
  onEdits?.(patches);
  return result;
}

// HTML-like strings inside Liquid expressions/tags are data, not inline scripts.
// Mask tokens only for HTML parsing, retaining every offset and newline so
// executable script locations still map to the unmodified authored source.
function markupOutsideLiquid(text) {
  const chunks = [];
  const endRaw = /\{%-?\s*endraw\s*-?%\}/g;
  let from = 0,
    cursor = 0,
    raw = false;
  while (cursor < text.length) {
    if (raw) {
      // Raw termination has its own grammar; quotes/unmatched tokens in its
      // literal body cannot swallow endraw or turn later expressions into HTML.
      endRaw.lastIndex = cursor;
      const closing = endRaw.exec(text);
      if (!closing) break;
      chunks.push(text.slice(from, closing.index), closing[0].replace(/[^\r\n]/g, ' '));
      cursor = from = closing.index + closing[0].length;
      raw = false;
      continue;
    }
    const begin = text.indexOf('{', cursor);
    if (begin < 0) break;
    const kind = text[begin + 1];
    if (kind !== '{' && kind !== '%') {
      cursor = begin + 1;
      continue;
    }
    const end = liquidTokenEnd(text, begin + 2, kind);
    const finish = end < 0 ? text.length : end + 2;
    const name =
      kind === '%' ? /^-?\s*(\w+)/.exec(text.slice(begin + 2, end < 0 ? text.length : end))?.[1]?.toLowerCase() : null;
    if (name === 'raw') raw = true;
    chunks.push(text.slice(from, begin), text.slice(begin, finish).replace(/[^\r\n]/g, ' '));
    cursor = from = finish;
  }
  chunks.push(text.slice(from));
  return chunks.join('');
}

// Match the Liquid parser's quote semantics: a quoted fragment runs to the next
// matching quote. Backslashes are literal; they do not escape that closing quote.
function liquidTokenEnd(text, cursor, kind) {
  while (cursor < text.length) {
    const character = text[cursor++];
    if (character === '"' || character === "'") {
      const quote = text.indexOf(character, cursor);
      if (quote < 0) return -1;
      cursor = quote + 1;
    } else if (character === (kind === '{' ? '}' : '%') && text[cursor] === '}') return cursor - 1;
  }
  return -1;
}
