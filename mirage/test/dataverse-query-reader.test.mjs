import test from "node:test";
import assert from "node:assert/strict";
import {
  DataStore,
  emptyState,
} from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import {
  parseODataExpression,
  parseOrderBy,
} from "../lib/odata-query.mjs";
const APP = "10000000-0000-4000-8000-000000000001",
  ID = "20000000-0000-4000-8000-000000000001";
test("HTTP native query reader retains qualified parser positions and unary Negate statuses without changing rows", async (t) => {
  const variable = "PAQVILO_QUERY_DIAGNOSTIC_TEST_SECRET";
  process.env[variable] = "Invented native query test secret";
  t.after(() => delete process.env[variable]);
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
      stamp: { dataverseType: "datetime" },
      parentid: { dataverseType: "lookup", target: "sample" },
    },
    relationships: {
      parent: {
        entity: "sample",
        from: "parentid",
        to: "sampleid",
        type: "lookup",
      },
    },
  };
  state.tables.sample = [
    {
      sampleid: ID,
      name: "Unchanged",
      quantity: 1,
      enabled: true,
      stamp: "2020-01-01T00:00:00Z",
    },
  ];
  const store = await new DataStore({ state }).init(),
    server = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: "Invented query client",
            secretEnvironmentVariable: variable,
            roles: ["System Administrator"],
          },
        ],
      }),
      log() {},
    });
  t.after(() => server.close());
  const auth = await fetch(server.authority + "/oauth2/v2.0/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: APP,
      client_secret: process.env[variable],
      scope: server.origin + "/.default",
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const initial = JSON.stringify(store.state.tables.sample),
    request = (params) =>
      fetch(
        server.origin +
          "/api/data/v9.2/samples?" +
          new URLSearchParams({ $select: "sampleid", ...params }),
        { headers: { authorization: "Bearer " + token } },
      );
  const cases = [
    [
      "$filter",
      "quantity eq",
      400,
      "Expression expected at position 11 in 'quantity eq'.",
    ],
    [
      "$filter",
      "quantity eq ",
      400,
      "Expression expected at position 12 in 'quantity eq '.",
    ],
    [
      "$filter",
      "(quantity eq 1",
      400,
      "')' or operator expected at position 14 in '(quantity eq 1'.",
    ],
    [
      "$filter",
      " (quantity eq 1",
      400,
      "')' or operator expected at position 15 in ' (quantity eq 1'.",
    ],
    [
      "$filter",
      "((quantity eq 1)",
      400,
      "')' or operator expected at position 16 in '((quantity eq 1)'.",
    ],
    [
      "$filter",
      "(quantity eq 1 ",
      400,
      "')' or operator expected at position 15 in '(quantity eq 1 '.",
    ],
    [
      "$filter",
      "(quantity eq 12",
      400,
      "')' or operator expected at position 15 in '(quantity eq 12'.",
    ],
    [
      "$filter",
      "((quantity eq 1) and (quantity eq 2)",
      400,
      "')' or operator expected at position 36 in '((quantity eq 1) and (quantity eq 2)'.",
    ],
    [
      "$filter",
      "sampleid eq not-a-guid",
      400,
      "Syntax error at position 18 in 'sampleid eq not-a-guid'.",
    ],
    [
      "$filter",
      "sampleid eq bad-guid",
      400,
      "Syntax error at position 16 in 'sampleid eq bad-guid'.",
    ],
    [
      "$orderby",
      "name sideways",
      400,
      "Syntax error at position 13 in 'name sideways'.",
    ],
    [
      "$orderby",
      "name sideways ",
      400,
      "Syntax error at position 13 in 'name sideways '.",
    ],
    [
      "$orderby",
      "name asc sideways",
      400,
      "Syntax error at position 17 in 'name asc sideways'.",
    ],
    [
      "$orderby",
      "name asc, quantity sideways",
      400,
      "Syntax error at position 27 in 'name asc, quantity sideways'.",
    ],
    [
      "$filter",
      "quantity eq -quantity",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    [
      "$filter",
      "-quantity lt 0",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    [
      "$filter",
      "quantity eq -(quantity)",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    [
      "$filter",
      "quantity eq -(1)",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    [
      "$filter",
      "quantity eq -null",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    [
      "$filter",
      "name eq -name",
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.String' for operator kind 'Negate'.",
    ],
    [
      "$filter",
      "enabled eq -enabled",
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Boolean' for operator kind 'Negate'.",
    ],
    [
      "$filter",
      "stamp eq -stamp",
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.DateTimeOffset' for operator kind 'Negate'.",
    ],
    [
      "$filter",
      "sampleid eq -sampleid",
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Guid' for operator kind 'Negate'.",
    ],
    [
      "$filter",
      "quantity eq +quantity",
      400,
      "Syntax error: character '+' is not valid at position 12 in 'quantity eq +quantity'.",
    ],
    ...[
      ["-2147483648", "Edm.Int32"],
      ["2147483648", "Edm.Int64"],
      ["1.5", "Edm.Single"],
      ["0.1", "Edm.Single"],
      ["1e2", "Edm.Single"],
    ].map(([literal, type]) => [
      "$filter",
      `name eq ${literal}`,
      400,
      `A binary operator with incompatible types was detected. Found operand types 'Edm.String' and '${type}' for operator kind 'Equal'.`,
    ]),
    ...[
      ["quantity eq @", "Syntax error at position 13 in 'quantity eq @'."],
      ["@", "Syntax error at position 1 in '@'."],
      [
        "quantity eq @ ",
        "Syntax error: character ' ' is not valid at position 13 in 'quantity eq @ '.",
      ],
      [
        "quantity eq @1",
        "Syntax error: character '1' is not valid at position 13 in 'quantity eq @1'.",
      ],
      [
        "quantity eq @@v",
        "Syntax error: character '@' is not valid at position 13 in 'quantity eq @@v'.",
      ],
    ].map(([filter, message]) => ["$filter", filter, 400, message]),
    ...[
      ["1", "Edm.Int32"],
      ["1.5", "Edm.Single"],
      ["1L", "Edm.Int64"],
      ["1m", "Edm.Decimal"],
      ["1e2", "Edm.Single"],
      ["2147483648", "Edm.Int32"],
      ["2147483649", "Edm.Int64"],
      ["9223372036854775808", "Edm.Int64"],
      ["9223372036854775809", "Edm.Decimal"],
      ["0.1", "Edm.Single"],
      ["1.2345678", "Edm.Double"],
      ["1.23456789", "Edm.Double"],
      ["0.10000000000000001", "Edm.Decimal"],
      ["1e100", "Edm.Double"],
      ["1d", "Edm.Double"],
      ["1f", "Edm.Single"],
      ["79228162514264337593543950335", "Edm.Decimal"],
      ["79228162514264337593543950336", "Edm.Double"],
      ["10000000000000000000", "Edm.Single"],
      ["18446744073709551616", "Edm.Decimal"],
      ["10000000000000000000000000000", "Edm.Double"],
    ].map(([literal, type]) => [
      "$filter",
      `quantity eq --${literal}`,
      400,
      `Unrecognized '${type}' literal '--${literal}' at '12' in 'quantity eq --${literal}'.`,
    ]),
    [
      "$filter",
      "quantity eq ---1",
      400,
      "Unrecognized 'Edm.Int32' literal '--1' at '13' in 'quantity eq ---1'.",
    ],
    [
      "$filter",
      "quantity eq - -1",
      400,
      "Unrecognized 'Edm.Int32' literal '--1' at '12' in 'quantity eq - -1'.",
    ],
    [
      "$filter",
      "quantity eq --1e400",
      400,
      "Numeric string '-1e400' is not a valid Int32/Int64/Double/Decimal.",
    ],
    [
      "$filter",
      "quantity eq --quantity",
      501,
      'The "Negate" operator isn\'t supported.',
    ],
    ...["1", "0", "-1", "abc"].map((value) => [
      "$skip",
      value,
      400,
      "Skip Clause is not supported in CRM",
    ]),
  ];
  for (const [option, value, status, message] of cases)
    await t.test(option + " " + value, async () => {
      const response = await request({ [option]: value });
      assert.equal(response.status, status);
      const error = (await response.json()).error;
      assert.equal(error.code, status === 501 ? "0x8006088a" : "0x80060888");
      assert.equal(error.message, message);
    });
  for (const filter of ["quantity eq -1", "quantity eq null", "not enabled"]) {
    const response = await request({ $filter: filter });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).value));
  }
  for (const [filter, aliases] of [
    ["quantity eq @v", { "@v": "-1" }],
    ["quantity eq -1", {}],
  ]) {
    const response = await request({ $filter: filter, ...aliases });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).value, []);
  }
  for (const rows of [store.state.tables.sample, []]) {
    store.state.tables.sample = rows;
    for (const [filter, aliases, expectedStatus, cause] of [
      [
        "quantity eq -parent/quantity",
        {},
        400,
        /Unsupported OData (?:expression negate|filter near -)/,
      ],
      [
        "quantity eq -contains(name,'x')",
        {},
        400,
        /Unsupported OData (?:expression negate|filter near -)/,
      ],
      ["quantity eq -@v", { "@v": "1" }, 501, /Negate.*isn't supported/],
      [
        "quantity eq -missing",
        {},
        400,
        /Could not find a property named 'missing'/,
      ],
      [
        "quantity eq -@v",
        { "@v": "missing" },
        400,
        /Parameter alias @v must be a literal value/,
      ],
    ]) {
      const response = await request({ $filter: filter, ...aliases });
      assert.equal(response.status, expectedStatus, filter);
      const error = (await response.json()).error;
      assert.match(error.message, cause, filter);
    }
  }
  store.state.tables.sample = JSON.parse(initial);
  for (const [method, body, set] of [
    ["PATCH", "{bad", ""],
    ["POST", '{"name":', "samples"],
    ["PATCH", '{"name":"unfinished', ""],
  ]) {
    const response = await fetch(
      server.origin +
        "/api/data/v9.2/samples" +
        (method === "PATCH" ? `(${ID})` : ""),
      {
        method,
        body,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
      },
    );
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, "0x80048d19");
    assert.equal(
      error.message,
      `Error identified in Payload provided by the user for Entity :'${set}', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : System.ArgumentException: Stream was not readable.`,
    );
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "stack"), false);
  }
  assert.equal(JSON.stringify(store.state.tables.sample), initial);
});

