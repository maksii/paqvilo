// Shared setup of the invented classic list workflow fixtures (Node and browser tests).
import { createSimulator } from '../../server.mjs';

/**
 * Seeds published, on-demand, real-time classic workflows on contoso_widget and the Widgets list schema, then starts a
 * simulator over `dir` with the trusted handler pack `pack`. `otherTable` names workflows of the same kind on contact;
 * `observed` is the site's observed behaviour (lib/project-config.mjs observedConfig).
 */
export function startListWorkflowSimulator({ dir, state, workflowIds, pack, otherTable = [], observed = null }) {
  state.tables.workflow = [...workflowIds, ...otherTable].map((workflowid) => ({
    workflowid,
    name: 'Invented list workflow',
    category: 0,
    type: 1,
    mode: 1,
    ondemand: true,
    primaryentity: otherTable.includes(workflowid) ? 'contact' : 'contoso_widget',
    statecode: 1,
    statuscode: 2,
  }));
  state.simulator = {
    componentSchemas: { Widgets: { entity: 'contoso_widget', fields: [{ name: 'name', label: 'Widget' }] } },
    ...(observed ? { observed } : {}),
  };
  return createSimulator({
    sourceDir: dir,
    projectRoot: dir,
    watch: false,
    port: 0,
    initial: state,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    dataPacks: [{ module: pack }],
  });
}
