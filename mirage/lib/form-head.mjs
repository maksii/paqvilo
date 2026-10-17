import { parseFragment, serializeOuter } from 'parse5';

/** Keep exported content styles in form documents without duplicating captured links. */
export function formContentStyles(content = '', profile) {
  const key = value => { try { return new URL(value, 'https://local.invalid').pathname; } catch { return value; } };
  const captured = new Set((profile?.stylesheets ?? []).map(entry => key(typeof entry === 'string' ? entry : entry.href)));
  return parseFragment(content).childNodes.filter(node => node.tagName === 'link' && !captured.has(key(node.attrs.find(attr => attr.name === 'href')?.value))).map(node => serializeOuter(node)).join('');
}
