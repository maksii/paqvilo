// @test-kind observation: hosted session F7 (paqvilo-developer hosted-f7, runs a and b agree, integration off): the Document Locations subgrid markup after the platform client ran (view-s0, view-s0-read, view-s0-none, read-s0, insert-s0 in mirage/test/fixtures/hosted-f7-sharepoint-grid.json), the list request body and the dialogs' error placement (ops-s0)
// The SharePoint document control in a browser: the grid as the hosted platform leaves it, the services' request bodies,
// and, with SharePoint storage configured (local answers), New folder, navigation, upload into the open folder and delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });
const hosted = JSON.parse(
  await fs.readFile(new URL('../test/fixtures/hosted-f7-sharepoint-grid.json', import.meta.url), 'utf8'),
);
const SITE = '77777777-7777-4777-8777-777777777711';
const CASE = '77777777-7777-4777-8777-777777777712';
const FORM = '77777777-7777-4777-8777-777777777713';
const CONTACT = '77777777-7777-4777-8777-777777777714';
const READ_FORM = '77777777-7777-4777-8777-777777777715';
const INSERT_FORM = '77777777-7777-4777-8777-777777777716';
const NOT_ENABLED = 'SharePoint integration is not enabled. Please contact your system administrator for more details.';
const entity = (name) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><EntitySetName>${name}s</EntitySetName><PrimaryIdAttribute>${name}id</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="${name}id"><Name>${name}id</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>`;
const layout = [
  {
    name: 'tab',
    columns: [
      {
        sections: [
          {
            name: 's',
            rows: [
              [{ name: 'x_name' }],
              [{ type: 'subgrid', id: 'docs', entity: 'sharepointdocumentlocation', label: 'Documents', rowspan: 4 }],
            ],
          },
        ],
      },
    ],
  },
];
const schema = (mode) => ({ entity: 'x_case', mode, fields: [{ name: 'x_name', label: 'Name' }], layout });
const page = (name, url, form, tag = 'entityform') => ({
  [`portal/${name}.webpage.yml`]: `adx_webpageid: ${name.toLowerCase()}\nadx_name: ${name}\nadx_partialurl: ${url}\n${url === '/' ? 'adx_isroot: true' : 'adx_parentpageid: home'}\nadx_pagetemplateid: ${name.toLowerCase()}`,
  [`portal/${name}.pagetemplate.yml`]: `adx_pagetemplateid: ${name.toLowerCase()}\nadx_webtemplateid: ${name.toLowerCase()}`,
  [`portal/${name}.webtemplate.yml`]: `adx_webtemplateid: ${name.toLowerCase()}\nadx_name: ${name}`,
  [`portal/${name}.webtemplate.source.html`]: `{% ${tag} name: "${form}" %}`,
});

const ALL = ['read', 'create', 'update', 'append', 'delete'];
// The integration off, as every F7 phase ran (summary-F7.md section 8).
const OFF = {
  sharePointIntegration: 'off',
  evidence: 'Hosted session F7: the admin center SharePoint Integration setting was No.',
};
async function site(t, { child = ALL, observed, stepKey = 'x_caseid' } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-documents-folders-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedDocs</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_case/Entity.xml': entity('x_case'),
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Example`,
    ...page('Home', '/', 'Case'),
    ...page('Reader', 'reader', 'Case Read'),
    ...page('Creator', 'creator', 'Case Insert'),
    ...page('Steps', 'steps', 'Steps', 'webform'),
    'portal/Steps.advancedform.yml': `adx_webformid: steps\nadx_name: Steps\nadx_startstep: edit`,
    'portal/Case.basicform.yml': `adx_entityformid: ${FORM}\nadx_name: Case\nadx_entityname: x_case\nadx_mode: 100000001\nadx_recordsourcetype: 756150001\nadx_recordidquerystringparametername: id`,
    'portal/CaseRead.basicform.yml': `adx_entityformid: ${READ_FORM}\nadx_name: Case Read\nadx_entityname: x_case\nadx_mode: 100000002\nadx_recordsourcetype: 756150001\nadx_recordidquerystringparametername: id`,
    'portal/CaseInsert.basicform.yml': `adx_entityformid: ${INSERT_FORM}\nadx_name: Case Insert\nadx_entityname: x_case\nadx_mode: 100000000`,
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const initial = {
    version: 1,
    mappings: { x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor', statecode: 0 }],
      x_case: [{ x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 }],
      sharepointsite: [
        {
          sharepointsiteid: SITE,
          name: 'Default Site',
          absoluteurl: 'https://site.example.test/sites/invented',
          isdefault: true,
          statecode: 0,
          statuscode: 1,
        },
      ],
    },
    permissions: [
      {
        id: 'case',
        entity: 'x_case',
        scope: 'global',
        roles: ['Member'],
        operations: ['read', 'create', 'appendTo', 'update'],
      },
      ...(child.length
        ? [
            {
              id: 'docs',
              entity: 'sharepointdocumentlocation',
              scope: 'parent',
              roles: ['Member'],
              operations: child,
              parentPermissionId: 'case',
              relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' },
            },
          ]
        : []),
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
      componentSchemas: {
        Case: schema(100000001),
        'Case Read': schema(100000002),
        'Case Insert': schema(100000000),
        // A multistep step editing the record named in the query string (F7 steps-s0: pqf7 Step Edit).
        Steps: {
          initialStepId: 'edit',
          steps: [
            {
              ...schema(100000001),
              stepId: 'edit',
              metadata: {
                adx_entitysourcetype: 100000001,
                adx_primarykeyquerystringparametername: 'id',
                ...(stepKey ? { adx_primarykeyattributelogicalname: stepKey } : {}),
              },
            },
          ],
        },
      },
    },
  };
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    initial,
    ...(observed ? { observed } : {}),
  });
  ownedFixture(t).add(() => app.close());
  const context = await chrome.browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, { roles: ['Member'] });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  return { app, page: tab, errors };
}
const expected = (markup) =>
  markup.replaceAll('{case}', CASE).replaceAll('{website}', SITE).replaceAll('{table}', 'x_case');
