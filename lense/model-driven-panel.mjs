import path from 'node:path';
import { modelDrivenResourcePath } from './model-driven.mjs';
import { GitBaseline, gitHead } from './git.mjs';
import { comparison } from './panel.mjs';

/** The canonical panel's data contract. Model-driven code supplies facts, never a second shell. */
export function modelDrivenPanelData(
  state,
  { cfg, ui = {}, activity = [], live = true, online = false, git = null, facts = new Map(), scope = 'all' } = {},
) {
  const resources = state.resources ?? [];
  const forms = state.catalogue?.forms ?? [];
  const sourceDir = cfg.sourceDir ?? cfg.projectRoot ?? '';
  const resource = (item) => ({
    kind: 'web-file',
    group: /(?:javascript|ecmascript)/i.test(item.mime ?? '')
      ? 'js'
      : /text\/css/i.test(item.mime ?? '')
        ? 'css'
        : /\.(?:png|svg|jpg|woff2?)$/i.test(item.name)
          ? 'media'
          : 'other',
    title: item.name,
    rel: item.name,
    path: item.source,
    url: item.paths?.[0],
    count: item.currentRevisionApplied,
    note: item.currentRevisionApplied ? `applied on revision ${state.revision}` : 'not observed on this revision',
    canPause: !item.unbound,
    canDiff: !item.unbound && /(?:javascript|ecmascript|text\/css)/i.test(item.mime ?? ''),
    paused: Boolean(item.paused),
    edited: facts.get(item.name)?.edited,
    differs: facts.get(item.name)?.differs ?? null,
  });
  const problems = (state.problems ?? []).map((item) => {
    let resource, where;
    try {
      const url = new URL(item.url);
      where = url.origin + url.pathname;
      if (url.origin === state.origin) {
        const key = modelDrivenResourcePath(url.pathname);
        resource = resources.find((candidate) =>
          candidate.paths?.some((value) => modelDrivenResourcePath(value) === key),
        );
      }
    } catch {
      /* Unmapped native locations remain display-only, never guessed sources. */
    }
    return {
      ...item,
      type: ['pageerror', 'error'].includes(item.type)
        ? 'error'
        : ['warn', 'warning'].includes(item.type)
          ? 'warning'
          : item.type === 'requestfailed'
            ? 'failed'
            : item.type,
      at: item.at ?? Date.now(),
      where,
      ...(resource
        ? {
            rel: resource.name,
            line: Number.isSafeInteger(item.line) && item.line >= 0 ? item.line + 1 : undefined,
            col: Number.isSafeInteger(item.col) && item.col >= 0 ? item.col + 1 : undefined,
          }
        : {}),
    };
  });
  const notes = [
    ...(state.diagnostics ?? []).map((item) => ({
      kind: 'source',
      reason: `${item.code}: ${item.message}`,
      rel: item.source ?? '',
    })),
    ...resources
      .filter((item) => item.unbound)
      .map((item) => ({
        kind: 'source',
        reason: `${item.name}: an exact observed native resource mapping is required.`,
        rel: item.name,
      })),
  ];
  return {
    origin: state.origin,
    token: state.token,
    transport: 'model-driven',
    modelDriven: true,
    site: cfg.siteName ?? cfg.site?.name ?? cfg.site?.id ?? 'Solution sources',
    env: cfg.envName ?? cfg.env?.name ?? 'Model-driven',
    targets: cfg.devTargets ?? [],
    sourceDir,
    live,
    online,
    caution: Boolean(cfg.caution ?? cfg.env?.caution),
    scope,
    capabilities: {
      actions: true,
      targets: (cfg.devTargets?.length ?? 0) > 0,
      scope: true,
      comparison: true,
      git: Boolean(git),
    },
    keys: { hide: 'Alt+Shift+L', panel: 'Alt+Shift+P', mode: 'Alt+Shift+O' },
    keyCodes: { hide: 'KeyL', panel: 'KeyP', mode: 'KeyO' },
    ui,
    git: git ?? {},
    now: Date.now(),
    catalogVersion: state.revision,
    page: {
      path: '/main.aspx',
      name: state.context?.entity ?? 'Model-driven app',
      sources: forms
        .filter((form) => form.id === state.context?.formId)
        .map((form) => ({ rel: form.source, label: 'FormXml' })),
    },
    items: online ? [] : resources.filter((item) => item.currentRevisionApplied && !item.paused).map(resource),
    paused: resources.filter((item) => item.paused).map(resource),
    insync: [],
    unobserved: resources.filter((item) => !item.currentRevisionApplied && !item.paused).map(resource),
    notes,
    needsDeploy: [],
    problems,
    activity,
    pending: [],
    pendingBaseline: false,
    stats: { webFiles: state.resourceCount, blocks: 0, patches: 0 },
    inspection: {
      active: true,
      version: state.inspectionVersion,
      loading: state.pendingInspection,
      loadingId: state.inspectionVersion,
      phase: state.inspectionError || 'Reading the current app and matching exported Solution sources.',
      mode: 'model-driven',
      status: { solutionCount: state.catalogue?.solutionCount ?? 0 },
    },
    sourceCatalogue: [
      ...resources.map((item) => ({
        t: 'file',
        kind: 'web-file',
        title: item.name,
        rel: item.name,
        path: item.source,
        url: item.paths?.[0],
      })),
      ...forms.map((form) => ({
        t: 'file',
        kind: 'form',
        title: `${form.name} · ${form.type ?? 'main'} form of ${form.entity}`,
        rel: form.source,
        path: form.source,
      })),
      ...(state.catalogue?.tables ?? [])
        .filter((table) => table.source)
        .map((table) => ({
          t: 'file',
          kind: 'table',
          title: `${table.label || table.logicalName} · table ${table.logicalName}`,
          rel: table.source,
          path: table.source,
        })),
      ...(state.catalogue?.views ?? [])
        .filter((view) => view.source)
        .map((view) => ({
          t: 'file',
          kind: 'view',
          title: `${view.name} · ${view.type} view of ${view.entity}`,
          rel: view.source,
          path: view.source,
        })),
      ...(state.catalogue?.apps ?? [])
        .filter((app) => app.source)
        .map((app) => ({
          t: 'file',
          kind: 'app',
          title: `${app.name ?? app.uniqueName} · app`,
          rel: app.source,
          path: app.source,
        })),
      ...(state.catalogue?.commands ?? [])
        .filter((command) => command.source)
        .map((command) => ({
          t: 'file',
          title: command.label || command.id,
          rel: command.source,
          path: command.source,
        })),
    ],
  };
}

