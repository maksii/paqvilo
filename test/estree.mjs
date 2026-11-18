// Tests inspect JavaScript sources by syntax through Vite's parser, which returns a standard ESTree; they never load
// the TypeScript compiler as a library.
import { parseSync } from 'vite';

function* descend(node) {
  yield node;
  const children = Object.values(node)
    .flat()
    .filter((value) => typeof value?.type === 'string')
    .sort((a, b) => a.start - b.start);
  for (const child of children) yield* descend(child);
}

/**
 * Every syntax node of a JavaScript module in source order, each parent before its children. The parser is tolerant:
 * text that is not a module (JSON, a stylesheet) or has an unrecoverable syntax error yields only what it recovered,
 * which may be the empty program alone.
 */
export function* syntaxNodes(source) {
  yield* descend(parseSync('module.mjs', source).program);
}
