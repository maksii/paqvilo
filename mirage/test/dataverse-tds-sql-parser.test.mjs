import assert from "node:assert/strict";
import { test } from "node:test";
import { TdsSqlError } from "../lib/dataverse-tds-sql-lexer.mjs";
import { parseBatch } from "../lib/dataverse-tds-sql-parser.mjs";


const one = (sql) => {
  const { statements } = parseBatch(sql);
  assert.equal(statements.length, 1, sql);
  return statements[0];
};

const select = (sql) => {
  const stmt = one(sql);
  assert.equal(stmt.type, "Select", sql);
  return stmt;
};

// Every rejected construct is an unsupported 102 error (or 2715 for types) carrying its absolute line.
function assertRejected(sql, { number = 102, line }) {
  assert.throws(() => parseBatch(sql), (err) => {
    assert.ok(err instanceof TdsSqlError, `expected TdsSqlError for: ${sql}`);
    assert.equal(err.number, number, sql);
    assert.equal(err.unsupported, true, sql);
    assert.equal(err.line, line, sql);
    return true;
  });
}

test("supported statements parse to their AST nodes", () => {
  const cases = [
    ["DISTINCT with schema-qualified table and AS alias", "SELECT DISTINCT a.name AS n FROM dbo.account AS a", (s) => {
      assert.equal(s.distinct, true);
      assert.equal(s.from[0].source.schema, "dbo");
      assert.equal(s.from[0].source.alias, "a");
    }],
    ["TOP (n) PERCENT then star", "SELECT TOP (10) PERCENT * FROM account", (s) => {
      assert.equal(s.top.percent, true);
      assert.equal(s.top.count.text, "10");
      assert.deepEqual(s.columns, [{ kind: "Star", qualifier: null }]);
    }],
    ["TOP n without parentheses", "SELECT TOP 5 a.x AS x FROM account a", (s) => {
      assert.equal(s.top.count.text, "5");
      assert.equal(s.top.percent, false);
    }],
    ["TOP (@n) with a parenthesised variable", "SELECT TOP (@n) a.x AS x FROM account a", (s) => {
      assert.equal(s.top.count.type, "Variable");
      assert.equal(s.top.percent, false);
    }],
    ["TOP with a variable count and a qualified star", "SELECT TOP @n t.* FROM account t", (s) => {
      assert.equal(s.top.count.type, "Variable");
      assert.deepEqual(s.columns, [{ kind: "Star", qualifier: "t" }]);
    }],
    ["column aliases with and without AS", "SELECT a.name AS n, a.id m FROM account a", (s) => {
      assert.deepEqual(s.columns.map((c) => c.alias), ["n", "m"]);
    }],
    ["expression column with alias", "SELECT 1 + 2 AS total FROM account", (s) => {
      assert.equal(s.columns[0].expr.operator, "+");
      assert.equal(s.columns[0].alias, "total");
    }],
    ["INNER JOIN with ON", "SELECT a.x AS x FROM account a INNER JOIN contact c ON c.p = a.id", (s) => {
      assert.equal(s.from[0].joins[0].kind, "INNER");
      assert.equal(s.from[0].joins[0].on.operator, "=");
    }],
    ["bare JOIN is INNER", "SELECT a.x AS x FROM account a JOIN contact c ON c.p = a.id", (s) => {
      assert.equal(s.from[0].joins[0].kind, "INNER");
    }],
    ["LEFT OUTER JOIN", "SELECT a.x AS x FROM account a LEFT OUTER JOIN contact c ON c.p = a.id", (s) => {
      assert.equal(s.from[0].joins[0].kind, "LEFT");
    }],
    ["RIGHT JOIN", "SELECT a.x AS x FROM account a RIGHT JOIN contact c ON c.p = a.id", (s) => {
      assert.equal(s.from[0].joins[0].kind, "RIGHT");
    }],
    ["FULL OUTER JOIN", "SELECT a.x AS x FROM account a FULL OUTER JOIN contact c ON c.p = a.id", (s) => {
      assert.equal(s.from[0].joins[0].kind, "FULL");
    }],
    ["CROSS JOIN has no ON", "SELECT a.x AS x FROM account a CROSS JOIN contact c", (s) => {
      assert.equal(s.from[0].joins[0].kind, "CROSS");
      assert.equal(s.from[0].joins[0].on, null);
    }],
    ["CROSS APPLY with a derived table", "SELECT a.x AS x FROM account a CROSS APPLY (SELECT TOP 1 c.x AS x FROM contact c) AS d", (s) => {
      const apply = s.from[0].joins[0];
      assert.equal(apply.type, "Apply");
      assert.equal(apply.kind, "CROSS");
      assert.equal(apply.source.type, "Derived");
      assert.equal(apply.source.alias, "d");
    }],
    ["OUTER APPLY with AS alias", "SELECT a.x AS x FROM account a OUTER APPLY (SELECT c.x AS x FROM contact c) AS d", (s) => {
      assert.equal(s.from[0].joins[0].kind, "OUTER");
      assert.equal(s.from[0].joins[0].source.alias, "d");
    }],
    ["OUTER APPLY with a bare alias", "SELECT a.x AS x FROM account a OUTER APPLY (SELECT c.x AS x FROM contact c) d", (s) => {
      assert.equal(s.from[0].joins[0].source.alias, "d");
    }],
    ["derived table in FROM", "SELECT d.x AS x FROM (SELECT name AS x FROM account) AS d", (s) => {
      assert.equal(s.from[0].source.type, "Derived");
      assert.equal(s.from[0].source.query.type, "Select");
    }],
    ["derived table holding a UNION ALL", "SELECT d.x AS x FROM (SELECT a.x AS x FROM account a UNION ALL SELECT b.x AS x FROM contact b) AS d", (s) => {
      assert.equal(s.from[0].source.query.type, "SetOperation");
    }],
    ["comma-separated FROM sources", "SELECT a.x AS x FROM account a, contact c", (s) => {
      assert.equal(s.from.length, 2);
    }],
    ["WHERE with IS NOT NULL, IN, BETWEEN and LIKE", "SELECT a FROM account WHERE a IS NOT NULL AND b IN (1, 2) AND c BETWEEN 1 AND 3 AND d LIKE 'x%'", (s) => {
      assert.equal(s.where.operator, "AND");
      assert.deepEqual([s.where.left.left.left.type, s.where.left.left.right.type, s.where.left.right.type, s.where.right.type],
        ["IsNull", "In", "Between", "Like"]);
    }],
    ["LIKE with ESCAPE", "SELECT a.x AS x FROM account a WHERE a.x LIKE 'a!%' ESCAPE '!'", (s) => {
      assert.equal(s.where.type, "Like");
      assert.equal(s.where.escape.value, "!");
    }],
    ["NOT IN list", "SELECT a.x AS x FROM account a WHERE a.x NOT IN (1, 2)", (s) => {
      assert.equal(s.where.type, "In");
      assert.equal(s.where.negated, true);
      assert.equal(s.where.list.length, 2);
    }],
    ["CASE searched and simple", "SELECT CASE WHEN a = 1 THEN 'x' ELSE 'y' END AS c, CASE a WHEN 1 THEN 'x' END AS d FROM account", (s) => {
      assert.equal(s.columns[0].expr.type, "Case");
      assert.equal(s.columns[0].expr.operand, null);
      assert.notEqual(s.columns[1].expr.operand, null);
    }],
    ["CAST, CONVERT and TRY_CAST", "SELECT CAST(a AS int) AS c, CONVERT(varchar(10), a, 101) AS d, TRY_CAST(a AS int) AS e FROM account", (s) => {
      assert.equal(s.columns[0].expr.type, "Cast");
      assert.equal(s.columns[0].expr.tryCast, false);
      assert.equal(s.columns[1].expr.type, "Convert");
      assert.equal(s.columns[1].expr.targetType.length, 10);
      assert.equal(s.columns[2].expr.tryCast, true);
    }],
    ["CONTAINS predicate in WHERE", "SELECT a.x AS x FROM account a WHERE CONTAINS(a.name, 'text')", (s) => {
      assert.equal(s.where.type, "FunctionCall");
      assert.equal(s.where.name.toUpperCase(), "CONTAINS");
      assert.equal(s.where.args.length, 2);
    }],
    ["GROUP BY with several expressions, HAVING and ORDER BY with ordinal and direction", "SELECT a, b, COUNT(*) AS n FROM account GROUP BY a, b HAVING COUNT(*) > 1 ORDER BY n DESC, 2 ASC, a", (s) => {
      assert.equal(s.groupBy.length, 2);
      assert.equal(s.having.operator, ">");
      assert.deepEqual(s.orderBy.map((o) => [o.direction, o.ordinal]), [["DESC", null], ["ASC", 2], [null, null]]);
    }],
    ["DECLARE several variables with types and lengths", "DECLARE @a int = 1, @b bigint, @c nvarchar(max), @d decimal(10, 2)", (s) => {
      assert.equal(s.type, "Declare");
      assert.deepEqual(s.variables.map((v) => v.name), ["@a", "@b", "@c", "@d"]);
      assert.deepEqual(s.variables[2].dataType, { type: "DataType", name: "NVARCHAR", length: "MAX", scale: null });
      assert.deepEqual(s.variables[3].dataType, { type: "DataType", name: "DECIMAL", length: 10, scale: 2 });
      assert.equal(s.variables[1].value, null);
    }],
    ["DECLARE assigned from a scalar subquery", "DECLARE @n int = (SELECT COUNT(*) AS c FROM account)", (s) => {
      assert.equal(s.variables[0].value.type, "Subquery");
    }],
    ["SET assigns an expression", "SET @a = @a + 1", (s) => {
      assert.equal(s.type, "Set");
      assert.equal(s.name, "@a");
      assert.equal(s.value.operator, "+");
    }],
    ["SELECT @v = expr assigns a variable", "SELECT @v = a.name FROM account a", (s) => {
      assert.deepEqual(s.columns[0].kind, "Assign");
      assert.equal(s.columns[0].name, "@v");
      assert.equal(s.columns[0].expr.type, "ColumnRef");
    }],
    ["SELECT several variable assignments", "SELECT @a = COUNT(*), @b = 1 FROM account", (s) => {
      assert.deepEqual(s.columns.map((c) => [c.kind, c.name]), [["Assign", "@a"], ["Assign", "@b"]]);
    }],
    ["@@ROWCOUNT as a WHERE expression", "SELECT a.x AS x FROM account a WHERE @@ROWCOUNT > 0", (s) => {
      assert.equal(s.where.left.type, "GlobalVariable");
    }],
    ["@@ROWCOUNT with an alias", "SELECT @@ROWCOUNT AS rc", (s) => {
      assert.equal(s.columns[0].expr.type, "GlobalVariable");
      assert.equal(s.columns[0].alias, "rc");
    }],
    ["N'unicode' literal", "SELECT N'uni' AS u", (s) => {
      assert.equal(s.columns[0].expr.national, true);
    }],
    ["bracketed and double-quoted identifiers", "SELECT [a b].[c] AS x, \"q\" AS y FROM [dbo].[account] AS [t]", (s) => {
      assert.deepEqual(s.columns[0].expr.parts, ["a b", "c"]);
      assert.deepEqual(s.columns[1].expr.parts, ["q"]);
      assert.equal(s.from[0].source.schema, "dbo");
      assert.equal(s.from[0].source.alias, "t");
    }],
    ["line and block comments", "SELECT a.x AS x -- note\nFROM account a /* block */ WHERE a.x = 1", (s) => {
      assert.equal(s.where.operator, "=");
    }],
    ["semicolon after a statement", "SELECT a.x AS x FROM account a;", (s) => {
      assert.equal(s.type, "Select");
    }],
    ["scalar subquery in the SELECT list", "SELECT (SELECT COUNT(*) AS n FROM contact) AS total FROM account", (s) => {
      assert.equal(s.columns[0].expr.type, "Subquery");
      assert.equal(s.columns[0].expr.query.type, "Select");
    }],
    ["IN subquery", "SELECT a FROM account WHERE a IN (SELECT b FROM contact)", (s) => {
      assert.equal(s.where.type, "In");
      assert.equal(s.where.subquery.type, "Select");
    }],
    ["NOT EXISTS", "SELECT a.x AS x FROM account a WHERE NOT EXISTS (SELECT 1 AS x FROM contact c)", (s) => {
      assert.equal(s.where.type, "Unary");
      assert.equal(s.where.operand.type, "Exists");
    }],
    ["comparison = ANY subquery", "SELECT a.x AS x FROM account a WHERE a.x = ANY (SELECT b.x AS x FROM contact b)", (s) => {
      assert.equal(s.where.type, "Quantified");
      assert.equal(s.where.quantifier, "ANY");
      assert.equal(s.where.operator, "=");
      assert.equal(s.where.query.type, "Select");
    }],
    ["comparison > SOME subquery is stored as ANY", "SELECT a.x AS x FROM account a WHERE a.x > SOME (SELECT b.x AS x FROM contact b)", (s) => {
      assert.equal(s.where.quantifier, "ANY");
      assert.equal(s.where.operator, ">");
    }],
    ["comparison <> ALL subquery under AND", "SELECT a.x AS x FROM account a WHERE a.x <> ALL (SELECT b.x AS x FROM contact b) AND a.y = 1", (s) => {
      assert.equal(s.where.operator, "AND");
      assert.equal(s.where.left.quantifier, "ALL");
      assert.equal(s.where.right.operator, "=");
    }],
    ["nested quantified subqueries", "SELECT a.x AS x FROM account a WHERE a.x = ANY (SELECT b.x AS x FROM contact b WHERE b.y = ANY (SELECT c.y AS y FROM lead c))", (s) => {
      assert.equal(s.where.query.where.type, "Quantified");
    }],
    ["nested subqueries in FROM and WHERE", "SELECT o.x AS x FROM (SELECT i.x AS x FROM (SELECT y AS x FROM contact) AS i) AS o WHERE o.x IN (SELECT z AS x FROM lead)", (s) => {
      assert.equal(s.from[0].source.query.from[0].source.query.type, "Select");
      assert.equal(s.where.type, "In");
    }],
    ["UNION chains are left-deep", "SELECT 1 AS a UNION SELECT 2 AS a UNION ALL SELECT 3 AS a", (s) => {
      assert.equal(s.type, "SetOperation");
      assert.equal(s.all, true);
      assert.equal(s.left.type, "SetOperation");
      assert.equal(s.left.all, false);
    }],
    ["UNION ALL with ORDER BY on the outer node", "SELECT 1 AS a UNION ALL SELECT 2 AS a ORDER BY a", (s) => {
      assert.equal(s.orderBy.length, 1);
      assert.equal(s.left.orderBy, null);
    }],
    ["statement without FROM", "SELECT 1 AS a", (s) => {
      assert.equal(s.from, null);
    }],
    ["FROM-less @@version without alias", "SELECT @@version", (s) => {
      assert.equal(s.from, null);
      assert.equal(s.columns[0].alias, null);
    }],
    ["FROM-less expression without alias", "SELECT 1 + 2", (s) => {
      assert.equal(s.from, null);
      assert.equal(s.columns[0].kind, "Expr");
    }],
    ["FROM-less duplicate names", "SELECT 1, 2", (s) => {
      assert.equal(s.columns.length, 2);
    }],
    ["WHERE with NOT and a parenthesised OR", "SELECT a.x AS x FROM account a WHERE NOT (a.x = 1 OR a.y = 2)", (s) => {
      assert.equal(s.where.type, "Unary");
    }],
  ];
  for (const [label, sql, check] of cases) {
    const stmt = one(sql);
    try {
      check(stmt);
    } catch (err) {
      err.message = `${label}: ${err.message}`;
      throw err;
    }
  }
});

