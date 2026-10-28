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
      number: 22019,
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
