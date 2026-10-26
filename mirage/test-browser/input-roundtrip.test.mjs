import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

// These are invented local records. Acceptance of an input by this fixture does
// not establish that the hosted portal's request-validation policy accepts it.
const CASES = [
  ['quotes', `A & B "quoted" O'Brien \\ / + = ? #`],
  ['entities', '&lt;img src=x onerror=alert(1)&gt; &amp; &#39;'],
  ['json', '{"name":"A & B","items":[1,null],"quote":"\\""}'],
  ['unicode', 'Київ café cafe\u0301 😀 \u2028 \u2029'],
  ['html', '<b>bold</b><img data-input-probe src="/probe-missing" onerror="window.__inputInjected=1">'],
  ['xml', '<?xml version="1.0"?><record name="A &amp; B">text</record>'],
  ['breakout', '</textarea></script><img data-input-probe src="/probe-missing" onerror="window.__inputInjected=1">'],
];

async function fixture(t, extraFields = [], contextOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'input-roundtrip-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: input-site\nadx_name: Input fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '{% if request.params.readonly %}{% entityform name: "View input" %}{% elsif request.params.id %}{% entityform name: "Edit input" %}{% else %}{% entityform name: "Create input" %}{% endif %}{% include "entity_list" key: "Inputs" %}',
    'Create.basicform.yml':
      'adx_entityformid: input-create\nadx_name: Create input\nadx_entityname: sample\nadx_mode: 100000000',
    'Edit.basicform.yml':
      'adx_entityformid: input-edit\nadx_name: Edit input\nadx_entityname: sample\nadx_mode: 100000001',
    'View.basicform.yml':
      'adx_entityformid: input-view\nadx_name: View input\nadx_entityname: sample\nadx_mode: 100000002',
    'Inputs.list.yml':
      'adx_entitylistid: input-list\nadx_name: Inputs\nadx_entityname: sample\nadx_pagesize: 50\nadx_searchenabled: true',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const fields = [
    { name: 'title', label: 'Title', type: 'text', dataverseType: 'nvarchar', required: true, maxLength: 500 },
    { name: 'notes', label: 'Notes', type: 'textarea', dataverseType: 'memo', maxLength: 2000 },
    ...extraFields,
  ];
  const initial = {
    mappings: {
      sample: {
        entitySet: 'samples',
        idColumn: 'sampleid',
        nameColumn: 'title',
        relationships: Object.fromEntries(
          fields
            .filter((field) => field.type === 'lookup')
            .map((field) => [field.name, { entity: 'sample', from: field.name, to: 'sampleid', many: false }]),
        ),
        fieldMetadata: Object.fromEntries(
          fields.map((field) => [
            field.name,
            {
              dataverseType: field.dataverseType,
              maxLength: field.maxLength,
              minValue: field.minValue,
              maxValue: field.maxValue,
              precision: field.precision,
              dateTimeBehavior: field.dateTimeBehavior,
              format: field.format,
            },
          ]),
        ),
      },
    },
    tables: { sample: [] },
    permissions: [],
    settings: {
      permissionMode: 'permissive',
      'Webapi/sample/enabled': true,
      'Webapi/sample/fields': fields.map((field) => field.name).join(','),
    },
    simulator: {
      identity: { id: 'fixture-editor', roles: ['Editor'] },
      // This suite asserts the JSON form endpoint's responses; the core default is the postback.
      observed: { nativeFormTransport: 'json', evidence: 'Invented loopback JSON transport fixture' },
      componentSchemas: {
        'input-create': { entity: 'sample', fields },
        'input-edit': { entity: 'sample', fields },
        'input-view': { entity: 'sample', fields },
        Inputs: { entity: 'sample', fields },
      },
    },
  };
  const app = await createSimulator({ sourceDir: root, initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const context = await chrome.browser.newContext(contextOptions);
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, 'fixture-editor', { roles: ['Editor'] });
  const page = await context.newPage();
  const errors = [],
    external = [],
    writes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/__sim/forms/') && request.method() === 'POST')
      writes.push(request.postDataJSON().values);
  });
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== new URL(app.url).origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  return { app, page, errors, external, writes };
}

async function assertInert(page) {
  assert.equal(await page.locator('[data-input-probe]').count(), 0, 'input markup must remain text');
  assert.equal(await page.evaluate(() => window.__inputInjected), undefined, 'input event handlers must not execute');
}

