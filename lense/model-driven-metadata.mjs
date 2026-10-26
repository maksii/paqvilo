import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileForm, parseRibbonCommands } from '../mirage/lib/model-driven/solution.mjs';
import { parseSolutionXml } from '../mirage/lib/solution-xml.mjs';
import { modelDrivenKey, modelDrivenControlKey } from '../mirage/lib/model-driven/provenance-registry.mjs';

const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const FORM_TYPES = {
  0: 'dashboard',
  2: 'main',
  5: 'mobile',
  6: 'quick view',
  7: 'quick create',
  11: 'card',
  12: 'main (interactive)',
};
const VIEW_TYPES = { 0: 'public', 1: 'advanced find', 2: 'associated', 4: 'quick find', 64: 'lookup' };
const boundedString = (value) => (typeof value === 'string' ? value.slice(0, 2048) : '');
const childText = (node, name) =>
  node.children?.find((child) => child.name.toLowerCase() === name.toLowerCase())?.text?.trim();

/** Requests cross a page binding. Keep active metadata selectors bounded and typed. */
export function normalizeModelDrivenMetadataRequest(body) {
  if (!body || body.version !== 1 || !body.active || typeof body.active !== 'object' || Array.isArray(body.active))
    return null;
  const active = {};
  for (const name of ['entity', 'table', 'formId', 'viewId']) {
    const value = body.active[name];
    if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 256)) return null;
    if (value !== undefined) active[name] = value;
  }
  const list = (value) =>
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 8192);
  for (const name of ['controlNames', 'controlKeys', 'componentKeys']) {
    if (body.active[name] !== undefined && !list(body.active[name])) return null;
    if (body.active[name] !== undefined) active[name] = [...body.active[name]];
  }
  if (body.componentKeys !== undefined && !list(body.componentKeys)) return null;
  const cursor = body.cursor;
  if (
    cursor !== undefined &&
    (!cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      typeof cursor.sourceRevision !== 'string' ||
      cursor.sourceRevision.length > 256 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0)
  )
    return null;
  if (
    cursor?.formKey !== undefined &&
    (typeof cursor.formKey !== 'string' ||
      !cursor.formKey.startsWith('form:') ||
      cursor.formKey.length > 256 ||
      ['controls', 'structure', 'events', 'libraries'].some(
        (name) => !Number.isSafeInteger(cursor[name]) || cursor[name] < 0,
      ))
  )
    return null;
  return {
    active,
    componentKeys: body.componentKeys ?? [],
    ...(cursor
      ? {
          cursor: {
            sourceRevision: cursor.sourceRevision,
            offset: cursor.offset,
            ...(cursor.formKey
              ? {
                  formKey: cursor.formKey,
                  controls: cursor.controls,
                  structure: cursor.structure,
                  events: cursor.events,
                  libraries: cursor.libraries,
                }
              : {}),
          },
        }
      : {}),
  };
}

