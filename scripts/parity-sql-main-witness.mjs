// Exact 74-entry FROM-less evaluator registration source witness. This source
// binding alone grants no parity credit to any row.
import { verifySqlWitnessSource } from './parity-sql-source-witness.mjs';

export const SQL_EXTRA_EVALUATOR_CASES = Object.freeze([
  ...[23, 24, 28, 29, 30, 31, 32, 45, 46, 47].map((index) => Object.freeze({ binding: 'cases', index })),
  ...[12, 15].map((index) => Object.freeze({ binding: 'orderedCases', index })),
]);

export function verifySqlMainSource(ast) {
  return verifySqlWitnessSource(ast, {
    binding: 'cases',
    count: 74,
    arraySha256: '0b607a8858aa2e9320c98406ca80467f1b53844052d86ce07242634e3eea66f6',
    loopSha256: '70ada5ed4ebbac069bb4640dc880dcf8bc091c601e43fe659f72a88786899caa',
    error: 'sql-main-witness-invalid',
  });
}
