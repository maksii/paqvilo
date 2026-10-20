import { runPluginPhase, pluginStepMatchesEntity, pluginPhaseRequiresCheckpoint } from './exported-plugins.mjs';
import { prepareClrRuntime, closeClrHostPool } from './plugin-clr.mjs';
import { createAsyncPluginRunner } from './plugin-async.mjs';
import { createFlowTriggerRunner } from './flow-triggers.mjs';
import { settleCommittedWork } from './committed-work.mjs';
import { webhookDelivery } from './dataverse-webhooks.mjs';

/** The same source/trusted-handler backend runs for portal and standalone hosts.
 * Callers own the source catalogue and execution choices; no portal or HTTP
 * listener is needed to install synchronous and committed-event processing. */
export async function createOrganizationBackend({ store, items = () => [], handlers = new Map(), runtimes = new Map(), descriptors = new Map(),
  operations = () => [], workflows = () => new Map(), identities = () => ({}), diagnostic = () => {}, systemJobs = () => true }) {
  const webhooks = webhookDelivery(store), acceptedChains = new Set();
  store.setPluginPipeline(context => runPluginPhase({ ...context, store, runtimes, items: items(), handlers, webhooks, diagnostic }),
    ({ entity, operation }) => items().some(step => step.enabled && pluginStepMatchesEntity(step, entity)
      && String(step.message).toLowerCase() === operation && (!['retrieve', 'retrievemultiple'].includes(operation) || !['placeholder', 'disabled'].includes(step.mode))),
    context => pluginPhaseRequiresCheckpoint(items(), context));
  for (const item of items().filter(item => item.mode === 'clr')) try {
    if (!item.clrAvailable) throw new Error('No exact trusted descriptor');
    runtimes.set(item.id, await prepareClrRuntime(descriptors.get(item.id)));
  } catch (error) { diagnostic({ code: 'PLUGIN_CLR_PREPARATION_FAILED', stepId: item.id, message: error.message }); }
  const triggerRunner = createFlowTriggerRunner({ store, items: operations, workflows, identities, diagnostic, acceptedChains });
  const asyncPluginRunner = createAsyncPluginRunner({ store, items, handlers, runtimes, webhooks, diagnostic, acceptedChains, systemJobs });
  let closed;
  return { webhooks, triggerRunner, asyncPluginRunner,
    settle: () => settleCommittedWork(store, [triggerRunner, asyncPluginRunner]),
    close: () => closed ??= (async () => {
      await settleCommittedWork(store, [triggerRunner, asyncPluginRunner], { close: true });
      for (const runtime of runtimes.values()) await closeClrHostPool({ runtime, diagnostic });
    })() };
}