test("GO batches and statement separators", () => {
  const batched = parseBatch("SELECT 1 AS a\nGO\nSELECT 2 AS b\nGO 2\nSELECT 3 AS c");
  assert.deepEqual(batched.statements.map((s) => s.line), [1, 3, 5]);

  assert.equal(parseBatch("SELECT 1 AS a\nSELECT 2 AS b").statements.length, 2);
  assert.equal(parseBatch("SELECT 1 AS a;SELECT 2 AS b;;").statements.length, 2);
  assert.equal(parseBatch("SELECT a\n  FROM account").statements.length, 1);
  assert.deepEqual(parseBatch("").statements, []);
  assert.deepEqual(
    parseBatch("DECLARE @a int = 1;\nSET @a = @a + 1;\nSELECT @a AS v").statements.map((s) => s.type),
    ["Declare", "Set", "Select"],
  );
});

test("rejected constructs raise unsupported errors at their own line", () => {
  const rejected = [
    ["INSERT", "INSERT INTO account (name) VALUES ('x')", 1],
    ["UPDATE after GO", "SELECT 1 AS a\nGO\nUPDATE account SET name = 'x'", 3],
    ["DELETE", "DELETE FROM account", 1],
    ["MERGE", "MERGE account AS t USING contact AS s ON 1 = 1 WHEN MATCHED THEN DELETE", 1],
    ["CREATE", "CREATE TABLE t (a int)", 1],
    ["DROP", "DROP TABLE account", 1],
    ["ALTER", "ALTER TABLE account ADD x int", 1],
    ["TRUNCATE", "TRUNCATE TABLE account", 1],
    ["BEGIN TRAN", "BEGIN TRAN", 1],
    ["COMMIT", "SELECT 1 AS a;\nCOMMIT", 2],
    ["ROLLBACK", "ROLLBACK", 1],
    ["GRANT", "GRANT SELECT ON account TO u", 1],
    ["REVOKE", "REVOKE SELECT ON account FROM u", 1],
    ["DENY", "DENY SELECT ON account TO u", 1],
    ["EXEC", "EXEC sp_who", 1],
    ["EXECUTE", "EXECUTE sp_who", 1],
    ["PRINT", "PRINT 'x'", 1],
    ["RAISERROR", "RAISERROR('x', 16, 1)", 1],
    ["USE", "USE master", 1],
    ["IF", "IF 1 = 1\n  SELECT 1 AS a", 1],
    ["ELSE", "SELECT 1 AS a\nELSE SELECT 2 AS b", 2],
    ["WHILE", "WHILE 1 = 0 SELECT 1 AS a", 1],
    ["CTE", "WITH c AS (SELECT 1 AS a)\nSELECT c.a AS a FROM c", 1],
    ["SELECT INTO", "SELECT a.x AS x INTO t FROM account a", 1],
    ["SELECT INTO inside a derived table", "SELECT d.x AS x\nFROM (SELECT a.x AS x INTO t FROM account a) AS d", 2],
    ["FOR XML", "SELECT a.x AS x FROM account a\nFOR XML PATH", 2],
    ["FOR JSON", "SELECT a.x AS x FROM account a FOR JSON AUTO", 1],
    ["window function OVER", "SELECT ROW_NUMBER() OVER (ORDER BY a.x) AS r FROM account a", 1],
    ["GROUP BY ROLLUP", "SELECT a.x AS x FROM account a GROUP BY ROLLUP (a.x)", 1],
    ["GROUP BY CUBE", "SELECT a.x AS x FROM account a GROUP BY CUBE (a.x)", 1],
    ["GROUP BY GROUPING SETS", "SELECT a.x AS x FROM account a GROUP BY GROUPING SETS ((a.x))", 1],
    ["GROUP BY ALL", "SELECT a.x AS x FROM account a GROUP BY ALL a.x", 1],
    ["GROUP BY ()", "SELECT a.x AS x FROM account a GROUP BY ()", 1],
    ["OPTION", "SELECT a.x AS x FROM account a OPTION (MAXDOP 1)", 1],
    ["table hint WITH (NOLOCK)", "SELECT a.x AS x FROM account a WITH (NOLOCK)", 1],
    ["PIVOT", "SELECT p.x AS x FROM account PIVOT (COUNT(x) FOR y IN (z)) p", 1],
    ["UNPIVOT", "SELECT p.x AS x FROM account UNPIVOT (v FOR y IN (z)) p", 1],
    ["FREETEXT", "SELECT a.x AS x FROM account a WHERE FREETEXT(a.name, 'x')", 1],
    ["AT TIME ZONE", "SELECT a.x AT TIME ZONE 'UTC' AS x FROM account a", 1],
    ["OUTPUT", "SELECT a.x AS x FROM account a OUTPUT a.x", 1],
    ["VALUES as a statement", "VALUES (1)", 1],
    ["VALUES as a derived table", "SELECT d.x AS x FROM (VALUES (1)) AS d(x)", 1],
    ["OFFSET and FETCH", "SELECT a.x AS x FROM account a ORDER BY a.x OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY", 1],
    ["EXCEPT after select", "SELECT 1 AS a EXCEPT SELECT 2 AS a", 1],
    ["INTERSECT after select", "SELECT 1 AS a INTERSECT SELECT 1 AS a", 1],
    ["EXCEPT after table", "SELECT a.x AS x FROM account a EXCEPT SELECT a.x AS x FROM contact a", 1],
    ["non-dbo schema", "SELECT a.x AS x FROM sales.account a", 1],
    ["three-part name", "SELECT a.x AS x FROM master.dbo.account a", 1],
    ["APPLY over a table", "SELECT a.x AS x FROM account a CROSS APPLY contact c", 1],
    ["duplicate output names", "SELECT a.id AS id, b.id AS id FROM account a, contact b", 1],
    ["duplicate column references", "SELECT a.x AS x,\n  b.x AS x FROM account a, contact b", 2],
    ["expression column without alias", "SELECT a.x + 1 FROM account a", 1],
    ["aggregate without alias", "SELECT COUNT(*) FROM account a", 1],
    ["SET option", "SET NOCOUNT ON", 1],
    ["SET option after a statement", "SELECT 1 AS a\nSET NOCOUNT ON", 2],
  ];
  for (const [label, sql, line] of rejected) {
    try {
      assertRejected(sql, { line });
    } catch (err) {
      err.message = `${label}: ${err.message}`;
      throw err;
    }
  }
});

