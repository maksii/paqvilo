// This fixed migration preserves the original matrix assertion while directly
// asserting the native error for its one reviewed value-to-error correction.
import { createRequire } from 'node:module';
import { hashAst } from './parity-ast-utils.mjs';

const { parse } = createRequire(import.meta.url)('espree');
export const SQL_FORMAT_82_CALL = `const call = (name, args, ctx) => {
  if (name === 'FORMAT' && args.length === 3 && args[0] === 1234.5 && args[1] === 'N2' && args[2] === 'not a culture' && ctx === undefined) {
    assert.throws(() => callFunction(name, args, ctx), { number: 9818 });
    return { sqlError: 9818 };
  }
  return callFunction(name, args, ctx);
};`;
const options = { ecmaVersion: 'latest', sourceType: 'module' };
const expectedBefore = parse('const call = (name, args, ctx) => callFunction(name, args, ctx);', options).body[0]
  .declarations[0].init;
const expectedAfter = parse(SQL_FORMAT_82_CALL, options).body[0].declarations[0].init;
const invalid = () =>
  Object.assign(new Error('sql-format82-call-invalid'), { qualificationCode: 'sql-format82-call-invalid' });

function callDeclaration(ast) {
  const matches = ast.body.flatMap((item) =>
    item.type === 'VariableDeclaration' && item.kind === 'const'
      ? item.declarations.filter((declaration) => declaration.id?.name === 'call')
      : [],
  );
  if (matches.length !== 1) throw invalid();
  return matches[0];
}

export function verifySqlFormat82Call(oldAst, currentAst) {
  const before = callDeclaration(oldAst),
    after = callDeclaration(currentAst);
  if (hashAst(before.init) !== hashAst(expectedBefore) || hashAst(after.init) !== hashAst(expectedAfter))
    throw invalid();
  return { before: before.init, after: after.init };
}

export function verifyCurrentSqlFormat82Call(currentAst) {
  const after = callDeclaration(currentAst);
  if (hashAst(after.init) !== hashAst(expectedAfter)) throw invalid();
}

export function verifySqlFormat82Outcome(before, after, fact) {
  const expected = { type: 'object', value: { sqlError: { type: 'number', value: 9818 } } };
  if (
    before?.type !== 'null' ||
    JSON.stringify(after) !== JSON.stringify(expected) ||
    fact?.priorExpected !== null ||
    JSON.stringify(fact.currentExpected) !== JSON.stringify({ sqlError: 9818 }) ||
    fact.typedOutcome?.outcome !== 'sql-error' ||
    !Array.isArray(fact.typedOutcome.errors) ||
    fact.typedOutcome.errors.length !== 1 ||
    fact.typedOutcome.errors[0].number !== 9818
  )
    throw Object.assign(new Error('sql-format82-outcome-mismatch'), {
      qualificationCode: 'sql-format82-outcome-mismatch',
    });
}
