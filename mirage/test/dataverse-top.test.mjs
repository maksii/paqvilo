import test from "node:test";
import assert from "node:assert/strict";
import {
  DataStore,
  emptyState,
} from "../lib/data.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
const APP = "10000000-0000-4000-8000-000000000001",
  SECRET = "PAQVILO_TEST_TOP_SECRET";
test("Dataverse collection $top parses native signed/whitespace Int64 input and bounded positive Int32 query limits", async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = "invented-top-secret";
  const state = emptyState();
  state.mappings.sample = {
    logicalName: "sample",
    entitySet: "samples",
    idColumn: "sampleid",
    nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" } },
  };
  state.tables.sample = [1, 2, 3].map((n) => ({
    sampleid: "20000000-0000-4000-8000-" + String(n).padStart(12, "0"),
    name: "Sample " + n,
  }));
  const store = await new DataStore({ state }).init(),
    api = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: "Top fixture",
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
  const tokenResponse = await fetch(api.authority + "/oauth2/v2.0/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: APP,
      client_secret: process.env[SECRET],
      scope: api.origin + "/.default",
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const request = (url, options = {}) =>
    fetch(api.origin + "/api/data/v9.2/" + url, {
      ...options,
      headers: { authorization: "Bearer " + token, ...options.headers },
    });
  for (const subject of ["A", "B", "C"]) {
    const r = await request("tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject }),
    });
    assert.equal(r.status, 204);
  }
  const before = JSON.stringify(store.state.tables.sample);
  for (const set of ["samples", "activitypointers"]) {
    for (const value of ["1", "+1", " 1 ", "\t+1\r\n", "01", "2147483647"])
      await t.test(set + " accepts " + JSON.stringify(value), async () => {
        const r = await request(
          set + "?" + new URLSearchParams({ $top: value }),
        );
        assert.equal(r.status, 200);
        assert.equal(
          (await r.json()).value.length,
          value === "2147483647" ? 3 : 1,
        );
      });
    for (const value of ["0", "-0", "000", "+0"])
      await t.test(set + " rejects zero " + JSON.stringify(value), async () => {
        const r = await request(
          set + "?" + new URLSearchParams({ $top: value }),
        );
        assert.equal(r.status, 400);
        const e = (await r.json()).error;
        assert.equal(e.code, "0x80060888");
        assert.equal(e.message, "Invalid value for $top query option.");
      });
    for (const value of [
      "-1",
      "abc",
      "1.0",
      "1e0",
      "9223372036854775808",
      "9".repeat(1000),
      "\u00a01\u00a0",
    ])
      await t.test(
        set + " rejects grammar/range " + JSON.stringify(value).slice(0, 60),
        async () => {
          const r = await request(
            set + "?" + new URLSearchParams({ $top: value }),
          );
          assert.equal(r.status, 400);
          const e = (await r.json()).error;
          assert.equal(e.code, "0x80060888");
          assert.equal(
            e.message,
            `Invalid value '${value}' for $top query option found. The $top query option requires a non-negative integer value.`,
          );
        },
      );
    for (const value of ["2147483648", "+2147483648", "9223372036854775807"])
      await t.test(set + " rejects query bound " + value, async () => {
        const r = await request(
          set + "?" + new URLSearchParams({ $top: value }),
        );
        assert.equal(r.status, 400);
        const e = (await r.json()).error;
        assert.equal(e.code, "0x80060888");
        assert.equal(
          e.message,
          `The limit of '2147483647' for Top query has been exceeded. The value from the incoming request is '${BigInt(value)}'.`,
        );
      });
    const duplicate = await request(set + "?$top=1&$top=2");
    assert.equal(duplicate.status, 400);
    assert.equal(
      (await duplicate.json()).error.message,
      "Query option '$top' was specified more than once, but it must be specified at most once.",
    );
  }
  assert.equal(JSON.stringify(store.state.tables.sample), before);
  assert.equal(
    store.query("sample", { $top: 0 }, { admin: true }).value.length,
    0,
    "internal query retains zero limit",
  );
  assert.equal(
    store.query("sample", { $top: "1e0" }, { admin: true }).value.length,
    1,
    "internal extended numeric parsing is unchanged",
  );
});