test("unsupported data types are reported as 2715", () => {
  assertRejected("DECLARE @d date", { number: 2715, line: 1 });
  assertRejected("DECLARE @t TABLE (a int)", { number: 2715, line: 1 });
  assertRejected("SELECT 1 AS a\nDECLARE @d date", { number: 2715, line: 2 });
});

test("syntax errors are non-unsupported 102 errors at their line", () => {
  const malformed = [
    ["derived table without alias", "SELECT a FROM (SELECT 1 AS a)", 1],
    ["two statements on one line", "SELECT 1 AS a SELECT 2 AS b", 1],
    ["missing table", "SELECT a FROM", 1],
    ["JOIN without ON", "SELECT a.x AS x FROM account a JOIN contact c", 1],
    ["unknown leading word", "FOO bar", 1],
    ["DECLARE without a variable", "DECLARE int", 1],
    ["quantified comparison without a subquery", "SELECT a.x AS x FROM account a WHERE a.x = ANY (1, 2)", 1],
    ["syntax error after GO", "SELECT 1 AS a\nGO\nSELECT 2 AS b FROM", 3],
  ];
  for (const [label, sql, line] of malformed) {
    assert.throws(() => parseBatch(sql), (err) => {
      assert.ok(err instanceof TdsSqlError, label);
      assert.equal(err.number, 102, label);
      assert.equal(err.unsupported, false, label);
      assert.equal(err.line, line, label);
      return true;
    });
  }
});

