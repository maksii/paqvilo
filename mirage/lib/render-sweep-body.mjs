import { parse } from 'parse5';

/** Keep response bytes in diagnostic samples, omitting simulator runtime scripts only for HTML responses. */
export function retainedResponseBody(body, contentType) {
  const html = String(body ?? ''),
    ranges = [],
    pending = /text\/html/i.test(contentType ?? '') ? [parse(html, { sourceCodeLocationInfo: true })] : [];
  while (pending.length) {
    const node = pending.pop();
    if (
      node.tagName === 'script' &&
      node.attrs?.some((attribute) => attribute.name === 'data-paqvilo-mirage-runtime') &&
      node.sourceCodeLocation
    ) {
      ranges.push(node.sourceCodeLocation);
      continue;
    }
    for (const child of node.childNodes ?? []) pending.push(child);
    if (node.content) pending.push(node.content);
  }
  let authored = html;
  for (const { startOffset, endOffset } of ranges.sort((a, b) => b.startOffset - a.startOffset))
    authored = authored.slice(0, startOffset) + authored.slice(endOffset);
  return {
    body: authored.slice(0, 20_000),
    bodyTruncated: authored.length > 20_000,
    bodyOmittedRuntimeScripts: ranges.length,
  };
}
