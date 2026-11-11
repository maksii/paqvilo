// @test-kind contract: T-SQL LIKE, ESCAPE and PATINDEX evaluation are Paqvilo's designed runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

const evaluate = async (sql, collation = 'CI_AI') => {
  const result = await executeBatch(sql, { catalog: { tables: new Map() }, collation });
  return result.resultSets[0].rows;
};

test('SQL LIKE respects the configured accent sensitivity for literals and character sets', async () => {
  const sql =
    "SELECT CASE WHEN 'Café' LIKE 'CAFE%' THEN 1 ELSE 0 END AS prefix, CASE WHEN 'é' LIKE '[e]' THEN 1 ELSE 0 END AS letters";
  assert.deepEqual(await evaluate(sql), [[1, 1]]);
  assert.deepEqual(await evaluate(sql, 'CI_AS'), [[0, 0]]);
  assert.deepEqual(await evaluate("SELECT CASE WHEN 'Café' LIKE 'CAFÉ%' THEN 1 ELSE 0 END AS matched", 'CI_AS'), [[1]]);
  assert.deepEqual(await evaluate("SELECT CASE WHEN 'Café' LIKE 'cafe%' THEN 1 ELSE 0 END AS matched"), [[1]]);
});

test('SQL LIKE rejects a trailing escape as a match and preserves NOT and NULL semantics', async () => {
  assert.deepEqual(
    await evaluate(
      "SELECT CASE WHEN 'a!' LIKE 'a!' ESCAPE '!' THEN 1 ELSE 0 END AS bad, CASE WHEN 'a!' NOT LIKE 'a!' ESCAPE '!' THEN 1 ELSE 0 END AS negated",
    ),
    [[0, 1]],
  );
  assert.deepEqual(
    await evaluate(
      "SELECT CASE WHEN 'a!' LIKE 'a!!' ESCAPE '!' THEN 1 ELSE 0 END AS escaped, CASE WHEN 'ab' LIKE 'a!b' ESCAPE '!' THEN 1 ELSE 0 END AS ordinary",
    ),
    [[1, 1]],
  );
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE NULL NOT LIKE 'a!' ESCAPE '!'"), []);
});

test('SQL LIKE requires an escape expression containing exactly one character', async () => {
  for (const escape of ["''", "'!!'"]) {
    await assert.rejects(evaluate(`SELECT 1 AS matched WHERE 'abc' LIKE 'abc' ESCAPE ${escape}`), {
      number: 506,
    });
  }
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'abc' LIKE 'abc' ESCAPE NULL"), []);
});

test('SQL LIKE tokenizes escapes before folding literal characters', async () => {
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE '%' LIKE 'é%' ESCAPE 'é'"), [[1]]);
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'E%' LIKE 'Eé%' ESCAPE 'é'"), [[1]]);
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'é' LIKE '!é' ESCAPE '!'"), [[1]]);
});

test('SQL LIKE preserves case-insensitive matching for contextual Greek sigma', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'ΟΣ' LIKE 'ΟΣ'", collation), [[1]]);
    assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'ος' LIKE 'ΟΣ%'", collation), [[1]]);
    assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'ΟΣ' LIKE 'ο_'", collation), [[1]]);
  }
});

test('SQL LIKE interprets escapes within character sets without creating extra members or ranges', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    for (const [value, pattern, expected] of [
      ['%', '[!%]', true],
      ['!', '[!%]', false],
      [']', '[!]]', true],
      ['!', '[!]]', false],
      ['^', '[!^a]', true],
      ['b', '[!^a]', false],
      ['-', '[a!-c]', true],
      ['b', '[a!-c]', false],
      ['a', '[a!-c]', true],
      ['c', '[a!-c]', true],
      ['b', '[a-c]', true],
      [']', '[^!]]', false],
      ['b', '[^!]]', true],
    ]) {
      assert.deepEqual(
        await evaluate(`SELECT 1 AS matched WHERE '${value}' LIKE '${pattern}' ESCAPE '!'`, collation),
        expected ? [[1]] : [],
        `${collation}: ${value} LIKE ${pattern}`,
      );
    }
  }
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE '%' LIKE '[é%]' ESCAPE 'é'"), [[1]]);
  assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'e' LIKE '[é%]' ESCAPE 'é'"), []);
});

