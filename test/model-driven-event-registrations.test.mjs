import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createModelDrivenMetadataIndex } from '../lense/model-driven-metadata.mjs';
import { modelDrivenEventPage, validateModelDrivenArguments } from '../lense/commands/model-driven.mjs';
import { modelDrivenFixture } from '../mirage/test/model-driven-fixture.mjs';
import { runToolkit } from './toolkit-cli.mjs';

const handler = (id, library = 'x_shared.js', extra = '') =>
  `<Handler handlerUniqueId="${id}" libraryName="${library}" functionName="Invented.review" ${extra}/>`;
const event = (handlers, extra = '', name = 'onload') =>
  `<event name="${name}" ${extra}><Handlers>${handlers}</Handlers></event>`;
const form = (id, events, entity = 'x_item') => ({
  id,
  entity,
  name: 'Formulaire invente',
  xml: `<form><formLibraries><Library name="x_shared.js"/><Library name="x_missing.js"/><Library name="x_ambiguous.js"/></formLibraries><events>${events}</events></form>`,
});
const imported = (forms) => ({
  metadata: { lcid: 1036, forms },
  resources: [
    { name: 'x_shared.js', type: 'script' },
    { name: 'x_ambiguous.js', type: 'script', id: 'first' },
    { name: 'x_ambiguous.js', type: 'script', id: 'second' },
  ],
});

test('source registrations preserve cross-form order, handler identities and language without printing parameter literals', () => {
  const source = imported([
    form(
      '{FIRST}',
      event(
        handler(
          '{HANDLER-A}',
          'x_shared.js',
          'parameters="&quot;Invented, quoted literal&quot;,false,0" passExecutionContext="true"',
        ) + handler('HANDLER-B', 'x_shared.js', 'enabled="false"'),
      ) + event('', 'attribute="x_name" active="false"', 'onchange'),
    ),
    form(
      'SECOND',
      event(handler('HANDLER-C', 'x_missing.js')) +
        event(handler('HANDLER-D', 'x_ambiguous.js')) +
        event(handler('HANDLER-E', 'x_notdeclared.js')),
      'x_other',
    ),
  ]);
  const before = JSON.stringify(source),
    index = createModelDrivenMetadataIndex(source, { sourceRevision: 'invented-1' });
  const report = index.eventRegistrations();
  assert.equal(report.complete, true);
  assert.equal(report.registrations.length, 6);
  assert.deepEqual(
    report.registrations.map((row) => [row.formId, row.eventIndex, row.handlerIndex, row.handlerId]),
    [
      ['{FIRST}', 0, 0, '{HANDLER-A}'],
      ['{FIRST}', 0, 1, 'HANDLER-B'],
      ['{FIRST}', 1, null, null],
      ['SECOND', 0, 0, 'HANDLER-C'],
      ['SECOND', 1, 0, 'HANDLER-D'],
      ['SECOND', 2, 0, 'HANDLER-E'],
    ],
  );
  assert.equal(report.registrations[0].formName, 'Formulaire invente');
  assert.equal(report.registrations[0].parameterCount, 3);
  assert.equal(report.registrations[0].passExecutionContext, true);
  assert.equal(report.registrations[1].enabled, false);
  assert.equal(report.registrations[2].attribute, 'x_name');
  assert.equal(report.registrations[2].eventActive, false);
  assert.deepEqual(
    report.registrations.slice(3).map((row) => row.libraryStatus),
    ['missing', 'ambiguous', 'undeclared'],
  );
  assert.equal(report.registrations[5].resourceStatus, 'missing');
  assert.ok(report.registrations.every((row) => !Object.hasOwn(row, 'parameters') && row.sourceRefs.length === 0));
  assert.doesNotMatch(JSON.stringify(report), /Invented, quoted literal/);
  assert.equal(JSON.stringify(source), before);
  const exact = index.eventRegistrations({
    entity: 'X_ITEM',
    formId: 'first',
    library: 'x_shared.js',
    includeParameters: true,
  });
  assert.equal(exact.registrations.length, 2);
  assert.equal(exact.registrations[0].parameters, '"Invented, quoted literal",false,0');
});

