// Dataverse SOAP XML codec: namespace-aware parsing, value round trips, envelopes, faults.
// Invented values and fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataError } from "../lib/data-error.mjs";
import {
  NS,
  decodePairs,
  decodeValue,
  encodeValue,
  envelope,
  executeResponse,
  fault,
  parseEnvelope,
  parseOrganizationRequest,
  parseXml,
} from "../lib/dataverse-soap-xml.mjs";

const GUID = "6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const BUSINESS_UNIT = "aaaaaaaa-0000-4000-8000-000000000002";
const text = (value) => ({ type: "string", value });

// Every prefix in encoded XML is renamed, so decoding must rely on namespace URIs only.
// The lookaheads leave xmlns:xml, xml:lang and http(s) URI text alone.
const renamed = (xml) =>
  xml
    .replace(/xmlns:([a-z0-9]+)=/g, "xmlns:p$1=")
    .replace(/(?<=[<\s"/])(?!xmlns:|xml:|https?:)([a-z0-9]+)(?=:)/g, "p$1");

const decodeFrom = (xml) => decodeValue(parseEnvelope(xml).request);
const byName = (node, name) => node.children.find((c) => c.name === name);

const VALUES = [
  text('a & <b> "c"'),
  { type: "int", value: -7 },
  { type: "long", value: 9007199254740 },
  { type: "decimal", value: "1234.5600" },
  { type: "double", value: 2.5 },
  { type: "double", value: Infinity },
  { type: "boolean", value: false },
  { type: "dateTime", value: "2026-10-19T08:30:00Z" },
  { type: "guid", value: GUID },
  { type: "base64", value: "AQID" },
  { type: "duration", value: "PT5S" },
  { type: "EntityReference", logicalName: "widget", id: GUID, name: "Blue", keyAttributes: new Map([["code", text("W-1")]]) },
  { type: "EntityReference", logicalName: "widget", id: GUID, name: null, keyAttributes: new Map() },
  { type: "OptionSetValue", value: 2 },
  { type: "Money", value: "99.90" },
  { type: "OptionSetValueCollection", values: [1, 3] },
  { type: "AliasedValue", attribute: "name", entity: "widget", value: text("Blue") },
  { type: "Relationship", schemaName: "widget_gadgets", primaryEntityRole: "Referenced" },
  {
    type: "Entity",
    logicalName: "widget",
    id: GUID,
    attributes: new Map([["name", text("Blue")], ["price", { type: "Money", value: "5.00" }]]),
    formattedValues: new Map([["price", "$5.00"]]),
    keyAttributes: new Map([["code", text("W-1")]]),
    rowVersion: "123",
    entityState: null,
  },
  {
    type: "EntityCollection",
    entityName: "widget",
    entities: [{ type: "Entity", logicalName: "widget", id: GUID, attributes: new Map([["name", text("Blue")]]), formattedValues: new Map(), keyAttributes: new Map(), rowVersion: null, entityState: null }],
    moreRecords: true,
    pagingCookie: "<cookie page=\"2\"/>",
    totalRecordCount: 12,
    totalRecordCountLimitExceeded: false,
    minActiveRowVersion: null,
  },
];

test("every value type round-trips with canonical and arbitrary prefixes", () => {
  for (const value of VALUES) {
    const xml = envelope(encodeValue("v", value));
    assert.deepStrictEqual(decodeFrom(xml), value, `direct ${value.type}`);
    assert.deepStrictEqual(decodeFrom(renamed(xml)), value, `renamed ${value.type}`);
  }
  assert.equal(decodeFrom(envelope(encodeValue("v", null))), null);
  assert.deepStrictEqual(decodeFrom(envelope(encodeValue("v", "plain"))), text("plain"));
});

test("i:type and element names resolve by namespace URI, not prefix", () => {
  // The prefix "zz" is bound to the XML Schema URI, so this is a string.
  const bound = `<s:Envelope xmlns:s="${NS.s}"><s:Body><v xmlns:i="${NS.i}" xmlns:zz="${NS.c}" i:type="zz:string">hi</v></s:Body></s:Envelope>`;
  assert.deepStrictEqual(decodeFrom(bound), text("hi"));
  // The prefix "c" is bound to another URI, so the same spelling is not a known type.
  const other = `<s:Envelope xmlns:s="${NS.s}"><s:Body><v xmlns:i="${NS.i}" xmlns:c="http://example.test/other" i:type="c:string">hi</v></s:Body></s:Envelope>`;
  const raw = decodeFrom(other);
  assert.equal(raw.type, "Raw");
  assert.deepStrictEqual(raw.qname, { ns: "http://example.test/other", name: "string" });
});

test("comments, processing instructions and CDATA are handled", () => {
  const doc = parseXml('<?xml version="1.0"?>\n<!-- note --><r a="1 &amp; 2"><![CDATA[x<y & z]]></r>');
  assert.equal(doc.name, "r");
  assert.equal(doc.text, "x<y & z");
  assert.equal(doc.attrs[0].value, "1 & 2");
});

test("https:// namespace forms from Microsoft samples are accepted", () => {
  const whoAmI = whoAmIRequest().replaceAll("http://", "https://");
  const { operation, request } = parseEnvelope(whoAmI);
  assert.equal(operation, "Execute");
  assert.equal(parseOrganizationRequest(request).requestName, "WhoAmI");
});

test("DTDs, unbalanced tags and undeclared prefixes throw DataError 400", () => {
  for (const bad of ["<!DOCTYPE x [<!ENTITY y 'z'>]><x/>", "<a><b></a>", '<p:a xmlns:q="urn:x"/>']) {
    assert.throws(() => parseXml(bad), (error) => error instanceof DataError && error.status === 400, bad);
  }
});

function whoAmIRequest() {
  return (
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    '<request i:type="b:WhoAmIRequest" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:b="http://schemas.microsoft.com/crm/2011/Contracts">' +
    '<a:Parameters xmlns:c="http://schemas.datacontract.org/2004/07/System.Collections.Generic" />' +
    '<a:RequestId i:nil="true" /><a:RequestName>WhoAmI</a:RequestName>' +
    "</request></Execute></s:Body></s:Envelope>"
  );
}

test("WhoAmI request decodes to its request name, type and empty parameters", () => {
  const { headers, operation, request } = parseEnvelope(whoAmIRequest());
  assert.deepStrictEqual(headers, {});
  assert.equal(operation, "Execute");
  assert.deepStrictEqual(parseOrganizationRequest(request), {
    requestName: "WhoAmI",
    requestType: "WhoAmIRequest",
    requestId: null,
    parameters: new Map(),
  });
});

test("WhoAmI response carries the g: response type and typed guid results", () => {
  const body = executeResponse({
    responseType: "WhoAmIResponse",
    namespace: NS.g,
    responseName: "WhoAmI",
    results: new Map([
      ["UserId", { type: "guid", value: USER }],
      ["BusinessUnitId", { type: "guid", value: BUSINESS_UNIT }],
      ["OrganizationId", { type: "guid", value: GUID }],
    ]),
  });
  const xml = envelope(body);
  const { operation, request } = parseEnvelope(xml);
  assert.equal(operation, "ExecuteResponse");
  const result = byName(request, "ExecuteResult");
  assert.equal(result.attrs.find((a) => a.name === "type").value, "r:WhoAmIResponse");
  assert.equal(result.scope.get("r"), NS.g);
  assert.equal(byName(result, "ResponseName").text, "WhoAmI");
  assert.deepStrictEqual(decodePairs(byName(result, "Results")), new Map([
    ["UserId", { type: "guid", value: USER }],
    ["BusinessUnitId", { type: "guid", value: BUSINESS_UNIT }],
    ["OrganizationId", { type: "guid", value: GUID }],
  ]));
  assert.equal(parseEnvelope(renamed(xml)).operation, "ExecuteResponse");
});

test("Entity members are emitted in DataContract order", () => {
  const xml = encodeValue("v", {
    type: "Entity",
    logicalName: "widget",
    id: GUID,
    attributes: new Map([["name", text("Blue")]]),
    formattedValues: new Map([["name", "Blue"]]),
    keyAttributes: new Map([["code", text("W-1")]]),
    rowVersion: "1",
    entityState: "Created",
  });
  const order = ["<a:Attributes", "<a:EntityState", "<a:FormattedValues", "<a:Id", "<a:KeyAttributes", "<a:LogicalName", "<a:RowVersion"];
  const positions = order.map((marker) => xml.indexOf(marker));
  assert.ok(positions.every((p) => p >= 0), `missing member in ${xml}`);
  assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b));
});

test("EntityCollection members are emitted in DataContract order", () => {
  const xml = encodeValue("v", {
    type: "EntityCollection",
    entityName: "widget",
    entities: [],
    moreRecords: true,
    pagingCookie: "<c/>",
    totalRecordCount: 3,
    totalRecordCountLimitExceeded: false,
    minActiveRowVersion: "9",
  });
  const order = [
    "<a:Entities>",
    "<a:EntityName>",
    "<a:MinActiveRowVersion>",
    "<a:MoreRecords>",
    "<a:PagingCookie>",
    "<a:TotalRecordCount>",
    "<a:TotalRecordCountLimitExceeded>",
  ];
  const positions = order.map((marker) => xml.indexOf(marker));
  assert.ok(positions.every((p) => p >= 0), `missing member in ${xml}`);
  assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b));
});