test("default and strict SDK/portal parser calls retain existing unsupported syntax diagnostics", () => {
  for (const strictEdm of [false, true])
    assert.throws(
      () =>
        parseODataExpression("quantity eq -quantity", {
          strictEdm,
          columnDefinition: () => ({ dataverseType: "int" }),
        }),
      (error) =>
        error.status === 400 &&
        error.message === "Unsupported OData filter near -quantity",
    );
  assert.throws(
    () => parseODataExpression("quantity eq"),
    (error) => error.message === "Incomplete OData filter",
  );
  assert.throws(
    () => parseOrderBy("name sideways"),
    (error) => error.message === "Unsupported order name sideways",
  );
  for (const filter of ["quantity eq @", "quantity eq --1"])
    assert.throws(
      () => parseODataExpression(filter),
      (error) =>
        error.status === 400 &&
        error.message.startsWith("Unsupported OData filter near "),
    );
});

test("invalid adjacent minus chains remain bounded errors rather than recursive stack failures", () => {
  assert.throws(
    () =>
      parseODataExpression("quantity eq " + "-".repeat(10000) + "1", {
        nativeSyntax: true,
        strictEdm: true,
        columnDefinition: () => ({ dataverseType: "int" }),
      }),
    (error) =>
      error.status === 400 &&
      error.message.startsWith("Unrecognized 'Edm.Int32' literal "),
  );
  assert.throws(
    () =>
      parseODataExpression("quantity eq " + "-".repeat(10000) + "quantity", {
        nativeSyntax: true,
        strictEdm: true,
        columnDefinition: () => ({ dataverseType: "int" }),
      }),
    (error) =>
      error.status === 400 && /bounded query complexity/.test(error.message),
  );
});