// The grid once its first list answered (the error, empty or access-denied panel, or rows).
const settled = (page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll('.sharepoint-grid > .message:not(.sharepoint-loading)')].some(
      (panel) => panel.style.display !== 'none',
    ),
  );
// The grid without Mirage's own render provenance attributes (data-paqvilo-source), which the platform does not send.
const gridMarkup = (page) =>
  page.locator('.sharepoint-grid').evaluate((grid) => {
    const copy = grid.cloneNode(true);
    for (const element of [copy, ...copy.querySelectorAll('*')])
      for (const name of element.getAttributeNames())
        if (name.startsWith('data-paqvilo-')) element.removeAttribute(name);
    return copy.outerHTML;
  });

test('F7: the edit form grid, its list request and the failed list panel match the hosted platform', async (t) => {
  const { app, page, errors } = await site(t, { observed: OFF });
  const listed = page.waitForRequest((request) => request.url().includes('/_services/sharepoint-data.json/'));
  await page.goto(`${app.url}/?id=${CASE}`);
  const request = await listed;
  assert.equal(new URL(request.url()).pathname, `/_services/sharepoint-data.json/${SITE}`);
  assert.equal(request.headers()['content-type'], 'application/json');
  assert.equal(request.headers()['x-requested-with'], 'XMLHttpRequest');
  assert.deepEqual(request.postDataJSON(), {
    regarding: { Id: CASE, LogicalName: 'x_case', Name: null, KeyAttributes: [], RowVersion: null },
    sortExpression: 'FileLeafRef ASC',
    page: 1,
    pageSize: 10,
    folderPath: '',
  });
  await settled(page);
  assert.equal(await gridMarkup(page), expected(hosted.edit));
  assert.equal(
    await page.locator('td:has(> .control > #docs)').getAttribute('class'),
    'clearfix cell sharepoint-documents table table-striped-cell',
  );
  assert.deepEqual(errors, []);
});

test('F7: the grid offers no add or delete for a read-only form or a read or missing child permission', async (t) => {
  for (const [label, options, route] of [
    ['read-only form', {}, '/reader/'],
    ['child permission read', { child: ['read'] }, '/'],
    ['no child permission', { child: [] }, '/'],
  ]) {
    const { app, page, errors } = await site(t, { ...options, observed: OFF });
    await page.goto(`${app.url}${route}?id=${CASE}`);
    await settled(page);
    assert.equal(await gridMarkup(page), expected(hosted.read), label);
    assert.deepEqual(errors, [], label);
  }
});

