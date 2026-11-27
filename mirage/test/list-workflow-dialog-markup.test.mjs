// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (lists.json and lists-bs3.json, runs a and b, 2026-11-26), the list workflow dialog markup replayed on invented loopback fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { boundedMarkup } from './support/bounded-markup.mjs';

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
    boundedMarkup(html),
  )?.[0] ?? '';
const itemLinks = (html) =>
  JSON.parse(Buffer.from(/data-view-layouts="([^"]*)"/.exec(html)[1], 'base64').toString('utf8'))[0].Configuration
    .ItemActionLinks;

// The captured list workflow dialog (paqvilo-developer hosted-f2 summary-F2 LIST-01d, lists.json and lists-bs3.json):
// whatever the configured workflow actions and WorkflowDialog, the list draws no workflow link and one default dialog.
const DEFAULT_DIALOG = {
  bs5: '<div aria-hidden="true" class="modal fade modal-run-workflow " role="dialog" tabindex="-1"><div class="modal-dialog "><div class="modal-content"><div class="modal-header"><h4 class="modal-title "> Run workflow</h4><button class="btn-close" data-bs-dismiss="modal" type="button"><span aria-hidden="true">&times;</span><span class="visually-hidden">Close</span></button></div><div class="modal-body">&lt;p&gt;Are you sure you want to run this workflow?&lt;/p&gt;</div><div class="modal-footer"><button class="primary btn btn-primary " type="button">Run workflow</button><button class="cancel btn btn-default " data-bs-dismiss="modal" type="button">Cancel</button></div></div></div></div>',
  bs3: '<div aria-hidden="true" class="modal fade modal-run-workflow " role="dialog" tabindex="-1"><div class="modal-dialog "><div class="modal-content"><div class="modal-header"><button class="close" data-dismiss="modal" type="button"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button><h4 class="modal-title "> Run workflow</h4></div><div class="modal-body">&lt;p&gt;Are you sure you want to run this workflow?&lt;/p&gt;</div><div class="modal-footer"><button class="primary btn btn-primary " type="button">Run workflow</button><button class="cancel btn btn-default " data-dismiss="modal" type="button">Cancel</button></div></div></div></div>',
};

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (lists.json and lists-bs3.json, runs a and b, 2026-11-26): workflow actions in ItemActions and ExtendedItemActions draw no item action link, and the default modal-run-workflow dialog is drawn with its body HTML-escaped, the grid WorkflowDialog and the actions' dialog texts ignored, in the Bootstrap 5 and the Bootstrap 3 list markup
test('a list draws no workflow link and the default workflow dialog whatever its workflow settings', async () => {
  for (const v5 of [true, false])
    for (const lcid of [1033, 1036]) {
      const html = await render(configured, { v5, lcid });
      assert.equal(workflowDialog(html), DEFAULT_DIALOG[v5 ? 'bs5' : 'bs3'], `v5 ${v5}, lcid ${lcid}`);
      assert.deepEqual(itemLinks(html), [], `v5 ${v5}, lcid ${lcid}`);
      assert.doesNotMatch(html, /gadget-run|Approuver|Approve|Gadget process/);
    }
});

// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01d (runs a and b): a list without any workflow action draws the same default workflow dialog; an exported WorkflowDialog with empty values changes nothing
test('a list without a workflow action and one with an empty WorkflowDialog draw the same default dialog', async () => {
  for (const v5 of [true, false]) {
    const plain = { ItemActions: [workflow(FIRST, {})] };
    assert.equal(workflowDialog(await render({}, { v5 })), DEFAULT_DIALOG[v5 ? 'bs5' : 'bs3']);
    assert.equal(workflowDialog(await render(plain, { v5 })), DEFAULT_DIALOG[v5 ? 'bs5' : 'bs3']);
    assert.equal(
      workflowDialog(await render({ ...plain, WorkflowDialog: emptyDialog }, { v5 })),
      DEFAULT_DIALOG[v5 ? 'bs5' : 'bs3'],
    );
  }
});
