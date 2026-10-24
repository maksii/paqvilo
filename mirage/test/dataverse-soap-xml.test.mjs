// Dataverse SOAP XML codec: namespace-aware parsing, value round trips, envelopes, faults.
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
  { type: "Money", value: "99.9000" }, // four-digit exact scale on the wire and after decode
  { type: "OptionSetValueCollection", values: [1, 3] },
  { type: "AliasedValue", attribute: "name", entity: "widget", value: text("Blue") },
  { type: "Relationship", schemaName: "widget_gadgets", primaryEntityRole: "Referenced" },
  {
    type: "Entity",
    logicalName: "widget",
    id: GUID,
    attributes: new Map([["name", text("Blue")], ["price", { type: "Money", value: "5.0000" }]]),
    formattedValues: new Map([["price", "$5.00"]]),
    keyAttributes: new Map([["code", text("W-1")]]),
    relatedEntities: null,
    rowVersion: "123",
    entityState: null,
  },
  { type: "long", value: "9007199254740993" },
  { type: "ColumnSet", allColumns: false, columns: ["name", "createdon"] },
  { type: "ColumnSet", allColumns: true, columns: [] },
  {
    type: "EntityReferenceCollection",
    values: [{ type: "EntityReference", logicalName: "widget", id: GUID, name: "Blue", keyAttributes: new Map() }],
  },
  {
    type: "Entity",
    logicalName: "widget",
    id: GUID,
    attributes: new Map(),
    formattedValues: new Map(),
    keyAttributes: new Map(),
    relatedEntities: [{
      relationship: { schemaName: "widget_gadgets", primaryEntityRole: "Referenced" },
      entities: { type: "EntityCollection", entityName: "gadget", entities: [], moreRecords: false, pagingCookie: null, totalRecordCount: 1, totalRecordCountLimitExceeded: false, minActiveRowVersion: null },
    }],
    rowVersion: null,
    entityState: null,
  },
  {
    type: "EntityCollection",
    entityName: "widget",
    entities: [{ type: "Entity", logicalName: "widget", id: GUID, attributes: new Map([["name", text("Blue")]]), formattedValues: new Map(), keyAttributes: new Map(), relatedEntities: null, rowVersion: null, entityState: null }],
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
    relatedEntities: [],
    rowVersion: "1",
    entityState: "Created",
  });
  const order = ["<a:Attributes", "<a:EntityState", "<a:FormattedValues", "<a:Id", "<a:KeyAttributes", "<a:LogicalName", "<a:RelatedEntities", "<a:RowVersion"];
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

// Regression tests. Golden strings and literal namespace URIs pin the SDK wire shape; the
// round trips above cannot, because the decoder ignores item element names.
const encodedNode = (xml) => parseEnvelope(envelope(xml)).request;
// Hand-written SDK-shaped XML: only the SOAP envelope prefix is declared at the root.
const sdkNode = (xml) => parseEnvelope(`<s:Envelope xmlns:s="${NS.s}"><s:Body>${xml}</s:Body></s:Envelope>`).request;
const sdkValue = (xml) => decodeValue(sdkNode(xml));
const SDK_ARRAYS = "http://schemas.microsoft.com/2003/10/Serialization/Arrays";

test("FormattedValues items are KeyValuePairOfstringstring with untyped values", () => {
  const xml = encodeValue("v", {
    type: "Entity", logicalName: "widget", id: GUID, attributes: new Map(), formattedValues: new Map([["statecode", "Active"]]),
    keyAttributes: new Map(), relatedEntities: null, rowVersion: null, entityState: null,
  });
  assert.ok(
    xml.includes("<a:FormattedValues><a:KeyValuePairOfstringstring><b:key>statecode</b:key><b:value>Active</b:value></a:KeyValuePairOfstringstring></a:FormattedValues>"),
    xml,
  );
  assert.deepStrictEqual(decodePairs(byName(encodedNode(xml), "FormattedValues"), (v) => v.text), new Map([["statecode", "Active"]]));
});

