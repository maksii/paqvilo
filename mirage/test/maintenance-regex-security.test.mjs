// @test-kind security: malformed imported text and request values must not trigger repeated regex suffix scans; valid captures retain the established contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { NetDecimal, toNetDecimal } from '../lib/liquid-dotnet.mjs';
import { invariantNumberText } from '../lib/power-fx.mjs';
import { entryParameters } from '../lib/plugin-platform-messages.mjs';
import { redactSecureConfigurationTokens } from '../lib/capture-control-redaction.mjs';
import { readCanvasSource } from '../lib/canvas-source.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { LiquidContext, LiquidEngine } from '../lib/liquid-engine.mjs';
import { subgridActionApplies } from '../lib/subgrid-actions.mjs';

// @test-kind contract+security: editable parsing retries starts inside a malformed quoted candidate
test('editable parsing retries starts inside a malformed quoted candidate', () => {
  const renderer = createPortalRenderer({ templates: {}, snippets: {}, records: [], pages: [], website: {} });
  const Editable = renderer.engine.tags.get('editable');
  const tag = new Editable();
  tag.initialize(renderer.engine, 'editable', "a'a '", []);
  assert.equal(tag.editable, 'a');
  assert.equal(tag.key, '');
  assert.throws(() => new Editable().initialize(renderer.engine, 'editable', 'a'.repeat(50000), []), /Syntax Error/);
});

test('legacy canvas control names retain whitespace backtracking and quoted type parts', async () => {
  const name = ' \u2028\t\n As a';
  const malformed = ' '.repeat(20000) + 'unknown';
  const quotedName = JSON.stringify(name).replaceAll('\u2028', '\\L');
  const source = await readCanvasSource({
    msapp: writeSolutionAssetEntries([
      {
        name: 'Src/Home.fx.yaml',
        data: Buffer.from(
          `Home As screen:\n  ${quotedName}: {}\n  "Title As a.'x''y'": {}\n  ? ${JSON.stringify(malformed)}\n  : {}\n`,
        ),
      },
    ]),
  });
  assert.deepEqual(
    source.screens[0].controls.map(({ name, control }) => ({ name, control })),
    [
      { name: '\t', control: 'a' },
      { name: 'Title', control: "a.'x''y'" },
    ],
  );
  assert.equal(
    source.formulas.some((entry) => entry.property === malformed),
    true,
  );
});

test('Liquid ranges reject long malformed separators and retain endpoint recursion', async () => {
  const context = new LiquidContext(new LiquidEngine());
  assert.deepEqual(await context.resolve('(1..3)'), [1, 2, 3]);
  const unknown = '(' + '.'.repeat(50000) + '!';
  let refused;
  context.variable = async (key) => {
    refused = key;
    return null;
  };
  assert.equal(await context.resolve(unknown), null);
  assert.equal(refused, unknown);
  assert.equal(await context.resolve('(1..3)\n'), null);
  assert.equal(refused, '(1..3)\n');
});

test('SDK entry references handle long malformed identifiers and retain suffix identity selection', () => {
  const store = { resolveMapping: (name) => ({ logicalName: name }) };
  const invalid = { '@odata.id': 'a'.repeat(50000) + '!' };
  assert.deepEqual(entryParameters(store, { Target: invalid }).Target, invalid);
  assert.deepEqual(
    entryParameters(store, { Target: { '@odata.id': '/123sample(00000000-0000-0000-0000-000000000001)' } }).Target,
    { $type: 'EntityReference', logicalName: 'sample', id: '00000000-0000-0000-0000-000000000001', name: null },
  );
});

test('subgrid filters reject repeated unterminated entity tags without querying records', async () => {
  let reads = 0;
  const options = {
    entity: 'sample',
    idColumn: 'sampleid',
    recordId: 'invented-id',
    readProvider: {
      fetchXml() {
        reads++;
      },
    },
    identity: {},
  };
  await assert.rejects(
    subgridActionApplies({ FilterCriteria: '<entity '.repeat(30000) }, options),
    (error) => error.code === 'SUBGRID_FILTER_INVALID' && error.status === 501,
  );
  assert.equal(reads, 0);
});

test('subgrid filters retain the final viable entity name and exact inserted tag boundary', async () => {
  let xml;
  const matched = "<entity name='wrong' name='sample'>";
  const FilterCriteria = '<fetch>' + matched + '</entity></fetch>';
  const identity = {};
  assert.equal(
    await subgridActionApplies(
      { FilterCriteria },
      {
        entity: 'sample',
        idColumn: 'sampleid',
        recordId: 'invented-id',
        identity,
        readProvider: {
          fetchXml(value, caller) {
            xml = value;
            assert.equal(caller, identity);
            return { entities: [{ sampleid: 'invented-id' }] };
          },
        },
      },
    ),
    true,
  );
  assert.equal(
    xml,
    '<fetch>' +
      matched +
      '<filter type="and"><condition attribute="sampleid" operator="eq" value="invented-id"/></filter></entity></fetch>',
  );
});

// @test-kind security+contract: query token redaction skips long malformed candidates without changing protected fields
test('query token redaction skips long malformed candidates without changing protected fields', () => {
  const prefix = '?'.repeat(50000);
  const text = prefix + '&base64SecureConfiguration=invented&ordinary=keep';
  assert.equal(redactSecureConfigurationTokens(text), prefix + '&base64SecureConfiguration={token}&ordinary=keep');
  assert.equal(
    redactSecureConfigurationTokens('?base64SecureConfiguration=invented'),
    '?base64SecureConfiguration=invented',
  );
});

test('decimal parsers reject long whitespace candidates and preserve signs and grouped fractions', () => {
  assert.throws(() => NetDecimal.parse(' '.repeat(50000) + 'x'), /correct format/);
  assert.throws(() => toNetDecimal(' '.repeat(50000) + 'x'), /correct format/);
  assert.equal(NetDecimal.parse(' \n -1.25e1\t ').toFixedString(), '-12.5');
  assert.equal(toNetDecimal(' \t +1,234.50\n ').toFixedString(), '1234.50');
});

test('Power Fx currency suffix handling rejects long interior whitespace and preserves valid currency', () => {
  assert.equal('text' in invariantNumberText('1' + ' '.repeat(50000) + 'x'), false);
  assert.deepEqual(invariantNumberText('1 \t$'), { text: '1', percent: false });
});

// @test-kind contract+security: public CSS capture ignores unterminated URL candidates and still follows valid dependencies
test('public CSS capture ignores unterminated URL candidates and still follows valid dependencies', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-css-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const cache = await new AssetCache({
    directory,
    origin: 'https://invented.example.test',
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      const css = url.endsWith('/root.css');
      return new Response(
        css ? '.invented { background: url("child.js"); }\n' + 'url('.repeat(15000) : '/* invented */',
        {
          headers: { 'content-type': css ? 'text/css' : 'application/javascript' },
        },
      );
    },
  }).init();
  const report = await cache.capturePublic(['/resource/powerappsportal/root.css']);
  assert.deepEqual(calls, ['/resource/powerappsportal/root.css', '/resource/powerappsportal/child.js']);
  assert.equal(report.failures.length, 0);
});
