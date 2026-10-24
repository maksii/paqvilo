import path from 'node:path';
import {
  modelDrivenOrigin,
  readModelDrivenResourceMap,
  createModelDrivenOverlay,
  modelDrivenResourcePath,
} from './model-driven.mjs';

function localPath(value, origin) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
    /[\\\x00-\x20]/.test(value) ||
    new URL(value, origin).origin !== origin
  )
    throw new Error('A model-driven start path must stay on its declared origin.');
  return value;
}

/** Only explicit modelDriven.targets opt cross-product references into this runner. */
export function modelDrivenTargets(project, args = {}) {
  if (args.env && args.url) throw new Error('Choose --env or --url, not both.');
  const targets = (project.modelDriven?.targets ?? []).map((target) => {
    const reference = project.references.find((item) => item.id === target.reference);
    if (!reference) throw new Error(`Unknown model-driven reference '${target.reference}'.`);
    const origin = modelDrivenOrigin(reference.origin);
    return {
      id: reference.id,
      origin,
      siteName: reference.name ?? reference.id,
      envName: reference.environment ?? reference.id,
      startPath: localPath(target.startPath, origin),
      mapFile: target.resourceMap ?? null,
      caution: target.caution === true,
    };
  });
  let selected;
  if (args.env) {
    selected = targets.find((target) => target.id === args.env);
    if (!selected) throw new Error('--env must select an explicitly declared modelDriven.targets reference.');
  } else if (args.url) {
    const origin = modelDrivenOrigin(args.url);
    selected = targets.find((target) => target.origin === origin);
    if (!selected) {
      selected = {
        id: 'explicit-url',
        origin,
        siteName: path.basename(project.configFile),
        envName: 'explicit URL',
        startPath: '/main.aspx',
        mapFile: null,
        caution: false,
      };
      targets.push(selected);
    }
  } else {
    selected =
      targets.find((target) => target.id === project.defaultReference?.id) ??
      (targets.length === 1 ? targets[0] : null);
    if (!selected)
      throw new Error('Select --env, provide --url, or mark a declared model-driven reference as default.');
  }
  if (args.path !== undefined) selected.startPath = localPath(args.path, selected.origin);
  if (args['resource-map'] !== undefined) selected.mapFile = path.resolve(args['resource-map']);
  if (new Set(targets.map((target) => target.origin)).size !== targets.length)
    throw new Error('Model-driven targets require distinct origins.');
  return { targets, selected };
}

/** All map validation completes before publishing any target revision. */
export async function readTargetMappings(targets, imported) {
  const result = new Map();
  for (const target of targets) {
    const mappings = await readModelDrivenResourceMap(target.mapFile, { assets: imported.assets });
    const names = new Set([...imported.assets.values()].map((asset) => asset.name));
    const routes = new Map();
    for (const { path: route, resource } of [
      ...imported.resources.map((item) => ({ path: `/WebResources/${item.name}`, resource: item.name })),
      ...mappings,
    ]) {
      if (!names.has(resource)) throw new Error(`Resource map selects an undeclared Solution resource: ${resource}`);
      const key = modelDrivenResourcePath(route);
      if (routes.has(key) && routes.get(key) !== resource)
        throw new Error(`Multiple Solution resources map to ${key}.`);
      routes.set(key, resource);
    }
    result.set(target.id, mappings);
  }
  return result;
}

/** One owned page, one active identity/bridge/agent; source baselines remain per target. */
export function modelDrivenTargetSessions({
  targets,
  initial,
  imported,
  mappings,
  createInspector,
  ownsRequest,
  onApplied,
  liveReload = true,
}) {
  const sessions = new Map();
  let selected = initial,
    active,
    pending = Promise.resolve(),
    stopped = false,
    retirementFailure,
    activationFailure;
  const enqueue = (task) => {
    const next = pending.then(task);
    pending = next.catch(() => {});
    return next;
  };
  const retire = async () => {
    if (!active?.inspector) return;
    const inspector = active.inspector;
    active.saved = inspector.persistentState();
    active.saved.panelSources?.clearNative();
    active.inspector = null;
    try {
      await inspector.close();
    } catch (error) {
      retirementFailure = error;
      throw error;
    }
  };
  const ensure = (target) => {
    let session = sessions.get(target.id);
    if (!session) {
      session = { target, live: liveReload, saved: null, inspector: null };
      session.overlay = createModelDrivenOverlay({
        origin: target.origin,
        imported,
        mappings: mappings.get(target.id),
        ownsRequest,
        onApplied: (event) => {
          onApplied?.(event);
          session.inspector?.refresh();
        },
      });
      sessions.set(target.id, session);
    }
    return session;
  };
  return {
    activate(origin) {
      return enqueue(async () => {
        if (stopped) throw new Error('The model-driven target session has stopped.');
        if (retirementFailure || activationFailure) throw retirementFailure ?? activationFailure;
        const target = targets.find((item) => item.origin === origin);
        if (!target) throw new Error('The model-driven target is not declared.');
        if (active?.target.id === target.id && active.inspector) return active;
        await retire();
        selected = target;
        active = ensure(target);
        try {
          active.inspector = await createInspector(active, imported);
        } catch (error) {
          activationFailure = error;
          throw error;
        }
        return active;
      });
    },
    suspend() {
      return enqueue(retire);
    },
    async ready() {
      await pending;
      if (retirementFailure || activationFailure) throw retirementFailure ?? activationFailure;
      return active;
    },
    current() {
      return active;
    },
    selected() {
      return selected;
    },
    async replace(next, nextMappings) {
      await enqueue(async () => {
        if (stopped) return;
        for (const session of sessions.values()) session.overlay.replace(next, nextMappings.get(session.target.id));
        imported = next;
        mappings = nextMappings;
        active?.inspector?.refresh(next);
      });
    },
    report() {
      const current = active ?? ensure(selected);
      return {
        ...current.overlay.report(),
        selectedTarget: selected.id,
        targets: targets.map((target) => ({
          id: target.id,
          origin: target.origin,
          activated: sessions.has(target.id),
          ...(sessions.has(target.id) ? { applied: sessions.get(target.id).overlay.report().applied } : {}),
        })),
      };
    },
    async close() {
      stopped = true;
      await enqueue(retire);
    },
  };
}