test("KeyAttributes items are in the xrm/7.1 namespace (KeyAttributeCollection)", () => {
  const xml = encodeValue("v", {
    type: "EntityReference", logicalName: "widget", id: GUID, name: null, keyAttributes: new Map([["code", text("W-1")]]),
  });
  assert.ok(xml.includes("<a:KeyAttributes><o:KeyValuePairOfstringanyType><b:key>code</b:key>"), xml);
  const item = byName(byName(encodedNode(xml), "KeyAttributes"), "KeyValuePairOfstringanyType");
  assert.equal(item.ns, "http://schemas.microsoft.com/xrm/7.1/Contracts");
});

test("ErrorDetails items are KeyValuePairOfstringanyType in the xrm/2011 namespace", () => {
  const xml = fault({
    errorCode: -2147220969,
    message: "Throttled",
    timestamp: "2026-10-19T08:30:00Z",
    errorDetails: new Map([["Retry-After", { type: "duration", value: "PT5S" }]]),
  });
  assert.ok(
    xml.includes('<ErrorDetails xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><KeyValuePairOfstringanyType><b:key>Retry-After</b:key><b:value i:type="e:duration">PT5S</b:value></KeyValuePairOfstringanyType></ErrorDetails>'),
    xml,
  );
  const details = byName(byName(byName(parseEnvelope(xml).request, "detail"), "OrganizationServiceFault"), "ErrorDetails");
  assert.equal(details.children[0].ns, "http://schemas.microsoft.com/xrm/2011/Contracts");
});

test("untyped a:Value decodes OptionSetValue and its collection as int, and Money as text (SDK wire)", () => {
  const head = `xmlns:i="${NS.i}" xmlns:a="${NS.a}"`;
  assert.deepStrictEqual(sdkValue(`<v ${head} i:type="a:OptionSetValue"><a:Value>1</a:Value></v>`), { type: "OptionSetValue", value: 1 });
  assert.deepStrictEqual(
    sdkValue(`<v ${head} xmlns:x9="${NS.x9}" i:type="x9:OptionSetValueCollection"><x9:OptionSetValue><a:Value>1</a:Value></x9:OptionSetValue><x9:OptionSetValue><a:Value>3</a:Value></x9:OptionSetValue></v>`),
    { type: "OptionSetValueCollection", values: [1, 3] },
  );
  assert.deepStrictEqual(sdkValue(`<v ${head} i:type="a:Money"><a:Value>12.50</a:Value></v>`), { type: "Money", value: "12.50" });
  assert.equal(encodeValue("v", { type: "OptionSetValue", value: 2 }), '<v i:type="a:OptionSetValue"><a:Value>2</a:Value></v>');
});

test("Money encodes an exact four-digit decimal in a typed c:decimal Value, rounding beyond four digits", () => {
  assert.equal(encodeValue("v", { type: "Money", value: 12.5 }), '<v i:type="a:Money"><a:Value i:type="c:decimal">12.5000</a:Value></v>');
  assert.equal(encodeValue("v", { type: "Money", value: "0.123456" }), '<v i:type="a:Money"><a:Value i:type="c:decimal">0.1235</a:Value></v>');
  assert.equal(encodeValue("v", { type: "Money", value: null }), '<v i:nil="true"/>');
});

test("an invalid Date is a 400 DataError with the invalid-argument code, not a RangeError", () => {
  assert.throws(
    () => encodeValue("v", { type: "dateTime", value: new Date(Number.NaN) }),
    (error) => error instanceof DataError && error.status === 400 && error.details?.innerCode === "0x80040203",
  );
});