test('F7: a create-mode form renders a file input and the unknown-failure alert', async (t) => {
  const { app, page } = await site(t, { observed: OFF });
  await page.goto(`${app.url}/creator/`);
  const input = page.locator('td.sharepoint-documents input[type="file"]');
  // A form field name of the basic form (F7 insert-s0: ctl00$ContentContainer$EntityFormControl_<form>$..._EntityFormView$<control>).
  const form = INSERT_FORM.replaceAll('-', '');
  const own = (element) =>
    [...element.attributes]
      .filter((item) => !item.name.startsWith('data-paqvilo-'))
      .map((item) => [item.name, item.value]);
  assert.deepEqual(await input.evaluate(own), [
    ['type', 'file'],
    ['multiple', 'multiple'],
    ['name', `ctl00$ContentContainer$EntityFormControl_${form}$EntityFormControl_${form}_EntityFormView$docs`],
    ['id', 'docs'],
    ['class', 'sharepoint-documents table table-striped'],
  ]);
  assert.match(
    await page.locator('.alert.alert-block.alert-danger', { hasText: 'unknown failure' }).textContent(),
    /^An unknown failure has occurred\. Error ID # \[[0-9a-f-]{36}\]$/,
  );
});

test('F7: Add files and New folder post the recorded bodies and show the answer in the dialog', async (t) => {
  const { app, page, errors } = await site(t, { observed: OFF });
  await page.goto(`${app.url}/?id=${CASE}`);
  await settled(page);
  await page.locator('.sharepoint-grid a.add-file').click();
  const addFile = page.locator('.modal-add-file');
  await addFile.locator('input[name="file"]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('invented note'),
  });
  const upload = page.waitForRequest((request) => request.url().includes('/_services/sharepoint-addfiles/'));
  await addFile.locator('.modal-footer button.primary').click();
  const multipart = (await upload).postData();
  assert.deepEqual(
    [...multipart.matchAll(/; name="([^"]+)"/g)].map((match) => match[1]),
    ['regardingEntityLogicalName', 'regardingEntityId', 'files', 'overwrite', '__RequestVerificationToken'],
  );
  const fileError = addFile.locator('.modal-body > .alert.alert-block.alert-danger.error.clearfix');
  await fileError.waitFor();
  assert.equal(await fileError.textContent(), NOT_ENABLED);
  await addFile.locator('.modal-footer button.cancel').click();
  await page.locator('.sharepoint-grid a.add-folder').click();
  const addFolder = page.locator('.modal-add-folder');
  const create = addFolder.locator('.modal-footer button.primary');
  assert.equal(await create.isDisabled(), true, 'Create folder waits for a name');
  await addFolder.locator('#FolderName').pressSequentially('Contracts');
  assert.equal(await create.isDisabled(), false);
  const folder = page.waitForRequest((request) => request.url().includes('/_services/sharepoint-addfolder/'));
  await create.click();
  assert.deepEqual((await folder).postDataJSON(), {
    regarding: { Id: CASE, LogicalName: 'x_case', Name: null, KeyAttributes: [], RowVersion: null },
    name: 'Contracts',
    folderPath: '',
  });
  const folderError = addFolder.locator('.modal-body > .alert.alert-block.alert-danger.error.clearfix');
  await folderError.waitFor();
  assert.equal(await folderError.textContent(), NOT_ENABLED);
  assert.deepEqual(errors, []);
});

