// Shared setup of the invented classic list workflow fixtures (Node and browser tests).
import { createSimulator } from '../../server.mjs';

/**
 * Seeds published, on-demand, real-time classic workflows on contoso_widget and the Widgets list schema, then starts a
 * simulator over `dir` with the trusted handler pack `pack`.
 */
export function startListWorkflowSimulator({ dir, state, workflowIds, pack }) {
  state.tables.workflow = workflowIds.map((workflowid) => ({
    workflowid,
    name: 'Invented list workflow',
    category: 0,
    type: 1,
    mode: 1,
    ondemand: true,
    primaryentity: 'contoso_widget',
    statecode: 1,
    statuscode: 2,
  }));
  state.simulator = {
    componentSchemas: { Widgets: { entity: 'contoso_widget', fields: [{ name: 'name', label: 'Widget' }] } },
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
