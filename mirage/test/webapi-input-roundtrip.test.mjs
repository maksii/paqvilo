// Synthetic, loopback-only API regressions. Browser rendering and live parity
// evidence belong to the external portal project, not this reusable fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { parseDateValue } from "../lib/dataverse-values.mjs";

const BASE_ID = "00000000-0000-0000-0000-000000000001";
const COLLECTION = "/_api/probeentries";
const BASE_RECORD = `${COLLECTION}(${BASE_ID})`;
const INPUTS = [
  ["HTML and executable-looking markup", '<img src=x onerror="window.__inputProbe=1"><script>window.__inputProbe=2</script>', "img src=x"],
  ["encoded and double-encoded HTML", "&lt;script&gt;probe&lt;/script&gt; &amp;lt;img&amp;gt;", "&lt;script&gt;"],
  ["XML", '<entry key="a&b"><name>O\'Brien & text</name></entry>', "O'Brien"],
  ["JSON text", '{"name":"O\'Brien","nested":[null,true,"\\u003cscript\\u003e"]}', "O'Brien"],
  ["quotes, OData-looking text and URL delimiters", "O'Brien' or title ne 'none & + ? # = / \\\" end", "O'Brien' or title ne 'none"],
  ["SQL-looking text and wildcard characters", "'; DROP TABLE invented;-- % _ [a-z] [^x]", "DROP TABLE invented;--"],
  ["Unicode", "Résumé Київ 中文 😀 e\u0301 \u202eRTL\u202c", "Київ 中文 😀"],
  ["whitespace and control characters", "  first\tsecond\r\nthird\u0000end  ", "first\tsecond\r\nthird\u0000end"],
];
const literal = (value) => `'${value.replace(/'/g, "''")}'`;

async function start(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mirage-input-roundtrip-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: probe-site\nadx_name: Input probe\n");
  await fs.writeFile(path.join(directory, "sitesetting.yml"), [
    "- adx_name: Webapi/probeentry/enabled\n  adx_value: 'true'",
    "- adx_name: Webapi/probeentry/fields\n  adx_value: 'title,content,count,rate,amount,price,category,flag,address,plainaddress,localdate,reviewdate,referenceid'",
    "- adx_name: Webapi/error/innererror\n  adx_value: 'true'",
  ].join("\n"));
  const app = await createSimulator({
    sourceDir: directory,
    watch: false,
    initial: {
      mappings: {
        probeentry: {
          entitySet: "probeentries",
          idColumn: "probeentryid",
          nameColumn: "title",
          schemaComplete: true,
          fields: {
            probeentryid: { dataverseType: "uniqueidentifier" },
            title: { dataverseType: "nvarchar", maxLength: 1000 },
            content: { dataverseType: "memo", maxLength: 4000 },
            count: { dataverseType: "int", minValue: 0, maxValue: 100 },
            rate: { dataverseType: "float", precision: 4, minValue: 0, maxValue: 1000 },
            amount: { dataverseType: "decimal", precision: 2, minValue: 0, maxValue: 100 },
            price: { dataverseType: "money", precision: 2, minValue: 0, maxValue: 1000 },
            category: { dataverseType: "picklist", options: [{ value: 1, label: "One" }] },
            flag: { dataverseType: "bit" },
            address: { dataverseType: "nvarchar", format: "Email", maxLength: 30 },
            plainaddress: { dataverseType: "nvarchar", format: "Text", maxLength: 30 },
            localdate: { dataverseType: "datetime", format: "date", dateTimeBehavior: "UserLocal" },
            reviewdate: { dataverseType: "datetime", dateTimeBehavior: "DateOnly" },
            referenceid: { dataverseType: "uniqueidentifier" },
          },
        },
      },
      tables: { probeentry: [{ probeentryid: BASE_ID, title: "Original", content: "Unchanged", versionnumber: 1 }] },
      settings: { permissionMode: "permissive" },
      simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: "probe-persona", roles: [] }, live: {}, endpoints: [] },
    },
  });
  t.after(() => app.close());
  const call = async (route, { method = "GET", body, rawBody, token = app.state().csrf } = {}) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        ...(token == null ? {} : { __RequestVerificationToken: token }),
        ...(body === undefined && rawBody === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    const json = text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, text, json };
  };
  return { app, call };
}

async function assertReadable(call, record, id, values, fragment, label) {
  const read = await call(`${record}?$select=title,content`);
  assert.equal(read.status, 200, label);
  assert.equal(read.headers.get("x-content-type-options"), "nosniff");
  for (const [field, value] of Object.entries(values)) {
    assert.equal(read.json[field], value, `${label}: entity ${field}`);
    const property = await call(`${record}/${field}`);
    assert.equal(property.status, 200, `${label}: property ${field}`);
    assert.deepEqual(property.json, { value }, label);
    const raw = await call(`${record}/${field}/$value`);
    assert.equal(raw.status, 200, `${label}: raw ${field}`);
    assert.equal(raw.text, value, `${label}: raw ${field} preserves input`);
    assert.match(raw.headers.get("content-type"), /^text\/plain/);
    // Equality checks the complete input, including wildcard characters.
    // contains fragments deliberately omit SQL LIKE wildcards; their platform
    // interpretation requires separate live evidence before a parity assertion.
    for (const filter of [`${field} eq ${literal(value)}`, `contains(${field},${literal(fragment)})`]) {
      const params = new URLSearchParams({ $select: "title,content", $filter: filter });
      const search = await call(`${COLLECTION}?${params}`);
      assert.equal(search.status, 200, `${label}: ${filter}`);
      assert.ok(search.json.value.some((row) => row.probeentryid === id && row[field] === value), `${label}: search finds the submitted ${field}`);
    }
  }
}

