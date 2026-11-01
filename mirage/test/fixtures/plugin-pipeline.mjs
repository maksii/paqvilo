import { createOrganizationBackend } from '../../lib/organization-backend.mjs';
import { pluginCatalogue } from '../../lib/exported-plugins.mjs';

/** Mount one prepared original assembly for the exact invented registrations. */
export async function attachClrSteps(t, { store, steps, runtime, handlers = new Map(), prepareRuntime }) {
  const runtimes = new Map(
    steps
      .map((step) => [step.id, typeof runtime === 'function' ? runtime(step) : runtime])
      .filter(([, value]) => value),
  );
  const descriptors = new Map([...runtimes].map(([id, value]) => [id, value.descriptor]));
  const items = pluginCatalogue({
    plugins: { steps },
    runtimes,
    descriptors,
    handlers,
    overrides: Object.fromEntries([...runtimes.keys()].map((id) => ['plugin-step:' + id, { mode: 'clr' }])),
  });
  const backend = await createOrganizationBackend({
    store,
    items: () => items,
    runtimes,
    descriptors,
    handlers,
    prepareRuntime,
  });
  t.after(() => backend.close());
  return { backend, items, runtimes, descriptors };
}
