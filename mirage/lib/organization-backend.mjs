import { runPluginPhase, pluginStepMatchesEntity, pluginPhaseRequiresCheckpoint } from './exported-plugins.mjs';
import { prepareClrRuntime, closeClrHostPool } from './plugin-clr.mjs';
import { createAsyncPluginRunner } from './plugin-async.mjs';
import { createFlowTriggerRunner } from './flow-triggers.mjs';
import { settleCommittedWork, committedJobs } from './committed-work.mjs';
import { storeScheduler } from './runtime-clock.mjs';
import { serviceEndpointDelivery } from './dataverse-webhooks.mjs';

/** The same source/trusted-handler backend runs for portal and standalone hosts.
 * Callers own the source catalogue and execution choices; no portal or HTTP
 * listener is needed to install synchronous and committed-event processing. */
export async function createOrganizationBackend({ store, items = () => [], handlers = new Map(), runtimes = new Map(), descriptors = new Map(),
  operations = () => [], workflows = () => new Map(), identities = () => ({}), diagnostic = () => {}, systemJobs = () => true, scheduler = null,
  connectors = null, secrets = null, messaging = null }) {
  // The store's one scheduler (runtime-clock.mjs) runs the durable committed-event jobs and the dataverse-async jobs. The
  // backend owns its lifecycle (close() closes it), so a backend over a store whose previous backend closed opens a live
  // scheduler again, and a closed committed-job runner is dropped so committedJobs(store) builds a new one.
  storeScheduler(store, scheduler, { reopen: true });
  if (store.committedJobs?.closed) store.committedJobs = null;
  // messaging: a getter of providers.messaging; queue and topic endpoints (contracts 2, 5, 6) deliver through its bus.
  const webhooks = serviceEndpointDelivery(store, { messaging: messaging ?? null }), acceptedChains = new Set();
  store.setPluginPipeline(context => runPluginPhase({ ...context, store, runtimes, items: items(), handlers, webhooks, diagnostic }),
    ({ entity, operation }) => items().some(step => step.enabled && pluginStepMatchesEntity(step, entity)
      && String(step.message).toLowerCase() === operation && (!['retrieve', 'retrievemultiple'].includes(operation) || !['placeholder', 'disabled'].includes(step.mode))),
    context => pluginPhaseRequiresCheckpoint(items(), context));
  for (const item of items().filter(item => item.mode === 'clr')) try {
    if (!item.clrAvailable) throw new Error('No exact trusted descriptor');
    runtimes.set(item.id, await prepareClrRuntime(descriptors.get(item.id)));
  } catch (error) { diagnostic({ code: 'PLUGIN_CLR_PREPARATION_FAILED', stepId: item.id, message: error.message }); }
  // Row-triggered flows reach connector actions through the host's connector runtime (organization-host.mjs).
  const triggerRunner = createFlowTriggerRunner({ store, items: operations, workflows, identities, diagnostic, acceptedChains, connectors, secrets });
  const asyncPluginRunner = createAsyncPluginRunner({ store, items, handlers, runtimes, webhooks, diagnostic, acceptedChains, systemJobs });
  // Ready jobs saved before a restart run once the organization exists (createOrganizationRuntime resumes them too).
  const resume = () => committedJobs(store).resume();
  if (systemJobs()) resume();
  let closed;
  return { webhooks, triggerRunner, asyncPluginRunner, resume, get scheduler() { return store.scheduler; },
    settle: () => settleCommittedWork(store, [triggerRunner, asyncPluginRunner]),
    close: () => closed ??= (async () => {
      await settleCommittedWork(store, [triggerRunner, asyncPluginRunner], { close: true });
      for (const runtime of runtimes.values()) await closeClrHostPool({ runtime, diagnostic });
    })() };
}
