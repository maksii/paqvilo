import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { importPortal } from '../../lib/importer.mjs';
import { importSolutionMetadata } from '../../lib/solution-metadata.mjs';
import { importSolutionData } from '../../lib/solution-data.mjs';
import { scanSolutionSources, buildSolutionSchema } from '../../lib/solution-schema.mjs';
import { importCodeComponents, renderCodeComponent } from '../../lib/code-components.mjs';
import { renderComponent } from '../../lib/platform.mjs';
import { createPortalRenderer } from '../../lib/liquid.mjs';
import { DataStore } from '../../lib/data.mjs';
import { createWebFormSessions } from '../../lib/form-service.mjs';
import { applyObserved } from '../../lib/redirects.mjs';
import { componentRenderResult } from '../../lib/component-provenance.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/project');

/**
 * The example project with the renderer wiring of mirage/server.mjs (renderComponent, renderCodeComponent), no
 * listener. `renderOverride` replaces the rendering of a component kind, `editPortal` changes the imported portal
 * before anything is built from it, `owner` names the web form session owner.
 */
export async function exampleRuntime({ renderOverride = null, editPortal = null, owner = 'visitor:test' } = {}) {
  const config = YAML.parse(fs.readFileSync(path.join(project, 'paqvilo.config.yml'), 'utf8'));
  const portal = applyObserved(await importPortal(path.join(project, 'portal')), config.sites.example.mirage.observed);
  editPortal?.(portal);
  const roots = ['code-solution', 'metadata', 'solution'].map((root) => path.join(project, root));
  const scan = await scanSolutionSources(roots, { order: 'explicit' });
  const schema = buildSolutionSchema(scan, { lcid: 1033 });
  const codeComponents = await importCodeComponents(scan.layers, { retainBytes: true });
  const metadata = await importSolutionMetadata(roots, { portal, scan, schema });
  const data = await importSolutionData(roots, { scan, schema, lcid: 1033 });
  const fixtures = JSON.parse(fs.readFileSync(path.join(project, 'pack/fixtures.json'), 'utf8'));
  const store = await new DataStore({
    state: {
      mappings: data.mappings,
      relationships: data.relationships,
      tables: Object.fromEntries(Object.entries(fixtures).filter(([table]) => data.mappings[table])),
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const webFormSessions = createWebFormSessions();
  const pcf = (spec) =>
    renderCodeComponent({ portal, catalog: codeComponents, metadata, identity: {}, mappings: data.mappings, ...spec });
  const renderer = createPortalRenderer(portal, {
    metadata,
    codeCatalogue: codeComponents,
    renderComponent: async (kind, args, context) => {
      const components = [],
        explicit = [];
      const provenance = (result) =>
        componentRenderResult(result, {
          components,
          explicit,
          index: renderer.sourceIndex(context?.__language?.id),
          tag: kind,
          args,
        });
      if (renderOverride?.[kind]) return renderOverride[kind]({ args, context, provenance, components, explicit });
      if (kind === 'codecomponent')
        return provenance(pcf({ name: args?.name ?? args?.id, args, onRendered: (item) => explicit.push(item) }));
      const rendered = await renderComponent(
        kind,
        typeof args === 'string' ? args : (args?.name ?? args?.id ?? args?.key ?? ''),
        context,
        {
          portal,
          store,
          readProvider: store,
          args: typeof args === 'string' ? { name: args } : (args ?? {}),
          metadata,
          codeComponent: pcf,
          config: {},
          schemas: metadata.componentSchemas,
          renderLiquid: (source, ctx) => renderer.renderString(source, ctx),
          webFormSessions,
          webFormOwner: () => owner,
          onProgressRendered: (item) => explicit.push(item),
          onComponentRendered: (item) => components.push(item),
        },
      );
      return provenance(rendered);
    },
  });
  return { portal, metadata, renderer };
}
