// XML infoset projection of one serialised XML document: the portable form both the recorded SDK output and Mirage's
// output are compared in. Dependency-free recursive-descent reader for the XML the Dataverse serializers emit.

const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const XSI_TYPE = `{${XSI_NS}}type`;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const NAME = /[A-Za-z_][-A-Za-z0-9._]*(?::[A-Za-z_][-A-Za-z0-9._]*)?/y;
const WHITESPACE = /[ \t\r\n]*/y;
const DECLARATION = /<\?xml[ \t\r\n][\s\S]*?\?>/y;
const BLANK = /^[ \t\r\n]*$/;
const REFERENCE = /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g;
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/**
 * Projects one XML document onto its infoset. The comparison is over this projection, not over bytes.
 *
 * - An element is `{ name, attributes, children }`. `name` is `{namespace-uri}local`, or `local` when the element is in
 *   no namespace. `children` holds the child elements and text nodes in document order.
 * - A text node is a string, entity-decoded; character data separated only by comments is one node. An element with
 *   no child elements keeps its text exactly, whitespace included. In an element with child elements, whitespace-only
 *   text between them is dropped and any other text is kept exactly.
 * - Namespace declarations (`xmlns`, `xmlns:p`) are not attributes and are resolved away. An unprefixed attribute has
 *   no namespace, so its key is `local`; a prefixed one is keyed `{namespace-uri}local`. Keys are written sorted.
 * - The value of `{http://www.w3.org/2001/XMLSchema-instance}type` is a QName and is written as `{namespace-uri}local`
 *   (or `local`), resolved with the namespace declarations in scope at that element. Every other value is a string,
 *   so `{http://www.w3.org/2001/XMLSchema-instance}nil` stays `"true"` or `"false"`.
 * - Child order is preserved. Attribute values are normalised as XML requires (a literal tab or line break becomes a
 *   space; character references are not normalised). An XML declaration and comments are skipped.
 * - CDATA sections, processing instructions other than the XML declaration, DOCTYPE declarations, undeclared prefixes,
 *   duplicate attributes and any other markup throw, rather than being guessed at.
 *
 * @param {string} xml one XML document, or one element
 * @param {Record<string, string>} [inScope] prefix to namespace URI for the prefixes an element fragment inherits from
 *   an enclosing document that is not part of `xml` (Mirage's value fragments rely on the codec envelope's
 *   declarations). A prefix used but neither declared in `xml` nor given here throws.
 * @returns {{ name: string, attributes: Record<string, string>, children: Array<object|string> }} root element
 */
export function xmlInfoset(xml, inScope = {}) {
  if (typeof xml !== 'string') throw new TypeError('xmlInfoset needs an XML string');
  const reader = new Reader(xml);
  DECLARATION.lastIndex = 0;
  if (DECLARATION.test(xml)) reader.at = DECLARATION.lastIndex;
  reader.skipMisc();
  const root = reader.element(new Map([['xml', XML_NS], ...Object.entries(inScope)]));
  reader.skipMisc();
  if (reader.at !== xml.length) reader.fail('content after the root element');
  return root;
}

class Reader {
  constructor(xml) {
    this.xml = xml;
    this.at = 0;
  }

  fail(message) {
    throw new Error(`xmlInfoset: ${message} at offset ${this.at}`);
  }

  startsWith(text) {
    return this.xml.startsWith(text, this.at);
  }

  expect(text) {
    if (!this.startsWith(text)) this.fail(`expected ${text}`);
    this.at += text.length;
  }

  skipSpace() {
    WHITESPACE.lastIndex = this.at;
    WHITESPACE.exec(this.xml);
    this.at = WHITESPACE.lastIndex;
  }

  name() {
    NAME.lastIndex = this.at;
    const match = NAME.exec(this.xml);
    if (match === null) this.fail('expected a name');
    this.at = NAME.lastIndex;
    return match[0];
  }

  comment() {
    const end = this.xml.indexOf('-->', this.at + 4);
    if (end === -1) this.fail('unterminated comment');
    this.at = end + 3;
  }

  // Whitespace and comments before the root element or after it.
  skipMisc() {
    for (;;) {
      this.skipSpace();
      if (this.startsWith('<!--')) this.comment();
      else if (this.startsWith('<?') || this.startsWith('<!')) this.fail('unsupported markup outside the root element');
      else return;
    }
  }

