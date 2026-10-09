import test from "node:test";
import assert from "node:assert/strict";
import { classifyGuidLiterals } from "../lib/guid-inventory.mjs";
const id = "0ae15f60-2ce0-f011-8543-6045bdf47c74";
test("Literal GUID audit distinguishes missing binding data, component metadata, existing data and contextual solution views", () => {
  const mappings = {
    sample_changerequesttype: { entitySet: "sample_changerequesttypes" },
  };
  const text = `const value = '/sample_changerequesttypes(${id})';`;
  assert.deepEqual(
    classifyGuidLiterals(text, { mappings }).map(
      ({ classification, entity }) => ({ classification, entity }),
    ),
    [{ classification: "missing-data", entity: "sample_changerequesttype" }],
  );
  assert.equal(
    classifyGuidLiterals(text, {
      mappings,
      records: new Map([[id, ["sample_changerequesttype"]]]),
    })[0].classification,
    "present-data",
  );
  assert.equal(
    classifyGuidLiterals(text, { components: new Set([id]) })[0].classification,
    "component",
  );
  assert.equal(
    classifyGuidLiterals(`const formId = '${id}'`)[0].classification,
    "component",
  );
  assert.equal(
    classifyGuidLiterals(
      `<condition attribute="contactid" uitype="contact" value="${id}"/>`,
      { source: "View.xml" },
    )[0].classification,
    "contextual-view-binding",
  );
  assert.equal(
    classifyGuidLiterals(`const unresolved = '${id}'`)[0].classification,
    "unclassified",
  );
});
