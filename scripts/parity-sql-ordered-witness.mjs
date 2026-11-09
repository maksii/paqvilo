// A fixed source witness for one FROM-less orderedCases original test. The
// remaining fifteen entries still execute but receive no qualification credit.
import { verifySqlWitnessSource } from './parity-sql-source-witness.mjs';

const EXPECTED = {
  oldArray: '309e075aff1f0e4d91b476af16843fdc7c3962baf6ed9fcb0e0911938114c5cf',
  currentArray: 'c9adf3bfc35f599d7eba74913fb3d74ecf531c441043583500c0c2d6e7f37d4e',
  oldTuple: '18405a7ef4796ae3910241cad90366755dc5428db680dfbcc01daa6044d9d3f0',
  currentTuple: '531bb28317f73dda7075f5324e9a68e537bf3f74a4e90d6612e06927d48a1be0',
  loop: 'f9a54543c5dff3505a0b656623e8ab1463bf0f9c31c54565083ac3cf81349a97',
};
export function verifySqlOrderedSource(ast, baseline = false) {
  return verifySqlWitnessSource(ast, {
    binding: 'orderedCases',
    count: 16,
    tupleIndex: 11,
    arraySha256: baseline ? EXPECTED.oldArray : EXPECTED.currentArray,
    tupleSha256: baseline ? EXPECTED.oldTuple : EXPECTED.currentTuple,
    loopSha256: EXPECTED.loop,
    error: 'sql-ordered-witness-invalid',
  });
}
