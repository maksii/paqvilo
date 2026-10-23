import test from "node:test";
import assert from "node:assert/strict";
import {
  DataStore,
  emptyState,
} from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import {
  install,
  parseCustomApiFiles,
} from "../lib/dataverse-customapi.mjs";
import { createOrganizationRuntime } from "../lib/dataverse-organization.mjs";
import { sourceOrganizationExtensions } from "../lib/source-organization-extensions.mjs";

const APP = "10000000-0000-4000-8000-000000000001",
  ID = "20000000-0000-4000-8000-000000000001";
const SECRET = "PAQVILO_SCALAR_READER_TEST_SECRET";
const nativeCause = (literal, target, source) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type '${source}' to the expected target type '${target}'.`;
const nativeFormat = (literal, target, cause) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> System.FormatException: ${cause}`;

test("HTTP scalar errors retain native type/format causes and exact numeric tokens without inventing CLR stacks", async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = "invented-loopback-secret";
  const state = emptyState();
  state.mappings.sample = {
    logicalName: "sample",
    entitySet: "samples",
    idColumn: "sampleid",
    nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar" },
      quantity: { dataverseType: "int" },
      enabled: { dataverseType: "bit" },
      amount: { dataverseType: "decimal" },
      price: { dataverseType: "money" },
      ratio: { dataverseType: "float" },
      stamp: { dataverseType: "datetime" },
      day: { dataverseType: "datetime", dateTimeBehavior: "DateOnly" },
      choice: { dataverseType: "picklist" },
      tags: { dataverseType: "multiselectpicklist" },
    },
  };
  state.tables.sample = [
    {
      sampleid: ID,
      name: "Unchanged",
      quantity: 7,
      enabled: true,
      amount: 1.25,
      price: 2.5,
      ratio: 1.5,
      stamp: "2020-01-15T12:00:00Z",
      day: "2020-01-15",
      choice: 1,
      tags: "1",
    },
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
            displayName: "Invented reader client",
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
  const auth = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: APP,
      client_secret: process.env[SECRET],
      scope: `${api.origin}/.default`,
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const initial = JSON.stringify(store.state.tables.sample);
  const cases = [
    ["name", "1", nativeCause("1", "Edm.String", "Edm.Int32")],
    ["name", "1.0", nativeCause("1.0", "Edm.String", "Edm.Decimal")],
    [
      "name",
      "9007199254740993",
      nativeCause("9007199254740993", "Edm.String", "Edm.Decimal"),
    ],
    ["name", "false", nativeCause("False", "Edm.String", "Edm.Boolean")],
    ["quantity", "true", nativeCause("True", "Edm.Int32", "Edm.Boolean")],
    ["quantity", "1.25", nativeCause("1.25", "Edm.Int32", "Edm.Decimal")],
    [
      "quantity",
      '"not-a-number"',
      nativeFormat(
        "not-a-number",
        "Edm.Int32",
        "Input string was not in a correct format.",
      ),
    ],
    ["enabled", "1", nativeCause("1", "Edm.Boolean", "Edm.Int32")],
    ["enabled", "2", nativeCause("2", "Edm.Boolean", "Edm.Int32")],
    [
      "enabled",
      '""',
      nativeFormat(
        "",
        "Edm.Boolean",
        "String was not recognized as a valid Boolean.",
      ),
    ],
    ["price", "true", nativeCause("True", "Edm.Decimal", "Edm.Boolean")],
    ["ratio", "false", nativeCause("False", "Edm.Double", "Edm.Boolean")],
    [
      "stamp",
      '"2020-02-31T12:00:00Z"',
      nativeFormat(
        "2020-02-31T12:00:00Z",
        "Edm.DateTimeOffset",
        "The string '2020-02-31T12:00:00Z' is not a valid AllXsd value.",
      ),
    ],
    ["stamp", "0", nativeCause("0", "Edm.DateTimeOffset", "Edm.Int32")],
    [
      "day",
      '"bad-date"',
      nativeFormat(
        "bad-date",
        "Edm.Date",
        "String 'bad-date' was not recognized as a valid Edm.Date.",
      ),
    ],
    ["choice", "false", nativeCause("False", "Edm.Int32", "Edm.Boolean")],
    ["tags", "2", nativeCause("2", "Edm.String", "Edm.Int32")],
  ];
  for (const [field, tokenText, cause] of cases)
    for (const method of ["POST", "PATCH"])
      await t.test(`${method} ${field} ${tokenText}`, async () => {
        const response = await fetch(
          api.origin +
            "/api/data/v9.2/" +
            (method === "POST" ? "samples" : `samples(${ID})`),
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: `{"${field}":${tokenText}}`,
          },
        );
        assert.equal(response.status, 400);
        const error = (await response.json()).error;
        assert.equal(error.code, "0x80048d19");
        assert.ok(error.message.includes(cause), error.message);
        assert.ok(
          error.message.includes(
            method === "POST" ? "Entity :'samples'" : "Entity :''",
          ),
        );
        assert.equal(error.message.includes("   at "), false);
      });
  assert.equal(
    JSON.stringify(store.state.tables.sample),
    initial,
    "all failed HTTP conversions are nonmutating",
  );
  assert.throws(
    () =>
      store.coerceRecord(
        store.state.mappings.sample,
        { name: false },
        { dataverseWebApi: true },
      ),
    (e) =>
      e.message.includes("'false'") &&
      !e.message.includes("InnerException") &&
      !e.message.includes("Edm.Boolean' to"),
  );
  assert.throws(
    () =>
      store.coerceRecord(
        store.state.mappings.sample,
        { quantity: "bad" },
        { coerce: true },
      ),
    (e) =>
      !e.message.includes("InnerException") &&
      !e.message.includes("System.FormatException"),
  );
});

