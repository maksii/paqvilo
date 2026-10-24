// Read-only index over the sources the existing loaders already produced (Solution scan, schema, metadata, workflows,
// optional portal). Nothing is re-read or rewritten; consumers ask the graph which source of a component is in effect
// and what a run still requires.
import { createHash } from 'node:crypto';
import { COMPONENT_BY_TYPE } from './solution-inventory.mjs';
import { loadOrganizationSources } from './solution-runtime-source.mjs';
import { pcfAdmission } from './model-driven/pcf-runtime.mjs';
import { customPageResolution, dashboardPage } from './model-driven/solution.mjs';
import { hierarchicalIn, offlineProfileGaps } from './model-driven/offline.mjs';

const SURFACES = { portal: 'portalRendering', 'model-driven': 'staff', canvas: 'canvas' }; // host surface of each hostSurfaceNodes kind
const SECRET_TYPE = 100000005; // environmentvariabledefinition type Secret (secret-resolver.mjs SECRET_TYPE)
const norm = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const canonical = (value) => norm(value).replace(/[{}]/g, '');

/**
 * Build the graph. Node: `{ kind, id: '<kind>:<key>', name, version, layer, solution, source, level, dependencies }`.
 * One precedence rule, applied when nodes are added: the node from the later selected layer wins (equal layers: the
 * later contribution); `variants` counts the contributions. `bindings` are deployment-profile values
 * (`{ connectionReferences: [{ logicalName, connectionId }], environmentVariables: { name: value } }`).
 * A contribution with a canonical `alias` (a component GUID) is also found by `resolve(kind, guid)`; aliases are not part
 * of the node ids or the fingerprint. `clientResources` (model-driven-resources.mjs) adds the PCF controls a host must admit.
 * `mappings`: the effective table mappings (`{ [logical]: mapping }`, the store's on a running host, the boot mappings
 * offline); the model-driven catalogue sees the same tables, so dashboard rows judge lists as its page does. Without
 * them the Solution tables stand in.
 */
