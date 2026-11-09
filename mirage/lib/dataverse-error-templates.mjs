import { createHash } from 'node:crypto';
import { templateDataRecord, templateDataArray } from './error-template-data.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const TYPES = new Set([
  'Edm.String',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Boolean',
  'Edm.Date',
  'Edm.DateTimeOffset',
  'Edm.Guid',
  'Edm.Binary',
]);
const FIELDS = {
  'primitive-type': ['sourceType', 'expectedType'],
  'primitive-format': ['expectedType'],
  'decimal-format': ['expectedType'],
  'property-node': ['actualNode', 'expectedNode'],
  'root-node': ['actualNode', 'expectedNode'],
  'unreadable-stream': [],
  'unknown-parameter': [],
  'unknown-property': [],
};
const NODES = new Set(['StartObject', 'StartArray', 'PrimitiveValue', 'EndOfInput']);
/** Finite type/node keys deliberately exclude submitted values, routes and schema identifiers. */
function dataverseReaderTemplateKey(descriptor) {
  templateDataRecord(descriptor, 'Dataverse reader templates');
  const fields =
    typeof descriptor.kind === 'string' && Object.hasOwn(FIELDS, descriptor.kind) ? FIELDS[descriptor.kind] : null;
  if (
    !fields ||
    !['record', 'operation'].includes(descriptor?.target) ||
    Object.keys(descriptor).length !== fields.length + 2 ||
    Object.keys(descriptor).some((key) => !['kind', 'target', ...fields].includes(key))
  )
    throw Error('Finite Dataverse reader template descriptor required');
  for (const field of fields)
    if (!(field.endsWith('Type') ? TYPES : NODES).has(descriptor[field]))
      throw Error('Unsupported Dataverse reader template type/node');
  return JSON.stringify(Object.fromEntries(['target', 'kind', ...fields].map((key) => [key, descriptor[key]])));
}

function dataverseReaderTemplateDescriptor(message, target = 'record') {
  if (
    typeof message !== 'string' ||
    !message.startsWith('Error identified in Payload provided by the user for Entity :')
  )
    return null;
  const separator = ' ---->  InnerException : ';
  const at = message.indexOf(separator);
  const detail = at < 0 ? null : message.slice(at + separator.length);
  if (!detail) return null;
  // Match the final canonical cause, never diagnostic-looking text inside a
  // submitted literal. Literals can contain quotes, CRLF and this separator.
  const literalMessage = detail.startsWith("Microsoft.OData.ODataException: Cannot convert the literal '");
  let found = literalMessage
    ? / ---> Microsoft\.OData\.ODataException: Cannot convert a value of type '(Edm\.\w+)' to the expected target type '(Edm\.\w+)'\.$/.exec(
        detail,
      )
    : null;
  if (found) return { target, kind: 'primitive-type', sourceType: found[1], expectedType: found[2] };
  const formatCauses = [
    ['Edm.Boolean', 'String was not recognized as a valid Boolean.'],
    ['Edm.Int32', 'Input string was not in a correct format.'],
    ['Edm.Int64', 'Input string was not in a correct format.'],
    ['Edm.Double', 'Input string was not in a correct format.'],
    ['Edm.Decimal', 'Input string was not in a correct format.'],
    ['Edm.Guid', 'Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).'],
    [
      'Edm.Binary',
      'The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.',
    ],
  ];
  for (const [expectedType, cause] of formatCauses) {
    const tail = "' to the expected type '" + expectedType + "'. ---> System.FormatException: " + cause;
    if (literalMessage && detail.endsWith(tail)) return { target, kind: 'primitive-format', expectedType };
  }
  if (
    literalMessage &&
    detail.endsWith("' is not a valid AllXsd value.") &&
    detail.includes("' to the expected type 'Edm.DateTimeOffset'. ---> System.FormatException: The string '")
  )
    return { target, kind: 'primitive-format', expectedType: 'Edm.DateTimeOffset' };
  if (
    literalMessage &&
    detail.endsWith("' was not recognized as a valid Edm.Date.") &&
    detail.includes("' to the expected type 'Edm.Date'. ---> System.FormatException: String '")
  )
    return { target, kind: 'primitive-format', expectedType: 'Edm.Date' };
  found =
    /^Microsoft\.OData\.ODataException: Cannot convert a value to target type '(Edm\.\w+)' because of conflict between input format string\/number and parameter 'IEEE754Compatible' false\/true\.$/.exec(
      detail,
    );
  if (found) return { target, kind: 'decimal-format', expectedType: found[1] };
  found =
    /^Microsoft\.OData\.ODataException: An unexpected '(\w+)' node was found(?: for property named '[\s\S]*')? when reading from the JSON reader\. A '(\w+)' node was expected\.$/.exec(
      detail,
    );
  if (found)
    return {
      target,
      kind: found[2] === 'StartObject' ? 'root-node' : 'property-node',
      actualNode: found[1],
      expectedNode: found[2],
    };
  if (detail === 'System.ArgumentException: Stream was not readable.') return { target, kind: 'unreadable-stream' };
  if (
    /^Microsoft\.Crm\.CrmException: Invalid property '[\s\S]*' was found in entity 'Microsoft\.Dynamics\.CRM\.[^']+'\. ---> Microsoft\.OData\.ODataException: The property '[\s\S]*' does not exist on type 'Microsoft\.Dynamics\.CRM\.[^']+'\. Make sure to only use property names that are defined by the type\.$/.test(
      detail,
    )
  )
    return { target, kind: 'unknown-property' };
  if (
    /^Microsoft\.OData\.ODataException: The parameter '[\s\S]*' in the request payload is not a valid parameter for the operation '[^']*'\.$/.test(
      detail,
    )
  )
    return { target, kind: 'unknown-parameter' };
  return null;
}

