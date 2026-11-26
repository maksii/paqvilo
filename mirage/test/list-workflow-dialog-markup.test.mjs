// @test-kind unproven: local model of the legacy grid workflow dialog markup (Adxstudio EntityGridExtensions/EntityList render the first workflow item action's WorkflowActionLink modal, localized in the request language); no hosted capture of a configured list workflow action
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';

const SITE = '6a000000-0000-4000-8000-000000000001';
const LIST = '6b000000-0000-4000-8000-000000000001';
const VIEW = '6c000000-0000-4000-8000-000000000001';
const FIRST = '6d000000-0000-4000-8000-000000000001';
const SECOND = '6d000000-0000-4000-8000-000000000002';
const text = (english, french) => [
  { LCID: 1033, Value: english },
  { LCID: 1036, Value: french },
];
const metadata = {
  entities: {
    gadget: {
      fields: {
        gadgetid: { name: 'gadgetid', dataverseType: 'primarykey', label: 'Gadget' },
        name: { name: 'name', dataverseType: 'nvarchar', label: 'Name', isPrimaryName: true },
      },
    },
  },
  views: [
    {
      id: VIEW,
      entity: 'gadget',
      name: 'Gadgets',
      fetchXml: '<fetch><entity name="gadget"><attribute name="name"/></entity></fetch>',
      fields: [{ name: 'name', width: 100 }],
    },
  ],
};
const workflow = (id, extra) => ({ Type: 'CrmEntityFormView-WorkflowAction', WorkflowId: id, ShowModal: 1, ...extra });
const configured = {
  ItemActions: [workflow(SECOND, { ActionIndex: 3, ButtonLabel: text('Later', 'Plus tard') })],
  ExtendedItemActions: [
    workflow(FIRST, {
      ActionIndex: 1,
      ButtonLabel: text('Approve', 'Approuver'),
      Confirmation: text('Approve this gadget?', 'Approuver ce gadget ?'),
      WorkflowDialogTitle: text('Approve gadget', 'Approuver le gadget'),
      WorkflowDialogCloseButtonText: text('Keep', 'Garder'),
    }),
  ],
  WorkflowDialog: {
    Title: text('Gadget process', 'Processus'),
    PrimaryButtonText: text('Go', 'Lancer'),
    CloseButtonText: text('Back', 'Retour'),
    DismissButtonSrText: text('Close dialog', 'Fermer'),
    Size: 2,
    CssClass: 'gadget-run',
    TitleCssClass: 'gadget-title',
    PrimaryButtonCssClass: '',
    CloseButtonCssClass: '',
  },
};
// A maker export: the WorkflowDialog object with every value empty.
const emptyDialog = {
  Title: text('', ''),
  PrimaryButtonText: text('', ''),
  CloseButtonText: text('', ''),
  DismissButtonSrText: text('', ''),
  Size: 0,
  CssClass: '',
  TitleCssClass: '',
  PrimaryButtonCssClass: '',
  CloseButtonCssClass: '',
};
const render = async (settings, { v5 = false, lcid = 1033 } = {}) =>
  (
    await renderComponent(
      'entitylist',
      'Gadgets',
      { user: { id: 'current' }, request: { url: 'http://localhost/gadgets/' }, key: 'Gadgets', __language: { lcid } },
      {
        portal: {
          website: { id: SITE },
          websiteLanguages: [
            { lcid: 1033, isDefault: true },
            { lcid: 1036, isDefault: false },
          ],
          pages: [],
          settings: { 'Site/BootstrapV5Enabled': v5 ? 'true' : 'false' },
          lists: [
            {
              id: LIST,
              name: 'Gadgets',
              entityName: 'gadget',
              metadata: {
                adx_entitylistid: LIST,
                adx_name: 'Gadgets',
                adx_entityname: 'gadget',
                adx_view: VIEW,
                adx_settings: JSON.stringify(settings),
              },
            },
          ],
        },
        metadata,
        store: { resolveMapping: () => ({ entitySet: 'gadgets', idColumn: 'gadgetid', nameColumn: 'name' }) },
        schemas: {},
        args: { key: 'Gadgets' },
      },
    )
  ).html;
const workflowDialog = (html) =>
  /<(section|div) aria-hidden="true"[^>]*modal-run-workflow[\s\S]*?<\/(section|div)><\/div><\/div><\/\1>/.exec(
    html,
  )?.[0] ?? '';
const itemLinks = (html) =>
  JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html)[1], 'base64').toString('utf8'))[0].Configuration
    .ItemActionLinks;

test('a Bootstrap 3 grid renders the first workflow action dialog in the request language', async () => {
  const html = await render(configured, { lcid: 1036 });
  const dialog = workflowDialog(html);
  assert.match(dialog, /class="modal fade modal-run-workflow gadget-run"/);
  assert.match(dialog, /<div class="modal-sm modal-dialog">/);
  assert.match(dialog, /<h1 class="modal-title gadget-title" title="Approuver le gadget">Approuver le gadget<\/h1>/);
  assert.match(dialog, /<span class="sr-only">Fermer<\/span>/);
  assert.match(dialog, /<div class="modal-body">Approuver ce gadget \?<\/div>/);
  assert.match(dialog, /<button class="primary btn btn-primary" type="button">Lancer<\/button>/);
  assert.match(dialog, /<button class="cancel btn btn-default" data-dismiss="modal" type="button">Garder<\/button>/);
  // Labels and link dialogs are localized with the same request language.
  const links = itemLinks(html);
  assert.deepEqual(
    links.map((link) => [link.Label, link.CustomizeModal, link.Modal.Title, link.Modal.PrimaryButtonText]),
    [
      ['Approuver', true, 'Approuver le gadget', 'Lancer'],
      ['Plus tard', false, 'Processus', 'Lancer'],
    ],
  );
  assert.equal(itemLinks(await render(configured)).at(0).Label, 'Approve');
});

test('a Bootstrap 5 list renders the first workflow action dialog texts and classes', async () => {
  const dialog = workflowDialog(await render(configured, { v5: true }));
  assert.match(dialog, /class="modal fade modal-run-workflow gadget-run"/);
  assert.match(dialog, /<div class="modal-dialog modal-sm">/);
  assert.match(dialog, /<h4 class="modal-title gadget-title">Approve gadget<\/h4>/);
  assert.match(dialog, /<span class="visually-hidden">Close dialog<\/span>/);
  assert.match(dialog, /<div class="modal-body">Approve this gadget\?<\/div>/);
  assert.match(dialog, /<button class="primary btn btn-primary btn btn-primary" type="button">Go<\/button>/);
  assert.match(dialog, /data-bs-dismiss="modal" type="button">Keep<\/button>/);
});

test('an exported WorkflowDialog with empty values keeps the default workflow dialog', async () => {
  for (const v5 of [false, true]) {
    const plain = { ItemActions: [workflow(FIRST, {})] };
    const exported = { ...plain, WorkflowDialog: emptyDialog };
    const defaults = workflowDialog(await render(plain, { v5 }));
    const dialog = workflowDialog(await render(exported, { v5 }));
    assert.ok(defaults, 'the default dialog renders');
    // Bootstrap 5 repeats the button classes for a configured dialog, as for the list's other dialogs.
    const expected = v5
      ? defaults
          .replace('primary btn btn-primary "', 'primary btn btn-primary btn btn-primary"')
          .replace('cancel btn btn-default "', 'cancel btn btn-default btn btn-default"')
      : defaults;
    assert.equal(dialog, expected, `v5 ${v5}`);
  }
});