export function buildSourceGraph({
  scan,
  metadata = {},
  solutionData = {},
  workflows,
  portal,
  bindings = {},
  clientResources = null,
  mappings = null,
} = {}) {
  const nodes = new Map(),
    aliases = new Map();
  const add = ({
    kind,
    key,
    name = key,
    version = null,
    layer = null,
    solution = null,
    source = null,
    level = 'behaviour',
    dependencies = [],
    alias = null,
    ...extra
  }) => {
    const id = `${kind}:${canonical(key)}`;
    if (alias && canonical(alias) !== canonical(key)) aliases.set(`${kind}:${canonical(alias)}`, id);
    const node = {
      kind,
      id,
      name: String(name ?? key),
      version,
      layer,
      solution,
      source,
      level,
      dependencies,
      ...extra,
    };
    const current = nodes.get(id);
    if (current && (current.layer ?? -1) > (layer ?? -1)) {
      current.variants++;
      return current;
    }
    node.variants = (current?.variants ?? 0) + 1;
    nodes.set(id, node);
    return node;
  };
  const layers = scan?.layers ?? [];
  const layerOf = (index) => layers.find((layer) => layer.index === index);
  for (const layer of layers)
    add({
      kind: 'layer',
      key: layer.name,
      version: layer.solution?.version ?? null,
      layer: layer.index,
      solution: layer.name,
      source: layer.dir,
      format: layer.format ?? 'xml',
    });
  const schema = solutionData.schema ?? {};
  for (const table of Object.values(schema.tables ?? {})) {
    const last = table.layers?.at(-1);
    add({
      kind: 'table',
      key: table.logicalName,
      layer: last?.layer ?? null,
      solution: last?.solution ?? null,
      source: last?.file ?? table.sources?.[0] ?? null,
      level: table.origin === 'solution' ? 'behaviour' : 'contract',
    });
  }
  const localValues = new Map(
    Object.entries(bindings.environmentVariables ?? {}).map(([name, value]) => [norm(name), value]),
  );
  for (const variable of schema.environmentVariables ?? solutionData.environmentVariables ?? [])
    add({
      kind: 'environmentvariable',
      key: variable.schemaName,
      source: variable.source ?? null,
      type: variable.type ?? null,
      required: variable.isRequired !== false,
      hasValue: localValues.has(norm(variable.schemaName)) || variable.value != null || variable.defaultValue != null,
    });
  const bound = new Map(
    (bindings.connectionReferences ?? []).map((reference) => [norm(reference.logicalName), reference]),
  );
  for (const reference of solutionData.connectionReferences ?? schema.connectionReferences ?? []) {
    const layer = layerOf(reference.layer);
    add({
      kind: 'connectionreference',
      key: reference.logicalName,
      layer: reference.layer ?? null,
      solution: layer?.name ?? null,
      source: reference.source ?? null,
      dependencies: reference.connectorId
        ? [{ component: 'connector', name: String(reference.connectorId).split('/').at(-1) }]
        : [],
      bound: Boolean(bound.get(norm(reference.logicalName))?.connectionId),
    });
  }
  for (const [kind, rows] of [
    ['form', metadata.forms],
    ['view', metadata.views],
  ])
    for (const row of rows ?? [])
      add({
        kind,
        key: row.id,
        name: row.name ?? row.id,
        source: row.file ?? null,
        dependencies: row.entity ? [{ component: 'table', name: row.entity }] : [],
      });
  for (const [id, workflow] of workflows ?? [])
    add({
      kind: 'workflow',
      key: id,
      name: workflow.name ?? id,
      source: workflow.file ?? null,
      active: workflow.active !== false,
    });
  // Connection references come from the merged schema above (with their binding); other inventory records are added as listed.
  for (const record of (scan?.inventory ?? []).filter((item) => item.component !== 'connectionreference'))
    add({
      kind: record.component,
      key: record.name,
      alias: record.id,
      name: record.name,
      version: record.version,
      layer: record.layer,
      solution: record.solution,
      source: record.source,
      level: record.level,
      dependencies: record.dependencies,
      reason: record.reason,
      componentType: record.componentType,
      inventory: true,
      sourceMissing: record.sourceMissing === true,
      diagnostics: [...(record.diagnostics ?? []), ...(record.canvas?.diagnostics ?? [])],
    });
  for (const page of portal?.pages ?? [])
    add({ kind: 'webpage', key: page.id, name: page.name ?? page.id, source: page.metadata?._file ?? null });
  hostSurfaceNodes(add, {
    portal,
    metadata,
    clientResources,
    inventory: scan?.inventory ?? [],
    nodes,
    relationships: Object.values(schema.relationships ?? {}),
    tableNames: mappings
      ? Object.keys(mappings)
      : [...Object.keys(schema.tables ?? {}), ...Object.keys(metadata.entities ?? {})],
  });

  const missing = layers.flatMap((layer) =>
    (layer.solution?.missingDependencies ?? []).map((dependency) => ({ layer, ...dependency })),
  );

  const resolve = (kind, key) => {
    const id = `${kind}:${canonical(key)}`;
    return nodes.get(id) ?? nodes.get(aliases.get(id)) ?? null;
  };
  // Loader failures (unreadable root or folder, unsupported input, corrupt archive or XML, YAML not imported or empty): one
  // row each, so strict preflight never passes an empty or partial inventory. Inventory notes are not failures.
  const failures = (scan?.diagnostics ?? []).filter((item) => item.severity === 'error' && !item.inventory);
  const graph = {
    nodes,
    resolve,
    /**
     * What a run of these sources requires, one row per item: `satisfied`, `missing` (unbound connection reference,
     * required environment variable without a value, Solution missing dependency no selected layer provides, inventory
     * dependency that resolves to no node or to an unbound connection reference, root component whose source file is
     * absent), `secret` (a Secret environment variable: `provider: 'secret-resolver'` must resolve it), `placeholder`
     * (a component a placeholder host answers: canvas apps), `unsupported` (other inventory-level components, or an
     * inventory record with an `error` diagnostic, whose code is the reason) or `disabled` (inactive workflows). Loader
     * failures are `solution-source:<hash>` rows (`missing`, or `unsupported` for a YAML file the adapter cannot read) with the
     * diagnostic code as reason; host-surface nodes (hostSurfaceNodes) carry their own status, reason and `level`.
     * A missing dependency resolves by schema name, then by component id (GUID aliases).
     * capability-report.mjs turns these rows into preflight requirements.
     */
    requirements() {
      const rows = failures.map((item) => ({
        id: `solution-source:${createHash('sha256')
          .update(String(item.source ?? item.layer ?? ''))
          .update('\0')
          .update(item.code)
          .digest('hex')
          .slice(0, 12)}`,
        kind: 'solution-source',
        source: item.source ?? null,
        status: item.status ?? 'missing',
        reason: item.code,
      }));
      for (const node of nodes.values()) {
        // A host-surface gap row names its surface (capability-report.mjs scopes it with a scenario naming the surface).
        if (node.requirement) {
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            ...node.requirement,
            surface: SURFACES[node.kind] ?? null,
          });
          continue;
        }
        if (node.kind === 'connectionreference')
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: node.bound ? 'satisfied' : 'missing',
            reason: node.bound ? null : 'SOLUTION_CONNREF_UNBOUND',
          });
        else if (node.kind === 'environmentvariable' && Number(node.type) === SECRET_TYPE)
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: 'secret',
            reason: 'ENVIRONMENT_VARIABLE_SECRET',
            provider: 'secret-resolver',
          });
        else if (node.kind === 'environmentvariable') {
          const missing = !node.hasValue && node.required;
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: missing ? 'missing' : 'satisfied',
            reason: missing ? 'ENVIRONMENT_VARIABLE_NO_VALUE' : null,
          });
        } else if (node.kind === 'workflow' && !node.active)
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: 'disabled',
            reason: 'WORKFLOW_INACTIVE',
          });
        else if (node.sourceMissing)
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: 'missing',
            reason: 'SOLUTION_COMPONENT_SOURCE_MISSING',
          });
        else if (node.diagnostics?.some((item) => item.severity === 'error'))
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: 'unsupported',
            reason: node.diagnostics.find((item) => item.severity === 'error').code,
          });
        // A mobile offline profile is reported by its model-driven:offline/<profile> row (hostSurfaceNodes).
        else if (node.level === 'inventory' && node.kind !== 'mobileofflineprofile')
          rows.push({
            id: node.id,
            kind: node.kind,
            source: node.source,
            status: node.kind === 'canvasapp' ? 'placeholder' : 'unsupported',
            reason: node.reason ?? null,
          });
        // Inventory dependencies; `missing: true` ones come from the Solution manifest and are reported below.
        if (node.inventory)
          for (const dependency of node.dependencies ?? []) {
            if (dependency.missing) continue;
            const target = resolve(dependency.component, dependency.name);
            if (target && (target.kind !== 'connectionreference' || target.bound)) continue;
            rows.push({
              id: `${dependency.component}:${canonical(dependency.name)}`,
              kind: dependency.component,
              source: node.source,
              status: 'missing',
              reason: 'INVENTORY_DEPENDENCY_UNRESOLVED',
              dependent: node.id,
            });
          }
      }
      for (const { layer, required, dependent } of missing) {
        const kind = COMPONENT_BY_TYPE[required.type] ?? `type:${required.type}`;
        const key = required.schemaName ?? required.id ?? '';
        const provided =
          (required.schemaName && resolve(kind, required.schemaName)) ||
          (required.id && resolve(kind, required.id)) ||
          null;
        rows.push({
          id: `${kind}:${canonical(key)}`,
          kind,
          source: layer.manifestFile ?? layer.dir,
          status: provided ? 'satisfied' : 'missing',
          reason: provided ? null : 'SOLUTION_MISSING_DEPENDENCY',
          layer: layer.name,
          ...(dependent ? { dependent: dependent.schemaName ?? dependent.id ?? null } : {}),
        });
      }
      return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    /** The diagnostics that explain requirement rows: loader failures and portal findings that carry a requirement. */
    diagnostics() {
      return [...failures, ...(portal?.diagnostics ?? []).filter((item) => item.requirement)].map((item) =>
        structuredClone(item),
      );
    },
    /** Counts per kind and level: `{ nodes, levels: { level: n }, kinds: { kind: { level: n } } }`. */
    summary() {
      const levels = {},
        kinds = {};
      for (const node of nodes.values()) {
        levels[node.level] = (levels[node.level] ?? 0) + 1;
        const counts = (kinds[node.kind] ??= {});
        counts[node.level] = (counts[node.level] ?? 0) + 1;
      }
      return { nodes: nodes.size, levels, kinds };
    },
    toJSON() {
      return { fingerprint: graph.fingerprint, summary: graph.summary(), nodes: [...nodes.values()] };
    },
  };
  // Identity of what is in effect: ids, layers, versions and levels (never source paths or values).
  const digest = createHash('sha256');
  for (const id of [...nodes.keys()].sort()) {
    const node = nodes.get(id);
    digest.update(JSON.stringify([id, node.layer, node.version, node.level])).update('\n');
  }
  graph.fingerprint = digest.digest('hex');
  return graph;
}

