// @test-kind tooling: protects the exact API router fixture and original keyed method assertions from unsafe qualification context drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  reviewApiRouterSlice,
  apiRouterSliceAstHash,
  apiRouterSliceSourceSnapshots,
} from '../scripts/parity-api-router-slice.mjs';
const require = createRequire(import.meta.url),
  espree = require('espree'),
  file = 'mirage/test/dataverse-api.test.mjs',
  fixtureBytes = fs.readFileSync(new URL('./fixtures/parity-api-router-slice-source.json', import.meta.url)),
  { baseline, current } = JSON.parse(fixtureBytes),
  parse = (s) => espree.parse(s, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true }),
  baseAst = parse(baseline),
  id = file + ':615:2';
test('accepts only the original serial fixture and keyed HEAD/OPTIONS test', () => {
  const review = reviewApiRouterSlice({ baselineAst: baseAst, currentAst: parse(current), baselineId: id }),
    sha = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(fixtureBytes), '98674b9c3815961fc4714891e282c9eb90f55dcd2472718124669b97b48bfa9c');
  assert.equal(review.baseline.earlierSiblingCount, 34);
  assert.equal(review.current.earlierSiblingAstSha256, review.baseline.earlierSiblingAstSha256);
  assert.equal(apiRouterSliceAstHash(baseAst), apiRouterSliceSourceSnapshots.baselineAstSha256);
  assert.equal(apiRouterSliceAstHash(parse(current)), apiRouterSliceSourceSnapshots.currentAstSha256);
  assert.equal(sha(baseline), apiRouterSliceSourceSnapshots.baselineSha256);
  assert.equal(sha(current), apiRouterSliceSourceSnapshots.currentSha256);
});
test('rejects changed identity, role, loopback, selected method, sibling and suite ordering', () => {
  for (const [before, after] of [
    ["roles: ['System Administrator']", "roles: ['Basic User']"],
    ["host: '127.0.0.1'", "host: '0.0.0.0'"],
    ['widgets(aaaaaaaa-0000-0000-0000-000000000001)', 'widgets(aaaaaaaa-0000-0000-0000-000000000099)'],
    ["method: 'HEAD', headers: auth()", "method: 'GET', headers: auth()"],
    ['const recordCalls = [];', 'let recordCalls = [];'],
    ['recordCalls.length = 0;', 'store.state.tables.widget = []; recordCalls.length = 0;'],
    ['recordCalls.length = 0;', "token = 'synthetic-other'; recordCalls.length = 0;"],
    [
      'const mapping = store.state.mappings.widget;',
      "const mapping = store.state.mappings.widget; mapping.idColumn = 'other';",
    ],
    ["describe('dataverse API router', () => {", "describe('dataverse API router', { concurrency: true }, () => {"],
  ]) {
    assert.ok(current.includes(before));
    assert.throws(
      () =>
        reviewApiRouterSlice({
          baselineAst: baseAst,
          currentAst: parse(current.replace(before, after)),
          baselineId: id,
        }),
      { qualificationCode: 'api-router-slice-unproven' },
    );
  }
  assert.throws(
    () => reviewApiRouterSlice({ baselineAst: baseAst, currentAst: parse(current), baselineId: file + ':614:2' }),
    { qualificationCode: 'api-router-slice-unproven' },
  );
});