test("Web API preserves hostile-looking strings through create, update, reads, property values and escaped search", async (t) => {
  const { app, call } = await start(t);
  for (const [label, input, fragment] of INPUTS) {
    const original = { title: input, content: input };
    const created = await call(COLLECTION, { method: "POST", body: original });
    assert.equal(created.status, 204, `${label}: create`);
    assert.equal(created.text, "");
    const id = created.headers.get("entityid");
    assert.ok(id, `${label}: create returns a record identity`);
    const record = `${COLLECTION}(${id})`;
    await assertReadable(call, record, id, original, fragment, `${label}: create`);
    const changed = { title: `${input} updated`, content: `updated ${input}` };
    const updated = await call(record, { method: "PATCH", body: changed });
    assert.equal(updated.status, 204, `${label}: update`);
    await assertReadable(call, record, id, changed, fragment, `${label}: update`);
    const stored = app.store.snapshot().tables.probeentry.find((row) => row.probeentryid === id);
    assert.equal(stored.title, changed.title, `${label}: stored title`);
    assert.equal(stored.content, changed.content, `${label}: stored content`);
  }
});

test("malformed JSON and non-object Web API bodies reject create/update/property writes without mutation", async (t) => {
  const { app, call } = await start(t);
  const invalidBodies = ['{"title":', '{"title":"unterminated}', '{"title":"x",}', "not JSON", "null", '"scalar"', "42", "true", "[]"];
  for (const [route, method] of [[COLLECTION, "POST"], [BASE_RECORD, "PATCH"], [`${BASE_RECORD}/title`, "PUT"]]) {
    for (const rawBody of invalidBodies) {
      const before = app.store.snapshot().tables;
      const result = await call(route, { method, rawBody });
      assert.equal(result.status, 400, `${method} ${route}: ${rawBody}`);
      assert.equal(result.json.error.code, "9004010D", `${method}: error envelope`);
      assert.equal(result.json.error.message, "CDS error occurred.");
      assert.equal(typeof result.json.error.innererror.message, "string");
      assert.deepEqual(app.store.snapshot().tables, before, `${method}: rejected input must not mutate rows or versions`);
    }
  }
});

test("missing and wrong CSRF tokens reject each Web API write before any mutation", async (t) => {
  const { app, call } = await start(t);
  const writes = [
    [COLLECTION, "POST", { title: "Unexpected new row" }],
    [BASE_RECORD, "PATCH", { title: "Unexpected update" }],
    [`${BASE_RECORD}/title`, "PUT", { value: "Unexpected property update" }],
    [`${BASE_RECORD}/title`, "DELETE", undefined],
    [BASE_RECORD, "DELETE", undefined],
  ];
  for (const [token, expected] of [[null, 401], ["wrong-local-token", 403]]) {
    for (const [route, method, body] of writes) {
      const before = app.store.snapshot().tables;
      const result = await call(route, { method, body, token });
      assert.equal(result.status, expected, `${method}: ${token == null ? "missing" : "wrong"} token`);
      assert.equal(result.json.error.code, "90040107");
      assert.deepEqual(app.store.snapshot().tables, before, `${method}: rejected token must not mutate rows or versions`);
    }
  }
});

