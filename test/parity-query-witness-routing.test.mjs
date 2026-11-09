// @test-kind tooling: cumulative query proof routes preserve all previously bound authorities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeQueryWitnesses, queryBridgeSourceIsCurrent } from '../scripts/parity-query-witness-routing.mjs';
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64),
  prior = { proofs: [{ path: 'old' }], queryBridgeAuthoritySha256: a },
  single = { indexPath: 'old-index', sha256: a },
  multi = [
    { proofPath: 'old', ...single },
    { proofPath: 'new', indexPath: 'new-index', sha256: b },
  ],
  call = (routes = multi, old = prior) =>
    routeQueryWitnesses({
      file: { queryBridgeWitness: single, queryBridgeWitnesses: routes },
      prior: old,
      bridgedPaths: ['old', 'new'],
    });
test('cumulative routes retain prior proof and allow a new independent authority', () => {
  const x = call();
  assert.equal(x.get('old').sha256, a);
  assert.equal(x.get('new').sha256, b);
});
test('dropped, replaced, duplicate, mixed and extra routes fail closed', () => {
  assert.throws(() => call([multi[1]]));
  assert.throws(() => call([{ ...multi[0], sha256: c }, multi[1]]));
  assert.throws(() => call([multi[0], multi[0]]));
  assert.throws(() => call([multi[0], { ...multi[1], proofPath: 'unknown' }]));
  assert.throws(() => call([...multi, { proofPath: 'extra', indexPath: 'extra', sha256: c }]));
  assert.throws(() => call(multi, { proofs: [{ path: 'old' }] }));
});
test('subsequent cumulative additions preserve every previously saved authority', () => {
  const old = {
    proofs: [{ path: 'old' }, { path: 'new' }],
    queryBridgeAuthoritySha256: a,
    queryBridgeAuthorities: [
      { proofPath: 'old', sha256: a },
      { proofPath: 'new', sha256: b },
    ],
  };
  assert.equal(call(multi, old).size, 2);
  assert.throws(() => call([multi[0], { ...multi[1], sha256: c }], old));
  assert.throws(() => call(multi, { ...old, queryBridgeAuthorities: [old.queryBridgeAuthorities[0]] }));
});
test('legacy single witness works only for one bridged proof', () => {
  assert.equal(
    routeQueryWitnesses({ file: { queryBridgeWitness: single }, prior, bridgedPaths: ['old'] }).get('old').sha256,
    a,
  );
  assert.throws(() =>
    routeQueryWitnesses({ file: { queryBridgeWitness: single }, prior, bridgedPaths: ['old', 'new'] }),
  );
  assert.throws(() =>
    routeQueryWitnesses({
      file: { queryBridgeWitness: { indexPath: 'other', sha256: c } },
      prior,
      bridgedPaths: ['old'],
    }),
  );
});
test('four independent authorities cannot silently replace any earlier proof', () => {
  const d = 'd'.repeat(64),
    paths = ['old', 'six', 'one', 'three'],
    rows = paths.map((proofPath, i) => ({ proofPath, indexPath: 'index-' + i, sha256: [a, b, c, d][i] })),
    old = {
      proofs: paths.slice(0, 3).map((path) => ({ path })),
      queryBridgeAuthoritySha256: a,
      queryBridgeAuthorities: rows.slice(0, 3).map(({ proofPath, sha256 }) => ({ proofPath, sha256 })),
    };
  const call4 = (x) =>
    routeQueryWitnesses({
      file: { queryBridgeWitness: single, queryBridgeWitnesses: x },
      prior: old,
      bridgedPaths: paths,
    });
  assert.equal(call4(rows).size, 4);
  for (let i = 0; i < 3; i++) {
    const changed = structuredClone(rows);
    changed[i].sha256 = d;
    assert.throws(() => call4(changed));
  }
});
test('after a write, each new proof remains bound to its own authority on rerun', () => {
  const saved = {
      queryBridgeAuthoritySha256: a,
      queryBridgeAuthorities: [
        { proofPath: 'old', sha256: a },
        { proofPath: 'new', sha256: b },
      ],
    },
    input = {
      prior: saved,
      proofPath: 'new',
      witness: { sha256: b },
      currentSourceSha256: 'postwrite',
      capsuleSourceSha256: 'prewrite',
    };
  assert.equal(queryBridgeSourceIsCurrent(input), true);
  assert.equal(queryBridgeSourceIsCurrent({ ...input, witness: { sha256: c } }), false);
  assert.equal(queryBridgeSourceIsCurrent({ ...input, proofPath: 'other' }), false);
});