test("an ExecuteTransactionFault is an OrganizationServiceFault element typed by i:type, its prefixes declared on that element", () => {
  // WCF reads FaultException<OrganizationServiceFault> from the detail element; a root named ExecuteTransactionFault is not that contract.
  const xml = fault({ errorCode: -2147220969, message: "failed", timestamp: "2026-10-19T08:30:00Z", faultedRequestIndex: 2 });
  assert.match(xml, /<OrganizationServiceFault xmlns="http:\/\/schemas\.microsoft\.com\/xrm\/2011\/Contracts" xmlns:i="[^"]+" xmlns:o="http:\/\/schemas\.microsoft\.com\/xrm\/7\.1\/Contracts" i:type="o:ExecuteTransactionFault">/);
  const serviceFault = byName(byName(parseEnvelope(xml).request, "detail"), "OrganizationServiceFault");
  assert.equal(serviceFault.ns, NS.a);
  assert.equal(serviceFault.attrs.find((a) => a.name === "type").value, "o:ExecuteTransactionFault");
  assert.equal(byName(serviceFault, "ErrorCode").ns, NS.a);
  assert.equal(byName(serviceFault, "ErrorCode").text, "-2147220969");
  // Base members (xrm/2011) come first; FaultedRequestIndex, the derived member, is last and in xrm/7.1.
  assert.equal(serviceFault.children.at(-1).name, "FaultedRequestIndex");
  assert.equal(serviceFault.children.at(-1).ns, NS.o);
  assert.equal(serviceFault.children.at(-1).text, "2");
});

test("a plain OrganizationServiceFault has no i:type and no FaultedRequestIndex", () => {
  const xml = fault({ errorCode: -2147220969, message: "failed", timestamp: "2026-10-19T08:30:00Z" });
  assert.doesNotMatch(xml, /i:type=/);
  assert.doesNotMatch(xml, /FaultedRequestIndex/);
  assert.match(xml, /<OrganizationServiceFault xmlns="http:\/\/schemas\.microsoft\.com\/xrm\/2011\/Contracts" xmlns:i="[^"]+">/);
});

test("an out-of-range character reference is a 400 DataError, not a RangeError", () => {
  for (const bad of ["<r>&#99999999;</r>", '<r a="&#x110000;"/>']) {
    assert.throws(() => parseXml(bad), (error) => error instanceof DataError && error.status === 400, bad);
  }
});

test("TotalRecordCount is always written: -1 when no count was requested", () => {
  const xml = encodeValue("v", {
    type: "EntityCollection", entityName: "widget", entities: [], moreRecords: false, pagingCookie: null,
    totalRecordCount: null, totalRecordCountLimitExceeded: null, minActiveRowVersion: null,
  });
  assert.ok(
    xml.endsWith("<a:TotalRecordCount>-1</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></v>"),
    xml,
  );
  assert.equal(decodeValue(encodedNode(xml)).totalRecordCount, -1);
});

test("an AliasedValue with a null inner value stays typed and writes a nil a:Value", () => {
  assert.equal(
    encodeValue("v", { type: "AliasedValue", attribute: "name", entity: "widget", value: null }),
    '<v i:type="a:AliasedValue"><a:AttributeLogicalName>name</a:AttributeLogicalName><a:EntityLogicalName>widget</a:EntityLogicalName><a:Value i:nil="true"/></v>',
  );
  assert.deepStrictEqual(
    decodeValue(encodedNode(encodeValue("v", { type: "AliasedValue", attribute: "name", entity: "widget", value: null }))),
    { type: "AliasedValue", attribute: "name", entity: "widget", value: null },
  );
});

test("a null AliasedValue name is nil, not the text null; a null OptionSetValue stays nil as a whole", () => {
  assert.equal(
    encodeValue("v", { type: "AliasedValue", attribute: null, entity: "widget", value: text("x") }),
    '<v i:type="a:AliasedValue"><a:AttributeLogicalName i:nil="true"/><a:EntityLogicalName>widget</a:EntityLogicalName><a:Value i:type="c:string">x</a:Value></v>',
  );
  assert.equal(encodeValue("v", { type: "OptionSetValue", value: null }), '<v i:nil="true"/>');
});