const field = (record, name) => record?.[`adx_${name}`] ?? record?.[`mspp_${name}`] ?? record?.[name] ?? null;
// A Document Locations subgrid on a Solution form (Learn, power-pages/configure/manage-sharepoint-documents).
const DOCUMENT_GRID = /<TargetEntityType>\s*sharepointdocumentlocation\s*<\/TargetEntityType>/i;

/**
 * Canvas apps (canvas-runtime.mjs hosts their logic headlessly): canvas:app/<name> is satisfied when every control is
 * hosted, else unsupported (CANVAS_CONTROL_UNSUPPORTED) naming the controls; canvas:rendering is the documented boundary
 * (apps are never rendered: placeholder at inventory) while there is a canvas app. One rule for Solution inventory apps
 * (hostSurfaceNodes) and project canvas.sources apps (canvasRequirementRows, merged by organization-host.mjs preflight).
 */
function canvasNodes(records = []) {
  const apps = records.filter((record) => record.component === 'canvasapp'),
    nodes = [];
  for (const record of apps.filter((item) => item.level === 'behaviour')) {
    const gaps = (record.unsupported ?? []).map((item) => `${item.screen}.${item.name} (${item.control})`);
    nodes.push({
      kind: 'canvas',
      key: `app/${record.name}`,
      name: record.name,
      level: 'behaviour',
      source: record.source ?? null,
      requirement: gaps.length
        ? {
            status: 'unsupported',
            reason: 'CANVAS_CONTROL_UNSUPPORTED',
            level: 'inventory',
            components: gaps,
            message: `Not hosted by the canvas runtime: ${gaps.join('; ')}.`,
          }
        : { status: 'satisfied', reason: null, level: 'behaviour' },
    });
  }
  if (apps.length)
    nodes.push({
      kind: 'canvas',
      key: 'rendering',
      name: 'Canvas rendering',
      level: 'inventory',
      source: null,
      requirement: {
        status: 'placeholder',
        reason: 'CANVAS_NOT_RENDERED',
        level: 'inventory',
        message: 'Canvas apps run headlessly at /_apps/canvas/<app>; screens are not rendered.',
      },
    });
  return nodes;
}
/** The requirement rows of canvas inventory records outside the Solution scan (project canvas.sources), as graph.requirements() rows. */
export const canvasRequirementRows = (records) =>
  canvasNodes(records).map((node) => ({
    id: `canvas:${canonical(node.key)}`,
    kind: 'canvas',
    source: node.source,
    ...node.requirement,
    surface: SURFACES.canvas,
  }));

