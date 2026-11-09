// @test-kind parity: repeated native service-document and CSDL GETs with their exact current If-None-Match return empty304 responses retaining the source ETag.
// @parity-evidence: dataverse-native-metadata-conditionals.json binds two fresh eight-read native cohorts, exact request-validator dependency, raw empty-body hashes and route-specific response headers. Wildcards, lists and weak validators are outside this proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { contractModuleFixture } from './contract-module-fixture.mjs';

for (const [kind, route] of [
  ['service', '/'],
  ['metadata', '/$metadata'],
])
  test(`native ${kind} exact metadata validator returns empty304 and retains its ETag`, async (t) => {
    const bytes = await readFile(new URL('./fixtures/dataverse-native-metadata-conditionals.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '98cbdc33972f10a179da1ed4116329638ad2d468df3ce2afbd1eee942ca64c7c',
    );
    const proof = JSON.parse(bytes);
    const facts = proof.captures.map((capture) => capture.cases.find((row) => row.kind === kind).facts);
    assert.equal(facts.length, 2);
    assert.deepEqual(facts[0], facts[1]);
    const expected = facts[0];
    const f = await contractModuleFixture(t, {
      mappings: {
        sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { name: { dataverseType: 'nvarchar' } } },
      },
      extension: { name: 'metadata-conditional-fixture', install: () => ({}) },
    });
    const first = await f.request('GET', route);
    assert.equal(first.status, expected.firstStatus);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.arrayBuffer();
    const matched = await f.request('GET', route, undefined, { 'if-none-match': etag });
    assert.equal(matched.status, expected.matchingConditionalStatus);
    assert.equal((await matched.arrayBuffer()).byteLength, expected.conditionalBytes);
    assert.equal(matched.headers.get('etag'), etag);
    assert.equal(matched.headers.get('content-type'), expected.conditionalContentType);
    assert.equal(matched.headers.has('odata-version'), expected.conditionalHasODataVersion);
    assert.equal(matched.headers.get('allow'), expected.allow);
  });