test("custom API actions obtain scalar causes through the actual HTTP transport", async (t) => {
  const variable = "PAQVILO_CUSTOM_SCALAR_READER_TEST_SECRET";
  process.env[variable] = "Invented custom reader secret";
  t.after(() => delete process.env[variable]);
  const state = emptyState(),
    files = [
      {
        path: "sample_Check/customapi.xml",
        text: '<customapi uniquename="sample_Check"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
      },
      ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(
        ([name, type]) => ({
          path: `sample_Check/customapirequestparameters/${name}/customapirequestparameter.xml`,
          text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
        }),
      ),
    ];
  Object.assign(state.tables, parseCustomApiFiles(files));
  const store = await new DataStore({ state }).init();
  let calls = 0;
  const extensions = await sourceOrganizationExtensions({
    customApis: new Map([
      [
        "sample_check",
        {
          handler: async () => {
            calls++;
            return { outputs: {} };
          },
        },
      ],
    ]),
  });
  const organization = await createOrganizationRuntime({
    store,
    extensions,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP,
          displayName: "Invented custom reader",
          secretEnvironmentVariable: variable,
          roles: ["System Administrator"],
        },
      ],
    }),
  });
  t.after(() => organization.close());
  const transport = await startDataverseApi({ organization });
  t.after(() => transport.close());
  const tokenResponse = await fetch(
    transport.authority + "/oauth2/v2.0/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: APP,
        client_secret: process.env[variable],
        scope: transport.origin + "/.default",
      }),
    },
  );
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  for (const [body, cause] of [
    [
      { Count: "bad" },
      nativeFormat(
        "bad",
        "Edm.Int32",
        "Input string was not in a correct format.",
      ),
    ],
    [{ Flag: 1 }, nativeCause("1", "Edm.Boolean", "Edm.Int32")],
    [{ Name: false }, nativeCause("False", "Edm.String", "Edm.Boolean")],
    [{ Labels: ["valid", 1] }, nativeCause("1", "Edm.String", "Edm.Int32")],
  ]) {
    const response = await fetch(
      transport.origin + "/api/data/v9.2/sample_Check",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 400);
    const message = (await response.json()).error.message;
    assert.ok(message.includes(cause), message);
  }
  assert.equal(calls, 0, "invalid parameters never execute custom logic");
});

test("custom API internal callers retain original diagnostics while the actual HTTP reader carries native causes", async () => {
  const files = [
    {
      path: "sample_Action/customapi.xml",
      text: '<customapi uniquename="sample_Action"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
    },
    ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(
      ([name, type]) => ({
        path: `sample_Action/customapirequestparameters/${name}/customapirequestparameter.xml`,
        text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
      }),
    ),
  ];
  const state = emptyState(),
    rows = parseCustomApiFiles(files);
  Object.assign(state.tables, rows);
  const store = new DataStore({ state }),
    ops = [];
  install({
    store,
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op), has: () => false },
    principals: { privileges: () => new Map() },
  });
  const op = ops.find((op) => op.name === "sample_Action");
  assert.ok(op);
  for (const [body, fragment] of [
    [{ Count: "bad" }, "System.FormatException"],
    [{ Flag: 1 }, "type 'Edm.Int32'"],
    [{ Name: false }, "literal 'False'"],
    [{ Labels: ["valid", 1] }, "type 'Edm.Int32'"],
  ]) {
    const context = {
      method: "POST",
      body,
      url: new URL("http://127.0.0.1/api/data/v9.2/sample_Action"),
      user: { systemuserid: ID },
      origin: "http://127.0.0.1",
      version: "v9.2",
    };
    await assert.rejects(
      () => op.handle(context),
      (e) =>
        !e.message.includes("System.FormatException") &&
        !e.message.includes(" ---> "),
    );
    // This marker is produced only by the real Dataverse HTTP transport. The
    // end-to-end record test above independently verifies that boundary.
    const source = JSON.stringify(body);
    context.dataverseHttpReader = {
      hasJsonBody: true,
      ieee754Compatible: false,
      numberLexemeFor: () =>
        source.includes(":1") || source.includes(",1") ? "1" : undefined,
    };
    await assert.rejects(
      () => op.handle(context),
      (e) => e.message.includes(fragment) && !e.message.includes("   at "),
    );
    for (const [method, hasJsonBody] of [["POST", false], ["GET", false], ["GET", true]]) {
      // A URI function or a non-JSON caller has no qualified JSON-reader cause,
      // even if an HTTP transport marker is present.
      state.tables.customapi[0].isfunction = method === "GET";
      await assert.rejects(
        () => op.handle({
          ...context,
          method,
          ...(method === "GET" ? { body: undefined, params: body } : {}),
          dataverseHttpReader: { ...context.dataverseHttpReader, hasJsonBody },
        }),
        (error) => !error.message.includes("System.FormatException") && !error.message.includes(" ---> "),
      );
      state.tables.customapi[0].isfunction = false;
    }
  }
});