test("schema types accept observed scalar strings and email format normalizes after length validation", async (t) => {
  const { app, call } = await start(t);
  const body = {
    count: "12", rate: "12.5", category: "1", flag: "true",
    address: "\u2028 Mixed@EXAMPLE.invalid \u2029", plainaddress: " Mixed@EXAMPLE.invalid ",
    localdate: "2026-10-10", reviewdate: "2026-10-10",
    referenceid: "ABCDEFAB-1234-4321-ABCD-123456789ABC",
  };
  assert.equal((await call(BASE_RECORD, { method: "PATCH", body })).status, 204);
  const selected = Object.keys(body).join(",");
  const read = await call(`${BASE_RECORD}?$select=${selected}`);
  assert.equal(read.status, 200);
  assert.deepEqual(Object.fromEntries(Object.keys(body).map((key) => [key, read.json[key]])), {
    count: 12, rate: 12.5, category: 1, flag: true,
    address: "mixed@example.invalid", plainaddress: " Mixed@EXAMPLE.invalid ",
    localdate: "2026-10-10T00:00:00Z", reviewdate: "2026-10-10",
    referenceid: "abcdefab-1234-4321-abcd-123456789abc",
  });
  assert.equal((await call(BASE_RECORD, { method: "PATCH", body: { flag: "false" } })).status, 204);
  assert.equal((await call(`${BASE_RECORD}/flag`)).json.value, false);
  // Independent live probes also accepted surrounding integer whitespace and
  // Boolean text in another case; these are wire conversions, not form parsing.
  assert.equal((await call(BASE_RECORD, { method: "PATCH", body: { count: " 12 ", flag: "TRUE" } })).status, 204);
  assert.equal((await call(`${BASE_RECORD}/count`)).json.value, 12);
  assert.equal((await call(`${BASE_RECORD}/flag`)).json.value, true);
  for (const rejected of [{ amount: "12.50" }, { price: "12.50" }, { flag: 1 }, { flag: 0 }, { count: "no" }, { rate: "no" }, { title: 5 }, { address: " ".repeat(31) }]) {
    const before = app.store.snapshot().tables;
    assert.equal((await call(BASE_RECORD, { method: "PATCH", body: rejected })).status, 400, JSON.stringify(rejected));
    assert.deepEqual(app.store.snapshot().tables, before);
  }
  assert.equal((await call(BASE_RECORD, { method: "PATCH", body: { address: " \u2028\u2029 " } })).status, 204);
  assert.equal((await call(`${BASE_RECORD}/address`)).status, 204, "whitespace email becomes null");
  // Internal fixture wrappers remain supported; the public policy separately
  // rejects object payloads before they reach the reusable store coercion.
  app.store.updateRecord("probeentry", BASE_ID, { category: { value: 1, label: "One" } }, {}, { coerce: true });
  assert.equal(app.store.snapshot().tables.probeentry[0].category, 1);
});

test("invalid calendar, clock, offset and GUID inputs reject atomically", async (t) => {
  const { app, call } = await start(t);
  const invalidDates = ["2026-02-30", "2026-13-10", "2026-10-10T24:00:00Z", "2026-10-10T12:60:00Z", "2026-10-10T12:00:60Z", "2026-10-10T12:00:00+24:00"];
  for (const value of invalidDates) {
    assert.equal(parseDateValue(value), null, value);
    for (const field of ["localdate", "reviewdate"]) {
      const before = app.store.snapshot().tables;
      const result = await call(BASE_RECORD, { method: "PATCH", body: { [field]: value } });
      assert.equal(result.status, 400, `${field}: ${value}`);
      assert.equal(result.json.error.innererror.code, value.includes('T') && !value.endsWith('+24:00') ? '0x80048d19' : '0x80040239', 'clock/calendar literal errors fail the OData conversion phase');
      assert.deepEqual(app.store.snapshot().tables, before);
    }
  }
  for (const value of ["not-guid", 42, {}, "00000000-0000-0000-0000-00000000000x"]) {
    const before = app.store.snapshot().tables;
    assert.equal((await call(BASE_RECORD, { method: "PATCH", body: { referenceid: value } })).status, 400, JSON.stringify(value));
    assert.deepEqual(app.store.snapshot().tables, before);
  }
  assert.ok(parseDateValue("2026-10-10T23:59:59+14:00"));
});

test("low-year date inputs cannot bypass the CRM minimum through the JavaScript 1900 offset", async (t) => {
  const { app, call } = await start(t);
  for (const value of ["0000-01-01", "0026-01-01", "0099-01-01T12:00:00Z", "0004-02-29T12:00:00Z"]) {
    for (const field of ["localdate", "reviewdate"]) {
      const before = app.store.snapshot().tables;
      const result = await call(BASE_RECORD, { method: "PATCH", body: { [field]: value } });
      assert.equal(result.status, 400, `${field}: ${value}`);
      assert.equal(result.json.error.innererror.code, "0x80040239");
      assert.deepEqual(app.store.snapshot().tables, before);
    }
  }
});

test("numeric and option validation messages identify the schema-derived column, value and bounds", async (t) => {
  const { app, call } = await start(t);
  const cases = [
    [{ count: -1 }, "A validation error occurred. The value -1 of 'count' on record of type 'probeentry' is outside the valid range. Minimum Value: 0, Maximum value: 100"],
    [{ count: 101 }, "A validation error occurred. The value 101 of 'count' on record of type 'probeentry' is outside the valid range. Minimum Value: 0, Maximum value: 100"],
    [{ price: -1 }, "A validation error occurred for probeentry.price. The value -1 of type Microsoft.Xrm.Sdk.Money is outside the valid range(0 to 1000)."],
    [{ amount: 100.01 }, "A validation error occurred for probeentry.amount. The value 100.01 of type System.Decimal is outside the valid range(0 to 100)."],
    [{ rate: -1 }, "A validation error occurred for probeentry.rate. The value -1 of type System.Double is outside the valid range(0 to 1000)."],
    [{ category: 99 }, "A validation error occurred. The value 99 of 'category' on record of type 'probeentry' is outside the valid range. Accepted Values: 1"],
  ];
  for (const [body, message] of cases) {
    const before = app.store.snapshot().tables;
    const result = await call(BASE_RECORD, { method: "PATCH", body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.json.error.innererror.message, message);
    assert.deepEqual(app.store.snapshot().tables, before);
  }
});