/**
 * Same Inspect and X-ray report contract, filled from the model-driven catalogue: the page's table (entity set, typed
 * columns, Entity.xml), its form (by the native form ID, else the table's main forms as candidates), the form's bound
 * columns, subgrids and code components, and on a list page the table's views (the current one first).
 */
export function modelDrivenPanelInspection(state) {
  const context = state.context ?? {},
    catalogue = state.catalogue ?? { forms: [], commands: [] };
  const tables = new Map((catalogue.tables ?? []).map((table) => [table.logicalName, table]));
  const onForm = context.pageType === 'entityrecord' || Boolean(context.formId);
  const exact = onForm ? catalogue.forms.filter((form) => form.id === context.formId) : [];
  // Without the native form ID the table's main forms are candidates; the first is what the app opens unless another is chosen.
  const forms = !onForm
    ? []
    : exact.length
      ? exact
      : catalogue.forms.filter(
          (form) => form.entity === context.entity && (!form.type || form.type.startsWith('main')),
        );
  const evidence = exact.length ? 'native-form-id' : 'candidate-table-form';
  const evidenceLabel = exact.length
    ? 'Form ID of this page matched to the selected Solution'
    : `Candidate: ${forms.length === 1 ? 'the only main form' : 'a main form'} of ${context.entity ?? 'this table'}`;
  const mapped = forms.map((form) => ({
    ...form,
    kind: 'model-driven-form',
    formType: form.type,
    ref: form.source,
    formName: form.name,
    evidence,
    evidenceLabel,
  }));
  const column = (table, name) => table?.columns?.find((item) => item.name === name);
  const columns = forms.flatMap((form) =>
    form.controls
      .filter((control) => control.kind === 'field' || control.kind === 'pcf')
      .map((control) => {
        const table = tables.get(form.entity),
          meta = column(table, control.name);
        return {
          entity: form.entity,
          name: control.name,
          label: control.label ?? meta?.label,
          type: meta?.type,
          required: meta?.required ? meta.required !== 'none' : undefined,
          maxLength: meta?.maxLength,
          resolved: Boolean(meta),
          ref: meta?.source ?? table?.source,
          formRef: form.source,
          formId: form.id,
          controlId: control.id,
          evidence,
        };
      }),
  );
  const view = !onForm ? (catalogue.views ?? []).find((item) => item.id === context.viewId) : null;
  const views = onForm
    ? forms.flatMap((form) =>
        form.controls
          .filter((control) => control.subgrid?.view)
          .map((control) => (catalogue.views ?? []).find((item) => item.id === control.subgrid.view))
          .filter(Boolean),
      )
    : (catalogue.views ?? [])
        .filter((item) => item.entity === context.entity && ['public', 'associated'].includes(item.type))
        .sort(
          (a, b) => Number(b.id === view?.id) - Number(a.id === view?.id) || Number(b.isDefault) - Number(a.isDefault),
        );
  const usedTables = [
    ...new Set(
      [context.entity, ...forms.flatMap((form) => form.controls.map((control) => control.subgrid?.entity))].filter(
        Boolean,
      ),
    ),
  ];
  return {
    evidence: {
      source:
        'Tables, forms, views and commands of the selected Solution matched to read-only native context. Native record values and effective access are not inferred.',
    },
    modelDriven: { ...context, catalogue },
    pageSources: [
      ...mapped.map((form) => ({ name: form.name, kind: `${form.formType ?? 'main'} form`, ref: form.ref })),
      ...(view ? [{ name: view.name, kind: 'View', ref: view.source }] : []),
      ...(tables.get(context.entity)?.source
        ? [
            {
              name: `${tables.get(context.entity).label || context.entity} table`,
              kind: 'Table definition',
              ref: tables.get(context.entity).source,
            },
          ]
        : []),
    ],
    forms: mapped,
    columns: onForm
      ? columns
      : view
        ? view.columns.map((name) => {
            const table = tables.get(context.entity),
              meta = column(table, name);
            return {
              entity: context.entity,
              name,
              label: meta?.label,
              type: meta?.type,
              resolved: Boolean(meta),
              ref: meta?.source ?? table?.source,
              evidence: 'view-column',
            };
          })
        : [],
    views: views.map((item) => ({
      ...item,
      fields: item.columns.map((name) => ({ name })),
      ref: item.source,
      evidence: item.id === context.viewId ? 'rendered-view-id' : undefined,
    })),
    nativeComponents: forms.flatMap((form) =>
      form.controls
        .filter((control) => control.kind === 'subgrid' || control.kind === 'quick-view')
        .map((control) => ({
          id: control.id,
          name: control.label ?? control.id,
          kind: control.kind === 'subgrid' ? 'subgrid' : 'quickform',
          owner: form.name,
          formId: form.id,
          entity: control.subgrid?.entity,
          relationship: control.subgrid?.relationship,
          view: control.subgrid?.view,
          ref: form.source,
          evidence: 'exported-form-control',
        })),
    ),
    codeComponents: forms.flatMap((form) =>
      form.controls
        .filter((control) => control.pcf)
        .map((control) => ({
          name: control.pcf.name,
          schemaName: control.pcf.name,
          owner: form.name,
          formId: form.id,
          field: control.name,
          expression: `${form.entity}.${control.name || control.id}`,
          binding: 'native-formxml',
          selectedDesktop: true,
          enablement: 'configured',
          ref: form.source,
        })),
    ),
    assets: state.resources.map((item) => ({
      name: item.name,
      url: item.paths?.[0],
      ref: item.name,
      path: item.source,
      evidence: item.currentRevisionApplied ? 'rendered-asset' : 'declared-asset',
    })),
    components: forms.flatMap((form) =>
      form.events.map((event) => ({
        name: event.name,
        kind: 'form-event',
        owner: form.name,
        entity: form.entity,
        ref: form.source,
        handlers: event.handlers,
        evidence: 'exported-event',
      })),
    ),
    tables: usedTables.map((name) => {
      const table = tables.get(name);
      return table
        ? {
            logicalName: name,
            displayName: table.label || undefined,
            entitySet: table.entitySet,
            fieldCount: table.fieldCount,
            ref: table.source,
            sourceRefs: [{ ref: table.source }],
          }
        : { logicalName: name, displayName: name };
    }),
    unresolved: state.diagnostics.map((item) => ({ name: item.code, message: item.message, ref: item.source })),
  };
}