test("errors carry absolute line numbers across GO batches", () => {
  assert.throws(() => parseBatch("SELECT 1 AS a\nGO\nSELECT b FROM x y z"), (err) => err.line === 3);
  assert.throws(() => parseBatch("SELECT 1 AS a\nGO\n\nUPDATE t SET a = 1"), (err) => err.line === 4 && err.unsupported === true);
  assert.throws(() => parseBatch("SELECT 1 AS a\nGO\nSELECT 2 AS b\nWHERE a.x = ANY (1)"), (err) => err.line === 4);
});

test("read-only message names the rejected statement", () => {
  assert.throws(() => parseBatch("UPDATE account SET a = 1"), { message: "UPDATE is not supported: the Dataverse SQL endpoint is read-only." });
  assert.throws(() => parseBatch("DELETE FROM account"), { message: /^DELETE is not supported/ });
});

// COUNT_BIG(*), STRING_AGG WITHIN GROUP and binary DECLAREs parse as statements.
const parserCases = [
  ["DECLARE varbinary(8) is supported", "DECLARE @b varbinary(8)", (s) => s.variables[0].dataType.name === "VARBINARY" && s.variables[0].dataType.length === 8],
  ["DECLARE binary(16) with a 0x value", "DECLARE @b binary(16) = 0x0102", (s) => s.variables[0].dataType.name === "BINARY" && s.variables[0].value.kind === "binary"],
  ["DECLARE varbinary(max)", "DECLARE @b varbinary(max)", (s) => s.variables[0].dataType.length === "MAX"],
  ["DECLARE bare varbinary", "DECLARE @b varbinary", (s) => s.variables[0].dataType.length === null],
  ["COUNT_BIG(*) in a select list", "SELECT COUNT_BIG(*) AS c FROM contoso_widget", (s) => s.columns[0].expr.name === "COUNT_BIG" && s.columns[0].expr.star],
  ["CAST to varbinary in a select list", "SELECT CAST(w.a AS varbinary(4)) AS b FROM contoso_widget w", (s) => s.columns[0].expr.targetType.name === "VARBINARY"],
  ["STRING_AGG WITHIN GROUP in a select list", "SELECT STRING_AGG(w.a, ',') WITHIN GROUP (ORDER BY w.b DESC) AS s FROM contoso_widget w",
    (s) => s.columns[0].expr.withinGroup[0].direction === "DESC"],
  ["STRING_AGG WITHIN GROUP in GROUP BY query", "SELECT w.a AS a, STRING_AGG(w.b, ',') WITHIN GROUP (ORDER BY w.b) AS s FROM contoso_widget w GROUP BY w.a",
    (s) => s.groupBy.length === 1 && s.columns[1].expr.withinGroup.length === 1],
  ["COUNT_BIG(*) in HAVING", "SELECT w.a AS a FROM contoso_widget w GROUP BY w.a HAVING COUNT_BIG(*) > 1",
    (s) => s.having.left.name === "COUNT_BIG"],
];
for (const [label, sql, check] of parserCases) {
  test(`parser: ${label}`, () => {
    assert.ok(check(one(sql)), sql);
  });
}