/** Complete keys stay in the controller. Only requested details are compiled and serialized. */
export function createModelDrivenMetadataIndex(imported, { sourceRevision = '1' } = {}) {
  sourceRevision = String(sourceRevision);
  const components = new Map(),
    formDefinitions = new Map(),
    compiledForms = new Map(),
    sourceRefs = new Map(),
    files = new Map();
  const metadata = imported.metadata ?? {},
    entities = metadata.entities ?? {};
  const put = (kind, id, value) => {
    const key = modelDrivenKey(kind, id);
    components.set(key, { key, kind, id: norm(id), ...value });
    return key;
  };
  for (const [logicalName, table] of Object.entries(entities)) {
    put('table', logicalName, {
      logicalName,
      label: table.label,
      collectionLabel: table.collectionLabel,
      entitySet: table.entitySet,
      source: table.sourceOriginVerified === false ? undefined : table.sources?.at(-1),
      fieldCount: Object.keys(table.fields ?? {}).length,
      sourceOriginVerified: table.sourceOriginVerified,
      raw: table,
    });
    for (const [name, field] of Object.entries(table.fields ?? {}))
      put('column', `${logicalName}:${name}`, {
        name,
        entity: logicalName,
        source: field.sourceOriginVerified === false ? undefined : (field.source ?? table.sources?.at(-1)),
        sourceOriginVerified: field.sourceOriginVerified,
        raw: field,
      });
  }
  const forms =
    metadata.forms ??
    (imported.layers ?? []).flatMap((layer) =>
      (layer.documents ?? []).flatMap((document) =>
        (document.facts?.appComponents?.forms ?? []).map((form) => ({ ...form, file: form.file ?? document.file })),
      ),
    );
  for (const form of forms) {
    const key = put('form', form.id, {
      entity: form.entity,
      name: form.name,
      type: form.formType ?? FORM_TYPES[form.systemFormType] ?? 'main',
      source: form.sourceOriginVerified === false ? undefined : (form.file ?? form.source),
      sourceOriginVerified: form.sourceOriginVerified,
    });
    formDefinitions.set(key, form);
  }
  for (const view of metadata.views ?? [])
    put('view', view.id, {
      entity: view.entity,
      name: view.name,
      type: VIEW_TYPES[view.queryType] ?? `query type ${view.queryType}`,
      isDefault: Boolean(view.isDefault),
      columns: (view.fields ?? []).map((field) => field.name),
      source: view.sourceOriginVerified === false ? undefined : view.file,
      sourceOriginVerified: view.sourceOriginVerified,
    });
  for (const app of imported.apps ?? []) {
    put('app', app.id ?? app.uniqueName, {
      name: app.name,
      uniqueName: app.uniqueName,
      source: app.sourceIdentityFile ?? app.sourceFile,
      navigation: app.navigation ?? [],
    });
    for (const area of app.navigation ?? [])
      for (const group of area.groups ?? [])
        for (const item of group.items ?? [])
          put('navigation', `${app.id ?? app.uniqueName}:${item.id}`, {
            entity: item.entity,
            source: app.navigationIdentityFile ?? app.navigationSourceFile ?? app.sourceIdentityFile ?? app.sourceFile,
            name: item.title,
            appId: app.id,
            navigationId: item.id,
          });
    for (const dashboard of app.dashboards ?? []) {
      put('dashboard', dashboard.id, {
        name: dashboard.name,
        source: dashboard.sourceIdentityFile,
        formId: dashboard.id,
      });
      for (const item of dashboard.components ?? []) {
        const control = item.sourceControl ?? { id: item.id };
        const key = `dashboard-${modelDrivenControlKey(dashboard.id, control)}`;
        components.set(key, {
          key,
          kind: 'dashboard-control',
          id: item.id,
          name: item.name,
          source: dashboard.sourceIdentityFile,
          formId: dashboard.id,
          controlId: control.id,
          uniqueId: control.uniqueId,
          ordinal: control.ordinal,
          region: 'body',
        });
      }
    }
  }
  const addCommand = (entry, source = entry.source) =>
    put('command', `${entry.entity}:${entry.id}`, {
      id: entry.id,
      entity: entry.entity,
      label: entry.label,
      locations: entry.locations,
      supported: entry.supported,
      nativeControlIds: entry.nativeControlIds,
      source,
      sourceContentRevision: entry.sourceContentRevision,
      actions: (entry.actions ?? []).map((action) => ({
        type: action.type,
        library: action.library,
        functionName: action.functionName,
      })),
    });
  for (const command of imported.appActions ?? []) addCommand(command);
  let ribbonsRead = false;
  const readRibbons = () => {
    if (ribbonsRead) return;
    ribbonsRead = true;
    for (const document of imported.ribbonDocuments ?? []) {
      if (typeof document.xml !== 'string' || Buffer.byteLength(document.xml) > 8 * 1024 * 1024) continue;
      try {
        for (const command of parseRibbonCommands(document.xml))
          addCommand(
            { ...command, entity: document.entity, sourceContentRevision: document.sourceContentRevision },
            document.source,
          );
      } catch {
        /* Availability below reports missing details without discarding other keys. */
      }
    }
  };
  for (const resource of imported.assets?.values?.() ?? [])
    put('resource', resource.name, {
      name: resource.name,
      source: resource.file,
      mime: resource.mime,
      ...(resource.data ? { sourceContentRevision: hash(resource.data) } : {}),
    });
  for (const resource of imported.resources ?? [])
    if (!components.has(modelDrivenKey('resource', resource.name)))
      put('resource', resource.name, {
        name: resource.name,
        source: resource.sourceFile ?? resource.source,
        sourceContentRevision: resource.sourceContentRevision,
      });
  for (const component of imported.pcf?.controls ??
    imported.clientExtensions?.controls ??
    imported.extensions?.controls ??
    [])
    put('pcf', component.name, {
      name: component.name,
      source: component.sourceFile ?? component.file ?? component.manifestFile ?? component.source,
      sourceContentRevision: component.sourceContentRevision,
      relationship: 'definition',
      implementations: [
        ...(component.resources?.code ?? []).map((url) => ({ url, kind: 'implementation' })),
        ...(component.resources?.css ?? []).map((url) => ({ url, kind: 'stylesheet' })),
      ].flatMap(({ url, kind }) => {
        const asset = imported.assets?.get?.(url),
          snapshot = component.sourceAssets?.find((item) => item.url === url);
        return asset?.file && asset.data
          ? [{ file: asset.file, contentRevision: hash(asset.data), kind }]
          : snapshot
            ? [{ ...snapshot, kind }]
            : [];
      }),
    });

  // One synchronous projection may name a form file hundreds of times (its
  // controls, tabs and sections). Admit that file once for this projection,
  // retaining the bounded byte cache. The next query, and especially Open
  // source, must perform the filesystem checks again.
  let sourceReads;
  const withSourceReads = (fn) => {
    const parent = sourceReads;
    sourceReads = new Map();
    try {
      return fn();
    } finally {
      sourceReads = parent;
    }
  };
  const sourceFile = (file) => {
    if (sourceReads?.has(file)) return sourceReads.get(file);
    const result = readSourceFile(file);
    if (sourceReads) {
      sourceReads.set(file, result);
      while (
        sourceReads.size > 16 ||
        [...sourceReads.values()].reduce((sum, item) => sum + (item?.size ?? 0), 0) > 16 * 1024 * 1024
      )
        sourceReads.delete(sourceReads.keys().next().value);
    }
    return result;
  };
  const readSourceFile = (file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    let fd;
    try {
      const canonical = fs.realpathSync.native(file);
      fd = fs.openSync(
        canonical,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > 8 * 1024 * 1024) return null;
      const sameVersion = (info) =>
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        info.dev === opened.dev &&
        info.ino === opened.ino &&
        info.size === opened.size &&
        info.mtimeMs === opened.mtimeMs &&
        info.ctimeMs === opened.ctimeMs;
      if (!sameVersion(fs.lstatSync(canonical))) return null;
      const previous = files.get(canonical);
      if (
        previous?.ino === opened.ino &&
        previous.dev === opened.dev &&
        previous.size === opened.size &&
        previous.mtimeMs === opened.mtimeMs &&
        previous.ctimeMs === opened.ctimeMs &&
        sameVersion(fs.fstatSync(fd))
      )
        return previous;
      const buffer = Buffer.alloc(opened.size + 1);
      let size = 0,
        count;
      while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0)
        size += count;
      if (size !== opened.size || !sameVersion(fs.fstatSync(fd)) || !sameVersion(fs.lstatSync(canonical))) return null;
      const bytes = buffer.subarray(0, size);
      const result = {
        file: canonical,
        contentRevision: hash(bytes),
        text: bytes.toString('utf8'),
        size: bytes.length,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
        dev: opened.dev,
        ino: opened.ino,
      };
      files.set(canonical, result);
      while (files.size > 16 || [...files.values()].reduce((sum, item) => sum + item.size, 0) > 16 * 1024 * 1024)
        files.delete(files.keys().next().value);
      return result;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const locate = (component, file) => {
    if (!/\.xml$/i.test(component.source ?? '')) return undefined;
    try {
      if (!file.locations) {
        const root = parseSolutionXml(file.text, { locations: true }),
          locations = new Map(),
          ordinals = new Map();
        const add = (key, region) => {
          if (!locations.has(key)) locations.set(key, []);
          locations.get(key).push(region);
        };
        const walk = (node, formId = '$root', region = 'body', entity = '$root') => {
          const tag = node.name.toLowerCase();
          if (tag === 'systemform') {
            formId = norm(childText(node, 'formid')) || '$root';
            add(`form:${formId}`, node.region);
          }
          if (tag === 'form') {
            ordinals.set(formId, 0);
            if (node === root) add('form:$root', node.region);
          }
          if (tag === 'entity')
            entity =
              norm(node.attrs.Name ?? node.attrs.name ?? childText(node, 'Name') ?? childText(node, 'LogicalName')) ||
              entity;
          if (tag === 'header' || tag === 'footer') region = tag;
          if (tag === 'control') {
            const ordinal = ordinals.get(formId) ?? 0;
            ordinals.set(formId, ordinal + 1);
            const prefix = `control:${formId}:${region}:`;
            if (node.attrs.uniqueid) add(prefix + 'unique:' + norm(node.attrs.uniqueid), node.region);
            if (node.attrs.id) add(prefix + 'id:' + node.attrs.id, node.region);
            add(prefix + 'ordinal:' + ordinal, node.region);
          }
          if (tag === 'tab' || tag === 'section') {
            if (node.attrs.id) add(`${tag}:${formId}:id:${node.attrs.id}`, node.region);
            if (node.attrs.name) add(`${tag}:${formId}:name:${node.attrs.name}`, node.region);
          }
          if (tag === 'savedquery') add('view:' + norm(childText(node, 'savedqueryid')), node.region);
          if (tag === 'entity' && (node.name === 'Entity' || node === root)) add('table:' + entity, node.region);
          if (tag === 'attribute')
            add(
              `column:${entity}:${norm(childText(node, 'LogicalName') ?? childText(node, 'Name') ?? node.attrs.PhysicalName)}`,
              node.region,
            );
          if (tag === 'subarea') add('navigation:' + (node.attrs.Id ?? node.attrs.id), node.region);
          if (tag === 'appmodule') {
            add('app:id:' + norm(childText(node, 'AppModuleId')), node.region);
            add('app:name:' + norm(childText(node, 'UniqueName')), node.region);
          }
          if (tag === 'commanddefinition')
            add(`command:${entity}:${norm(node.attrs.Id ?? node.attrs.id)}`, node.region);
          if (tag === 'button') add(`command-button:${entity}:${norm(node.attrs.Id ?? node.attrs.id)}`, node.region);
          if (tag === 'appaction')
            add(`command:$root:${norm(node.attrs.uniquename ?? childText(node, 'name'))}`, node.region);
          for (const child of node.children ?? []) walk(child, formId, region, entity);
        };
        walk(root);
        file.locations = locations;
      }
      const select = (key, fallback) =>
        file.locations.get(key) ?? (fallback ? file.locations.get(fallback) : undefined) ?? [];
      const formId = norm(component.formId);
      let matches = [];
      if (component.kind === 'form' || component.kind === 'dashboard')
        matches = select('form:' + component.id, 'form:$root');
      else if (['control', 'subgrid', 'dashboard-control'].includes(component.kind)) {
        const suffix = component.uniqueId
          ? 'unique:' + norm(component.uniqueId)
          : component.controlId
            ? 'id:' + component.controlId
            : 'ordinal:' + component.ordinal;
        matches = select(
          `control:${formId}:${component.region}:${suffix}`,
          `control:$root:${component.region}:${suffix}`,
        );
      } else if (['tab', 'section'].includes(component.kind)) {
        const suffix = component.structureId ? 'id:' + component.structureId : 'name:' + component.name;
        matches = select(`${component.kind}:${formId}:${suffix}`, `${component.kind}:$root:${suffix}`);
      } else if (component.kind === 'view') matches = select('view:' + component.id);
      else if (component.kind === 'table') matches = select('table:' + component.logicalName);
      else if (component.kind === 'column')
        matches = select(`column:${component.entity}:${component.name}`, `column:$root:${component.name}`);
      else if (component.kind === 'navigation') matches = select('navigation:' + component.navigationId);
      else if (component.kind === 'app')
        matches = select('app:id:' + component.id, 'app:name:' + norm(component.uniqueName));
      else if (component.kind === 'command')
        matches = select(
          `command-button:${component.entity}:${norm(component.id)}`,
          `command-button:$root:${norm(component.id)}`,
        );
      if (component.kind === 'command' && !matches.length)
        matches = select(`command:${component.entity}:${norm(component.id)}`, `command:$root:${norm(component.id)}`);
      return matches.length === 1 ? matches[0] : undefined;
    } catch {
      return undefined;
    }
  };
  const refsFor = (component, { locations = true } = {}) => {
    if (component?.implementations?.length)
      return [
        ...refsFor({ ...component, implementations: undefined }, { locations }),
        ...component.implementations.flatMap((implementation, index) =>
          refsFor(
            {
              ...component,
              implementations: undefined,
              source: implementation.file,
              sourceContentRevision: implementation.contentRevision,
              relationship: `${implementation.kind ?? 'implementation'}:${index + 1}`,
            },
            { locations },
          ),
        ),
      ];
    if (!component?.source) return [];
    const file = sourceFile(component.source);
    if (!file) return [];
    const relationship =
      component.relationship ??
      (['control', 'subgrid', 'dashboard-control', 'tab', 'section', 'navigation'].includes(component.kind)
        ? 'placement'
        : component.kind === 'pcf' || component.kind === 'resource'
          ? 'implementation'
          : 'definition');
    const id = `model-source:${Buffer.from(component.key).toString('base64url')}:${hash(`${relationship}\0${file.file}`).slice(0, 32)}`;
    const importedRevision = component.sourceContentRevision ?? metadata.sourceRevisions?.[component.source];
    const value = {
      id,
      key: id,
      sourceKey: id,
      componentKey: component.key,
      placementKey: component.placementKey ?? component.key,
      kind: component.kind,
      name: boundedString(component.name ?? component.id),
      ref: file.file,
      sourceRevision,
      contentRevision: importedRevision ?? file.contentRevision,
      relationship,
    };
    if (!importedRevision) {
      value.currentState = 'unavailable';
      value.observations = { declared: true, parsed: 'unavailable' };
    }
    if (importedRevision && importedRevision !== file.contentRevision)
      value.currentContentRevision = file.contentRevision;
    if (component.id) value.recordId = component.id;
    if (component.kind === 'column') value.fieldPath = ['fields', component.name];
    else if (['control', 'subgrid'].includes(component.kind))
      value.fieldPath = ['controls', component.uniqueId ?? component.controlId ?? `@${component.ordinal}`];
    const region = locations && !value.currentContentRevision ? locate(component, file) : undefined;
    if (
      ['control', 'subgrid', 'dashboard-control', 'tab', 'section', 'navigation'].includes(component.kind) &&
      !region &&
      !value.currentContentRevision
    )
      return [];
    if (region) value.region = region;
    sourceRefs.set(id, value);
    return [value];
  };
  const compile = (key) => {
    if (compiledForms.has(key)) return compiledForms.get(key);
    const definition = formDefinitions.get(key),
      form = components.get(key);
    if (!definition || !form) return null;
    if (!definition.xml || Buffer.byteLength(definition.xml) > 8 * 1024 * 1024) return null;
    try {
      const compiled = compileForm(definition, entities[definition.entity]?.fields ?? {});
      if (!compiled) return null;
      const controls = [],
        structure = [];
      const control = (field, region, tab, section) => {
        if (field.spacer) return;
        const sourceControl = field.sourceControl ?? { id: field.id };
        const kind = field.subgrid
          ? 'subgrid'
          : field.pcf
            ? 'pcf'
            : norm(sourceControl.classId) === '5c5600e0-1d6e-4205-a272-be80da87fd42'
              ? 'quick-view'
              : norm(sourceControl.classId) === '9fdf5f91-88b1-47f4-ad53-c11efc01a01d'
                ? 'web-resource'
                : field.name
                  ? 'field'
                  : 'other';
        const item = {
          key: modelDrivenControlKey(definition.id, sourceControl, region),
          kind,
          id: sourceControl.id ?? field.name,
          uniqueId: sourceControl.uniqueId,
          ordinal: sourceControl.ordinal,
          classId: sourceControl.classId,
          name: field.name ?? '',
          label: field.label,
          region,
          tab,
          section,
          ...(field.subgrid ? { subgrid: field.subgrid } : {}),
          ...(field.pcf
            ? {
                pcf: {
                  name: field.pcf.name,
                  formFactor: field.pcf.formFactor,
                  bindings: Object.fromEntries(
                    Object.entries(field.pcf.bindings ?? {}).map(([name, binding]) => [
                      name,
                      {
                        ...(binding.field ? { field: binding.field } : {}),
                        ...(binding.dataset ? { dataset: binding.dataset } : {}),
                      },
                    ]),
                  ),
                },
              }
            : {}),
          customBindings: (sourceControl.customBindings ?? []).map((entry) => ({
            name: entry.attributes.name,
            formFactor: entry.attributes.formFactor,
          })),
        };
        controls.push(item);
        components.set(item.key, {
          ...item,
          kind: field.subgrid ? 'subgrid' : 'control',
          controlId: sourceControl.id,
          formId: definition.id,
          source: form.source,
          sourceOriginVerified: form.sourceOriginVerified,
          entity: definition.entity,
        });
      };
      for (const tab of compiled.tabs) {
        const tabKey = modelDrivenKey('tab', `${definition.id}:${tab.id}`);
        components.set(tabKey, {
          key: tabKey,
          kind: 'tab',
          formId: definition.id,
          name: tab.id,
          structureId: tab.sourceStructure?.id,
          source: form.source,
        });
        structure.push({ key: tabKey, kind: 'tab', name: tab.id, region: 'body' });
        for (const [index, section] of tab.sections.entries()) {
          const sectionId = section.sourceStructure?.id ?? section.name ?? section.column ?? index;
          const sectionKey = modelDrivenKey('section', `${definition.id}:${sectionId}`);
          components.set(sectionKey, {
            key: sectionKey,
            kind: 'section',
            formId: definition.id,
            name: section.name,
            structureId: section.sourceStructure?.id,
            source: form.source,
          });
          structure.push({ key: sectionKey, kind: 'section', name: section.name, tab: tab.id, region: 'body' });
          for (const field of section.fields) control(field, 'body', tab.id, section.name);
        }
      }
      for (const item of compiled.regionControls ?? []) control(item, item.region);
      const result = {
        ...form,
        controls,
        structure,
        regions: ['header', 'body', 'footer'],
        libraries: compiled.libraries,
        events: compiled.clientEvents,
      };
      compiledForms.set(key, result);
      // Keep the lazy cache bounded; the complete raw component keys remain.
      if (compiledForms.size > 32) compiledForms.delete(compiledForms.keys().next().value);
      return result;
    } catch {
      return null;
    }
  };
  const details = (component) => {
    const { raw, implementations: _implementations, ...entry } = component;
    if (component.kind === 'table')
      entry.columns = Object.values(raw.fields ?? {}).map((field) => ({
        name: field.name,
        label: field.label,
        type: field.dataverseType ?? field.type,
        required: field.requiredLevel ?? field.required,
        maxLength: field.maxLength,
        primaryName: field.isPrimaryName,
        source: field.source,
      }));
    return { ...entry, sourceRefs: refsFor(component) };
  };
  const query = ({ active = {}, componentKeys = [], budget = {}, cursor } = {}) => {
    const itemLimit = Math.max(1, Math.min(2000, Number.isSafeInteger(budget.items) ? budget.items : 200));
    const byteLimit = Math.max(
      256,
      Math.min(2 * 1024 * 1024, Number.isSafeInteger(budget.bytes) ? budget.bytes : 256 * 1024),
    );
    const formId = active.formId ?? active.form,
      viewId = active.viewId ?? active.view;
    const keys = new Set(
      [...componentKeys, ...(active.componentKeys ?? []), ...(active.controlKeys ?? [])].filter(
        (key) => typeof key === 'string',
      ),
    );
    if (formId) keys.add(String(formId).startsWith('form:') ? formId : modelDrivenKey('form', formId));
    if (viewId) keys.add(String(viewId).startsWith('view:') ? viewId : modelDrivenKey('view', viewId));
    if (active.table ?? active.entity) keys.add(modelDrivenKey('table', active.table ?? active.entity));
    // Native command selectors request active definitions without transporting
    // every command ahead of the current form. They remain DOM candidates.
    for (const key of [...keys])
      if (key.startsWith('native-command:')) {
        let identifier;
        try {
          identifier = decodeURIComponent(key.slice('native-command:'.length));
        } catch {
          continue;
        }
        if (
          identifier.length > 2048 ||
          // eslint-disable-next-line no-control-regex -- Reject control bytes in native metadata selectors.
          !/^[a-z][a-z0-9_]*\|NoRelationship\|(?:Form|Grid)\|[^|\u0000-\u001f]+$/i.test(identifier)
        )
          continue;
        readRibbons();
        const [entity, , location] = identifier.split('|');
        if (entity !== (active.entity ?? active.table)) continue;
        for (const command of components.values())
          if (
            command.kind === 'command' &&
            command.entity === entity &&
            command.locations?.includes(location.toLowerCase()) &&
            command.nativeControlIds?.includes(identifier)
          )
            keys.add(command.key);
        keys.delete(key);
      }
    const activeNames = new Set(active.controlNames ?? []),
      activeKeys = new Set(active.controlKeys ?? []);
    for (const key of [...keys]) if (key.startsWith('form:')) compile(key);
    // A control key can arrive before its form was requested explicitly.
    for (const key of [...keys, ...activeKeys])
      if (key.startsWith('control:')) {
        const match = /^control:([^:]+):/.exec(key);
        if (match) compile(modelDrivenKey('form', match[1]));
        keys.add(key);
      }
    if ([...keys].some((key) => key.startsWith('command:')) || !keys.size) readRibbons();
    // Rows also appear in the legacy catalogue and references have a separate
    // join table. Reserve their serialized copies rather than understating the
    // transport budget for a large active form.
    let remainingItems = itemLimit,
      remainingBytes = Math.max(128, Math.floor((byteLimit - 1024) / 3)),
      deferred = false;
    const rows = [],
      forms = [],
      unavailable = [],
      refs = new Map();
    const admit = (entry) => {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (remainingItems < 1 || bytes > remainingBytes) {
        deferred = true;
        return false;
      }
      remainingItems--;
      remainingBytes -= bytes;
      rows.push(entry);
      for (const ref of entry.sourceRefs ?? []) refs.set(ref.id, ref);
      return true;
    };
    const ordered = [...keys, ...[...components.keys()].filter((key) => !keys.has(key))];
    const offset =
      cursor && cursor.sourceRevision === sourceRevision && Number.isSafeInteger(cursor.offset)
        ? Math.max(0, cursor.offset)
        : 0;
    let nextOffset = offset;
    for (let index = offset; index < ordered.length; index++) {
      const key = ordered[index],
        component = components.get(key);
      nextOffset = index + 1;
      if (!component) {
        if (keys.has(key)) unavailable.push({ key, reason: 'component-not-imported' });
        continue;
      }
      if (keys.has(key) && component.sourceOriginVerified === false)
        unavailable.push({ key, reason: 'effective-definition-has-no-local-file-origin' });
      if (component.kind === 'form') {
        if (!keys.has(key)) {
          const entry = { ...component, controls: [], events: [], libraries: [], metadata: 'lazy', sourceRefs: [] };
          if (!admit(entry)) {
            nextOffset = index;
            break;
          }
          forms.push(entry);
          continue;
        }
        const full = compile(key);
        if (!full) {
          if (keys.has(key)) unavailable.push({ key, reason: 'form-structure-unavailable' });
          continue;
        }
        const controls = [...full.controls].sort(
          (a, b) =>
            Number(activeKeys.has(b.key) || activeNames.has(b.id)) -
            Number(activeKeys.has(a.key) || activeNames.has(a.id)),
        );
        const positions = Object.fromEntries(
          ['controls', 'structure', 'events', 'libraries'].map((name) => [
            name,
            cursor?.sourceRevision === sourceRevision && cursor.formKey === key ? (cursor[name] ?? 0) : 0,
          ]),
        );
        const entry = {
          ...full,
          controls: [],
          structure: [],
          events: [],
          libraries: [],
          controlCount: full.controls.length,
          controlsComplete: false,
          structureCount: full.structure.length,
          structureComplete: false,
          eventCount: full.events.length,
          eventsComplete: false,
          libraryCount: full.libraries.length,
          librariesComplete: false,
          detailOffsets: { ...positions },
          sourceRefs: refsFor(component),
        };
        let size = Buffer.byteLength(JSON.stringify(entry)),
          nestedItems = 0;
        const baseBytes = size,
          maximumPageBytes = Math.floor((byteLimit - 1024) / 3);
        const take = (name, values, end = values.length) => {
          for (; positions[name] < end; positions[name]++) {
            const value = values[positions[name]];
            const detailed = name === 'controls' ? { ...value, sourceRefs: refsFor(components.get(value.key)) } : value;
            const bytes = Buffer.byteLength(JSON.stringify(detailed)) + 1;
            if (baseBytes + bytes + 512 > maximumPageBytes) {
              if (unavailable.length < 128)
                unavailable.push({
                  key,
                  detail: name,
                  index: positions[name],
                  reason: 'detail-exceeds-response-budget',
                });
              deferred = true;
              continue;
            }
            if (nestedItems >= remainingItems - 1 || size + bytes + 512 > remainingBytes) break;
            entry[name].push(detailed);
            size += bytes;
            nestedItems++;
          }
        };
        const priorityControls = controls.filter(
          (control) => activeKeys.has(control.key) || activeNames.has(control.id),
        ).length;
        take('controls', controls, priorityControls);
        take('structure', full.structure);
        take('controls', controls);
        take('events', full.events);
        take('libraries', full.libraries);
        for (const name of ['controls', 'structure', 'events', 'libraries'])
          entry[`${name}Complete`] =
            entry.detailOffsets[name] === 0 &&
            entry[name].length === (name === 'controls' ? controls : full[name]).length;
        if (
          ['controls', 'structure', 'events', 'libraries'].some(
            (name) => positions[name] < (name === 'controls' ? controls : full[name]).length,
          )
        )
          entry.detailsCursor = { sourceRevision, offset: index, formKey: key, ...positions };
        if (admit(entry)) {
          for (const control of entry.controls) for (const ref of control.sourceRefs) refs.set(ref.id, ref);
          forms.push(entry);
          remainingItems -= nestedItems;
          if (['controls', 'structure', 'events', 'libraries'].some((name) => !entry[`${name}Complete`]))
            deferred = true;
        }
      } else {
        const { raw: _raw, ...summary } = component;
        const entry = keys.has(key)
          ? details(component)
          : { ...summary, ...(component.kind === 'table' ? { columns: [] } : {}), sourceRefs: [] };
        if (!admit(entry)) {
          nextOffset = index;
          break;
        }
      }
      if (remainingItems < 1) {
        nextOffset = index + 1;
        break;
      }
    }
    const catalogue = {
      forms,
      tables: rows.filter((item) => item.kind === 'table'),
      views: rows.filter((item) => item.kind === 'view'),
      apps: rows.filter((item) => item.kind === 'app'),
      commands: rows.filter((item) => item.kind === 'command'),
      solutionCount: imported.layers?.length ?? 0,
      limits: { maxItems: itemLimit, maxBytes: byteLimit, truncated: deferred || nextOffset < ordered.length },
    };
    return {
      version: 1,
      sourceRevision,
      components: rows,
      sourceRefs: [...refs.values()],
      catalogue,
      unavailable,
      limits: { ...catalogue.limits, indexed: components.size, forms: formDefinitions.size },
      ...(nextOffset < ordered.length ? { cursor: { sourceRevision, offset: nextOffset } } : {}),
    };
  };
  const resolveOpen = (
    {
      evidenceKey,
      sourceKey = evidenceKey,
      componentKey,
      placementKey,
      sourceRevision: revision,
      contentRevision,
    } = {},
    { observedRegion } = {},
  ) => {
    if (!sourceRefs.has(sourceKey)) {
      let selectedKey = componentKey;
      if (!selectedKey && typeof sourceKey === 'string') {
        const encoded = /^model-source:([a-zA-Z0-9_-]{1,4096}):[a-f0-9]{32}$/.exec(sourceKey)?.[1];
        if (encoded) {
          const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
          if (Buffer.from(decoded).toString('base64url') === encoded) selectedKey = decoded;
        }
      }
      if (typeof selectedKey === 'string') sourceRefsFor([selectedKey]);
    }
    const source = sourceRefs.get(sourceKey);
    if (
      !source ||
      (componentKey && source.componentKey !== componentKey) ||
      (placementKey && source.placementKey !== placementKey)
    )
      return { ok: false, reason: 'source-evidence-unavailable' };
    if (source.currentState === 'unavailable') return { ok: false, reason: 'source-origin-revision-unverified' };
    if (revision !== sourceRevision || source.sourceRevision !== revision || contentRevision !== source.contentRevision)
      return { ok: false, reason: 'source-evidence-stale' };
    const file = sourceFile(source.ref);
    if (!file || file.contentRevision !== contentRevision) return { ok: false, reason: 'source-content-changed' };
    const current = refsFor(components.get(source.componentKey)).find((ref) => ref.id === sourceKey);
    if (!current || current.contentRevision !== contentRevision) return { ok: false, reason: 'source-evidence-stale' };
    let region = current.region;
    if (!region && observedRegion && components.get(source.componentKey)?.kind === 'resource') {
      const { start, end } = observedRegion;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > file.text.length
      )
        return { ok: false, reason: 'source-location-unavailable' };
      let line = 1,
        column = 1;
      for (let offset = 0; offset < start; offset++) {
        const code = file.text.charCodeAt(offset);
        if (code === 13 && file.text.charCodeAt(offset + 1) === 10 && offset + 1 < start) offset++;
        if ([10, 13, 0x2028, 0x2029].includes(code)) {
          line++;
          column = 1;
        } else column++;
      }
      region = { start, end, line, column };
    }
    return {
      ok: true,
      file: file.file,
      ...(region ? { line: region.line, column: region.column } : {}),
      locationAvailable: Boolean(region),
      sourceRef: { ...current, ...(region ? { region } : {}) },
    };
  };
  const sourceRefsFor = (keys, options) =>
    keys.flatMap((key) => {
      if (key.startsWith('command:')) readRibbons();
      if (/^(control|tab|section):/.test(key)) {
        const match = /^(?:control|tab|section):([^:]+):/.exec(key);
        if (match) compile(modelDrivenKey('form', match[1]));
      }
      const component = components.get(key);
      return component ? refsFor(component, options) : [];
    });
  const formControls = (key) => compile(key)?.controls ?? [];
  const sourceRefsForForm = (key, { controlNames, controlKeys, includeStructure = true } = {}) => {
    const form = compile(key);
    if (!form) return [];
    const controls = form.controls.filter(
      (control) =>
        (!controlNames && !controlKeys) ||
        controlNames?.includes(control.id) ||
        controlNames?.includes(control.name) ||
        controlKeys?.includes(control.key),
    );
    return sourceRefsFor([
      key,
      ...controls.map((control) => control.key),
      ...(includeStructure ? form.structure.map((item) => item.key) : []),
    ]);
  };
  return Object.freeze({
    query: (request) => withSourceReads(() => query(request)),
    resolveOpen,
    sourceRefsFor: (keys, options) => withSourceReads(() => sourceRefsFor(keys, options)),
    sourceRefsForForm: (key, options) => withSourceReads(() => sourceRefsForForm(key, options)),
    formControls,
    controlKeysForForm: (key) => formControls(key).map((control) => control.key),
    sourceRevision,
    component: (key) => components.get(key),
    counts: () => ({ components: components.size, forms: formDefinitions.size }),
  });
}
