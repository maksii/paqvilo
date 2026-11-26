import { createHash, sign, timingSafeEqual, verify } from 'node:crypto';

/**
 * XML for the local SAML 2.0 and WS-Federation identity flows: a strict reader, Exclusive XML Canonicalization 1.0
 * without comments (https://www.w3.org/TR/xml-exc-c14n/) and enveloped XML signatures
 * (https://www.w3.org/TR/xmldsig-core1/) with RSA-SHA256 and SHA-256.
 *
 * The reader keeps the document order of elements and text and every element's namespace scope, as canonicalization
 * needs. It refuses document type declarations, entity declarations, comments, processing instructions other than the
 * XML declaration, undeclared prefixes, duplicate attributes, other than the predefined and numeric character
 * references, and documents over the size, depth, node, namespace declaration or attribute limits. A refused document
 * is an XmlProblem.
 *
 * verifyEnvelopedSignature trusts only the caller's key (never a KeyInfo of the message), accepts exactly one Reference
 * to the signed element's own ID with the enveloped-signature and exclusive canonicalization transforms, and refuses an
 * ID that more than one element of the document carries, so a signature cannot vouch for a wrapped copy.
 */

export const NS = Object.freeze({
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
});
const ALGORITHMS = Object.freeze({
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
});
// Namespace declarations are bounded per element and per document, and attributes per element: a scope is shared by
// the elements that declare nothing, so reading costs no more than the document's size.
const LIMITS = {
  bytes: 512 * 1024,
  depth: 48,
  nodes: 20_000,
  declarationsPerElement: 64,
  declarations: 256,
  attributesPerElement: 128,
};
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.-]/;
const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export class XmlProblem extends Error {}
const problem = (message) => new XmlProblem(message);

/** A name (NCName, optionally prefixed) at `at`, ASCII only; the end index or -1. */
function nameEnd(text, at) {
  if (!NAME_START.test(text[at] ?? '')) return -1;
  let end = at + 1;
  let colons = 0;
  while (end < text.length && (NAME_CHAR.test(text[end]) || text[end] === ':')) {
    if (text[end] === ':') {
      colons += 1;
      if (colons > 1 || !NAME_START.test(text[end + 1] ?? '')) return -1;
    }
    end += 1;
  }
  return end;
}

/** Whether a character reference names a character XML 1.0 allows (XML 1.0 2.2 Char). */
const allowedCharacter = (code) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

function referenceText(body) {
  if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body];
  if (!/^#\d{1,7}$/.test(body) && !/^#x[\da-fA-F]{1,6}$/.test(body))
    throw problem(`Undeclared entity reference &${body};.`);
  const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
  if (!allowedCharacter(code)) throw problem('Invalid character reference.');
  return String.fromCodePoint(code);
}

function decodeReferences(raw) {
  let out = '';
  let at = 0;
  while (at < raw.length) {
    const amp = raw.indexOf('&', at);
    if (amp < 0) return out + raw.slice(at);
    const semi = raw.indexOf(';', amp);
    if (semi < 0 || semi - amp > 10) throw problem('Malformed character reference.');
    out += raw.slice(at, amp) + referenceText(raw.slice(amp + 1, semi));
    at = semi + 1;
  }
  return out;
}

const splitName = (qname) => {
  const index = qname.indexOf(':');
  return index < 0 ? ['', qname] : [qname.slice(0, index), qname.slice(index + 1)];
};
const skipSpace = (text, at) => {
  let pos = at;
  while (/\s/.test(text[pos] ?? '')) pos += 1;
  return pos;
};

