/** Hide non-executing Liquid bodies when indexing Liquid references, preserving offsets. */
export function stripLiquidLiteralBlocks(source) {
  const text = String(source ?? '');
  const tags = /{%-?\s*(raw|endraw|comment|endcomment|manifest|endmanifest)\b[^%]*%-?}/gi;
  let kind = null, depth = 0, start = 0, from = 0, result = '';
  const blank = (body) => body.replace(/[^\r\n]/g, ' ');
  for (const match of text.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (!kind) {
      if (tag.startsWith('end')) continue;
      kind = tag; depth = 1; start = match.index;
      result += text.slice(from, start);
    } else if (kind === 'comment' && tag === 'comment') depth++;
    else if (tag === 'end' + kind && --depth === 0) {
      from = match.index + match[0].length;
      result += blank(text.slice(start, from));
      kind = null;
    }
  }
  return result + (kind ? blank(text.slice(start)) : text.slice(from));
}