export function validateDataverseErrorTemplates(value) {
  templateDataRecord(value, 'Dataverse reader templates');
  if (
    value?.version !== 1 ||
    typeof value.evidence !== 'string' ||
    !value.evidence.trim() ||
    !Array.isArray(value.templates)
  )
    throw Error('dataverseErrorTemplates requires version1, evidence and 1..128 templates');
  const entries = templateDataArray(value.templates, { maximum: 128, label: 'Dataverse reader templates' });
  const keys = new Set();
  return entries.map((template) => {
    templateDataRecord(template, 'Dataverse reader templates');
    if (!['POST', 'PATCH', 'PUT'].includes(template?.method))
      throw Error('Dataverse reader template requires evidenced POST/PATCH/PUT method');
    const key = template.method + ':' + dataverseReaderTemplateKey(template.descriptor);
    if (keys.has(key)) throw Error('Duplicate Dataverse reader template descriptor');
    keys.add(key);
    for (const field of ['capturedSourceSha256', 'qualifiedVariationSha256', 'suffixSha256'])
      if (typeof template[field] !== 'string' || !SHA.test(template[field]))
        throw Error('Dataverse reader template requires source, variation and suffix SHA256');
    const suffix = template.suffix;
    if (
      typeof suffix !== 'string' ||
      !/^ ?\r\n/.test(suffix) ||
      /(?<!\r)\n|\r(?!\n)/.test(suffix) ||
      !suffix.includes('\r\n   at ') ||
      Buffer.byteLength(suffix) > 131072 ||
      sha(suffix) !== template.suffixSha256
    )
      throw Error('Dataverse reader template requires bounded exact CRLF suffix/hash');
    return {
      key,
      suffix,
      capturedSourceSha256: template.capturedSourceSha256,
      qualifiedVariationSha256: template.qualifiedVariationSha256,
      suffixSha256: template.suffixSha256,
    };
  });
}

export function collectDataverseErrorTemplates(packs = []) {
  const templates = new Map();
  for (const pack of packs) {
    const property = Object.getOwnPropertyDescriptor(pack, 'dataverseErrorTemplates');
    if (!property) continue;
    if (!('value' in property)) throw Error('dataverseErrorTemplates must be an explicit data property');
    if (property.value === undefined) continue;
    for (const template of validateDataverseErrorTemplates(property.value)) {
      if (templates.has(template.key))
        throw Error('Matching packs have duplicate Dataverse reader template descriptors');
      templates.set(template.key, Object.freeze({ ...template, packId: pack.id }));
    }
  }
  return templates;
}

export function appendObservedDataverseErrorTemplate(
  message,
  { mode = 'diagnostic', templates, method, target = 'record' } = {},
) {
  if (mode !== 'response-template' || !(templates instanceof Map) || !['POST', 'PATCH', 'PUT'].includes(method))
    return message;
  const descriptor = dataverseReaderTemplateDescriptor(message, target);
  if (!descriptor) return message;
  let key;
  try {
    key = method + ':' + dataverseReaderTemplateKey(descriptor);
  } catch {
    return message;
  }
  return message + (templates.get(key)?.suffix ?? '');
}