/**
 * Requirement nodes for what the Power Pages and model-driven hosts detect in the sources but do not run, each with
 * `requirement: { status, reason, level }`:
 * - portal:enhanced-authorization and portal:modern-list: platform-changes.mjs findings that carry a requirement;
 * - portal:sharepoint-documents: a basic form or advanced form step whose Solution form has a Document Locations subgrid
 *   (the document control renders local markup over the local document service: contract);
 * - model-driven:custom-page/<app>/<subarea>: a SiteMap SubArea that opens a custom page (its canvas app runs in the
 *   headless canvas host: placeholder CANVAS_NOT_RENDERED) when the app has the page as a type-300 component and the
 *   sources hold its canvas app, else unsupported MD_NAV_CUSTOM_PAGE with the reason;
 * - model-driven:pcf/<control>: a virtual (React) code component whose platform libraries the project does not supply;
 *   portal:pcf/<control>: the same control under a portal source (the Power Pages host supplies no platform libraries);
 * - model-driven:offline/<profile>: a mobile offline profile (satisfied when every item's filter is evaluated, else
 *   MD_OFFLINE_FILTER_UNSUPPORTED naming the items), or an app naming a profile the sources do not hold (keyed by the app);
 * - model-driven:dashboard/<app>/<subarea>: a SiteMap SubArea that opens a dashboard: `satisfied` (behaviour) when the shell
 *   hosts every component, else `unsupported` with MD_NAV_DASHBOARD (no definition in the sources) or
 *   MD_DASHBOARD_COMPONENT_UNSUPPORTED naming the components (charts, web resources, IFRAMEs, other controls).
 * Their rows carry `surface` (portalRendering for portal, staff for model-driven). A Solution dashboard an app hosts also
 * raises its inventory node: to behaviour when every component renders, else its row keeps MD_DASHBOARD_COMPONENT_UNSUPPORTED.
 */
