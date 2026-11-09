// @test-kind parity: the source-bound 2026-11-08 native include captures reproduce literally through complete local HTTP rendering with source debugging enabled.
// @parity-evidence: frontend-parity-evidence.json binds both native captures for pages65/language20; private pages-http-local.json/language-http-local.json reproduce all85 fragments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { createSimulator } from '../server.mjs';

for (const [suite, casesHash, expectedHash] of [
  [
    'contract',
    'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
    '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
  ],
  [
    'language',
    '99c620ba9e0cf548e3ad6464e073122843afaed413a482264fff657b0c09ec91',
    '0a42f3a7b11cea8fa2187e71cadeef6aa1bdc3620432048654ea7824b4507ca8',
  ],
]) {
  test(`native Power Pages ${suite} fragments survive source import and HTTP rendering`, async (t) => {
    const read = async (kind, checksum) => {
      const bytes = await fs.readFile(new URL(`./fixtures/power-pages-${suite}-${kind}.json`, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
      return JSON.parse(bytes);
    };
    const cases = await read('cases', casesHash),
      expected = await read('expected', expectedHash);
    const fixture = await profileFixture(t);
    const directory = path.join(fixture.sourceDir, 'web-templates');
    await fs.writeFile(
      path.join(directory, 'Main.webtemplate.source.html'),
      cases.map(({ id }) => `<!--CONTRACT:${id}:BEGIN-->{% include '${id}' %}<!--CONTRACT:${id}:END-->`).join('\n'),
    );
    await Promise.all(
      cases.map(async ({ id, source }) => {
        await fs.writeFile(path.join(directory, `${id}.webtemplate.yml`), `adx_webtemplateid: ${id}\nadx_name: ${id}`);
        await fs.writeFile(path.join(directory, `${id}.webtemplate.source.html`), source);
      }),
    );
    const simulator = await createSimulator({
      sourceDir: fixture.sourceDir,
      port: 0,
      watch: false,
      observed: {
        liquidHtmlVoidSerialization: 'html',
        liquidPathAndQueryFragment: 'query',
        ...(suite === 'language' ? { liquidRuntimeCompatibility: 'observed', liquidFilterErrors: 'observed' } : {}),
        evidence: 'Repeated native source-bound include captures on 2026-11-08; frontend-parity-evidence.md.',
      },
    });
    fixture.onCleanup(() => simulator.close());
    const response = await fetch(simulator.url + '/');
    assert.equal(response.status, 200);
    const body = await response.text();
    const actual = cases.map(({ id }) => {
      const begin = `<!--CONTRACT:${id}:BEGIN-->`,
        end = `<!--CONTRACT:${id}:END-->`;
      const start = body.indexOf(begin),
        finish = body.indexOf(end, start);
      assert.ok(start >= 0 && finish >= 0, 'missing authored response marker: ' + id);
      return { id, output: body.slice(start + begin.length, finish) };
    });
    assert.deepEqual(actual, expected);
  });
}