test("OrganizationServiceFault has the documented shape", () => {
  const xml = fault({
    errorCode: -2147220969,
    message: "Account With Id = 0 Does Not Exist",
    timestamp: "2026-10-19T08:30:00Z",
  });
  assert.match(xml, /<faultcode>s:Client<\/faultcode>/);
  const { operation, request } = parseEnvelope(xml);
  assert.equal(operation, "Fault");
  assert.equal(request.ns, NS.s);
  const detail = byName(request, "detail");
  const ofs = byName(detail, "OrganizationServiceFault");
  assert.equal(ofs.ns, NS.a);
  assert.equal(byName(ofs, "ErrorCode").text, "-2147220969");
  assert.equal(byName(ofs, "Message").text, "Account With Id = 0 Does Not Exist");
  assert.equal(byName(ofs, "Timestamp").text, "2026-10-19T08:30:00Z");
  assert.equal(decodeValue(byName(ofs, "InnerFault")), null);
  assert.equal(decodeValue(byName(ofs, "TraceText")), null);
  assert.equal(decodePairs(byName(ofs, "ErrorDetails")).size, 0);
});

test("throttling fault carries Retry-After as an e:duration detail", () => {
  const xml = fault({
    errorCode: -2147220969,
    message: "Throttled",
    timestamp: "2026-10-19T08:30:00Z",
    traceText: "trace",
    errorDetails: new Map([["Retry-After", { type: "duration", value: "PT5S" }]]),
  });
  const ofs = byName(byName(parseEnvelope(xml).request, "detail"), "OrganizationServiceFault");
  assert.deepStrictEqual(decodePairs(byName(ofs, "ErrorDetails")), new Map([["Retry-After", { type: "duration", value: "PT5S" }]]));
  assert.equal(byName(ofs, "TraceText").text, "trace");
});

test("unsupported value types and non-integer fault codes are refused", () => {
  assert.throws(() => encodeValue("v", { type: "Raw" }), DataError);
  assert.throws(() => fault({ errorCode: 1.5, message: "x", timestamp: "t" }), TypeError);
});
