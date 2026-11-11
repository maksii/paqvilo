// Adapter for the dataverse-soap surface: a recorded SOAP envelope, the input the official Microsoft.Xrm.Sdk
// DataContractSerializer read, -> Mirage SOAP codec -> the decoded value in the oracle's canonical shape,
// the SDK type name of that value, and the value re-serialised as an element named `v`, projected onto its XML
// infoset (xml-infoset.mjs) so that prefix naming, declarations and spacing do not count as differences.
// Only `input` drives the codec. Each envelope is decoded on its own (the direct and renamed prefix forms).
import { decodeValue, encodeValue, NS, parseEnvelope } from '../../../lib/dataverse-soap-xml.mjs';
import { xmlInfoset } from './xml-infoset.mjs';

// The .NET type the SDK reports for each Mirage canonical type name. Fixed for every case of the surface.
const SDK_TYPE = {
  string: 'System.String',
  int: 'System.Int32',
  long: 'System.Int64',
  decimal: 'System.Decimal',
  double: 'System.Double',
  boolean: 'System.Boolean',
  dateTime: 'System.DateTime',
  guid: 'System.Guid',
  base64: 'System.Byte[]',
  duration: 'System.TimeSpan',
  EntityReference: 'Microsoft.Xrm.Sdk.EntityReference',
  OptionSetValue: 'Microsoft.Xrm.Sdk.OptionSetValue',
  Money: 'Microsoft.Xrm.Sdk.Money',
  OptionSetValueCollection: 'Microsoft.Xrm.Sdk.OptionSetValueCollection',
  AliasedValue: 'Microsoft.Xrm.Sdk.AliasedValue',
  Relationship: 'Microsoft.Xrm.Sdk.Relationship',
  Entity: 'Microsoft.Xrm.Sdk.Entity',
  ColumnSet: 'Microsoft.Xrm.Sdk.Query.ColumnSet',
  EntityReferenceCollection: 'Microsoft.Xrm.Sdk.EntityReferenceCollection',
  EntityCollection: 'Microsoft.Xrm.Sdk.EntityCollection',
};

/**
 * Value-space rules of the oracle's canonical JSON, the same for every case:
 * - a Map (Mirage keeps attribute, format and key collections in Maps) is written as {"$map": [[key, value], ...]};
 * - a non-finite number is written as {"$number": "NaN" | "Infinity" | "-Infinity"}, since JSON has no spelling for it.
 */
function canonicalOf(value) {
  if (value instanceof Map) return { $map: [...value].map(([key, item]) => [key, canonicalOf(item)]) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(canonicalOf);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalOf(item)]));
  }
  return value;
}

function project(xml) {
  const decoded = decodeValue(parseEnvelope(xml).request);
  const canonical = canonicalOf(decoded);
  return {
    phase: 'value',
    sdkType: decoded === null ? null : (SDK_TYPE[decoded.type] ?? null),
    canonical,
    // The codec writes fragments inside an envelope that declares every NS prefix, so those are the inherited scope.
    serializedXml: xmlInfoset(encodeValue('v', decoded), NS),
  };
}

/**
 * Decodes both recorded envelopes of one case.
 * @param {{ declaredType: string, xmlDirect: string, xmlRenamed: string }} input recorded input of one case
 * @returns {Promise<{ direct: object, renamed: object }>} the decode of each envelope, in the oracle's shape
 */
export default async function run(input) {
  return { direct: project(input.xmlDirect), renamed: project(input.xmlRenamed) };
}
