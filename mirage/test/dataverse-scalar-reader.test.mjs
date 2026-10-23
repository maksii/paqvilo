import test from "node:test";
import assert from "node:assert/strict";
import {
  scalarNumberLexemes,
  dataverseScalarCause,
  dataverseHttpReaderContext,
} from "../lib/dataverse-scalar-reader.mjs";
test("source facts preserve lexemes and refuse conflicting nested property spellings", () => {
  const facts = scalarNumberLexemes(
    '{"a":2147483648,"b":1.0,"nested":{"b":1},"c":1e0}',
  );
  assert.equal(facts("a", 2147483648), "2147483648");
  assert.equal(facts("b", 1), undefined);
  assert.equal(facts("c", 1), "1e0");
  assert.equal(
    dataverseScalarCause(2147483648, "Edm.Int32", {
      numericLexeme: facts("a", 2147483648),
    }),
    "Cannot convert the literal '2147483648' to the expected type 'Edm.Int32'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Decimal' to the expected target type 'Edm.Int32'.",
  );
  assert.equal(
    dataverseScalarCause(1, "Edm.String", { numericLexeme: facts("c", 1) }),
    null,
  );
});

test("reader source parsing is lazy and remains bounded to each actual JSON request", () => {
  const context = dataverseHttpReaderContext({
    method: "PATCH",
    route: { kind: "entity", set: "samples" },
    headers: { "Content-Type": 'application/json; IEEE754Compatible="true"' },
    bodyBuffer: Buffer.from("not JSON"),
  });
  assert.equal(context.ieee754Compatible, true);
  assert.equal(context.recordPayload, true);
  assert.equal(typeof context.numberLexemeFor, "function");
  assert.throws(() => context.numberLexemeFor("quantity", 1), SyntaxError);
  const unrelated = dataverseHttpReaderContext({
    method: "POST",
    route: { kind: "action" },
    headers: { "content-type": "application/octet-stream" },
    bodyBuffer: Buffer.from("not JSON"),
  });
  assert.equal(unrelated.numberLexemeFor, undefined);
  assert.equal(unrelated.recordPayload, false);
});

test("unqualified numeric-string overflow and exponent reader diagnostics are preserved", () => {
  assert.equal(dataverseScalarCause("2147483648", "Edm.Int32"), null);
  assert.equal(
    dataverseScalarCause(1, "Edm.String", { numericLexeme: "1e0" }),
    null,
  );
  assert.equal(
    dataverseScalarCause(1, "Edm.Unknown", { numericLexeme: "1" }),
    null,
  );
});
test("native Boolean casing and typed causes do not invent CLR stack frames", () => {
  for (const type of ["Edm.String", "Edm.Int32", "Edm.Decimal", "Edm.Double"]) {
    const message = dataverseScalarCause(true, type);
    assert.ok(message.includes("literal 'True'"));
    assert.ok(message.includes("type 'Edm.Boolean'"));
    assert.equal(message.includes("   at "), false);
  }
  assert.ok(
    dataverseScalarCause("", "Edm.Boolean").includes(
      "String was not recognized as a valid Boolean.",
    ),
  );
  assert.ok(
    dataverseScalarCause("2020-02-30", "Edm.Date").includes(
      "not recognized as a valid Edm.Date",
    ),
  );
});

test("leading request BOM preserves numeric lexemes and nested ambiguity without accepting extra BOMs", () => {
  const facts = scalarNumberLexemes(
    '\uFEFF{"name":9007199254740993,"a":1.0,"nested":{"a":1},"label":"\uFEFFinside"}',
  );
  assert.equal(facts("name", {
    $type: "DataverseNumeric", numericType: "Literal", value: "9007199254740993",
  }), "9007199254740993");
  assert.equal(facts("a", 1), undefined);
  for (const source of ['\uFEFF\uFEFF{}', ' \uFEFF{}'])
    assert.throws(() => scalarNumberLexemes(source), SyntaxError);
});
