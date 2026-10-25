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
  source = fs.readFileSync(file, 'utf8');
  let subsequentColumn = 0;
  if (target.field) {
    let scalar;
    if (/\.ya?ml$/i.test(file)) {
      const document = YAML.parseDocument(source, { keepSourceTokens: true, uniqueKeys: false });
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
      const offset = source.indexOf(scalar.srcToken.source, scalar.range[0]);
      if (offset >= 0) {
        const prefix = source.slice(0, offset),
          indent = /^[ \t]*/.exec(scalar.srcToken.source)[0].length;
        line += prefix.split(/\r\n?|\n/).length - 1;
        column += indent;
        subsequentColumn = indent;
      }
    }
  }
  return (
    text +
    `\n//# sourceURL=${sourceUrl.href}\n//# sourceMappingURL=${identityMapUrl(file, text.split(/\r\n?|\n/).length, source, { line, column, subsequentColumn })}\n`
  );
}

/** Append debugger metadata only to executable inline script bodies. */
export function debugMarkup(source, file) {
  if (debugging.getStore() === false) return source;
  if (!source || !file || !/<script\b/i.test(String(source))) return source;
  const text = String(source),
    tree = parseFragment(text, { sourceCodeLocationInfo: true }),
    patches = [];
  let inline = 0;
  const visit = (node) => {
    if (node.tagName === 'script' && !node.attrs.some((attr) => attr.name === 'src')) {
      const type = node.attrs.find((attr) => attr.name === 'type')?.value ?? '';
      const loc = node.sourceCodeLocation;
      if (loc?.endTag && /^(?:|module|(?:text|application)\/(?:java|ecma)script)$/i.test(type)) {
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
  for (const patch of patches.sort((a, b) => b.from - a.from))
    result = result.slice(0, patch.from) + patch.body + result.slice(patch.to);
  return result;
}
