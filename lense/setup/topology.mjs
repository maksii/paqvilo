// Planned topology for /_setup/: the dashboard node/edge shape (`/_sim/api/dashboard`, same node ids) derived
// from configuration alone. Configured pieces are `planned`; pieces the configuration turns off are `disabled`.
// Nothing here starts, probes or reads a service; there is no activity.
import path from 'node:path';

const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Resolved Mirage settings per runtime target of a setup snapshot (catalogue sites, or the project). */
function targets(snapshot) {
  if (snapshot.kind === 'project') {
    const settings = snapshot.settings ?? {};
    return [{ id: settings.defaultSite ?? 'project', kind: settings.runtime?.kind ?? 'power-pages', mirage: { ...(settings.mirage ?? {}), dataverse: settings.dataverse, simulation: settings.simulation },
      solutions: (snapshot.solutions ?? []).length, packs: snapshot.packs ?? [], portals: (snapshot.sites ?? []).length,
      roots: (snapshot.solutions ?? []).map(item => item.path), keys: Object.keys(settings.mirage ?? {}) }];
  }
  return (snapshot.sites ?? []).map(site => ({ id: site.id, kind: site.runtime?.kind ?? 'power-pages', mirage: site.effectiveMirage ?? site.mirage ?? {},
    solutions: (site.solutions ?? []).length, packs: site.packs ?? [], portals: 1,
    roots: (site.solutions ?? []).map(item => item.path), keys: [...Object.keys(site.mirage ?? {}).filter(key => site.mirage[key] != null),
      ...['source', 'defaultEnv', 'startPath', 'scope', 'routes', 'environments'].filter(key => site[key] != null && site[key] !== '' && !(plain(site[key]) && !Object.keys(site[key]).length))] }));
}

/** Names, labels and ports only: the dashboard configuration summary never carries setting values. */
function configuration(snapshot, list, dataverseOn) {
  const relative = file => (snapshot.directory && path.isAbsolute(file) ? path.relative(snapshot.directory, file).split(path.sep).join('/') || '.' : file);
  const packs = new Map();
  for (const pack of list.flatMap(item => item.packs)) {
    const module = relative(pack.module ?? pack.path);
    packs.set(module, { id: pack.id ?? null, module });
  }
  const target = list.find(item => item.id === snapshot.settings?.defaultSite) ?? list[0];
  const settings = target?.mirage ?? {}, dataverse = settings.dataverse ?? {};
  const port = value => (Number.isInteger(value) ? value : 0);
  const portal = target?.kind === 'power-pages' && snapshot.kind !== 'project' ? port(settings.port) : null;
  const api = target && dataverseOn(target);
  return {
    packs: [...packs.values()],
    solutionLayers: [...new Set(list.flatMap(item => item.roots).filter(Boolean).map(relative))],
    settingsKeys: [...new Set(list.flatMap(item => item.keys))].sort(),
    // The identity provider is served on the portal origin; a project portal port is chosen at start (null).
    ports: { portal, dataverseApi: api ? port(dataverse.port) : null, dataverseTls: api && dataverse.tls === true ? port(dataverse.tlsPort) : null,
      tds: api && dataverse.tds?.enabled === true ? port(dataverse.tds.port) : null, identityProvider: target?.kind === 'power-pages' ? portal : null },
  };
}

