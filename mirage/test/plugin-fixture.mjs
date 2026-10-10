import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';

export const pluginId = n => `d5100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const assemblyXml = `<PluginAssembly PluginAssemblyId="{${pluginId(1)}}"><Name>Invented.WidgetRules</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><PluginTypes><PluginType PluginTypeId="{${pluginId(2)}}"><TypeName>Invented.WidgetRules.Validate</TypeName></PluginType></PluginTypes></PluginAssembly>`;
export function stepXml(n, { message = 'Create', entity = 'fx_widget', stage = 10, rank = 1, mode = 0, attributes = '', enabled = true } = {}) {
  return `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${pluginId(n)}}"><Name>Widget step ${n}</Name><PluginTypeId>${pluginId(2)}</PluginTypeId><SdkMessageName>${message}</SdkMessageName><PrimaryEntity>${entity}</PrimaryEntity><Stage>${stage}</Stage><Rank>${rank}</Rank><Mode>${mode}</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>${enabled ? 0 : 1}</StateCode><FilteringAttributes>${attributes}</FilteringAttributes></SdkMessageProcessingStep>`;
}
export const pluginStepsXml = [stepXml(3), stepXml(4, { stage: 20, rank: 2 }), stepXml(5, { stage: 20, rank: 1 }), stepXml(6, { stage: 40 }), stepXml(7, { message: 'Update', attributes: 'fx_title' }), stepXml(8, { message: 'Update', stage: 20, attributes: 'fx_title' }), stepXml(9, { message: 'Update', stage: 40, mode: 1 }), stepXml(10, { enabled: false }), stepXml(11, { entity: 'fx_other' })];
export async function pluginFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-plugins-'));
  const portal = path.join(dir, 'portal'), solution = path.join(dir, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: fixture\nadx_name: Widget plugin fixture',
    'portal/Editor.webrole.yml': 'adx_webroleid: editor-role\nadx_name: Editor',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    'portal/Home.webpage.copy.html': '<p>Invented plugin fixture</p>',
    'portal/Webapi-enabled.sitesetting.yml': 'adx_sitesettingid: api-enabled\nadx_name: Webapi/fx_widget/enabled\nadx_value: true',
    'portal/Webapi-fields.sitesetting.yml': 'adx_sitesettingid: api-fields\nadx_name: Webapi/fx_widget/fields\nadx_value: fx_widgetid,fx_title,fx_note',
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedPlugins</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/PluginAssemblies/Invented.WidgetRules/Invented.WidgetRules.xml': assemblyXml,
    ...Object.fromEntries(pluginStepsXml.map((xml, index) => [`solution/SdkMessageProcessingSteps/${pluginId(index + 3)}.xml`, xml])),
  };
  for (const [name, body] of Object.entries(files)) { const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); }
  const app = await createSimulator({ sourceDir: portal, solutionRoots: [solution], stateFile: path.join(dir, 'state.json'), watch: false, initial: {
    version: 1, mappings: { fx_widget: { entitySet: 'fx_widgets', idColumn: 'fx_widgetid' } }, tables: { fx_widget: [] }, plugins: [],
    permissions: [{ entity: 'fx_widget', scope: 'global', operations: ['read', 'create', 'update', 'delete'], roles: ['Editor'] }], settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', identityScope: 'configured', identity: { id: 'editor', roles: ['Editor'] }, live: {}, endpoints: [] },
  } });
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, portal, solution, app };
}