test("ColumnSet encodes AllColumns and string Columns in the arrays namespace, and decodes SDK-shaped XML", () => {
  assert.equal(
    encodeValue("v", { type: "ColumnSet", allColumns: false, columns: ["name", "createdon"] }),
    '<v i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string><f:string>createdon</f:string></a:Columns></v>',
  );
  const head = `xmlns:i="${NS.i}" xmlns:a="${NS.a}" xmlns:f="${SDK_ARRAYS}"`;
  const node = sdkNode(`<v ${head} i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns><f:string>name</f:string></a:Columns></v>`);
  assert.deepStrictEqual(decodeValue(node), { type: "ColumnSet", allColumns: true, columns: ["name"] });
  assert.equal(byName(node, "Columns").children[0].ns, SDK_ARRAYS);
});

test("EntityReferenceCollection encodes untyped EntityReference items and decodes SDK-shaped XML", () => {
  assert.equal(
    encodeValue("v", {
      type: "EntityReferenceCollection",
      values: [{ type: "EntityReference", logicalName: "widget", id: GUID, name: "Blue", keyAttributes: new Map() }],
    }),
    `<v i:type="a:EntityReferenceCollection"><a:EntityReference><a:Id>${GUID}</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name>Blue</a:Name></a:EntityReference></v>`,
  );
  assert.deepStrictEqual(
    sdkValue(`<v xmlns:i="${NS.i}" xmlns:a="${NS.a}" i:type="a:EntityReferenceCollection"><a:EntityReference><a:Id>${GUID}</a:Id><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/></a:EntityReference></v>`),
    { type: "EntityReferenceCollection", values: [{ type: "EntityReference", logicalName: "widget", id: GUID, name: null, keyAttributes: new Map() }] },
  );
});

test("RelatedEntities items are KeyValuePairOfRelationshipEntityCollection with declared key and value", () => {
  const related = [{
    relationship: { schemaName: "widget_gadgets", primaryEntityRole: "Referenced" },
    entities: { type: "EntityCollection", entityName: "gadget", entities: [], moreRecords: false, pagingCookie: null, totalRecordCount: 1, totalRecordCountLimitExceeded: false, minActiveRowVersion: null },
  }];
  const xml = encodeValue("v", {
    type: "Entity", logicalName: "widget", id: GUID, attributes: new Map(), formattedValues: new Map(), keyAttributes: new Map(),
    relatedEntities: related, rowVersion: null, entityState: null,
  });
  assert.ok(
    xml.includes(
      "<a:RelatedEntities><a:KeyValuePairOfRelationshipEntityCollection><b:key><a:PrimaryEntityRole>Referenced</a:PrimaryEntityRole><a:SchemaName>widget_gadgets</a:SchemaName></b:key>" +
        "<b:value><a:Entities></a:Entities><a:EntityName>gadget</a:EntityName><a:MoreRecords>false</a:MoreRecords><a:TotalRecordCount>1</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></b:value></a:KeyValuePairOfRelationshipEntityCollection></a:RelatedEntities>",
    ),
    xml,
  );
  const item = byName(byName(encodedNode(xml), "RelatedEntities"), "KeyValuePairOfRelationshipEntityCollection");
  assert.equal(item.ns, "http://schemas.microsoft.com/xrm/2011/Contracts");
  assert.deepStrictEqual(decodeValue(encodedNode(xml)).relatedEntities, related);
});

test("a long beyond 2^53 is a decimal string, and a safe long stays a Number", () => {
  assert.equal(encodeValue("v", { type: "long", value: "9007199254740993" }), '<v i:type="c:long">9007199254740993</v>');
  assert.deepStrictEqual(sdkValue(`<v xmlns:i="${NS.i}" xmlns:c="${NS.c}" i:type="c:long">9007199254740993</v>`), { type: "long", value: "9007199254740993" });
  assert.deepStrictEqual(sdkValue(`<v xmlns:i="${NS.i}" xmlns:c="${NS.c}" i:type="c:long">-42</v>`), { type: "long", value: -42 });
});