export function plannedTopology(snapshot = {}) {
  const nodes = new Map(), edges = [];
  const node = (id, label, status, detail = {}) => {
    const existing = nodes.get(id);
    if (existing) { if (status === 'planned') existing.status = 'planned'; Object.assign(existing.detail, detail); return; }
    nodes.set(id, { id, kind: id.split(':')[0], label, status, detail });
  };
  const edge = (from, to, kind, label) => { if (!edges.some(item => item.from === from && item.to === to)) edges.push({ from, to, kind, label }); };
  const list = targets(snapshot);
  const sites = kind => list.filter(item => item.kind === kind).map(item => item.id);
  const portals = list.filter(item => item.kind === 'power-pages' && item.portals);
  const modelDriven = list.filter(item => item.kind === 'model-driven' || (item.kind === 'power-pages' && item.solutions));
  const dataverseOn = item => item.mirage.dataverse?.enabled === true || (item.mirage.dataverse?.enabled === undefined && item.kind === 'dataverse-api');
  const api = list.filter(dataverseOn);

  node('host:setup', 'Setup', 'planned'); node('host:admin', 'Administration', 'planned');
  node('client:browser', 'Browser', 'planned'); edge('client:browser', 'host:setup', 'http', 'configure'); edge('client:browser', 'host:admin', 'http', 'administer');
  if (snapshot.kind !== 'project') { node('client:lense', 'Lense', list.length ? 'planned' : 'disabled', { sites: list.map(item => item.id) }); }
  node('host:portal', 'Power Pages portal', portals.length ? 'planned' : 'disabled', { sites: portals.map(item => item.id) });
  edge('client:browser', 'host:portal', 'http', 'pages');
  node('host:identity-provider', 'Local identity provider', portals.length ? 'planned' : 'disabled', { sites: list.filter(item => item.mirage.identityProvider).map(item => item.id) });
  edge('host:portal', 'host:identity-provider', 'http', 'sign-in');
  node('client:staff', 'Staff browser', modelDriven.length ? 'planned' : 'disabled');
  node('host:model-driven', 'Model-driven apps', modelDriven.length ? 'planned' : 'disabled', { sites: modelDriven.map(item => item.id) });
  edge('client:staff', 'host:model-driven', 'http', 'apps');
  node('client:api', 'API client', api.length ? 'planned' : 'disabled');
  node('host:dataverse-api', 'Dataverse API', api.length ? 'planned' : 'disabled', { sites: api.map(item => item.id), applications: api.reduce((sum, item) => sum + (item.mirage.dataverse?.applications?.length ?? 0), 0) });
  edge('client:api', 'host:dataverse-api', 'http', 'Web API');
  const tds = list.filter(item => item.mirage.dataverse?.tds?.enabled === true);
  if (tds.length) { node('host:tds', 'TDS endpoint', 'planned'); edge('client:api', 'host:tds', 'http', 'SQL'); }

  for (const [id, label] of [['org:store', 'Organization store'], ['org:security', 'Security'], ['org:plugins', 'Plug-ins'], ['org:workflows', 'Workflows'], ['org:flows', 'Cloud flows'], ['org:jobs', 'Background jobs']]) node(id, label, list.length ? 'planned' : 'disabled');
  for (const host of ['host:portal', 'host:model-driven', 'host:dataverse-api']) edge(host, 'org:store', 'process', 'records');
  edge('org:store', 'org:security', 'process', 'access'); edge('org:store', 'org:plugins', 'process', 'pipeline');
  edge('org:store', 'org:workflows', 'process', 'pipeline'); edge('org:store', 'org:flows', 'process', 'triggers'); edge('org:flows', 'org:jobs', 'process', 'async');

  for (const item of list) {
    const settings = item.mirage;
    for (const pack of item.packs) {
      const name = pack.id ?? String(pack.module ?? pack.path ?? 'pack').split(/[\\/]/).pop().replace(/\.[cm]?js$/i, '');
      const id = `org:pack:${name}`;
      node(id, `Pack ${name}`, pack.exists === false ? 'missing' : 'planned', { module: pack.module ?? pack.path });
      edge(id, 'org:store', 'reads', 'data and handlers');
    }
    const providers = settings.providers ?? {};
    if (plain(providers.storage) || plain(providers.routes)) {
      node('provider:storage', 'Storage', 'planned', { providers: Object.keys(providers.storage ?? {}) });
      edge('org:store', 'provider:storage', 'storage', 'files');
      for (const [route, target] of Object.entries(providers.routes ?? {})) {
        node(`provider:storage-route:${route}`, route, 'planned', { target });
        edge('provider:storage', `provider:storage-route:${route}`, 'storage', target);
      }
      if (Object.values(providers.storage ?? {}).some(entry => entry?.kind === 'azurite')) { node('external:azurite', 'Azurite (declared)', 'planned'); edge('provider:storage', 'external:azurite', 'storage', 'blob'); }
    }
    if (plain(providers.messaging)) {
      node('provider:messaging', 'Messaging', 'planned', { providers: Object.keys(providers.messaging).filter(key => key !== 'endpoints') });
      edge('org:plugins', 'provider:messaging', 'bus', 'service endpoints');
      for (const target of Object.values(providers.messaging.endpoints ?? {})) {
        const entity = String(target).split('/').slice(1).join('/');
        node(`provider:messaging-endpoint:${entity}`, entity, 'planned', { target });
        edge('provider:messaging', `provider:messaging-endpoint:${entity}`, 'bus', 'messages');
      }
      if (Object.values(providers.messaging).some(entry => entry?.kind === 'servicebus-emulator')) { node('external:servicebus-emulator', 'Service Bus emulator (AMQP, started outside Paqvilo)', 'planned'); edge('provider:messaging', 'external:servicebus-emulator', 'bus', 'AMQP'); }
    }
    if (plain(providers.outbox)) { node('provider:outbox', 'Outbox', 'planned', { kind: providers.outbox.kind ?? 'local' }); edge('org:store', 'provider:outbox', 'process', 'external effects'); }
    const connections = Object.entries(settings.connections ?? {});
    if (connections.length) {
      node('provider:connectors', 'Connectors', 'planned', { connections: connections.length });
      edge('org:flows', 'provider:connectors', 'process', 'actions');
      for (const [id, entry] of connections) { node(`connection:${id}`, id, 'planned', { provider: entry?.provider ?? null }); edge('provider:connectors', `connection:${id}`, 'process', entry?.provider ?? 'connection'); }
    }
    const secrets = Object.keys(settings.secrets ?? {});
    // Names are counted only; references and values never leave the store.
    if (secrets.length) { node('provider:secrets', 'Secrets', 'planned', { references: secrets.length }); edge('org:store', 'provider:secrets', 'reads', 'references'); }
    for (const [id, entry] of Object.entries(settings.localServices ?? {})) {
      node(`provider:local-service:${id}`, id, 'planned', { kind: entry?.kind ?? null, required: entry?.required === true });
      edge('org:flows', `provider:local-service:${id}`, 'http', 'probe');
    }
    if (settings.canvas) node('app:canvas', 'Canvas apps', settings.canvas.enabled === false ? 'disabled' : 'planned', { sources: settings.canvas.sources?.length ?? 0 });
    if (Array.isArray(settings.codeApps) && settings.codeApps.length) node('app:code', 'Code apps', 'planned', { apps: settings.codeApps.length });
    if (item.kind === 'power-pages') {
      const max = settings.personaContexts?.maxInstances ?? 4;
      node(`persona-runtime:${item.id}`, `Persona contexts (${item.id})`, max > 0 ? 'planned' : 'disabled', { maxInstances: max });
      edge('host:portal', `persona-runtime:${item.id}`, 'process', 'isolated sessions');
    }
  }
  for (const id of ['app:canvas', 'app:code']) if (nodes.has(id)) edge(id, 'host:dataverse-api', 'http', 'data');
  const status = id => nodes.get(id)?.status;
  return { nodes: [...nodes.values()], configuration: configuration(snapshot, list, dataverseOn),
    edges: edges.filter(item => nodes.has(item.from) && nodes.has(item.to))
      .map(item => ({ ...item, status: [status(item.from), status(item.to)].includes('disabled') ? 'disabled' : 'planned' })) };
}
