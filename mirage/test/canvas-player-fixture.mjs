import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { createSimulator } from '../api.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const control = (name, type, properties, children = []) => ({
  [name]: { Control: type, Properties: properties, ...(children.length ? { Children: children } : {}) },
});
export const files = {
  'Src/App.pa.yaml': stringify({
    App: {
      Properties: {
        OnStart:
          '=Set(initialWidth, App.Width); Set(greeting, "Hello"); ClearCollect(choices, {name: "Alpha"}, {name: "Beta"})',
        StartScreen: '=HomeScreen',
      },
    },
  }),
  'Src/HomeScreen.pa.yaml': stringify({
    Screens: {
      HomeScreen: {
        Children: [
          control('Greeting', 'Label@2.5.1', {
            Text: '=greeting & " " & SearchBox.Text',
            X: '=20',
            Y: '=20',
            Width: '=300',
            Height: '=40',
          }),
          control('SearchBox', 'Classic/TextInput@2.3.2', {
            Default: '=""',
            X: '=20',
            Y: '=70',
            Width: '=200',
            Height: '=40',
          }),
          control('Check', 'Classic/CheckBox@2.1.0', {
            Text: '="Check"',
            Default: '=false',
            X: '=20',
            Y: '=120',
            Width: '=120',
            Height: '=40',
          }),
          control('Switch', 'Classic/Toggle@2.1.0', {
            Default: '=false',
            X: '=160',
            Y: '=120',
            Width: '=120',
            Height: '=40',
          }),
          control('Choice', 'Classic/DropDown@2.3.1', {
            Items: '=choices',
            X: '=20',
            Y: '=170',
            Width: '=200',
            Height: '=40',
          }),
          control('DateChoice', 'Classic/DatePicker@2.6.0', {
            DefaultDate: '=Date(2000, 1, 2)',
            X: '=240',
            Y: '=170',
            Width: '=140',
            Height: '=40',
          }),
          control(
            'List',
            'Gallery@2.15.0',
            {
              Items: '=Filter(choices, StartsWith(name, SearchBox.Text))',
              X: '=20',
              Y: '=220',
              Width: '=300',
              Height: '=120',
              TemplateSize: '=50',
            },
            [
              control('ItemName', 'Label@2.5.1', {
                Text: '=ThisItem.name',
                X: '=0',
                Y: '=0',
                Width: '=100',
                Height: '=40',
              }),
              control('OpenItem', 'Classic/Button@2.2.0', {
                Text: '="Open"',
                OnSelect:
                  '=UpdateContext({visited: true}); Navigate(DetailScreen, ScreenTransition.None, {selectedName: ThisItem.name})',
                X: '=110',
                Y: '=0',
                Width: '=80',
                Height: '=40',
              }),
            ],
          ),
          control('Next', 'Classic/Button@2.2.0', {
            Text: '="Next"',
            OnSelect: '=UpdateContext({visited: true}); Navigate(DetailScreen)',
            X: '=20',
            Y: '=350',
            Width: '=120',
            Height: '=40',
          }),
          control('VisitStatus', 'Label@2.5.1', {
            Text: '=If(visited, "visited", "new")',
            X: '=20',
            Y: '=450',
            Width: '=100',
            Height: '=30',
          }),
          control('Hidden', 'Label@2.5.1', { Text: '="hidden"', Visible: '=false' }),
          control('Disabled', 'Classic/Button@2.2.0', {
            Text: '="Disabled"',
            DisplayMode: '=DisplayMode.Disabled',
            X: '=150',
            Y: '=450',
            Width: '=100',
            Height: '=30',
          }),
          control(
            'Stack',
            'GroupContainer@1.0.0',
            {
              X: '=20',
              Y: '=500',
              Width: '=Parent.Width / 2',
              Height: '=100',
              LayoutDirection: '=LayoutDirection.Vertical',
            },
            [
              control('First', 'Label@2.5.1', { Text: '="First"', Width: '=Parent.Width / 2', Height: '=30' }),
              control('Second', 'Label@2.5.1', { Text: '="Second"', Width: '=Parent.Width / 2', Height: '=30' }),
            ],
          ),
          control(
            'Row',
            'GroupContainer@1.0.0',
            { X: '=20', Y: '=610', Width: '=300', Height: '=50', LayoutDirection: '=LayoutDirection.Horizontal' },
            [
              control('Left', 'Label@2.5.1', { Text: '="Left"', Width: '=100', Height: '=30' }),
              control('Right', 'Label@2.5.1', { Text: '="Right"', Width: '=100', Height: '=30' }),
            ],
          ),
          control('UnsafeText', 'Label@2.5.1', {
            Text: '="<img src=x onerror=window.canvasInjected=1>"',
            X: '=App.Width - 220',
            Y: '=400',
            Width: '=200',
            Height: '=40',
          }),
        ],
      },
    },
  }),
  'Src/DetailScreen.pa.yaml': stringify({
    Screens: {
      DetailScreen: {
        Children: [
          control('Detail', 'Label@2.5.1', { Text: '=selectedName', X: '=20', Y: '=20', Width: '=200', Height: '=40' }),
          control('Return', 'Classic/Button@2.2.0', {
            Text: '="Back"',
            OnSelect: '=Back()',
            X: '=20',
            Y: '=70',
            Width: '=120',
            Height: '=40',
          }),
        ],
      },
    },
  }),
};

export function canvasLocalIdentity() {
  return {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
    tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }] },
    permissions: [],
    simulator: {
      mode: 'local',
      pageMode: 'local',
      permissionSource: 'configured',
      live: { allowWrites: false },
      endpoints: [],
    },
  };
}

/** Invented app through the same configured source path as project exports. */
export async function canvasPlayerFixture(t, format, { gaps = false, watch = false } = {}) {
  const sources = { ...files };
  if (gaps) {
    sources['Src/Broken.pa.yaml'] = 'Screens: [';
    const home = (await import('yaml')).parse(sources['Src/HomeScreen.pa.yaml']);
    home.Screens.HomeScreen.Children.push(
      control('Unsupported', 'PieChart@1.0.0', { X: '=350', Y: '=20', Width: '=100', Height: '=100' }),
    );
    sources['Src/HomeScreen.pa.yaml'] = stringify(home);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-player-'));
  const cleanup = ownedFixture(t);
  cleanup.remove(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, body) => {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  };
  await write(
    'portal/website.yml',
    'adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: 1\n',
  );
  await write('portal/web-pages/home/Home.webpage.yml', 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n');
  if (format === 'archive') {
    await write(
      'Invented.msapp',
      writeSolutionAssetEntries(Object.entries(sources).map(([name, body]) => ({ name, data: Buffer.from(body) }))),
    );
  } else {
    for (const [name, body] of Object.entries(sources)) await write(`apps/invented/${name}`, body);
  }
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    stateFile: path.join(root, watch ? '.paqvilo/state.json' : 'state.json'),
    projectRoot: root,
    port: 0,
    watch,
    canvas: { sources: [format === 'archive' ? 'Invented.msapp' : 'apps/invented'] },
    initial: canvasLocalIdentity(),
  });
  cleanup.add(() => sim.close());
  return Object.assign(sim, { fixtureRoot: root });
}
