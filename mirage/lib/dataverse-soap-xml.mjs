// Dataverse SOAP 1.1 codec for the Organization service: a namespace-aware XML reader,
// the Dataverse value model (decode and encode), Execute envelopes, DataContract member
// order and OrganizationServiceFault. Pure functions, no sockets.
import { DataError } from './data-error.mjs';
import { xmlDecode, xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { exactNumeric, fixedScaleNumeric } from './exact-numeric.mjs';

// Canonical http:// URIs. Microsoft samples show https:// forms; canonical() folds them.
export const NS = {
  s: 'http://schemas.xmlsoap.org/soap/envelope/',
  a: 'http://schemas.microsoft.com/xrm/2011/Contracts',
  svc: 'http://schemas.microsoft.com/xrm/2011/Contracts/Services',
  g: 'http://schemas.microsoft.com/crm/2011/Contracts',
  l: 'http://schemas.microsoft.com/xrm/2012/Contracts', // ExecuteMultipleSettings, ExecuteMultipleResponseItem
  o: 'http://schemas.microsoft.com/xrm/7.1/Contracts', // KeyAttributeCollection, ExecuteTransactionFault, OrganizationResponseCollection
  x9: 'http://schemas.microsoft.com/xrm/9.0/Contracts', // OptionSetValueCollection
  x14: 'http://schemas.microsoft.com/xrm/2014/Contracts', // OrganizationDetail (Microsoft.Xrm.Sdk.Organization)
  b: 'http://schemas.datacontract.org/2004/07/System.Collections.Generic',
  c: 'http://www.w3.org/2001/XMLSchema',
  e: 'http://schemas.microsoft.com/2003/10/Serialization/',
  f: 'http://schemas.microsoft.com/2003/10/Serialization/Arrays', // ColumnSet.Columns items (assumed)
  i: 'http://www.w3.org/2001/XMLSchema-instance',
};
const PREFIX = new Map(Object.entries(NS).map(([prefix, uri]) => [uri, prefix]));
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const KVP = 'a:KeyValuePairOfstringanyType';
const KEY_ATTRIBUTE_KVP = 'o:KeyValuePairOfstringanyType'; // KeyAttributeCollection is in xrm/7.1
const SPECIAL_DOUBLE = new Map([
  ['INF', Infinity],
  ['-INF', -Infinity],
  ['NaN', NaN],
]);
const HEADER_NAMES = ['CallerId', 'CallerObjectId', 'SdkClientVersion', 'UserType'];
const SCALAR_TYPES = [
  'string',
  'int',
  'long',
  'decimal',
  'double',
  'boolean',
  'dateTime',
  'guid',
  'base64',
  'duration',
];

const canonical = (uri) => uri.replace(/^https:\/\//i, 'http://');
const xmlError = (message) => new DataError(message, 400, 'InvalidRequest');
const esc = (value) => xmlEscapeAttribute(value);
const splitName = (qname) => {
  const colon = qname.indexOf(':');
  return colon < 0 ? ['', qname] : [qname.slice(0, colon), qname.slice(colon + 1)];
};
const isDeclaration = (name) => name === 'xmlns' || name.startsWith('xmlns:');

// Reader: nodes are { raw, ns, name, attrs: [{ ns, name, value }], children, text, scope }.
const NAME = /[A-Za-z_][\w.:-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const TAG_END = /\s*(\/?)>/y;
const CLOSE_END = /\s*>/y;

const matchAt = (pattern, text, index) => {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match && { match, end: pattern.lastIndex };
};
const after = (text, marker, from) => {
  const index = text.indexOf(marker, from);
  if (index < 0) throw xmlError('Unterminated markup in SOAP XML');
  return index + marker.length;
};
const resolvePrefix = (scope, prefix) => {
  if (!prefix) return scope.get('') ?? '';
  const uri = scope.get(prefix);
  if (uri === undefined) throw xmlError(`Undeclared XML prefix '${prefix}'`);
  return uri;
};
const declareScope = (scope, attributes) => {
  const declarations = attributes.filter(([name]) => isDeclaration(name));
  if (!declarations.length) return scope;
  const next = new Map(scope);
  for (const [name, uri] of declarations) next.set(name === 'xmlns' ? '' : name.slice(6), canonical(uri));
  return next;
};
// xmlDecode throws a RangeError for an out-of-range character reference; the client needs a 400.
const decodeText = (text) => {
  try {
    return xmlDecode(text);
  } catch {
    throw xmlError('Invalid character reference in SOAP XML');
  }
};
const addText = (node, text) => {
  if (node.name !== '#document') node.text += text;
  else if (text.trim()) throw xmlError('Text outside the SOAP root element');
};

function openTag(stack, text, start) {
  const name = matchAt(NAME, text, start + 1);
  if (!name) throw xmlError('Malformed SOAP XML element');
  const attributes = [];
  let at = name.end;
  let attr;
  while ((attr = matchAt(ATTRIBUTE, text, at))) {
    attributes.push([attr.match[1], decodeText(attr.match[2] ?? attr.match[3])]);
    at = attr.end;
  }
  const tag = matchAt(TAG_END, text, at);
  if (!tag) throw xmlError('Malformed SOAP XML start tag');
  const parent = stack.at(-1);
  const scope = declareScope(parent.scope, attributes);
  const [prefix, local] = splitName(name.match[0]);
  const element = {
    raw: name.match[0],
    ns: resolvePrefix(scope, prefix),
    name: local,
    attrs: attributes
      .filter(([attrName]) => !isDeclaration(attrName))
      .map(([attrName, value]) => {
        const [attrPrefix, attrLocal] = splitName(attrName);
        return { ns: attrPrefix ? resolvePrefix(scope, attrPrefix) : '', name: attrLocal, value };
      }),
    children: [],
    text: '',
    scope,
  };
  parent.children.push(element);
  if (!tag.match[1]) stack.push(element);
  return tag.end;
}

function closeTag(stack, text, start) {
  const name = matchAt(NAME, text, start + 2);
  const close = name && matchAt(CLOSE_END, text, name.end);
  if (!close || stack.length === 1 || stack.at(-1).raw !== name.match[0])
    throw xmlError('Malformed or unbalanced SOAP XML closing tag');
  stack.pop();
  return close.end;
}

function markup(stack, text, start) {
  if (text.startsWith('<!--', start)) return after(text, '-->', start + 4);
  if (text.startsWith('<?', start)) return after(text, '?>', start + 2);
  if (text.startsWith('<![CDATA[', start)) {
    const end = after(text, ']]>', start + 9);
    addText(stack.at(-1), text.slice(start + 9, end - 3));
    return end;
  }
  return text[start + 1] === '/' ? closeTag(stack, text, start) : openTag(stack, text, start);
}

/** Namespace-aware reader for one XML document. DTDs and entity declarations are rejected. */
export function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw xmlError('SOAP XML declarations are not supported');
  const document = {
    raw: '#document',
    ns: '',
    name: '#document',
    attrs: [],
    children: [],
    text: '',
    scope: new Map([['xml', XML_NAMESPACE]]),
  };
  const stack = [document];
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const stop = lt < 0 ? text.length : lt;
    if (stop > pos) addText(stack.at(-1), decodeText(text.slice(pos, stop)));
    if (lt < 0) break;
    pos = markup(stack, text, lt);
  }
  if (stack.length !== 1 || document.children.length !== 1)
    throw xmlError('SOAP XML must contain one complete root element');
  return document.children[0];
}

// Accessors. Every lookup compares namespace URI and local name, never the prefix.
const attr = (node, ns, name) => node.attrs.find((a) => a.ns === ns && a.name === name)?.value;
const isNil = (node) => Boolean(node) && ['true', '1'].includes(attr(node, NS.i, 'nil'));
const kid = (node, ns, name) => node?.children.find((c) => c.ns === ns && c.name === name);
const kidText = (node, ns, name) => {
  const child = kid(node, ns, name);
  return child && !isNil(child) ? child.text : null;
};
// The declared `Value` member of an OptionSetValue, Money or AliasedValue element.
const valueNode = (node) => node.children.find((c) => c.name === 'Value');
const intOf = (node) => (node && !isNil(node) ? Number(node.text.trim()) : null);
const textOf = (node) => (node && !isNil(node) ? node.text.trim() : null);
function resolveQName(node, qname) {
  const [prefix, name] = splitName(qname);
  return { ns: resolvePrefix(node.scope, prefix), name };
}
function typeOf(node) {
  const qname = attr(node, NS.i, 'type');
  if (qname == null) return null;
  const { ns, name } = resolveQName(node, qname);
  return { key: `${PREFIX.get(ns) ?? ns}:${name}`, ns, name };
}

// Decoding. An untyped element decodes as a string, the SOAP default for xs:string.
const scalar =
  (type, read = (text) => text) =>
  (node) => ({ type, value: read(node.text.trim()) });
// long is a Number while it is exact (within 2^53), otherwise its decimal string.
const longOf = (text) => (Number.isSafeInteger(Number(text)) ? Number(text) : text);
const pairsOf = (container) =>
  (container?.children ?? []).map((pair) => [kidText(pair, NS.b, 'key'), kid(pair, NS.b, 'value')]);

/** Key/value pairs (DataContract KeyValuePair elements) as a Map. */
export const decodePairs = (container, read = decodeValue) =>
  new Map(pairsOf(container).map(([key, value]) => [key, read(value)]));

/** Decodes one typed element. Unknown types come back as { type: 'Raw', qname, node }. */
export function decodeValue(node) {
  if (!node || isNil(node)) return null;
  const type = typeOf(node);
  if (!type) return { type: 'string', value: node.text };
  const decode = DECODERS.get(type.key);
  return decode ? decode(node) : { type: 'Raw', qname: { ns: type.ns, name: type.name }, node };
}

function decodeReference(n) {
  return {
    type: 'EntityReference',
    logicalName: kidText(n, NS.a, 'LogicalName'),
    id: kidText(n, NS.a, 'Id'),
    name: kidText(n, NS.a, 'Name'),
    ...(kid(n, NS.a, 'RowVersion') ? { rowVersion: kidText(n, NS.a, 'RowVersion') } : {}),
    keyAttributes: decodePairs(kid(n, NS.a, 'KeyAttributes')),
  };
}

// RelatedEntities: each item is a KeyValuePair<Relationship, EntityCollection>. Key and value are
// declared members, so neither carries xsi:type.
function decodeRelated(n) {
  if (!n || isNil(n)) return null;
  return n.children.map((pair) => {
    const key = kid(pair, NS.b, 'key');
    const value = kid(pair, NS.b, 'value');
    return {
      relationship: {
        schemaName: kidText(key, NS.a, 'SchemaName'),
        primaryEntityRole: kidText(key, NS.a, 'PrimaryEntityRole'),
      },
      entities: value && !isNil(value) ? decodeCollection(value) : null,
    };
  });
}

function decodeEntity(n) {
  return {
    type: 'Entity',
    logicalName: kidText(n, NS.a, 'LogicalName'),
    id: kidText(n, NS.a, 'Id'),
    attributes: decodePairs(kid(n, NS.a, 'Attributes')),
    formattedValues: decodePairs(kid(n, NS.a, 'FormattedValues'), (v) => v?.text ?? null),
    keyAttributes: decodePairs(kid(n, NS.a, 'KeyAttributes')),
    relatedEntities: decodeRelated(kid(n, NS.a, 'RelatedEntities')),
    rowVersion: kidText(n, NS.a, 'RowVersion'),
    entityState: kidText(n, NS.a, 'EntityState'),
  };
}

function decodeCollection(n) {
  const count = kidText(n, NS.a, 'TotalRecordCount');
  const limit = kidText(n, NS.a, 'TotalRecordCountLimitExceeded');
  return {
    type: 'EntityCollection',
    entityName: kidText(n, NS.a, 'EntityName'),
    entities: (kid(n, NS.a, 'Entities')?.children ?? []).map((e) => decodeEntity(e)),
    moreRecords: ['true', '1'].includes(kidText(n, NS.a, 'MoreRecords')),
    pagingCookie: kidText(n, NS.a, 'PagingCookie'),
    totalRecordCount: count == null ? null : Number(count),
    totalRecordCountLimitExceeded: limit == null ? null : ['true', '1'].includes(limit),
    minActiveRowVersion: kidText(n, NS.a, 'MinActiveRowVersion'),
  };
}

/** Do not discard configured SDK query facets that the local executor cannot
 * represent. Normal SDK serializers emit empty collections and nil defaults. */
export function assertSoapQueryProperties(node, type, properties) {
  for (const [name, kind] of Object.entries(properties)) {
    const member = kid(node, NS.a, name);
    if (!member || isNil(member)) continue;
    if (
      kind !== 'object' &&
      !member.children.length &&
      (kind === 'collection' ? member.text.trim() === '' : member.text === '')
    )
      continue;
    throw new DataError(`Unsupported configured SDK property: ${type}.${name}`, 501, 'LocalPluginQueryUnsupported');
  }
}

/** ColumnSet is also a declared DataContract member without xsi:type. */
export function decodeColumnSet(node) {
  if (!node || isNil(node)) return null;
  const declaredType = typeOf(node);
  if (declaredType && declaredType.key !== 'a:ColumnSet') throw xmlError('ColumnSet has an incompatible SDK type.');
  assertSoapQueryProperties(node, 'ColumnSet', { AttributeExpressions: 'collection' });
  return {
    type: 'ColumnSet',
    allColumns: ['true', '1'].includes(kidText(node, NS.a, 'AllColumns')),
    columns: (kid(node, NS.a, 'Columns')?.children ?? []).map((c) => c.text),
  };
}

const DECODERS = new Map([
  ['c:string', (n) => ({ type: 'string', value: n.text })],
  ['c:int', scalar('int', Number)],
  ['c:long', scalar('long', longOf)],
  ['c:decimal', scalar('decimal')],
  ['c:double', scalar('double', (t) => SPECIAL_DOUBLE.get(t) ?? Number(t))],
  ['c:boolean', scalar('boolean', (t) => t === 'true' || t === '1')],
  ['c:dateTime', scalar('dateTime')],
  ['e:guid', scalar('guid')],
  ['c:base64Binary', scalar('base64')],
  ['e:duration', scalar('duration')],
  ['a:EntityReference', decodeReference],
  ['a:OptionSetValue', (n) => ({ type: 'OptionSetValue', value: intOf(valueNode(n)) })],
  ['a:Money', (n) => ({ type: 'Money', value: textOf(valueNode(n)) })],
  [
    'x9:OptionSetValueCollection',
    (n) => ({
      type: 'OptionSetValueCollection',
      values: n.children.map((item) => intOf(valueNode(item))),
    }),
  ],
  ['a:ColumnSet', decodeColumnSet],
  [
    'a:EntityReferenceCollection',
    (n) => ({
      type: 'EntityReferenceCollection',
      values: n.children.map((item) => decodeReference(item)),
    }),
  ],
  [
    'a:AliasedValue',
    (n) => ({
      type: 'AliasedValue',
      attribute: kidText(n, NS.a, 'AttributeLogicalName'),
      entity: kidText(n, NS.a, 'EntityLogicalName'),
      value: decodeValue(valueNode(n)),
    }),
  ],
  [
    'a:Relationship',
    (n) => ({
      type: 'Relationship',
      schemaName: kidText(n, NS.a, 'SchemaName'),
      primaryEntityRole: kidText(n, NS.a, 'PrimaryEntityRole'),
    }),
  ],
  ['a:Entity', decodeEntity],
  ['a:EntityCollection', decodeCollection],
  // Serialization/Arrays: a SOAP array of scalars (item element names are assumed to be the scalar names).
  ['f:ArrayOfstring', (n) => ({ type: 'Array', values: n.children.map((c) => (isNil(c) ? null : c.text)) })],
  [
    'f:ArrayOfint',
    (n) => ({ type: 'Array', values: n.children.map((c) => (isNil(c) ? null : Number(c.text.trim()))) }),
  ],
  ['f:ArrayOfguid', (n) => ({ type: 'Array', values: n.children.map((c) => (isNil(c) ? null : c.text.trim())) })],
]);

// Encoding. Element names use the canonical prefixes, which envelope() declares on the root.
const nil = (name) => `<${name} i:nil="true"/>`;
const typed = (name, qname, body) => `<${name} i:type="${qname}">${body}</${name}>`;
const plain = (name, text) => `<${name}>${esc(text)}</${name}>`;
const plainOrNil = (name, value) => (value == null ? nil(name) : plain(name, value));
const maybe = (value, render) => (value == null ? '' : render(value));
const pairItems = (entries, toValue, wrap = KVP) =>
  [...entries].map(([key, value]) => `<${wrap}><b:key>${esc(key)}</b:key>${toValue(value)}</${wrap}>`).join('');
const pairs = (name, entries, toValue = (v) => encodeValue('b:value', v), wrap = KVP) =>
  `<${name}>${pairItems(entries, toValue, wrap)}</${name}>`;
const scalarEncoder =
  (qname, text = String) =>
  (name, v) =>
    typed(name, qname, esc(text(v.value)));
const doubleText = (x) => (Number.isNaN(x) ? 'NaN' : x === Infinity ? 'INF' : x === -Infinity ? '-INF' : String(x));
// An invalid Date has no ISO form; toISOString would throw a RangeError, so it is a 400 fault instead.
const dateText = (x) => {
  if (!(x instanceof Date)) return String(x);
  if (Number.isNaN(x.getTime()))
    throw new DataError('The date-time value is not a valid date.', 400, 'InvalidRequest', { innerCode: '0x80040203' });
  return x.toISOString();
};
// Money is an exact decimal with four digits (the Web API scale); the Value is typed c:decimal.
const moneyValue = (value) =>
  value == null ? nil('a:Value') : typed('a:Value', 'c:decimal', esc(fixedScaleNumeric(value, 4).lexeme));

// Declared members (EntityReference fields, Relationship fields) carry no xsi:type.
const referenceBody = (r) =>
  maybe(r.id, (id) => plain('a:Id', id)) +
  maybe(r.keyAttributes, (keys) => pairs('a:KeyAttributes', keys, undefined, KEY_ATTRIBUTE_KVP)) +
  maybe(r.logicalName, (logical) => plain('a:LogicalName', logical)) +
  (r.name == null ? nil('a:Name') : plain('a:Name', r.name)) +
  (Object.hasOwn(r, 'rowVersion') ? plainOrNil('a:RowVersion', r.rowVersion) : '');
const encodeReference = (name, r) => typed(name, 'a:EntityReference', referenceBody(r));
const relationshipBody = (r) =>
  maybe(r.primaryEntityRole, (x) => plain('a:PrimaryEntityRole', x)) + plain('a:SchemaName', r.schemaName);

// DataContract order: Entities, EntityName, MinActiveRowVersion, MoreRecords, PagingCookie,
// TotalRecordCount, TotalRecordCountLimitExceeded. Both counts are always written: a missing
// TotalRecordCount reads as 0 in the SDK, while Dataverse sends -1 when no count was requested.
const collectionBody = (c) =>
  `<a:Entities>${(c.entities ?? []).map((e) => encodeEntity('a:Entity', e, false)).join('')}</a:Entities>` +
  maybe(c.entityName, (x) => plain('a:EntityName', x)) +
  maybe(c.minActiveRowVersion, (x) => plain('a:MinActiveRowVersion', x)) +
  `<a:MoreRecords>${Boolean(c.moreRecords)}</a:MoreRecords>` +
  maybe(c.pagingCookie, (x) => plain('a:PagingCookie', x)) +
  plain('a:TotalRecordCount', String(c.totalRecordCount ?? -1)) +
  plain('a:TotalRecordCountLimitExceeded', String(c.totalRecordCountLimitExceeded ?? false));
const encodeCollection = (name, c) => typed(name, 'a:EntityCollection', collectionBody(c));

// Items are KeyValuePair<Relationship, EntityCollection>; key and value are declared, so no xsi:type.
function encodeRelated(list) {
  return `<a:RelatedEntities>${list
    .map(
      (r) =>
        `<a:KeyValuePairOfRelationshipEntityCollection><b:key>${relationshipBody(r.relationship)}</b:key>` +
        (r.entities == null ? nil('b:value') : `<b:value>${collectionBody(r.entities)}</b:value>`) +
        '</a:KeyValuePairOfRelationshipEntityCollection>',
    )
    .join('')}</a:RelatedEntities>`;
}

// DataContract order: Attributes, EntityState, FormattedValues, Id, KeyAttributes, LogicalName,
// RelatedEntities, RowVersion. FormattedValues is KeyValuePair<string,string>: untyped values.
function encodeEntity(name, e, typedElement) {
  const body =
    maybe(e.attributes, (m) => pairs('a:Attributes', m)) +
    maybe(e.entityState, (s) => plain('a:EntityState', s)) +
    maybe(
      e.formattedValues,
      (m) =>
        `<a:FormattedValues>${pairItems(m, (v) => plainOrNil('b:value', v), 'a:KeyValuePairOfstringstring')}</a:FormattedValues>`,
    ) +
    maybe(e.id, (id) => plain('a:Id', id)) +
    maybe(e.keyAttributes, (m) => pairs('a:KeyAttributes', m, undefined, KEY_ATTRIBUTE_KVP)) +
    maybe(e.logicalName, (logical) => plain('a:LogicalName', logical)) +
    maybe(e.relatedEntities, (list) => encodeRelated(list)) +
    maybe(e.rowVersion, (version) => plain('a:RowVersion', version));
  return `<${name}${typedElement ? ' i:type="a:Entity"' : ''}>${body}</${name}>`;
}

const ENCODERS = new Map([
  ['string', scalarEncoder('c:string')],
  ['int', scalarEncoder('c:int')],
  ['long', scalarEncoder('c:long')],
  ['decimal', scalarEncoder('c:decimal')],
  ['double', scalarEncoder('c:double', doubleText)],
  ['boolean', scalarEncoder('c:boolean')],
  ['dateTime', scalarEncoder('c:dateTime', dateText)],
  ['guid', scalarEncoder('e:guid')],
  ['base64', scalarEncoder('c:base64Binary')],
  ['duration', scalarEncoder('e:duration')],
  ['EntityReference', encodeReference],
  ['OptionSetValue', (name, v) => typed(name, 'a:OptionSetValue', plainOrNil('a:Value', v.value))],
  [
    'Money',
    (name, v) =>
      typed(
        name,
        'a:Money',
        v.sdkExact && v.value != null
          ? typed('a:Value', 'c:decimal', esc(exactNumeric(v.value, 'Money', { collapse: false }).value))
          : moneyValue(v.value),
      ),
  ],
  [
    'OptionSetValueCollection',
    (name, v) =>
      typed(
        name,
        'x9:OptionSetValueCollection',
        v.values
          .map((x) =>
            x == null ? nil('x9:OptionSetValue') : `<x9:OptionSetValue>${plainOrNil('a:Value', x)}</x9:OptionSetValue>`,
          )
          .join(''),
      ),
  ],
  [
    'ColumnSet',
    (name, v) =>
      typed(
        name,
        'a:ColumnSet',
        plain('a:AllColumns', String(v.allColumns === true)) +
          `<a:Columns>${(v.columns ?? []).map((c) => plain('f:string', c)).join('')}</a:Columns>`,
      ),
  ],
  [
    'EntityReferenceCollection',
    (name, v) =>
      typed(
        name,
        'a:EntityReferenceCollection',
        v.values.map((r) => `<a:EntityReference>${referenceBody(r)}</a:EntityReference>`).join(''),
      ),
  ],
  [
    'AliasedValue',
    (name, v) =>
      typed(
        name,
        'a:AliasedValue',
        plainOrNil('a:AttributeLogicalName', v.attribute) +
          plainOrNil('a:EntityLogicalName', v.entity) +
          encodeValue('a:Value', v.value),
      ),
  ],
  ['Relationship', (name, r) => typed(name, 'a:Relationship', relationshipBody(r))],
  ['Entity', (name, v) => encodeEntity(name, v, true)],
  ['EntityCollection', encodeCollection],
]);

// Typed wrappers whose null value is nil as a whole. Other typed values (an AliasedValue, whose
// inner value may be null) stay typed and write their own nil <a:Value/>.
const NIL_WHEN_VALUE_NULL = new Set([...SCALAR_TYPES, 'OptionSetValue', 'Money']);

/** Encodes a value as one element named `name`. Scalars may be plain JS strings or booleans. */
export function encodeValue(name, value) {
  if (value == null || (typeof value === 'object' && NIL_WHEN_VALUE_NULL.has(value.type) && value.value === null))
    return nil(name);
  if (typeof value === 'string') return typed(name, 'c:string', esc(value));
  if (typeof value === 'boolean') return typed(name, 'c:boolean', String(value));
  const encode = ENCODERS.get(value.type);
  if (!encode) throw xmlError(`Unsupported SOAP value type '${value.type}'`);
  return encode(name, value);
}

const DECLARATIONS = Object.entries(NS)
  .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
  .join('');

/** SOAP 1.1 envelope around a body fragment. No WS-Addressing headers. */
export const envelope = (bodyXml) => `<s:Envelope${DECLARATIONS}><s:Body>${bodyXml}</s:Body></s:Envelope>`;

/** Body fragment for an Execute response. `results` is a Map (or [key, value] pairs). */
export function executeResponse({ responseType, namespace, responseName, results = new Map() }) {
  return (
    `<svc:ExecuteResponse><svc:ExecuteResult xmlns:r="${namespace}" i:type="r:${responseType}">` +
    plain('a:ResponseName', responseName) +
    pairs('a:Results', results) +
    '</svc:ExecuteResult></svc:ExecuteResponse>'
  );
}

/**
 * Full SOAP fault envelope. `errorCode` is the signed 32-bit code (for example -2147220969). With `faultedRequestIndex`
 * the detail is still an OrganizationServiceFault element (xrm/2011, the element WCF reads FaultException<T> from), typed
 * by i:type as ExecuteTransactionFault (xrm/7.1, DataContract name "ExecuteTransactionFault"). Its base
 * members come first, then FaultedRequestIndex, the derived member. Without i:type WCF falls back to a plain FaultException.
 * The i and o prefixes are declared on the fault element: WCF reads the detail without the envelope's declarations, so an
 * i:type prefix declared only on the root resolves to no namespace ("contains data of the ':ExecuteTransactionFault' data contract").
 */
export function fault({
  errorCode,
  message,
  timestamp,
  traceText = null,
  errorDetails = new Map(),
  faultedRequestIndex,
}) {
  if (!Number.isInteger(errorCode)) throw new TypeError('fault errorCode must be a signed integer');
  const transaction = faultedRequestIndex != null;
  const typeAttr = transaction ? ' i:type="o:ExecuteTransactionFault"' : '';
  const derivedNs = transaction ? ` xmlns:o="${NS.o}"` : '';
  const derived = transaction ? `<o:FaultedRequestIndex>${faultedRequestIndex}</o:FaultedRequestIndex>` : '';
  return envelope(
    '<s:Fault><faultcode>s:Client</faultcode><faultstring xml:lang="en-US">' +
      esc(message) +
      '</faultstring>' +
      `<detail><OrganizationServiceFault xmlns="${NS.a}" xmlns:i="${NS.i}"${derivedNs}${typeAttr}>` +
      `<ErrorCode>${errorCode}</ErrorCode>` +
      // ErrorDetailCollection is in xrm/2011 under the default namespace.
      `<ErrorDetails xmlns:b="${NS.b}">${pairItems(errorDetails, (v) => encodeValue('b:value', v), 'KeyValuePairOfstringanyType')}</ErrorDetails>` +
      plain('Message', message) +
      plain('Timestamp', timestamp) +
      `<InnerFault i:nil="true"/>` +
      (traceText == null ? `<TraceText i:nil="true"/>` : plain('TraceText', traceText)) +
      derived +
      '</OrganizationServiceFault></detail></s:Fault>',
  );
}

const SOAP_HEADERS = (root) => {
  const header = kid(root, NS.s, 'Header');
  const headers = {};
  for (const name of HEADER_NAMES) {
    // Header namespace not known: matched by local name only.
    const node = header?.children.find((c) => c.name === name);
    if (node) headers[name] = node.text.trim();
  }
  return headers;
};

/** Parses a request or response envelope. `request` is the Body operation element (for example Execute). */
export function parseEnvelope(text) {
  const root = parseXml(text);
  const body = kid(root, NS.s, 'Body');
  if (root.ns !== NS.s || root.name !== 'Envelope' || !body) throw xmlError('Not a SOAP 1.1 envelope with a Body');
  const operation = body.children[0];
  if (!operation) throw xmlError('SOAP Body has no operation element');
  return { headers: SOAP_HEADERS(root), operation: operation.name, request: operation };
}

/** Reads the `request` child of an Execute element (pass the operation element from parseEnvelope). */
export function parseOrganizationRequest(el) {
  const request = kid(el, NS.svc, 'request');
  if (!request) throw xmlError(`${el.name} has no request element`);
  return {
    requestName: kidText(request, NS.a, 'RequestName'),
    requestType: typeOf(request)?.name ?? null,
    requestId: kidText(request, NS.a, 'RequestId'),
    parameters: decodePairs(kid(request, NS.a, 'Parameters')),
  };
}