test('SQL LIKE recognizes a configured caret escape before character-set negation', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    for (const [value, pattern, expected] of [
      ['^', '[^^]', true],
      ['a', '[^^]', false],
      ['a', '[^a]', true],
      ['b', '[^a]', false],
      ['^', '[^^a]', true],
      ['a', '[^^a]', true],
      ['b', '[^^a]', false],
    ]) {
      assert.deepEqual(
        await evaluate(`SELECT 1 AS matched WHERE '${value}' LIKE '${pattern}' ESCAPE '^'`, collation),
        expected ? [[1]] : [],
        `${collation}: ${value} LIKE ${pattern} ESCAPE ^`,
      );
    }
    assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'b' LIKE '[^a]'", collation), [[1]]);
    assert.deepEqual(await evaluate("SELECT 1 AS matched WHERE 'a' LIKE '[^a]'", collation), []);
  }
});

test('SQL LIKE preserves bracket and hyphen escape characters without inventing wildcard syntax', async () => {
  for (const collation of ['CI_AI', 'CI_AS']) {
    for (const [value, pattern, escape, expected] of [
      ['-', '[--]', '-', true],
      ['b', '[a-c]', '-', false],
      ['a', '[a-c]', '-', true],
      ['c', '[a-c]', '-', true],
      ['[a]', '[[a]', '[', true],
      ['a', '[[a]', '[', false],
      ['a]', 'a]]', ']', true],
      ['a', 'a]]', ']', false],
      ['a]', 'a]', ']', false],
    ]) {
      assert.deepEqual(
        await evaluate(`SELECT 1 AS matched WHERE '${value}' LIKE '${pattern}' ESCAPE '${escape}'`, collation),
        expected ? [[1]] : [],
        `${collation}: ${value} LIKE ${pattern} ESCAPE ${escape}`,
      );
    }
  }
});

test('SQL LIKE treats a set with a backwards range as matching no character instead of raising', async () => {
  assert.deepEqual(await evaluate("SELECT CASE WHEN 'b' LIKE '[z-a]' THEN 1 ELSE 0 END AS matched"), [[0]]);
});

test('PATINDEX reports the leftmost wildcard position and 0 for an anchored miss', async () => {
  assert.deepEqual(
    await evaluate(
      "SELECT PATINDEX('%', 'abc') AS a, PATINDEX('', 'abc') AS b, PATINDEX('abc', 'abc') AS c, PATINDEX('%b%', 'abc') AS d",
    ),
    [[1, 0, 1, 2]],
  );
});

// @test-kind security: a LIKE or PATINDEX pattern from a request must not pin the event loop with backtracking
test('SQL LIKE and PATINDEX with repeated wildcards and no match return without backtracking', async () => {
  assert.deepEqual(
    await evaluate(`SELECT CASE WHEN '${'a'.repeat(40)}' LIKE '${'%'.repeat(25)}b' THEN 1 ELSE 0 END AS matched`),
    [[0]],
  );
  assert.deepEqual(await evaluate(`SELECT PATINDEX('${'%a'.repeat(18)}%b%', REPLICATE('a', 200)) AS position`), [[0]]);
});

test('SQL LIKE over many rows builds its pattern once instead of constructing expressions per row', async (t) => {
  const OriginalRegExp = globalThis.RegExp;
  let constructions = 0;
  globalThis.RegExp = class CountingRegExp extends OriginalRegExp {
    constructor(...args) {
      constructions++;
      super(...args);
    }
  };
  t.after(() => {
    globalThis.RegExp = OriginalRegExp;
  });
  const values = Array.from({ length: 2000 }, (_, i) =>
    i % 4 === 0 ? `Contoso Corp Limited ${i}` : `Fabrikam Holdings ${i}`,
  );
  const expected = values.filter((value) => value.toLowerCase().includes('contoso corp limit'));
  const catalog = {
    tables: new Map([
      [
        'contoso_company',
        {
          logicalName: 'contoso_company',
          columns: [
            { name: 'contoso_name', sqlType: 'nvarchar', length: 160, precision: null, scale: null, nullable: true },
          ],
        },
      ],
    ]),
  };
  const scan = async () => values.map((value) => ({ contoso_name: value }));
  const result = await executeBatch(
    "SELECT c.contoso_name AS name FROM contoso_company c WHERE c.contoso_name LIKE '%contoso corp limit%'",
    { catalog, scan },
  );
  assert.deepEqual(
    result.resultSets[0].rows.map(([value]) => value),
    expected,
  );
  assert.ok(constructions < 200, `expected fewer than 200 RegExp constructions, saw ${constructions}`);
});