/** UI state is portable; no native action parameters, identities or field values are persisted. */
export function modelDrivenPanelUi(input) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const key of ['open', 'hidden', 'large', 'localOnly'])
    if (typeof input[key] === 'boolean') result[key] = input[key];
  if (['overrides', 'runtime', 'issues', 'activity', 'explore', 'actions'].includes(input.tab)) result.tab = input.tab;
  if (['all', 'edited', 'differs'].includes(input.filter)) result.filter = input.filter;
  const pos = input.pos;
  if (
    pos &&
    ['left', 'right'].includes(pos.h) &&
    ['top', 'bottom'].includes(pos.v) &&
    Number.isFinite(pos.dx) &&
    Number.isFinite(pos.dy)
  )
    result.pos = {
      h: pos.h,
      v: pos.v,
      dx: Math.max(0, Math.min(pos.dx, 100000)),
      dy: Math.max(0, Math.min(pos.dy, 100000)),
    };
  if (input.collapsed && typeof input.collapsed === 'object' && !Array.isArray(input.collapsed))
    result.collapsed = Object.fromEntries(
      Object.entries(input.collapsed)
        .filter(([key, value]) => /^[a-z][a-z-]{0,40}$/.test(key) && typeof value === 'boolean')
        .slice(0, 100),
    );
  return result;
}

