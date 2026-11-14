import { createHash } from 'node:crypto';
import { odataReaderTemplateDescriptor } from './webapi-error-details.mjs';
import { templateDataRecord, templateDataArray } from './error-template-data.mjs';

const TYPES = new Set([
  'Edm.String',
  'Edm.Int32',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Boolean',
  'Edm.DateTimeOffset',
  'Edm.Guid',
]);
const NODES = new Set(['StartObject', 'StartArray', 'PrimitiveValue', 'EndOfInput']);
const FIELDS = {
  'unreadable-stream': [],
  'decimal-string': ['expectedType'],
  'property-node': ['actualNode', 'expectedNode'],
  'root-node': ['actualNode', 'expectedNode'],
  'unexpected-token': [],
  'unrecognized-token': [],
  'unknown-property': [],
  'primitive-type': ['sourceType', 'expectedType'],
  'primitive-format': ['expectedType'],
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;

/** Keys contain neither submitted values nor property/record/site identifiers. */
export function webApiReaderTemplateKey(descriptor) {
  templateDataRecord(descriptor, 'Reader templates');
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    throw new Error('Reader template descriptor required');
  const fields =
    Object.hasOwn(descriptor, 'kind') && typeof descriptor.kind === 'string' && Object.hasOwn(FIELDS, descriptor.kind)
      ? FIELDS[descriptor.kind]
      : null;
  if (
    !fields ||
    Object.keys(descriptor).length !== fields.length + 1 ||
    Object.keys(descriptor).some((key) => key !== 'kind' && !fields.includes(key))
  )
    throw new Error('Finite reader template descriptor required');
  for (const field of fields)
    if (!(field.endsWith('Type') ? TYPES : NODES).has(descriptor[field]))
      throw new Error('Unsupported reader template type/node');
  return JSON.stringify(Object.fromEntries(['kind', ...fields].map((field) => [field, descriptor[field]])));
}

/** Trusted pack templates are explicit response emulation, never CLR execution. */
export function validateWebApiErrorTemplates(value) {
  templateDataRecord(value, 'Reader templates');
  if (
    value?.version !== 1 ||
    typeof value.evidence !== 'string' ||
    !value.evidence.trim() ||
    !Array.isArray(value.templates)
  )
    throw new Error('webApiErrorTemplates requires version1, evidence and 1..32 templates');
  const entries = templateDataArray(value.templates, { maximum: 32, label: 'Reader templates' });
  const keys = new Set();
  return entries.map((template) => {
    templateDataRecord(template, 'Reader templates');
    if (!['POST', 'PATCH'].includes(template?.method))
      throw new Error('Reader template requires an evidenced POST/PATCH method');
    const key = template.method + ':' + webApiReaderTemplateKey(template?.descriptor);
    if (keys.has(key)) throw new Error('Duplicate reader template descriptor');
    keys.add(key);
    if (
      typeof template.capturedSourceSha256 !== 'string' ||
      !SHA.test(template.capturedSourceSha256) ||
      typeof template.qualifiedVariationSha256 !== 'string' ||
      !SHA.test(template.qualifiedVariationSha256) ||
      typeof template.suffixSha256 !== 'string' ||
      !SHA.test(template.suffixSha256)
    )
      throw new Error('Reader template requires captured source, qualified variation and suffix SHA256');
    const suffix = template.suffix;
    if (
      typeof suffix !== 'string' ||
      !suffix.startsWith('\r\n') ||
      /(?<!\r)\n|\r(?!\n)/.test(suffix) ||
      !suffix.includes('\r\n   at ') ||
      Buffer.byteLength(suffix) > 131072 ||
      sha(suffix) !== template.suffixSha256
    )
      throw new Error('Reader template requires bounded exact CRLF suffix/hash');
    return {
      key,
      suffix,
      capturedSourceSha256: template.capturedSourceSha256,
      qualifiedVariationSha256: template.qualifiedVariationSha256,
      suffixSha256: template.suffixSha256,
    };
  });
}

export function collectWebApiErrorTemplates(packs = []) {
  const templates = new Map();
  for (const pack of packs) {
    const property = Object.getOwnPropertyDescriptor(pack, 'webApiErrorTemplates');
    if (!property) continue;
    if (!('value' in property)) throw new Error('webApiErrorTemplates must be an explicit data property');
    if (property.value === undefined) continue;
    for (const template of validateWebApiErrorTemplates(property.value)) {
      if (templates.has(template.key)) throw new Error('Matching packs have duplicate reader template descriptors');
      templates.set(template.key, Object.freeze({ ...template, packId: pack.id }));
    }
  }
  return templates;
}

export function appendObservedWebApiErrorTemplate(error, message, { mode = 'diagnostic', templates, method } = {}) {
  if (mode !== 'response-template' || typeof message !== 'string' || !(templates instanceof Map)) return message;
  if (!['POST', 'PATCH'].includes(method)) return message;
  const descriptor = odataReaderTemplateDescriptor(error);
  if (!descriptor) return message;
  let key;
  try {
    key = method + ':' + webApiReaderTemplateKey(descriptor);
  } catch {
    return message;
  }
  return message + (templates.get(key)?.suffix ?? '');
}