test('event pagination resumes inside handlers without dropping duplicates, empty events or unavailable forms', () => {
  const source = imported([
    form('one', event(handler('same') + handler('same')) + event('')),
    { id: 'unavailable', entity: 'x_item' },
    form('empty', ''),
  ]);
  const index = createModelDrivenMetadataIndex(source),
    pages = [];
  let cursor;
  do {
    const page = index.eventRegistrations({ cursor, budget: { items: 1, bytes: 2048 } });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048);
    pages.push(page);
    assert.ok(pages.length <= 6, 'every cursor advances');
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pages.flatMap((page) => page.registrations).length, 3);
  assert.deepEqual(
    pages.flatMap((page) => page.registrations).map((row) => row.handlerIndex),
    [0, 1, null],
  );
  assert.equal(pages.flatMap((page) => page.diagnostics)[0].code, 'EVENT_FORM_UNAVAILABLE');
  assert.equal(pages.at(-1).complete, true);
  assert.equal(createModelDrivenMetadataIndex({}).eventRegistrations().complete, true);
});

test('event library status and filters use the same webresource prefix normalization as the host', () => {
  const index = createModelDrivenMetadataIndex(
    imported([
      form('one', event(handler('prefixed', '$WEBRESOURCE:x_shared.js') + handler('different-case', 'X_SHARED.js'))),
    ]),
  );
  const rows = index.eventRegistrations().registrations;
  assert.equal(rows[0].library, '$WEBRESOURCE:x_shared.js');
  assert.equal(rows[0].libraryStatus, 'available');
  assert.equal(rows[1].resourceStatus, 'missing');
  assert.deepEqual(
    index.eventRegistrations({ library: '$webresource:x_shared.js' }).registrations.map((row) => row.handlerId),
    ['prefixed'],
  );
});

test('oversized rows advance with explicit diagnostics and unsupported parameter syntax is never executed', () => {
  const index = createModelDrivenMetadataIndex(
    imported([
      form(
        'one',
        event(handler('huge', 'x_shared.js', `parameters="&quot;${'x'.repeat(3000)}&quot;"`)) +
          event(handler('dynamic', 'x_shared.js', 'parameters="Invented.execute()"')),
      ),
    ]),
  );
  const report = index.eventRegistrations({ includeParameters: true, budget: { bytes: 2048 } });
  assert.equal(report.diagnostics[0].code, 'EVENT_REGISTRATION_ROW_LIMIT');
  assert.equal(report.registrations[0].handlerId, 'dynamic');
  assert.equal(report.registrations[0].parameterCount, null);
  assert.equal(report.registrations[0].parameterStatus, 'unsupported');
  assert.equal(report.complete, true);
  assert.equal(report.truncated, true);
});

test('event cursors reject source changes, filter changes and malformed positions', () => {
  const source = imported([form('one', event(handler('one') + handler('two')))]);
  const index = createModelDrivenMetadataIndex(source),
    cursor = index.eventRegistrations({ budget: { items: 1 } }).nextCursor;
  for (const changed of [
    imported([form('one', event(handler('changed') + handler('two')))]),
    { ...source, resources: [] },
    { ...source, metadata: { ...source.metadata, lcid: 1033 } },
  ])
    assert.throws(() => createModelDrivenMetadataIndex(changed).eventRegistrations({ cursor }), {
      code: 'EVENT_REGISTRATION_CURSOR_STALE',
    });
  assert.throws(() => index.eventRegistrations({ cursor, includeParameters: true }), {
    code: 'EVENT_REGISTRATION_CURSOR_STALE',
  });
  assert.throws(() => index.eventRegistrations({ cursor, library: 'x_other.js' }), {
    code: 'EVENT_REGISTRATION_CURSOR_STALE',
  });
  for (const position of [[-1, 0, 0], [0, 0, 9], [0, 1, 1], [9, 0, 0], [1, 1, 0], []])
    assert.throws(() => index.eventRegistrations({ cursor: { ...cursor, position } }), {
      code: 'EVENT_REGISTRATION_REQUEST_INVALID',
    });
  for (const request of [
    { cursor: false },
    { budget: { items: 0 } },
    { budget: { bytes: 100 } },
    { includeParameters: 'yes' },
    { entity: [] },
  ])
    assert.throws(() => index.eventRegistrations(request), { code: 'EVENT_REGISTRATION_REQUEST_INVALID' });
  assert.throws(() => modelDrivenEventPage(source, { 'event-cursor': 'bad*' }), /Invalid --event-cursor/);
  assert.throws(
    () => validateModelDrivenArguments({ project: 'invented', 'event-cursor': 'abc' }, 'dev'),
    /inspect only/,
  );
});