/** One `name="value"` attribute at `at`; returns { qname, value, end }. */
function readAttribute(text, at) {
  const end = nameEnd(text, at);
  if (end < 0) throw problem('Malformed attribute name.');
  let pos = skipSpace(text, end);
  if (text[pos] !== '=') throw problem('Malformed attribute.');
  pos = skipSpace(text, pos + 1);
  const quote = text[pos];
  if (quote !== '"' && quote !== "'") throw problem('Unquoted attribute value.');
  const close = text.indexOf(quote, pos + 1);
  if (close < 0) throw problem('Unterminated attribute value.');
  const raw = text.slice(pos + 1, close);
  if (raw.includes('<')) throw problem('"<" in an attribute value.');
  // Attribute-value normalization: literal whitespace characters become spaces, references keep theirs.
  return { qname: text.slice(at, end), value: decodeReferences(raw.replace(/[\t\n\r]/g, ' ')), end: close + 1 };
}

/** Attributes of a start tag from `at`; returns { attributes, end, selfClosing }. */
function readAttributes(text, at) {
  const attributes = [];
  const seen = new Set();
  let pos = at;
  for (;;) {
    const before = pos;
    pos = skipSpace(text, pos);
    if (text.startsWith('/>', pos)) return { attributes, end: pos + 2, selfClosing: true };
    if (text[pos] === '>') return { attributes, end: pos + 1, selfClosing: false };
    if (pos === before) throw problem('Malformed start tag.');
    const { qname, value, end } = readAttribute(text, pos);
    if (seen.has(qname)) throw problem(`Duplicate attribute ${qname}.`);
    if (attributes.length >= LIMITS.attributesPerElement) throw problem('An element has too many attributes.');
    seen.add(qname);
    attributes.push({ qname, value });
    pos = end;
  }
}

/**
 * The namespace bindings in scope at an element: its own declarations, then its ancestors'. An element that declares
 * nothing shares its parent's scope.
 */
class Scope {
  constructor(parent, bindings) {
    this.parent = parent;
    this.bindings = bindings;
  }
  get(prefix) {
    for (let scope = this; scope; scope = scope.parent)
      if (scope.bindings.has(prefix)) return scope.bindings.get(prefix);
    return undefined;
  }
  has(prefix) {
    return this.get(prefix) !== undefined;
  }
}

/** An element's namespace declarations (prefix: URI) and its other attributes, within the declaration limits. */
function declarationsOf(state, attributes) {
  const declared = new Map();
  const plain = [];
  for (const attribute of attributes) {
    if (attribute.qname === 'xmlns' || attribute.qname.startsWith('xmlns:')) {
      const prefix = attribute.qname === 'xmlns' ? '' : attribute.qname.slice(6);
      if (prefix === 'xml' || prefix === 'xmlns' || (prefix && !attribute.value))
        throw problem(`Reserved or empty namespace declaration ${attribute.qname}.`);
      declared.set(prefix, attribute.value);
    } else plain.push(attribute);
  }
  if (declared.size > LIMITS.declarationsPerElement) throw problem('An element declares too many namespaces.');
  state.declarations += declared.size;
  if (state.declarations > LIMITS.declarations) throw problem('The document declares too many namespaces.');
  return { declared, plain };
}

function element(state, parent, qname, attributes) {
  const { declared, plain } = declarationsOf(state, attributes);
  const scope = declared.size ? new Scope(parent.scope, declared) : parent.scope;
  const resolve = (prefix) => {
    if (prefix === 'xml') return NS.xml;
    if (!scope.has(prefix)) throw problem(`Undeclared namespace prefix ${prefix}.`);
    return scope.get(prefix);
  };
  const [prefix, local] = splitName(qname);
  const node = {
    type: 'element',
    qname,
    prefix,
    local,
    ns: prefix ? resolve(prefix) : (scope.get('') ?? ''),
    attrs: plain.map((attribute) => {
      const [attrPrefix, attrLocal] = splitName(attribute.qname);
      return {
        qname: attribute.qname,
        prefix: attrPrefix,
        local: attrLocal,
        ns: attrPrefix ? resolve(attrPrefix) : '',
        value: attribute.value,
      };
    }),
    declared,
    scope,
    children: [],
    parent: parent.type === 'element' ? parent : null,
  };
  const seen = new Set(node.attrs.map((attribute) => `${attribute.ns}|${attribute.local}`));
  if (seen.size !== node.attrs.length) throw problem('Duplicate attribute after namespace resolution.');
  return node;
}

