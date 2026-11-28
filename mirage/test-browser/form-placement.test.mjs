// @test-kind observation: Power Pages renders stacked inline Bootstrap 3 wizard content directly and omits the readonly class on display-only lookup name boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });
const lookup = { type: 'lookup', lookupTargets: ['press'] };
const note = { name: 'note', type: 'text', label: 'Title' };
const displayed = [
  ['publisherid', 'Publisher'],
  ['imprintid', 'Imprint'],
  ['distributorid', 'Distributor'],
];
const inset = 37;
const border = [25, 69, 117];
const layout = (fields) => [
  { name: 'tab', columns: [{ sections: [{ name: 'details', rows: fields.map(({ name }) => [{ name }]) }] }] },
];

async function fixture(t, { wizard = false } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-form-placement-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const bookFields = [
    note,
    ...displayed.map(([name, label]) => ({ ...lookup, name, label, readOnly: true })),
    { ...lookup, name: 'editableid' },
    { ...lookup, name: 'immutableid', validForUpdate: false },
    { ...lookup, name: 'dropdownid', readOnly: true },
  ];
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Library',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `<!doctype html><html><head><style>
      body { margin: 0; }
      #authored-host { padding-inline: ${inset}px; }
      .row { margin-inline: -15px; }
      #authored-host fieldset { margin-inline: 0; padding-inline: 0; border: 0; }
      #authored-host table.section { width: 100%; }
      #authored-host table.section td.cell { padding-inline: 0; }
      #authored-host .form-control { border: 1px solid rgb(${border.join(', ')}); border-radius: 0; }
      #authored-host .form-control.readonly { border-color: rgb(142, 92, 49); }
      </style></head><body><main id="authored-host">${wizard ? '{% webform name: "Library renewal" %}' : '{% entityform name: "Library details" %}'}</main></body></html>`,
    'Renewal.advancedform.yml': 'adx_webformid: renewal\nadx_name: Library renewal\nadx_progressindicatorenabled: true',
    'Details.basicform.yml':
      'adx_entityformid: details\nadx_name: Library details\nadx_entityname: book\nadx_mode: 100000001\nadx_formname: Details layout',
    'Details.dropdown.basicformmetadata.yml':
      'adx_entityformmetadataid: dropdown-metadata\nadx_entityform: details\nadx_type: 100000000\nadx_attributelogicalname: dropdownid\nadx_controlstyle: 756150000',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedBooks</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/Entities/Book/Entity.xml': `<Entity><Name>book</Name><EntityInfo><entity><attributes>${bookFields
      .map(
        ({ name, type, validForUpdate }) =>
          `<attribute><LogicalName>${name}</LogicalName><Type>${type === 'text' ? 'nvarchar' : type}</Type><ValidForUpdateApi>${Number(validForUpdate !== false)}</ValidForUpdateApi></attribute>`,
      )
      .join('')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/Book/FormXml/main/Details.xml': `<systemform><formid>details-layout</formid><LocalizedNames><LocalizedName description="Details layout" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section name="details"><rows>${bookFields
      .map(
        ({ name, label = name, readOnly }) =>
          `<row><cell><labels><label description="${label}" languagecode="1033"/></labels><control datafieldname="${name}"${readOnly ? ' disabled="true"' : ''}/></cell></row>`,
      )
      .join('')}</rows></section></sections></column></columns></tab></tabs></form></systemform>`,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const wizardFields = [note, { ...lookup, name: 'publisherid', label: 'Publisher' }];
  const step = (id, options) => ({
    stepId: id,
    title: id === 'one' ? 'First step' : 'Second step',
    entity: 'book',
    fields: wizardFields,
    layout: layout(wizardFields),
    ...options,
  });
  const original = { id: 'original', logical_name: 'press', name: 'Original publisher' };
  const app = await createSimulator({
    sourceDir: directory,
    solutionRoots: [path.join(directory, 'solution')],
    port: 0,
    watch: false,
    initial: {
      mappings: {
        book: {
          idColumn: 'bookid',
          relationships: Object.fromEntries(
            bookFields
              .filter(({ type }) => type === 'lookup')
              .map(({ name }) => [`book_${name}`, { entity: 'press', from: name, to: 'pressid', many: false }]),
          ),
        },
        press: { idColumn: 'pressid', nameColumn: 'name' },
      },
      tables: {
        book: [
          {
            bookid: 'book',
            note: 'Original title',
            ...Object.fromEntries(displayed.map(([name]) => [name, original])),
          },
        ],
        press: [
          { pressid: 'original', name: original.name },
          { pressid: 'other', name: 'Other publisher' },
        ],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        componentSchemas: {
          renewal: {
            initialStepId: 'one',
            steps: [
              step('one', { mode: 100000000, nextStepId: 'two' }),
              step('two', {
                mode: 100000001,
                metadata: {
                  adx_entitysourcetype: 100000003,
                  adx_entitysourcestep: 'one',
                  adx_previousbuttonenabled: true,
                },
              }),
            ],
          },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return { app, page: await browser.page(t) };
}

test('the inline Bootstrap 3 wizard retains its authored inset during forward and backward navigation', async (t) => {
  const { app, page } = await fixture(t, { wizard: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width === 390) await page.context().clearCookies();
    await page.goto(app.url);
    const verifyPlacement = async () =>
      assert.deepEqual(
        await page.locator('#WebFormPanel').evaluate((panel) => {
          const wrapper = panel.parentElement;
          const table = panel.querySelector('table.section');
          const progress = wrapper.querySelector('.progress.list-group');
          return {
            direct: wrapper.parentElement.id === 'authored-host',
            left: [progress, table, panel.querySelector('#note'), panel.querySelector('#publisherid_name')].map(
              (element) => element.getBoundingClientRect().left,
            ),
          };
        }),
        { direct: true, left: [inset, inset, inset, inset] },
      );
    await verifyPlacement();
    assert.equal(await page.locator('button.launchentitylookup').count(), 1);
    await page.locator('#note').fill(`Draft at ${width}px`);
    const next = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('#NextButton').click();
    const advanced = await next;
    assert.equal(advanced.status(), 200, advanced.ok() ? '' : (await advanced.text()).slice(0, 400));
    assert.match(await page.locator('ol.progress li.active').innerText(), /Second step/);
    assert.equal(await page.locator('#note').inputValue(), `Draft at ${width}px`);
    await verifyPlacement();
    const back = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.locator('#PreviousButton').click();
    assert.equal((await back).status(), 200);
    assert.match(await page.locator('ol.progress li.active').innerText(), /First step/);
    assert.equal(await page.locator('#note').inputValue(), `Draft at ${width}px`);
    await verifyPlacement();
  }
});

test('Bootstrap 3 display-only lookup name controls preserve the authored border and submitted lookup permissions', async (t) => {
  const { app, page } = await fixture(t);
  await page.goto(app.url + '/?id=book');
  for (const [id, label] of displayed) {
    const display = page.getByRole('textbox', { name: label, exact: true });
    assert.equal(await display.getAttribute('id'), `${id}_name`);
    const state = await display.evaluate((field) => ({
      readOnly: field.readOnly,
      disabled: field.disabled,
      readonlyClass: field.classList.contains('readonly'),
      accessible: field.getAttribute('aria-readonly'),
      launcher: field.closest('.control').querySelector('button.launchentitylookup') !== null,
      border: getComputedStyle(field).borderTopColor,
    }));
    assert.deepEqual(state, {
      readOnly: true,
      disabled: false,
      readonlyClass: false,
      accessible: 'true',
      launcher: false,
      border: `rgb(${border.join(', ')})`,
    });
    const image = PNG.sync.read(await display.screenshot({ scale: 'css' }));
    const pixel = (y) => [...image.data.subarray(4 * (y * image.width + 5), 4 * (y * image.width + 6))];
    assert.ok([0, 1, 2].some((y) => pixel(y).join(',') === [...border, 255].join(',')));
    await page.locator(`#${id}`).evaluate((input) => {
      input.value = 'other';
    });
  }
  assert.equal(await page.locator('[data-logical-name=editableid] .launchentitylookup').count(), 1);
  assert.equal(await page.locator('#immutableid_name.readonly[readonly]').count(), 1);
  assert.equal(await page.locator('select#dropdownid').isDisabled(), true);
  await page.locator('#note').fill('Authorized title update');
  const post = page.waitForResponse((response) => response.request().method() === 'POST');
  await page.locator('#UpdateButton').click();
  assert.equal((await post).status(), 200);
  const book = app.store.snapshot().tables.book[0];
  assert.equal(book.note, 'Authorized title update');
  for (const [id] of displayed) assert.equal(book[id].id, 'original');
});