test('event work limits continue through empty forms without an unbounded compilation pass', () => {
  const index = createModelDrivenMetadataIndex(imported(Array.from({ length: 257 }, (_, n) => form(`empty-${n}`, ''))));
  const first = index.eventRegistrations();
  assert.equal(first.complete, false);
  assert.deepEqual(first.nextCursor.position, [256, 0, 0]);
  assert.equal(first.registrations.length, 0);
  const second = index.eventRegistrations({ cursor: first.nextCursor });
  assert.equal(second.complete, true);
  assert.equal(second.registrations.length, 0);
});

test('event byte bounds include revision metadata and long source identities cannot stall pagination', () => {
  assert.throws(
    () =>
      createModelDrivenMetadataIndex({}, { sourceRevision: 'x'.repeat(4096) }).eventRegistrations({
        budget: { items: 1, bytes: 2048 },
      }),
    { code: 'EVENT_REGISTRATION_ENVELOPE_LIMIT' },
  );
  const index = createModelDrivenMetadataIndex(
    imported([form('x'.repeat(4096), event(handler('one'))), { id: 'y'.repeat(4096), entity: 'x_item' }]),
  );
  const report = index.eventRegistrations({ budget: { bytes: 2048 } });
  assert.equal(report.complete, true);
  assert.equal(report.truncated, true);
  assert.equal(report.diagnostics.length, 2);
  assert.ok(report.diagnostics.every((item) => item.detailsOmitted));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 2048);
});

test('offline inspect CLI emits default-safe event pages and accepts continuation tokens across processes', async (t) => {
  const fx = await modelDrivenFixture(t, { defer: true });
  const file = path.join(fx.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(
    file,
    original.replace(
      '</form>',
      `<events>${Array.from({ length: 101 }, (_, n) => event(handler(`handler-${n}`, 'x_missing.js', 'parameters="&quot;Invented private literal&quot;"'))).join('')}</events></form>`,
    ),
  );
  const project = path.join(fx.root, 'project.json');
  await fs.writeFile(
    project,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'model-driven' },
      solutions: [{ id: 'invented', path: fx.solutionDir }],
      references: [{ id: 'local', origin: 'http://127.0.0.1:1234' }],
      modelDriven: { targets: [{ reference: 'local' }] },
    }),
  );
  const command = ['model-driven', 'inspect', '--project', project, '--json'];
  const first = await runToolkit(...command);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const report = JSON.parse(first.stdout).clientEvents;
  assert.equal(report.registrations.length, 100);
  assert.equal(report.complete, false);
  assert.equal(report.registrations[0].parameterCount, 1);
  assert.ok(report.registrations[0].sourceRefs.some((ref) => ref.recordId === 'item-form'));
  assert.doesNotMatch(first.stdout, /Invented private literal/);
  const second = await runToolkit(...command, '--event-cursor', report.nextCursorToken);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  const final = JSON.parse(second.stdout).clientEvents;
  assert.equal(final.registrations.length, 1);
  assert.equal(final.registrations[0].handlerId, 'handler-100');
  assert.equal(final.complete, true);
  const explicit = await runToolkit(...command, '--include-event-parameters');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).clientEvents.registrations[0].parameters, '"Invented private literal"');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('handler-0', 'handler-changed'));
  const stale = await runToolkit(...command, '--event-cursor', report.nextCursorToken);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout, /EVENT_REGISTRATION_CURSOR_STALE/);
});