/** Skips the XML declaration and whitespace at the start; refuses any other prolog markup. */
function prologEnd(text) {
  let pos = 0;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;
  if (text.startsWith('<?xml', pos) && /\s/.test(text[pos + 5] ?? '')) {
    const end = text.indexOf('?>', pos);
    if (end < 0) throw problem('Unterminated XML declaration.');
    pos = end + 2;
  }
  return pos;
}

/** The reader's state over one document: the open elements and the element count. */
function reader(text) {
  const document = { type: 'document', scope: new Scope(null, new Map([['', '']])), children: [] };
  return { text, document, stack: [document], nodes: 0, declarations: 0 };
}
const current = (state) => state.stack.at(-1);
const inRoot = (state) => state.stack.length > 1;

function readText(state, from, to) {
  const value = decodeReferences(state.text.slice(from, to));
  if (inRoot(state)) current(state).children.push({ type: 'text', value });
  else if (value.trim()) throw problem('Text outside the root element.');
}
function readCData(state, lt) {
  const end = state.text.indexOf(']]>', lt + 9);
  if (end < 0 || !inRoot(state)) throw problem('Malformed CDATA section.');
  current(state).children.push({ type: 'text', value: state.text.slice(lt + 9, end) });
  return end + 3;
}
function readClose(state, lt) {
  const { text } = state;
  const end = nameEnd(text, lt + 2);
  const close = end < 0 ? -1 : text.indexOf('>', end);
  if (close < 0 || text.slice(end, close).trim() || !inRoot(state)) throw problem('Malformed closing tag.');
  if (current(state).qname !== text.slice(lt + 2, end)) throw problem('Unbalanced closing tag.');
  state.stack.pop();
  return close + 1;
}
function readOpen(state, lt) {
  const { text, document, stack } = state;
  const end = nameEnd(text, lt + 1);
  if (end < 0) throw problem('Malformed element name.');
  const { attributes, end: tagEnd, selfClosing } = readAttributes(text, end);
  state.nodes += 1;
  if (state.nodes > LIMITS.nodes) throw problem('The XML document has too many elements.');
  if (!inRoot(state) && document.children.length) throw problem('More than one root element.');
  const node = element(state, current(state), text.slice(lt + 1, end), attributes);
  current(state).children.push(node);
  if (!selfClosing) stack.push(node);
  if (stack.length > LIMITS.depth) throw problem('The XML document is nested too deeply.');
  return tagEnd;
}
function readMarkup(state, lt) {
  const { text } = state;
  if (text.startsWith('<![CDATA[', lt)) return readCData(state, lt);
  if (text[lt + 1] === '!' || text[lt + 1] === '?')
    throw problem('Comments, processing instructions and declarations are not accepted.');
  return text[lt + 1] === '/' ? readClose(state, lt) : readOpen(state, lt);
}

/** Reads one XML document; returns its root element. */
export function parseXml(input) {
  const raw = String(input ?? '');
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.bytes) throw problem('The XML document is too large.');
  // XML end-of-line handling (XML 1.0 2.11).
  const state = reader(raw.replace(/\r\n?/g, '\n'));
  const { text, document } = state;
  let pos = prologEnd(text);
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const stop = lt < 0 ? text.length : lt;
    if (stop > pos) readText(state, pos, stop);
    if (lt < 0) break;
    pos = readMarkup(state, lt);
  }
  if (inRoot(state) || document.children.length !== 1) throw problem('The XML document is incomplete.');
  return document.children[0];
}

// ---- accessors (namespace URI and local name, never the prefix) ----
export const childElements = (node, ns, local) =>
  (node?.children ?? []).filter(
    (child) => child.type === 'element' && (ns === undefined || (child.ns === ns && child.local === local)),
  );