  quoted() {
    const quote = this.xml[this.at];
    if (quote !== '"' && quote !== "'") this.fail('expected a quoted attribute value');
    const end = this.xml.indexOf(quote, this.at + 1);
    if (end === -1) this.fail('unterminated attribute value');
    const raw = this.xml.slice(this.at + 1, end);
    if (raw.includes('<')) this.fail('< in an attribute value');
    this.at = end + 1;
    return decode(raw, true);
  }

  element(parentScope) {
    this.expect('<');
    const qname = this.name();
    const raw = [];
    for (;;) {
      const before = this.at;
      this.skipSpace();
      if (this.startsWith('/>') || this.startsWith('>')) break;
      if (this.at === before) this.fail('expected whitespace before an attribute');
      const attribute = this.name();
      this.skipSpace();
      this.expect('=');
      this.skipSpace();
      raw.push({ qname: attribute, value: this.quoted() });
    }
    const selfClosing = this.startsWith('/>');
    this.at += selfClosing ? 2 : 1;

    const scope = new Map(parentScope);
    for (const { qname: attribute, value } of raw) {
      if (attribute === 'xmlns') scope.set('', value);
      else if (attribute.startsWith('xmlns:')) scope.set(attribute.slice(6), value);
    }
    const attributes = new Map();
    for (const { qname: attribute, value } of raw) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
      const key = attribute.includes(':') ? expandName(attribute, scope) : attribute;
      if (attributes.has(key)) this.fail(`duplicate attribute ${key}`);
      attributes.set(key, key === XSI_TYPE ? expandQName(value, scope) : value);
    }
    const sorted = [...attributes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const children = selfClosing ? [] : this.content(qname, scope);
    return { name: expandName(qname, scope), attributes: Object.fromEntries(sorted), children };
  }

  content(qname, scope) {
    const nodes = [];
    let text = '';
    let hasElement = false;
    for (;;) {
      if (this.at >= this.xml.length) this.fail(`unclosed element ${qname}`);
      if (this.xml[this.at] !== '<') {
        const next = this.xml.indexOf('<', this.at);
        const stop = next === -1 ? this.xml.length : next;
        text += decode(this.xml.slice(this.at, stop), false);
        this.at = stop;
      } else if (this.startsWith('</')) {
        this.at += 2;
        const closing = this.name();
        if (closing !== qname) this.fail(`</${closing}> closes ${qname}`);
        this.skipSpace();
        this.expect('>');
        break;
      } else if (this.startsWith('<!--')) {
        this.comment();
      } else if (this.startsWith('<![CDATA[')) {
        this.fail('CDATA sections are not supported');
      } else if (this.startsWith('<?') || this.startsWith('<!')) {
        this.fail('unsupported markup inside an element');
      } else {
        hasElement = true;
        nodes.push(text, this.element(scope));
        text = '';
      }
    }
    if (!hasElement) return text === '' ? [] : [text];
    nodes.push(text);
    return nodes.filter((node) => typeof node !== 'string' || !BLANK.test(node));
  }
}

// Expands a prefixed name with the in-scope namespace; an unprefixed name takes the default namespace (if any).
function expandName(qname, scope) {
  const colon = qname.indexOf(':');
  const prefix = colon === -1 ? '' : qname.slice(0, colon);
  const local = colon === -1 ? qname : qname.slice(colon + 1);
  if (!scope.has(prefix)) {
    if (prefix === '') return local;
    throw new Error(`xmlInfoset: undeclared namespace prefix ${prefix} in ${qname}`);
  }
  const uri = scope.get(prefix);
  return uri === '' ? local : `{${uri}}${local}`;
}

function expandQName(value, scope) {
  const text = value.trim();
  if (!/^[A-Za-z_][-A-Za-z0-9._]*(?::[A-Za-z_][-A-Za-z0-9._]*)?$/.test(text)) {
    throw new Error(`xmlInfoset: ${JSON.stringify(value)} is not a QName`);
  }
  return expandName(text, scope);
}

// End-of-line and attribute normalisation first, then one pass of character and entity references, so a decoded
// character is never normalised or decoded again.
function decode(raw, attribute) {
  const lines = raw.replace(/\r\n?/g, '\n');
  const normal = attribute ? lines.replace(/[\t\n]/g, ' ') : lines;
  if (normal.replace(REFERENCE, '').includes('&')) throw new Error('xmlInfoset: a bare & or an unknown entity');
  return normal.replace(REFERENCE, (match, hex, decimal, named) => {
    if (named !== undefined) return ENTITY[named];
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new Error(`xmlInfoset: ${match} is not an XML character`);
    }
    return String.fromCodePoint(code);
  });
}
