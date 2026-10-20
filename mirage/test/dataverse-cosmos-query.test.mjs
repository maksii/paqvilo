import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileCosmosQuery, cosmosParameters } from "../lib/dataverse-cosmos-query.mjs";

const documents = [
  { props: { name: "A", kind: "humidity", json: { power: 12, tags: ["a", "b"] } } },
  { props: { name: "B", kind: "humidity", json: { power: 7, tags: [] } } },
  { props: { name: "C", kind: "heat", json: { power: 16 } } },
  { props: { name: "D", kind: "humidity", json: { power: 4 } } },
];

describe("local Cosmos SQL grammar", () => {
  it("projects nested JSON paths and typed parameters with boolean conditions, arithmetic and sorting", () => {
    const params = cosmosParameters({ Keys: ["@kind", "@min"], Values: [{ Type: "System.String", Value: "humidity" }, { Type: "System.Int32", Value: "5" }] });
    const query = compileCosmosQuery("SELECT c.props.name AS device, c.props.json.power * 2 AS watts FROM c WHERE c.props.kind=@kind AND c.props.json.power > @min ORDER BY c.props.json.power DESC", params);
    assert.deepEqual(query(documents), [{ device: "A", watts: 24 }, { device: "B", watts: 14 }]);
  });
  it("supports distinct value projections, bracket paths, membership and offset limits", () => {
    const query = compileCosmosQuery('SELECT DISTINCT VALUE c.props["kind"] FROM c WHERE c.props.json.power IN (4,7,12,16) ORDER BY c.props.kind OFFSET 1 LIMIT 1');
    assert.deepEqual(query(documents), ["humidity"]);
    assert.deepEqual(compileCosmosQuery("SELECT TOP 1 c.props.name AS name FROM c WHERE ARRAY_CONTAINS(c.props.json.tags,'b')")(documents), [{ name: "A" }]);
  });
  it("missing values follow JSON undefined semantics and cannot read inherited JavaScript properties", () => {
    assert.deepEqual(compileCosmosQuery("SELECT c.props.name, c.props.absent FROM c WHERE NOT IS_DEFINED(c.props.absent)")(documents), [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]);
    assert.deepEqual(compileCosmosQuery("SELECT c.constructor, c.__proto__ FROM c")(documents), [{}, {}, {}, {}]);
  });
  it("refuses missing/malformed parameters and unsupported syntax before execution, even against an empty table", () => {
    assert.throws(() => cosmosParameters({ Keys: ["@n"], Values: [{ Type: "System.Int32", Value: "text" }] }), /numeric/);
    assert.throws(() => cosmosParameters({ Keys: ["@n"], Values: [] }), /matching/);
    assert.throws(() => compileCosmosQuery("SELECT c.props.name FROM c WHERE c.props.name=@missing"), /Missing query parameter/);
    assert.throws(() => compileCosmosQuery("SELECT other.props.name FROM c"), /alias/);
    for (const text of ["DELETE FROM c", "SELECT COUNT(1) FROM c", "SELECT * FROM c JOIN p IN c.props", "SELECT * FROM c; DROP TABLE c", "SELECT TOP -1 * FROM c"])
      assert.throws(() => compileCosmosQuery(text), (error) => [400, 501].includes(error.status));
  });
});