export const child = (node, ns, local) => {
  const found = childElements(node, ns, local);
  if (found.length > 1) throw problem(`More than one ${local} element.`);
  return found[0] ?? null;
};
export const attribute = (node, local, ns = '') =>
  node?.attrs.find((item) => item.ns === ns && item.local === local)?.value ?? null;
/** The element's text content (its text children only; mixed content is refused). */
export function textOf(node) {
  if (!node) return null;
  if (node.children.some((item) => item.type === 'element')) throw problem(`${node.local} must contain text only.`);
  return node.children.map((item) => item.value).join('');
}
export function* descendants(node) {
  for (const item of node.children) {
    if (item.type !== 'element') continue;
    yield item;
    yield* descendants(item);
  }
}

// ---- Exclusive XML Canonicalization 1.0 (without comments) ----
const escapeText = (value) =>
  value.replace(/[&<>\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#xD;' })[c]);
const escapeAttribute = (value) =>
  value.replace(
    /[&<"\t\n\r]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' })[c],
  );
const byCodeUnits = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

function canonical(node, rendered, skip) {
  // The prefixes the element visibly uses: its own and its prefixed attributes' (xml is never declared).
  const used = new Set([node.prefix, ...node.attrs.filter((item) => item.prefix).map((item) => item.prefix)]);
  used.delete('xml');
  const inScope = new Map(rendered);
  const declarations = [];
  for (const prefix of [...used].sort(byCodeUnits)) {
    const uri = node.scope.get(prefix) ?? '';
    // A namespace node is rendered unless the nearest output ancestor rendered the same one; an empty default
    // namespace only undeclares a rendered non-empty one.
    if (prefix ? rendered.get(prefix) === uri : (rendered.get('') ?? '') === uri) continue;
    declarations.push(prefix ? ` xmlns:${prefix}="${escapeAttribute(uri)}"` : ` xmlns="${escapeAttribute(uri)}"`);
    inScope.set(prefix, uri);
  }
  const attributes = [...node.attrs]
    .sort((a, b) => byCodeUnits(a.ns, b.ns) || byCodeUnits(a.local, b.local))
    .map((item) => ` ${item.qname}="${escapeAttribute(item.value)}"`);
  let out = `<${node.qname}${declarations.join('')}${attributes.join('')}>`;
  for (const item of node.children) {
    if (item === skip) continue;
    out += item.type === 'text' ? escapeText(item.value) : canonical(item, inScope, skip);
  }
  return `${out}</${node.qname}>`;
}

/** The exclusive canonical form of `node` as an apex of a document subset, without `skip` (enveloped signature). */
const canonicalize = (node, skip = null) => canonical(node, new Map(), skip);

// ---- enveloped signatures ----
const escape = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const DS_DECLARATION = ` xmlns:ds="${NS.ds}"`;
const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

function signedInfoXml(id, digest) {
  return (
    `<ds:SignedInfo xmlns:ds="${NS.ds}"><ds:CanonicalizationMethod Algorithm="${ALGORITHMS.excC14n}"/>` +
    `<ds:SignatureMethod Algorithm="${ALGORITHMS.rsaSha256}"/><ds:Reference URI="#${escape(id)}"><ds:Transforms>` +
    `<ds:Transform Algorithm="${ALGORITHMS.enveloped}"/><ds:Transform Algorithm="${ALGORITHMS.excC14n}"/>` +
    `</ds:Transforms><ds:DigestMethod Algorithm="${ALGORITHMS.sha256}"/><ds:DigestValue>${digest}</ds:DigestValue>` +
    `</ds:Reference></ds:SignedInfo>`
  );
}

/**
 * The ds:Signature element (text) for the element of `xml` whose ID attribute is `id`. The element must declare the
 * namespaces it uses, so its canonical form is the same standalone and in the document it is inserted into.
 */
export function envelopedSignature(xml, id, privateKey) {
  const root = parseXml(xml);
  const target = [root, ...descendants(root)].find((item) => attribute(item, 'ID') === id);
  if (!target) throw problem(`No element has the ID ${id}.`);
  const signedInfo = signedInfoXml(id, digestOf(canonicalize(target)));
  const value = sign('sha256', Buffer.from(canonicalize(parseXml(signedInfo)), 'utf8'), privateKey).toString('base64');
  return (
    `<ds:Signature xmlns:ds="${NS.ds}">${signedInfo.replace(DS_DECLARATION, '')}` +
    `<ds:SignatureValue>${value}</ds:SignatureValue></ds:Signature>`
  );
}

const algorithmOf = (node) => attribute(node, 'Algorithm');
const base64Bytes = (value) => {
  const compact = String(value ?? '').replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z\d+/]+={0,2}$/.test(compact)) throw problem('A signature value is not base64.');
  return Buffer.from(compact, 'base64');
};

/** The signed element's own ds:Signature child, or null when it has none. */
export const signatureOf = (node) => child(node, NS.ds, 'Signature');

/**
 * Verifies the enveloped signature of `node` (a child ds:Signature) with `publicKeys` (KeyObjects of the issuer's
 * metadata); throws an XmlProblem naming the failure. `root` is the whole document, for the ID uniqueness check.
 */
export function verifyEnvelopedSignature(root, node, publicKeys) {
  const signature = signatureOf(node);
  if (!signature) throw problem(`The ${node.local} element is not signed.`);
  const id = attribute(node, 'ID');
  if (!id) throw problem(`The signed ${node.local} element has no ID.`);
  if ([root, ...descendants(root)].filter((item) => attribute(item, 'ID') === id).length !== 1)
    throw problem(`The ID ${id} is not unique in the document.`);
  const signedInfo = child(signature, NS.ds, 'SignedInfo');
  if (!signedInfo) throw problem('The signature has no SignedInfo.');
  if (algorithmOf(child(signedInfo, NS.ds, 'CanonicalizationMethod')) !== ALGORITHMS.excC14n)
    throw problem('The signature does not use exclusive canonicalization.');
  if (algorithmOf(child(signedInfo, NS.ds, 'SignatureMethod')) !== ALGORITHMS.rsaSha256)
    throw problem('The signature method is not RSA-SHA256.');
  const references = childElements(signedInfo, NS.ds, 'Reference');
  if (references.length !== 1 || attribute(references[0], 'URI') !== `#${id}`)
    throw problem(`The signature does not reference the ${node.local} element alone.`);
  const transforms = childElements(child(references[0], NS.ds, 'Transforms'), NS.ds, 'Transform');
  if (
    transforms.length !== 2 ||
    algorithmOf(transforms[0]) !== ALGORITHMS.enveloped ||
    algorithmOf(transforms[1]) !== ALGORITHMS.excC14n ||
    transforms.some((item) => item.children.some((part) => part.type === 'element'))
  )
    throw problem('The signature transforms are not enveloped-signature and exclusive canonicalization.');
  if (algorithmOf(child(references[0], NS.ds, 'DigestMethod')) !== ALGORITHMS.sha256)
    throw problem('The digest method is not SHA-256.');
  const expected = base64Bytes(textOf(child(references[0], NS.ds, 'DigestValue')));
  const actual = createHash('sha256').update(canonicalize(node, signature), 'utf8').digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw problem(`The digest of the ${node.local} element does not match: it was altered after signing.`);
  const value = base64Bytes(textOf(child(signature, NS.ds, 'SignatureValue')));
  const bytes = Buffer.from(canonicalize(signedInfo), 'utf8');
  if (!publicKeys.some((key) => safeVerify(bytes, key, value)))
    throw problem(`The signature of the ${node.local} element is not valid for the issuer's signing keys.`);
}

function safeVerify(bytes, key, value) {
  try {
    return verify('sha256', bytes, key, value);
  } catch {
    return false;
  }
}

/** Escapes text and attribute values for the message builders. */
export const xmlEscape = escape;