// @test-kind contract: with SharePoint storage configured the control creates, opens, fills and deletes subfolders over the local storage route (answers labelled local; F7 could not record SharePoint on)
test('with SharePoint storage the control creates, opens, fills and deletes subfolders', async (t) => {
  const { app, page, errors } = await site(t);
  await page.goto(`${app.url}/?id=${CASE}`);
  const grid = page.locator('.sharepoint-grid');
  await grid.locator('.sharepoint-empty').waitFor();
  await grid.locator('a.add-folder').click();
  await grid.locator('.modal-add-folder #FolderName').pressSequentially('Contracts');
  await grid.locator('.modal-add-folder .modal-footer button.primary').click();
  const folder = grid.locator('.sharepoint-data a.folder-link[data-folderpath="Contracts"]');
  await folder.waitFor();
  await folder.click();
  await grid.locator('.sharepoint-breadcrumbs .active', { hasText: 'Contracts' }).waitFor();
  await grid.locator('a.add-file').click();
  assert.equal(await grid.locator('.modal-add-file .destination-folder').textContent(), 'Documents/Contracts');
  await grid
    .locator('.modal-add-file input[name="file"]')
    .setInputFiles({ name: 'signed.txt', mimeType: 'text/plain', buffer: Buffer.from('signed') });
  await grid.locator('.modal-add-file .modal-footer button.primary').click();
  const file = grid.locator('.sharepoint-data tr.sp-item[data-filename="signed.txt"] a.sharepoint-custom-icon');
  await file.waitFor();
  const href = await file.getAttribute('href');
  assert.equal(href, `/_apps/portal-documents/x_case/${CASE}/signed.txt?folder=Contracts`);
  assert.equal(await (await page.request.get(app.url + href)).text(), 'signed');
  await grid.locator('.sharepoint-breadcrumbs a[data-folderpath=""]').click();
  await folder.waitFor();
  assert.equal(await grid.locator('tr.sp-item[data-filename]').count(), 0, 'the file stays in its folder');
  await grid.locator('tr.sp-item[data-foldername="Contracts"] .delete-link').dispatchEvent('click');
  await grid.locator('.modal-delete-folder .modal-footer button.primary').click();
  await grid.locator('.sharepoint-empty').waitFor();
  assert.deepEqual(errors, []);
});

// @test-kind observation: F7 steps-s0.json (runs a and b) for the step grid; the 500 without adx_primarykeyattributelogicalname is summary-F7.md section 1 (the first run-a steps capture, before the step was refreshed with the column)
test('F7: a multistep step shows the same grid and needs its primary key column', async (t) => {
  const { app, page } = await site(t, { observed: OFF });
  await page.goto(`${app.url}/steps/?id=${CASE}`);
  await settled(page);
  assert.equal(await gridMarkup(page), expected(hosted.edit));
  const missing = await site(t, { observed: OFF, stepKey: null });
  const response = await missing.page.goto(`${missing.app.url}/steps/?id=${CASE}`);
  assert.equal(response.status(), 500);
  assert.ok((await response.text()).includes('names no primary key column (adx_primarykeyattributelogicalname)'));
});

// @test-kind contract: with SharePoint storage, deleting the only item of the last page steps back to the last page that has items instead of showing the empty panel
test('deleting the last item of the last page steps back a page', async (t) => {
  const { app, page, errors } = await site(t);
  await page.goto(`${app.url}/?id=${CASE}`);
  const grid = page.locator('.sharepoint-grid');
  await grid.locator('.sharepoint-empty').waitFor();
  await grid.locator('a.add-file').click();
  await grid.locator('.modal-add-file input[name="file"]').setInputFiles(
    Array.from({ length: 11 }, (_, index) => ({
      name: `file-${String(index).padStart(2, '0')}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    })),
  );
  await grid.locator('.modal-add-file .modal-footer button.primary').click();
  const rows = grid.locator('.sharepoint-data tr.sp-item');
  await grid.locator('tr.sp-item[data-filename="file-00.txt"]').waitFor();
  assert.equal(await rows.count(), 10);
  await grid.locator('.sharepoint-pagination button', { hasText: 'Next page' }).click();
  await grid.locator('tr.sp-item[data-filename="file-10.txt"]').waitFor();
  await grid.locator('tr.sp-item[data-filename="file-10.txt"] .delete-link').dispatchEvent('click');
  await grid.locator('.modal-delete-file .modal-footer button.primary').click();
  await grid.locator('tr.sp-item[data-filename="file-00.txt"]').waitFor();
  assert.equal(await rows.count(), 10);
  assert.equal(await grid.locator('.sharepoint-empty').isVisible(), false);
  assert.deepEqual(errors, []);
});