export function modelDrivenSourceFiles(state) {
  const allowed = new Map();
  for (const resource of state.resources ?? [])
    if (resource.source && path.isAbsolute(resource.source)) {
      allowed.set(resource.name, resource.source);
      allowed.set(resource.source, resource.source);
    }
  for (const entry of [
    ...(state.catalogue?.forms ?? []),
    ...(state.catalogue?.commands ?? []),
    ...(state.catalogue?.tables ?? []),
    ...(state.catalogue?.views ?? []),
    ...(state.catalogue?.apps ?? []),
  ])
    if (entry.source && path.isAbsolute(entry.source)) allowed.set(entry.source, entry.source);
  return allowed;
}

/** Git supplies the edited/scope baseline; only actually observed native bytes supply online equality. */
export async function createModelDrivenPanelSources(imported) {
  const byName = (value) => ({
    ...value,
    assets: new Map([...value.assets.values()].map((asset) => [asset.name, asset])),
  });
  let current = byName(imported);
  const baselines = new Map(),
    native = new Map();
  const assetBudget = 3 * 1024 * 1024,
    sessionBudget = 16 * 1024 * 1024;
  let nativeBytes = 0;
  const rootOf = (file) =>
    [...(current.layers ?? [])]
      .map((layer) => layer.dir)
      .filter(Boolean)
      .filter((root) => {
        const relative = path.relative(root, file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      })
      .sort((a, b) => b.length - a.length)[0] ?? path.dirname(file);
  const state = { facts: new Map(), scope: 'all', git: null };
  let updating, latest;
  function update(next = current, repin = false) {
    latest = { next, repin: repin || Boolean(latest?.repin) };
    if (!updating)
      updating = (async () => {
        // Establish the shared promise before a synchronously empty catalogue settles.
        await Promise.resolve();
        try {
          while (latest) {
            const work = latest;
            latest = null;
            await readUpdate(work.next, work.repin);
          }
          return state;
        } finally {
          updating = null;
        }
      })();
    return updating;
  }
  async function readUpdate(next, repin) {
    current = byName(next);
    if (repin) baselines.clear();
    for (const [name, bytes] of native)
      if (!current.assets.has(name)) {
        native.delete(name);
        nativeBytes -= bytes.length;
      }
    const grouped = new Map();
    for (const asset of current.assets.values())
      if (asset.file) {
        const root = rootOf(asset.file);
        if (!grouped.has(root)) grouped.set(root, []);
        grouped.get(root).push(asset);
      }
    state.facts = new Map();
    for (const [root, assets] of grouped) {
      let baseline = baselines.get(root);
      if (!baseline) {
        baseline = new GitBaseline(root, 'HEAD');
        baselines.set(root, baseline);
      }
      baseline.preload(assets.map((asset) => asset.file));
      const changed = await baseline.changedFilesAsync({ refreshRef: false });
      for (const asset of assets) {
        const before = baseline.available ? baseline.show(asset.file) : null;
        const bytes = native.get(asset.name);
        state.facts.set(asset.name, {
          edited: baseline.available ? before === null || changed.has(path.resolve(asset.file)) : undefined,
          canDiff: bytes !== undefined || baseline.available,
          differs: bytes !== undefined ? !bytes.equals(asset.data) : null,
          baseline,
          before,
        });
      }
    }
    for (const asset of current.assets.values())
      if (!state.facts.has(asset.name)) {
        const bytes = native.get(asset.name);
        state.facts.set(asset.name, {
          edited: undefined,
          canDiff: Boolean(bytes),
          differs: bytes ? !bytes.equals(asset.data) : null,
          before: null,
        });
      }
    const first = [...baselines.entries()][0],
      head = first ? await gitHead(first[0]) : null;
    state.git = head
      ? {
          ...head,
          headMoved: head.commit !== first[1].commit,
          canRepin: true,
          baseline: { available: first[1].available, requested: 'HEAD', commit: first[1].commit, pinned: true },
        }
      : null;
    return state;
  }
  await update();
  return {
    state,
    update,
    clearNative() {
      native.clear();
      nativeBytes = 0;
      for (const fact of state.facts.values()) {
        fact.differs = null;
        fact.canDiff = Boolean(fact.baseline?.available);
      }
    },
    changed() {
      return new Set([...state.facts].filter(([, fact]) => fact.edited === true).map(([name]) => name));
    },
    setScope(value) {
      if (!['all', 'changed'].includes(value)) throw Error('Scope must be all or changed.');
      if (
        value === 'changed' &&
        (state.facts.size !== current.assets.size ||
          [...state.facts.values()].some((fact) => fact.edited === undefined))
      )
        throw Error('Changed scope requires a readable Git HEAD for every selected source root.');
      state.scope = value;
    },
    observe(name, bytes) {
      if (!current.assets.has(name) || !Buffer.isBuffer(bytes) || bytes.length > assetBudget) return false;
      const previous = native.get(name);
      if (previous) {
        nativeBytes -= previous.length;
        native.delete(name);
      }
      while (nativeBytes + bytes.length > sessionBudget && native.size) {
        const [evicted, old] = native.entries().next().value;
        native.delete(evicted);
        nativeBytes -= old.length;
        const fact = state.facts.get(evicted);
        if (fact) {
          fact.differs = null;
          fact.canDiff = Boolean(fact.baseline?.available);
        }
      }
      native.set(name, Buffer.from(bytes));
      nativeBytes += bytes.length;
      const fact = state.facts.get(name);
      if (fact) {
        fact.differs = !bytes.equals(current.assets.get(name).data);
        fact.canDiff = true;
      }
      return true;
    },
    observationSize() {
      return { bytes: nativeBytes, resources: native.size, assetBudget, sessionBudget };
    },
    diff(name, environment) {
      const asset = current.assets.get(name),
        fact = state.facts.get(name);
      if (!asset || !fact) return { ok: false, error: 'Select a declared Solution resource.' };
      if (!/(?:javascript|ecmascript|text\/css)/i.test(asset.mime))
        return { ok: false, error: 'Binary resources cannot be compared as text.' };
      const bytes = native.get(name),
        before = bytes?.toString('utf8') ?? fact.before;
      if (before === null || before === undefined)
        return fact.baseline?.available
          ? { ok: true, against: 'Git HEAD (new source)', ...comparison('', asset.data.toString('utf8')) }
          : {
              ok: false,
              error:
                'No native response or Git baseline has been observed. Switch Online and visit the control, or use sources in a Git checkout.',
            };
      if (Buffer.byteLength(before) > 3 * 1024 * 1024 || asset.data.length > 3 * 1024 * 1024)
        return { ok: false, error: 'The source exceeds the bounded comparison size.' };
      return {
        ok: true,
        against: bytes ? environment : 'Git HEAD',
        rawEqual: bytes ? bytes.equals(asset.data) : undefined,
        ...comparison(before, asset.data.toString('utf8')),
      };
    },
  };
}