async function save(page, title, notes, status) {
  await page.locator('#title').fill(title);
  await page.locator('#notes').fill(notes);
  const response = page.waitForResponse(
    (result) => result.url().includes('/__sim/forms/') && result.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  assert.equal((await response).status(), status);
  await page.locator('#MessageLabel').waitFor();
  await assertInert(page);
}

async function search(page, value) {
  const response = page.waitForResponse(
    (result) =>
      result.url().includes('/_services/entity-grid-data.json/') && result.request().postDataJSON()?.search === value,
  );
  await page.locator('.entitylist .view-search input.query').fill(value);
  await page.locator('.entitylist .view-search input.query').press('Enter');
  const result = await response;
  assert.equal(result.status(), 200);
  const data = await result.json();
  const ids = data.Records.map((record) => record.Id);
  await page.waitForFunction((expected) => {
    const rows = [...document.querySelectorAll('.entitylist .view-grid tbody tr')];
    return JSON.stringify(rows.map((row) => row.dataset.id)) === JSON.stringify(expected);
  }, ids);
  await assertInert(page);
  return data;
}

test('native multiline edits use browser LF values while direct data writes retain CRLF', async (t) => {
  const { app, page, writes, errors } = await fixture(t);
  const identity = { id: 'fixture-editor', roles: ['Editor'] };
  const prior = 'Original memo β',
    entered = 'Owned α<&>"\' \\ 😀 e\u0301\r\nline',
    saved = entered.replaceAll('\r\n', '\n');
  const row = await app.store.create('sample', { title: 'Multiline fixture', notes: prior }, identity);
  await page.goto(`${app.url}/?id=${row.sampleid}`);
  await save(page, 'Multiline fixture', entered, 200);
  assert.equal(writes.at(-1).notes, saved, 'native textarea submission exposes LF text');
  assert.equal(app.store.snapshot().tables.sample[0].notes, saved);
  await page.goto(`${app.url}/?id=${row.sampleid}&readonly=1`);
  assert.equal(await page.locator('#notes').inputValue(), saved);
  const found = await search(page, saved.split('\n')[0]);
  assert.deepEqual(
    found.Records.map((record) => record.Id),
    [row.sampleid],
  );
  await app.store.updateRecord('sample', row.sampleid, { notes: entered }, identity);
  assert.equal(
    app.store.snapshot().tables.sample[0].notes,
    entered,
    'data writes retain their separate raw string contract',
  );
  assert.deepEqual(errors, []);
});

test('native hidden lookups require a record GUID and entity name, and malformed edits clear the reference', async (t) => {
  const { app, page, writes } = await fixture(t, [
    { name: 'related', label: 'Related', type: 'lookup', dataverseType: 'lookup', targets: ['sample'] },
  ]);
  const parent = '00000000-0000-4000-8000-000000000001';
  await app.store.create('sample', { sampleid: parent, title: 'Parent' }, { id: 'fixture-editor', roles: ['Editor'] });
  for (const [label, value, entity, bound] of [
    ['missing entity', parent, '', false],
    ['malformed GUID', 'not-guid', 'sample', false],
    ['valid lookup', parent, 'sample', true],
  ]) {
    await page.goto(app.url);
    assert.equal(
      await page.locator('#related_entityname').inputValue(),
      '',
      'blank native lookups have no selected entity',
    );
    await page.evaluate(
      ({ value, entity }) => {
        document.getElementById('related').value = value;
        document.getElementById('related_entityname').value = entity;
      },
      { value, entity },
    );
    await save(page, label, '', 201);
    assert.equal(writes.at(-1)['related@odata.bind'], bound ? `/samples(${parent})` : undefined);
  }
  const child = app.store.snapshot().tables.sample.find((row) => row.title === 'valid lookup');
  for (const [value, entity] of [
    ['not-guid', 'sample'],
    [parent, ''],
  ]) {
    await app.store.updateRecord(
      'sample',
      child.sampleid,
      { 'related@odata.bind': `/samples(${parent})` },
      { id: 'fixture-editor', roles: ['Editor'] },
    );
    await page.goto(`${app.url}/?id=${child.sampleid}`);
    await page.evaluate(
      ({ value, entity }) => {
        document.getElementById('related').value = value;
        document.getElementById('related_entityname').value = entity;
      },
      { value, entity },
    );
    await save(page, 'Cleared malformed lookup', '', 200);
    assert.equal(
      writes.at(-1)['related@odata.bind'],
      null,
      'native edit clears a malformed reference instead of rejecting an API bind',
    );
    const row = app.store.snapshot().tables.sample.find((row) => row.sampleid === child.sampleid);
    assert.equal(row.related ?? null, null);
  }
});

test('native create and edit preserve special text through details, grids and quick search without executing markup', async (t) => {
  const { app, page, errors, external, writes } = await fixture(t);
  for (const [index, [name, payload]] of CASES.entries()) {
    const title = `Case ${index}: ${payload}`;
    const notes = `${payload}\nSecond line & "quotes"\n${payload}`;
    await page.goto(app.url);
    await save(page, title, notes, 201);
    const row = app.store.snapshot().tables.sample.find((record) => record.title === title);
    assert.ok(row, `${name}: created record`);
    assert.equal(row.notes, notes, `${name}: stored memo`);
    assert.deepEqual(writes.at(-1), { title, notes }, `${name}: JSON submit values`);

    await page.goto(`${app.url}/?id=${row.sampleid}`);
    assert.equal(await page.locator('#title').inputValue(), title);
    assert.equal(await page.locator('#notes').inputValue(), notes);
    await assertInert(page);
    const updatedTitle = `Updated ${index}: ${payload}`;
    const updatedNotes = `${notes}\nUpdated`;
    await save(page, updatedTitle, updatedNotes, 200);
    const stored = app.store.snapshot().tables.sample.find((record) => record.sampleid === row.sampleid);
    assert.equal(stored.title, updatedTitle);
    assert.equal(stored.notes, updatedNotes);
    assert.deepEqual(writes.at(-1), { title: updatedTitle, notes: updatedNotes });

    await page.goto(`${app.url}/?id=${row.sampleid}&readonly=1`);
    assert.equal(await page.locator('#title').getAttribute('readonly'), 'readonly');
    assert.equal(await page.locator('#title').inputValue(), updatedTitle);
    assert.equal(await page.locator('#notes').inputValue(), updatedNotes);
    await assertInert(page);
    const data = await search(page, `Updated ${index}:`);
    assert.equal(data.ItemCount, 1);
    const rendered = page.locator(`.entitylist tr[data-id="${row.sampleid}"]`);
    assert.equal(await rendered.locator('td[data-attribute="title"]').textContent(), updatedTitle);
    assert.equal(await rendered.locator('td[data-attribute="notes"]').textContent(), updatedNotes);
    assert.equal(await rendered.locator('td[data-attribute="notes"]').getAttribute('data-value'), updatedNotes);
  }
  assert.equal(writes.length, CASES.length * 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('native quick search treats markup, quotes, XML and JSON query text as data', async (t) => {
  const { app, page, errors, external } = await fixture(t);
  const records = CASES.map(([name, payload]) => ({ sampleid: name, title: payload, notes: `${name}\n${payload}` }));
  for (const record of records) await app.store.create('sample', record, { id: 'fixture-editor', roles: ['Editor'] });
  await page.goto(app.url);
  for (const [name, payload] of CASES) {
    // Native quick search uses SQL LIKE: JSON array brackets define a character
    // set rather than a literal array. The bracket escapes retain that contract.
    const raw = await search(page, payload);
    if (name === 'json') assert.equal(raw.ItemCount, 0, 'raw JSON array is a LIKE pattern');
    const query = payload.replace(/\[/g, '[[]'); // A closing bracket is literal in SQL LIKE.
    const data = query === payload ? raw : await search(page, query);
    assert.equal(data.ItemCount, 1, name);
    assert.equal(data.Records[0].Id, name);
    assert.equal(await page.locator('.entitylist td[data-attribute="title"]').textContent(), payload);
    assert.equal(await page.locator('.entitylist .view-search input.query').inputValue(), query);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('native format and range errors post to the server, preserve input and reject the entire write', async (t) => {
  const { app, page, writes, errors, external } = await fixture(t, [
    { name: 'email', label: 'Email', dataverseType: 'nvarchar', format: 'email' },
    { name: 'count', label: 'Count', dataverseType: 'int', minValue: 0, maxValue: 100 },
    { name: 'score', label: 'Score', dataverseType: 'decimal', minValue: 0, maxValue: 100, precision: 2 },
    { name: 'day', label: 'Day', dataverseType: 'datetime', type: 'date' },
  ]);
  await page.goto(app.url);
  await page.locator('#title').fill('Valid title');
  await page.locator('#email').fill('not an email');
  await page.locator('#count').fill('not a number');
  await page.locator('#score').fill('101');
  await page.locator('#day').evaluate((input) => {
    input.value = 'not a date';
  });
  assert.equal(
    await page.evaluate(() => window.Page_ClientValidate('')),
    true,
    'native custom format/range validators are server-only',
  );
  const submitted = page.waitForResponse(
    (response) => response.url().includes('/__sim/forms/') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const response = await submitted;
  assert.equal(response.status(), 400, 'Mirage retains its JSON form-service transport');
  const expected = [
    'Email must be a valid email address.',
    'Count must be a valid integer value.',
    'Count must have a value between 0 and 100.',
    'Score must have a value between 0.00 and 100.00.',
    'Day must have a valid date format.',
  ];
  assert.deepEqual(
    (await response.json()).error.validationErrors.map((entry) => entry.message),
    expected,
  );
  const summary = page.locator('#EntityFormPanel .validation-summary');
  await summary.waitFor({ state: 'visible' });
  // The server summary links end with a space, as the platform renders them.
  assert.deepEqual(
    await summary.locator('li a').allTextContents(),
    expected.map((message) => `${message} `),
  );
  assert.equal(await page.evaluate(() => window.Page_IsValid), false);
  assert.equal(await page.locator('#email').inputValue(), 'not an email');
  assert.equal(await page.locator('#count').inputValue(), 'not a number');
  assert.equal(writes[0].count, 'not a number', 'invalid numeric input must not collapse to JSON null');
  assert.equal(app.store.snapshot().tables.sample.length, 0);

  await page.locator('#email').fill("o'brien+probe@example.invalid");
  await page.locator('#count').fill('2');
  await page.locator('#score').fill('100');
  await page.locator('#day').evaluate((input) => {
    input.value = '2026-10-10T00:00:00.0000000';
  });
  await save(page, 'Valid title', 'Valid notes', 201);
  const row = app.store.snapshot().tables.sample[0];
  assert.equal(row.count, 2);
  assert.equal(row.score, 100);

  await page.goto(`${app.url}/?id=${row.sampleid}`);
  await page.locator('#email').fill('<img data-input-probe>@example.invalid');
  await page.locator('#title').evaluate((input) => {
    input.value = 'x'.repeat(501);
  });
  const rejected = page.waitForResponse(
    (result) => result.url().includes('/__sim/forms/') && result.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  assert.equal((await rejected).status(), 400);
  await summary.waitFor({ state: 'visible' });
  assert.deepEqual(await summary.locator('li a').allTextContents(), [
    'Title exceeds the maximum length of 500 characters. ',
    'Email must be a valid email address. ',
  ]);
  assert.deepEqual(app.store.snapshot().tables.sample, [row], 'invalid update cannot partially change another field');
  await assertInert(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('native date companions parse AM/PM and submit UserLocal dates as UTC in the browser timezone', async (t) => {
  for (const [timezoneId, offset] of [
    ['Europe/Kiev', 3],
    ['America/New_York', -4],
  ]) {
    await t.test(timezoneId, async (t) => {
      const { app, page, errors, external } = await fixture(
        t,
        [
          {
            name: 'date',
            label: 'Date',
            type: 'date',
            dataverseType: 'datetime',
            format: 'DateOnly',
            dateTimeBehavior: 'UserLocal',
          },
          {
            name: 'instant',
            label: 'Instant',
            type: 'date',
            dataverseType: 'datetime',
            format: 'DateAndTime',
            dateTimeBehavior: 'UserLocal',
          },
          {
            name: 'independent',
            label: 'Independent',
            dataverseType: 'datetime',
            format: 'datetime',
            dateTimeBehavior: 'TimeZoneIndependent',
          },
        ],
        { timezoneId },
      );
      const utc = (hour) => new Date(Date.UTC(2026, 9, 10, hour - offset)).toISOString().replace('.000Z', '.0000000Z');
      await page.goto(app.url);
      assert.equal(await page.locator('#date_datepicker_description').getAttribute('data-date-format'), 'M/D/YYYY');
      assert.equal(
        await page.locator('#instant_datepicker_description').getAttribute('data-date-format'),
        'M/D/YYYY h:mm A',
      );
      await page.locator('#date_datepicker_description').fill('not a date');
      await page.locator('#date_datepicker_description').press('Tab');
      assert.equal(await page.locator('#date_datepicker_description').inputValue(), '');
      assert.equal(await page.locator('#date').inputValue(), '');
      for (const [field, value] of [
        ['date', '10/10/2026'],
        ['instant', '10/10/2026 12:00 PM'],
        ['independent', '10/10/2026 12:00 AM'],
      ]) {
        await page.locator(`#${field}_datepicker_description`).fill(value);
        await page.locator(`#${field}_datepicker_description`).press('Tab');
      }
      assert.equal(await page.locator('#date').inputValue(), utc(0));
      assert.equal(await page.locator('#instant').inputValue(), utc(12));
      assert.equal(await page.locator('#independent').inputValue(), '2026-10-10T00:00:00.0000000');
      await page.locator('#instant_datepicker_description').fill('not a date');
      await page.locator('#instant_datepicker_description').press('Tab');
      assert.equal(await page.locator('#instant_datepicker_description').inputValue(), '10/10/2026 12:00 PM');
      assert.equal(await page.locator('#instant').inputValue(), utc(12));
      await save(page, 'Dates', '', 201);
      const row = app.store.snapshot().tables.sample[0];
      assert.equal(row.date, utc(0));
      assert.equal(row.instant, utc(12));
      await page.goto(`${app.url}/?id=${row.sampleid}`);
      assert.equal(await page.locator('#date_datepicker_description').inputValue(), '10/10/2026');
      assert.equal(await page.locator('#instant_datepicker_description').inputValue(), '10/10/2026 12:00 PM');
      await page.locator('#instant_datepicker_description').fill('10/10/2026 12:00 AM');
      await page.locator('#instant_datepicker_description').press('Tab');
      assert.equal(await page.locator('#instant').inputValue(), utc(0));
      await save(page, 'Edited dates', '', 200);
      assert.equal(app.store.snapshot().tables.sample[0].instant, utc(0));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    });
  }
});

test('native hidden dates require the native round-trip representation while Dataverse accepts ISO values', async (t) => {
  const { app, page, errors, external } = await fixture(
    t,
    [
      {
        name: 'at',
        label: 'Appointment',
        type: 'date',
        dataverseType: 'datetime',
        format: 'DateAndTime',
        dateTimeBehavior: 'UserLocal',
      },
    ],
    { timezoneId: 'Europe/Kiev' },
  );
  await page.goto(app.url);
  await page.locator('#title').fill('Date syntax');
  for (const value of [
    '2026-10-10',
    '2026-10-10T12:00:00Z',
    '2026-10-10T12:00:00.000Z',
    '2026-10-10T12:00:00.0000000',
  ]) {
    await page.locator('#at').evaluate((input, value) => {
      input.value = value;
    }, value);
    // Each rejection replaces the summary's children; mark the previous link so only a new one is awaited.
    await page
      .locator('.validation-summary li a')
      .evaluateAll((links) => links.forEach((link) => (link.dataset.stale = '')));
    const posted = page.waitForResponse(
      (response) => response.url().includes('/__sim/forms/') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    assert.equal((await posted).status(), 400, value);
    const link = page.locator('.validation-summary li a:not([data-stale])');
    await link.waitFor({ state: 'visible' });
    assert.equal(await link.textContent(), 'Appointment must have a valid date format. ');
    assert.equal(app.store.snapshot().tables.sample.length, 0);
  }
  const identity = { id: 'fixture-editor', roles: ['Editor'] };
  const row = await app.store.create('sample', { title: 'API ISO date', at: '2026-10-10T12:00:00Z' }, identity);
  assert.ok(row, 'the underlying Dataverse store retains its ISO contract');
  await page.goto(`${app.url}/?id=${row.sampleid}`);
  assert.equal(
    await page.locator('#at').inputValue(),
    '2026-10-10T12:00:00.0000000Z',
    'rendered edits expose the native canonical value',
  );
  assert.equal(await page.locator('#at_datepicker_description').inputValue(), '10/10/2026 3:00 PM');
  await save(page, 'Native unchanged date edit', '', 200);
  assert.equal(app.store.snapshot().tables.sample[0].at, '2026-10-10T12:00:00.0000000Z');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
