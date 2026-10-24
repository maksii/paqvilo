import test from "node:test";
import assert from "node:assert/strict";
import {
  DataStore,
  emptyState,
} from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { isExactNumeric } from "../lib/exact-numeric.mjs";
const APP = "10000000-0000-4000-8000-000000000001",
  ID = "20000000-0000-4000-8000-000000000001",
  SECRET = "PAQVILO_TEST_IEEE754_SECRET";
test("Dataverse Decimal/Money request representations follow Content-Type independently of Accept, including batch parts", async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = "invented-ieee754-secret";
  const state = emptyState();
  state.mappings.sample = {
    logicalName: "sample",
    entitySet: "samples",
    idColumn: "sampleid",
    nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar" },
      amount: { dataverseType: "decimal", precision: 10 },
      price: { dataverseType: "money", precision: 4 },
      big: { dataverseType: "bigint" },
    },
  };
  state.tables.sample = [
    { sampleid: ID, name: "IEEE sample", amount: 0, price: 0, big: 1 },
  ];
  const store = await new DataStore({ state }).init(),
    api = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: "IEEE fixture",
            secretEnvironmentVariable: SECRET,
            roles: ["System Administrator"],
          },
        ],
      }),
      log: () => {},
    });
  t.after(async () => {
    await api.close();
    if (previous === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previous;
  });
  const tokenResponse = await fetch(
    `${api.origin}/${api.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: APP,
        client_secret: process.env[SECRET],
        scope: `${api.origin}/.default`,
      }),
    },
  );
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const req = (url, o = {}) =>
      fetch(api.origin + "/api/data/v9.2/" + url, {
        ...o,
        headers: { authorization: "Bearer " + token, ...o.headers },
      }),
    path = "samples(" + ID + ")";
  for (const field of ["amount", "price"])
    for (const compatible of [false, true])
      for (const kind of ["string", "number"])
        for (const method of ["POST", "PATCH"])
          await t.test(
            [field, compatible, kind, method].join(" "),
            async () => {
              const before = JSON.stringify(store.state.tables.sample),
                body =
                  '{"' +
                  field +
                  '":' +
                  (kind === "string" ? '"1.25"' : "1.25") +
                  "}",
                accepted = compatible ? kind === "string" : kind === "number";
              const r = await req(method === "POST" ? "samples" : path, {
                method,
                headers: {
                  "content-type":
                    "application/json; IEEE754Compatible=" + compatible,
                  accept: "application/json; IEEE754Compatible=" + !compatible,
                },
                body,
              });
              assert.equal(r.status, accepted ? 204 : 400);
              if (!accepted) {
                const e = (await r.json()).error;
                assert.equal(e.code, "0x80048d19");
                assert.ok(
                  e.message.includes(
                    "parameter 'IEEE754Compatible' false/true",
                  ),
                );
                assert.equal(
                  JSON.stringify(store.state.tables.sample),
                  before,
                  "failed payload cannot write",
                );
              }
            },
          );
  for (const field of ["amount", "price"])
    for (const body of ['"not-a-number"', '""', '"NaN"']) {
      const before = JSON.stringify(store.state.tables.sample),
        r = await req(path, {
          method: "PATCH",
          headers: {
            "content-type": 'application/json;IEEE754Compatible="true"',
          },
          body: '{"' + field + '":' + body + "}",
        });
      assert.equal(r.status, 400);
      assert.equal(JSON.stringify(store.state.tables.sample), before);
    }
  for (const field of ["amount", "price"])
    // Each spelling is covered by the reader's own table (dataverse-decimal-input.test.mjs); these prove the Web API uses it.
    for (const [value, expected] of [
      ["1,2,3.5", 123.5],
      ["1.25-", -1.25],
    ])
      await t.test(
        field + " native lexical spelling " + JSON.stringify(value),
        async () => {
          const r = await req(path, {
            method: "PATCH",
            headers: {
              "content-type": "application/json;IEEE754Compatible=true",
            },
            body: JSON.stringify({ [field]: value }),
          });
          assert.equal(r.status, 204);
          assert.equal(
            Number(
              store.state.tables.sample.find((r) => r.sampleid === ID)[field]
                ?.value ??
                store.state.tables.sample.find((r) => r.sampleid === ID)[field],
            ),
            expected,
          );
        },
      );
  for (const field of ["amount", "price"]) {
    const r = await req(path, {
      method: "PATCH",
      headers: { "content-type": "application/json;IEEE754Compatible=true" },
      body: JSON.stringify({ [field]: "0.12345678901234567890123456789" }),
    });
    assert.equal(
      r.status,
      204,
      "native Decimal reader rounds overprecision before column rounding",
    );
    assert.equal(
      Number(
        store.state.tables.sample.find((r) => r.sampleid === ID)[field]
          ?.value ??
          store.state.tables.sample.find((r) => r.sampleid === ID)[field],
      ),
      field === "amount" ? 0.123456789 : 0.1235,
    );
  }
  for (const value of ["1e2", "1 25", "Infinity", ".", "++1", "1+2"]) {
    const before = JSON.stringify(store.state.tables.sample),
      r = await req(path, {
        method: "PATCH",
        headers: { "content-type": "application/json;IEEE754Compatible=true" },
        body: JSON.stringify({ amount: value }),
      });
    assert.equal(r.status, 400);
    assert.equal(JSON.stringify(store.state.tables.sample), before);
  }
  for (const field of ["amount", "price"]) {
    const r = await req(path, {
      method: "PATCH",
      headers: { "content-type": "application/json;IEEE754Compatible=TrUe" },
      body: '{"' + field + '":null}',
    });
    assert.equal(r.status, 204);
  }
  for (const header of [
    "application/json",
    "application/json;IEEE754Compatible=false",
  ]) {
    const r = await req(path, {
      method: "PATCH",
      headers: { "content-type": header },
      body: '{"amount":1.5}',
    });
    assert.equal(r.status, 204);
  }
  const exact = "123456789012345.1234567890",
    r = await req(path, {
      method: "PATCH",
      headers: { "content-type": "application/json;IEEE754Compatible=true" },
      body: '{"amount":"' + exact + '","big":"9223372036854775807"}',
    });
  assert.equal(r.status, 204);
  const row = store.state.tables.sample.find((r) => r.sampleid === ID);
  assert.ok(isExactNumeric(row.amount));
  assert.equal(row.amount.value, "123456789012345.123456789");
  assert.ok(isExactNumeric(row.big));
  assert.equal(row.big.value, "9223372036854775807");
  for (const ct of [
    "application/json",
    "application/json;IEEE754Compatible=true",
  ]) {
    const r = await req(path, {
      method: "PATCH",
      headers: { "content-type": ct },
      body: '{"big":"9223372036854775807"}',
    });
    assert.equal(r.status, 204, "existing Int64 string path unchanged");
  }
  const parts = [
    {
      id: "s",
      method: "PATCH",
      url: path,
      headers: { "content-type": "application/json;IEEE754Compatible=true" },
      body: { amount: "2.5" },
    },
    {
      id: "n",
      method: "PATCH",
      url: path,
      headers: { "content-type": "application/json;IEEE754Compatible=true" },
      body: { amount: 2.5 },
    },
  ];
  const batch = await req("$batch", {
    method: "POST",
    headers: {
      "content-type": "application/json;IEEE754Compatible=false",
      prefer: "odata.continue-on-error",
    },
    body: JSON.stringify({ requests: parts }),
  });
  const batchText = await batch.text();
  assert.equal(batch.status, 200, batchText);
  assert.deepEqual(
    [...batchText.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1])),
    [204, 400],
  );
  const mapping = store.state.mappings.sample;
  assert.throws(
    () => store.coerceRecord(mapping, { amount: "1.25" }, { dataverseWebApi: true }),
    { status: 400, details: { innerCode: "0x80048d19" }, message: "Cannot convert the literal '1.25' to the expected type 'Edm.Decimal'." },
  );
  const internal = store.coerceRecord(
    mapping,
    { amount: 1.25 },
    { dataverseWebApi: true },
  );
  assert.equal(
    internal.amount,
    1.25,
    "internal SDK/portal coercion still accepts numeric Decimal",
  );
});
