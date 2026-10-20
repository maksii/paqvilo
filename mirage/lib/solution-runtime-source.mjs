import { scanSolutionSources, buildSolutionSchema } from './solution-schema.mjs';
import { importSolutionMetadata } from './solution-metadata.mjs';
import { importSolutionData } from './solution-data.mjs';
import { importOperationWorkflows } from './exported-operations.mjs';
import { importSolutionOperationSources } from './operation-catalogue.mjs';
import { solutionApps } from './model-driven/catalogue.mjs';
import { importModelDrivenResources } from './model-driven-resources.mjs';

/** Load organization sources without creating a portal or reading an unrelated directory. */
export async function loadOrganizationSources({ solutionRoots = [], solutionOrder = 'derived', modelDriven, lcid = 1033, cacheFile } = {}) {
  const scan = await scanSolutionSources(solutionRoots, { order: solutionOrder, cacheFile });
  const schema = buildSolutionSchema(scan, { lcid });
  const [metadata, solutionData, workflows, operations] = await Promise.all([
    importSolutionMetadata(solutionRoots, { scan, schema, lcid }),
    importSolutionData(solutionRoots, { scan, schema, lcid }),
    importOperationWorkflows(scan.layers), importSolutionOperationSources(scan.layers),
  ]);
  metadata.modelDrivenApps = solutionApps(scan, { lcid });
  const clientResources = await importModelDrivenResources(scan.layers, { clientSources: modelDriven?.clientSources });
  metadata.modelDrivenRibbonDocuments = clientResources.ribbonDocuments;
  metadata.modelDrivenAppActions = clientResources.appActions;
  await scan.cache?.save();
  return { scan, schema, metadata, solutionData, workflows, operations, clientResources };
}