function hostSurfaceNodes(
  add,
  { portal, metadata, clientResources, inventory = [], nodes, tableNames = [], relationships = [] },
) {
  for (const node of canvasNodes(inventory)) add(node);
  // The catalogue's verdict (dashboardPage) over the catalogue's tables (the effective mappings, else the Solution tables) and their public views.
  const tables = Object.fromEntries(
    [...new Set(tableNames)].map((entity) => [
      entity,
      { views: (metadata?.views ?? []).filter((view) => view.entity === entity && view.queryType === 0) },
    ]),
  );
  const unrendered = (dashboard) =>
    dashboardPage(dashboard, tables)
      .components.filter((component) => component.supported === false)
      .map((component) => `${component.kind} ${component.name}`);
  const hosted = new Map(
    (metadata?.modelDrivenApps ?? []).flatMap((app) =>
      (app.dashboards ?? []).map((dashboard) => [dashboard.id, dashboard]),
    ),
  );
  for (const record of inventory.filter((record) => record.component === 'dashboard' && hosted.has(record.id))) {
    const node = nodes?.get(`dashboard:${canonical(record.name)}`);
    if (!node) continue;
    if (unrendered(hosted.get(record.id)).length) node.reason = 'MD_DASHBOARD_COMPONENT_UNSUPPORTED';
    else Object.assign(node, { level: 'behaviour', reason: null });
  }
  for (const app of metadata?.modelDrivenApps ?? [])
    for (const area of app.navigation ?? [])
      for (const group of area.groups ?? [])
        for (const item of group.items ?? []) {
          if (item.code !== 'MD_NAV_DASHBOARD') continue;
          const dashboard = item.dashboard
            ? (app.dashboards ?? []).find((candidate) => candidate.id === item.dashboard)
            : app.dashboards?.[0];
          const gaps = dashboard ? unrendered(dashboard) : [];
          add({
            kind: 'model-driven',
            key: `dashboard/${app.uniqueName ?? app.id}/${item.id ?? item.dashboard}`,
            name: dashboard?.name ?? item.dashboard ?? item.id,
            level: dashboard && !gaps.length ? 'behaviour' : 'inventory',
            source: dashboard?.sourceFile ?? app.sourceFile ?? null,
            requirement: !dashboard
              ? {
                  status: 'unsupported',
                  reason: 'MD_NAV_DASHBOARD',
                  level: 'inventory',
                  message: 'The dashboard definition is not in the sources.',
                }
              : gaps.length
                ? {
                    status: 'unsupported',
                    reason: 'MD_DASHBOARD_COMPONENT_UNSUPPORTED',
                    level: 'inventory',
                    components: gaps,
                    message: `Not rendered locally: ${gaps.join('; ')}.`,
                  }
                : { status: 'satisfied', reason: null, level: 'behaviour' },
          });
        }
  for (const finding of portal?.diagnostics ?? []) {
    const requirement = finding.requirement;
    if (requirement)
      add({
        kind: 'portal',
        key: requirement.id.replace(/^portal:/, ''),
        level: requirement.level,
        requirement: {
          status: requirement.status,
          reason: finding.code,
          level: requirement.level,
          ...(finding.message ? { message: finding.message } : {}),
        },
      });
  }
  if (portal) {
    const owners = [
      ...(portal.forms ?? []).map((form) => form.metadata),
      ...(portal.records ?? []).filter((record) => record.kind === 'advancedformstep'),
    ]
      .filter(Boolean)
      .map((record) => ({
        entity: String(field(record, 'entityname') ?? '').toLowerCase(),
        form: field(record, 'formname'),
      }))
      .filter((owner) => owner.entity && owner.form);
    const forms = (metadata?.forms ?? []).filter(
      (form) =>
        DOCUMENT_GRID.test(form.xml ?? '') &&
        owners.some((owner) => owner.entity === form.entity && [form.name, form.id].includes(owner.form)),
    );
    if (forms.length)
      add({
        kind: 'portal',
        key: 'sharepoint-documents',
        level: 'contract',
        source: forms[0].file ?? null,
        forms: forms.map((form) => form.id),
        requirement: { status: 'unsupported', reason: 'PORTAL_SHAREPOINT_DOCUMENTS_LOCAL', level: 'contract' },
      });
  }
  for (const app of metadata?.modelDrivenApps ?? [])
    for (const area of app.navigation ?? [])
      for (const group of area.groups ?? [])
        for (const item of group.items ?? [])
          if (item.code === 'MD_NAV_CUSTOM_PAGE') {
            // The shell's rule (model-driven/solution.mjs customPageResolution): the app's own type-300 component and a canvas app in the sources.
            const resolved = customPageResolution(
              app,
              item.page,
              inventory
                .filter((record) => record.component === 'canvasapp' && record.name)
                .map((record) => record.name),
            );
            add({
              kind: 'model-driven',
              key: `custom-page/${app.uniqueName ?? app.id}/${item.id ?? item.page}`,
              name: item.page ?? item.id,
              level: resolved.supported ? 'behaviour' : 'inventory',
              source: app.sourceFile ?? null,
              requirement: !resolved.supported
                ? { status: 'unsupported', reason: 'MD_NAV_CUSTOM_PAGE', level: 'inventory', message: resolved.reason }
                : {
                    status: 'placeholder',
                    reason: 'CANVAS_NOT_RENDERED',
                    level: 'behaviour',
                    message: "The custom page's canvas app runs headlessly; the page is not rendered.",
                  },
            });
          }
  for (const control of clientResources?.pcf?.controls ?? []) {
    const admission = pcfAdmission(control, { platformLibraries: clientResources.pcf.platformLibraries ?? [] });
    if (admission.code === 'PCF_VIRTUAL_UNSUPPORTED')
      add({
        kind: 'model-driven',
        key: `pcf/${control.name}`,
        name: control.name,
        level: 'contract',
        requirement: { status: 'unsupported', reason: admission.code, level: 'contract' },
      });
    // The Power Pages host renders any Solution code component by name and supplies no platform libraries (code-components.mjs).
    // ponytail: one row per Solution control a portal could render; per-reference detection in pages and forms is the upgrade.
    if (portal && pcfAdmission(control).code === 'PCF_VIRTUAL_UNSUPPORTED')
      add({
        kind: 'portal',
        key: `pcf/${control.name}`,
        name: control.name,
        level: 'contract',
        requirement: { status: 'unsupported', reason: 'PCF_VIRTUAL_UNSUPPORTED', level: 'contract' },
      });
  }
  // Mobile offline (model-driven/offline.mjs): a profile whose items the simulator evaluates is satisfied; one with a filter it
  // cannot evaluate names the items (MD_OFFLINE_FILTER_UNSUPPORTED); an app naming a profile (component type 161) the
  // sources do not hold is keyed by the app (MD_OFFLINE_PROFILE_MISSING).
  const profiles = inventory.filter((record) => record.component === 'mobileofflineprofile');
  for (const profile of profiles) {
    const gaps = Array.isArray(profile.items)
      ? offlineProfileGaps(profile, { hierarchical: (table) => hierarchicalIn(relationships, table) })
      : [{ entity: null, reason: 'The profile items could not be read from the sources.' }];
    add({
      kind: 'model-driven',
      key: `offline/${profile.name}`,
      name: profile.name,
      level: gaps.length ? 'contract' : 'behaviour',
      source: profile.source ?? null,
      requirement: gaps.length
        ? {
            status: 'unsupported',
            reason: 'MD_OFFLINE_FILTER_UNSUPPORTED',
            level: 'contract',
            items: gaps.map((gap) => gap.entity),
            message: gaps.map((gap) => gap.reason).join(' '),
          }
        : { status: 'satisfied', reason: null, level: 'behaviour' },
    });
  }
  for (const app of metadata?.modelDrivenApps ?? [])
    if (
      (app.components ?? []).some(
        (component) =>
          component.type === 161 &&
          !profiles.some(
            (profile) =>
              (profile.id && profile.id === component.id) ||
              (component.entity && component.entity === profile.name.toLowerCase()),
          ),
      )
    )
      add({
        kind: 'model-driven',
        key: `offline/${app.uniqueName ?? app.id}`,
        name: app.uniqueName ?? app.id,
        level: 'inventory',
        source: app.sourceFile ?? null,
        requirement: {
          status: 'unsupported',
          reason: 'MD_OFFLINE_PROFILE_MISSING',
          level: 'inventory',
          message: 'The app names a mobile offline profile that is not in the sources.',
        },
      });
}

/** Load the Solution (and optional portal) sources once and return their graph. Public: `paqvilo/mirage`. */
export async function loadSourceGraph({
  solutionRoots = [],
  solutionOrder = 'derived',
  sourceDir = null,
  lcid = 1033,
  bindings,
} = {}) {
  const sources = await loadOrganizationSources({ solutionRoots, solutionOrder, lcid });
  const portal = sourceDir ? await (await import('./importer.mjs')).importPortal(sourceDir, { lcid }) : null;
  return buildSourceGraph({ ...sources, portal, bindings });
}
