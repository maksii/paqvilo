// Canvas app and organization for the canvas runtime tests: pa.yaml sources written with the yaml package (so
// formulas stay literal), an organization-owned fx_widget table (display name 'Widget Name' on fx_name) and two staff
// users: a System Administrator and a Basic User, who reads fx_widget but may not create rows.
import { stringify } from 'yaml';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { readCanvasSource, canvasInventoryRecord } from '../lib/canvas-source.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const ADMIN_OID = '77777777-7777-4777-8777-7777777777a1',
  BASIC_OID = '77777777-7777-4777-8777-7777777777a2';

export async function organization(t, { rows = null } = {}) {
  const state = emptyState();
  state.mappings.fx_widget = {
    logicalName: 'fx_widget',
    entitySet: 'fx_widgets',
    idColumn: 'fx_widgetid',
    nameColumn: 'fx_name',
    ownership: 'OrganizationOwned',
    fields: { fx_name: { dataverseType: 'nvarchar', displayName: 'Widget Name' } },
  };
  state.tables.fx_widget = rows ?? [
    { fx_widgetid: '77777777-7777-4777-8777-777777777701', fx_name: 'Alpha' },
    { fx_widgetid: '77777777-7777-4777-8777-777777777702', fx_name: 'Beta' },
  ];
  const store = await new DataStore({ state }).init();
  const runtime = await createOrganizationRuntime({
    store,
    providers: {},
    diagnostic: () => {},
    settings: dataverseSettings({
      enabled: true,
      users: [
        { objectId: ADMIN_OID, domainname: 'admin@example.test', fullname: 'Admin', roles: ['System Administrator'] },
        { objectId: BASIC_OID, domainname: 'basic@example.test', fullname: 'Basic', roles: ['Basic User'] },
      ],
    }),
  });
  t.after(() => runtime.close());
  const id = (oid) => runtime.principals.resolve({ oid }).user.systemuserid;
  return {
    store,
    runtime,
    api: runtime.api,
    admin: { kind: 'staff', principalId: id(ADMIN_OID) },
    basic: { kind: 'staff', principalId: id(BASIC_OID) },
    caller: (principal) => {
      const user = runtime.principals.byId(principal?.principalId);
      return user ? { user } : null;
    },
  };
}
export const msappOf = (files) =>
  writeSolutionAssetEntries(Object.entries(files).map(([name, body]) => ({ name, data: Buffer.from(body) })));
/** The app entry canvas-http.mjs serves ({ uniqueName, source with tree }) and its inventory record. */
export async function fixtureApp(files = CANVAS_APP_FILES) {
  const source = await readCanvasSource({ msapp: msappOf(files), name: 'fx_inventedcanvas' });
  const record = canvasInventoryRecord(source);
  return { uniqueName: 'fx_inventedcanvas', source: { ...source, tree: record.tree }, record };
}

const control = (name, type, properties = {}, children = [], extra = {}) => ({
  [name]: { Control: type, ...extra, Properties: properties, ...(children.length ? { Children: children } : {}) },
});

export const CANVAS_APP_FILES = {
  'Src/App.pa.yaml': stringify({
    App: { Properties: { OnStart: '=Set(fxGreeting, "Hello")', StartScreen: '=HomeScreen' } },
    DataSources: { Widgets: { Type: 'Table', Parameters: { TableLogicalName: 'fx_widget' } } },
  }),
  'Src/HomeScreen.pa.yaml': stringify({
    Screens: {
      HomeScreen: {
        Properties: { OnVisible: '=UpdateContext({fxVisits: fxVisits + 1})', OnHidden: '=Set(fxHomeHidden, true)' },
        Children: [
          control('GreetingLabel', 'Label@2.5.1', { Text: '=fxGreeting' }),
          control('SearchBox', 'Classic/TextInput@2.3.2', { Default: '=""' }),
          control(
            'WidgetGallery',
            'Gallery@2.15.0',
            { Items: '=Filter(Widgets, StartsWith(fx_name, SearchBox.Text))' },
            [
              control('WidgetTitle', 'Label@2.5.1', { Text: "=ThisItem.'Widget Name'" }),
              control('OpenButton', 'Classic/Button@2.2.0', {
                OnSelect: '=Navigate(DetailScreen, ScreenTransition.None, {fxWidget: ThisItem})',
              }),
            ],
            { Variant: 'Vertical' },
          ),
          control('LongNames', 'Gallery@2.15.0', { Items: '=Filter(Widgets, Len(fx_name) > 4)' }, [], {
            Variant: 'Vertical',
          }),
          control('AddButton', 'Classic/Button@2.2.0', {
            OnSelect:
              '=Patch(Widgets, Defaults(Widgets), {fx_name: SearchBox.Text}); Notify("Saved", NotificationType.Success)',
          }),
          control('NestedButton', 'Classic/Button@2.2.0', {
            OnSelect:
              "=If(!IsBlank(SearchBox.Text), Set(fxCreated, Patch(Widgets, Defaults(Widgets), {'Widget Name': SearchBox.Text})))",
          }),
          control('Chart1', 'PieChart@1.0.0', { Items: '=Widgets' }),
        ],
      },
    },
  }),
  'Src/DetailScreen.pa.yaml': stringify({
    Screens: {
      DetailScreen: {
        Properties: { OnVisible: '=Set(fxDetailShown, true)' },
        Children: [
          control('TitleLabel', 'Label@2.5.1', { Text: '=fxWidget.fx_name' }),
          control('BackButton', 'Classic/Button@2.2.0', { OnSelect: '=Back()' }),
          control(
            'EditForm1',
            'Form@2.4.4',
            {
              DataSource: '=Widgets',
              Item: '=fxWidget',
              OnSuccess: '=Notify("Form saved", NotificationType.Success)',
              OnFailure: '=Notify(EditForm1.Error, NotificationType.Error)',
            },
            [
              control(
                'NameCard',
                'TypedDataCard@1.0.7',
                { DataField: '="fx_name"', Default: '=ThisItem.fx_name', Update: '=NameInput.Text', Required: '=true' },
                [control('NameInput', 'Classic/TextInput@2.3.2', { Default: '=Parent.Default' })],
                { Variant: 'ClassicTextualEdit' },
              ),
            ],
          ),
          control('SaveButton', 'Classic/Button@2.2.0', { OnSelect: '=SubmitForm(EditForm1)' }),
          control('NewButton', 'Classic/Button@2.2.0', { OnSelect: '=NewForm(EditForm1)' }),
          control('CycleA', 'Label@2.5.1', { Text: '=CycleB.Text' }),
          control('CycleB', 'Label@2.5.1', { Text: '=CycleA.Text' }),
        ],
      },
    },
  }),
};
