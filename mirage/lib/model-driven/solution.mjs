import { descendants, child, childText, label, labelsOf, parseSolutionXml, serializeXml } from '../solution-xml.mjs';

const id = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const nodes = (root, name) => root.name === name ? [root] : descendants(root, name);
const title = (node, lcid) => {
  const titles = descendants(node, 'Title');
  return (titles.find(row => Number(row.attrs.LCID) === Number(lcid)) ?? titles[0])?.attrs.Title
    ?? label(child(node, 'LocalizedNames'), lcid) ?? node.attrs.Title;
};
const titleLabels = node => Object.fromEntries(descendants(node, 'Title').filter(row => row.attrs.LCID && row.attrs.Title)
  .map(row => [row.attrs.LCID, row.attrs.Title]));
const tableNavigation = value => {
  if (!/^(?:\/)?main\.aspx\?/i.test(value ?? '')) return undefined;
  try {
    const url = new URL(value, 'http://local.invalid/'), entity = url.searchParams.get('etn');
    if (url.origin !== 'http://local.invalid' || url.pathname.toLowerCase() !== '/main.aspx' || url.searchParams.get('pagetype') !== 'entitylist' || !/^[a-z][\w]*$/i.test(entity ?? '')) return undefined;
    return { entity: entity.toLowerCase(), ...(url.searchParams.has('viewid') ? { view: id(url.searchParams.get('viewid')) } : {}), ...(url.searchParams.has('appid') ? { applicationId: id(url.searchParams.get('appid')) } : {}) };
  } catch { return undefined; }
};

/** Non-table SubArea destinations, each with a distinct code: web resources and dashboards whose definition the
 * sources hold are hosted (the catalogue resolves the dashboard); custom pages open the headless canvas host of their canvas
 * app (the shell answers a missing one with CustomPageNotFound); external URLs are not hosted. */
export const DASHBOARD_MISSING_REASON = 'The dashboard definition is not in the sources (MD_NAV_DASHBOARD).';
/** A custom page is a canvas app the model-driven app includes (Learn "Add a custom page to your model-driven app"; solution
 * component type 300 Canvas App, Learn solutioncomponent): it resolves only against the app's own type-300 AppModuleComponent
 * and a canvas app the canvas host holds (`canvasApps`: unique names, or null without a canvas host). One rule for the
 * catalogue, the shell (app.customPages) and the source graph.
 * unverified: an exported AppModule names a custom page's component by its schemaName (the canvas app's logical name). */
export function customPageResolution(app, page, canvasApps) {
  const name = String(page ?? '').toLowerCase();
  if (!(app?.components ?? []).some(component => component.type === 300 && component.entity === name))
    return { supported: false, reason: `Custom page ${page} is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).` };
  if (!Array.isArray(canvasApps)) return { supported: false, reason: `Custom page ${page} needs the canvas host, which is not enabled in this runtime (MD_NAV_CUSTOM_PAGE).` };
  if (!canvasApps.some(candidate => String(candidate).toLowerCase() === name)) return { supported: false, reason: `Custom page ${page} has no canvas app in the canvas sources (MD_NAV_CUSTOM_PAGE).` };
  return { supported: true };
}
function pageNavigation(attrs) {
  const url = String(attrs.Url ?? '');
  if (attrs.DefaultDashboard || /^\/?main\.aspx\?(?:.*&)?pagetype=dashboard(?:&|$)/i.test(url)) {
    // unverified: a dashboard SubArea Url names its dashboard as main.aspx?pagetype=dashboard&id=<guid>.
    const dashboard = id(attrs.DefaultDashboard ?? new URL(url, 'http://local.invalid/').searchParams.get('id'));
    return { kind: 'dashboard', code: 'MD_NAV_DASHBOARD', ...(dashboard ? { dashboard } : {}), supported: false, reason: DASHBOARD_MISSING_REASON };
  }
  // unverified: an exported custom-page SubArea carries main.aspx?pagetype=custom&name=<logical name> in Url.
  const custom = /^\/?main\.aspx\?(?:.*&)?pagetype=custom(?:&|$)/i.test(url) ? new URL(url, 'http://local.invalid/').searchParams.get('name') : null;
  if (custom !== null) return { kind: 'custom', code: 'MD_NAV_CUSTOM_PAGE', page: custom, ...customPageResolution(null, custom, null) };
  const resource = /^\$webresource:(.+)$/i.exec(url)?.[1];
  if (resource) return { kind: 'webresource', code: 'MD_NAV_WEBRESOURCE', webresource: resource };
  if (url) return { kind: 'url', code: 'MD_NAV_URL', supported: false, reason: 'External URL pages are not hosted locally (MD_NAV_URL).' };
  return undefined;
}

/** Data-only navigation. URLs, scripts and resource IDs are never executed as app code. */
export function parseSiteMap(root, { lcid = 1033 } = {}) {
  if (typeof root === 'string') root = parseSolutionXml(root);
  const map = nodes(root, 'SiteMap')[0];
  if (!map) return [];
  return nodes(map, 'Area').map(area => ({
    id: area.attrs.Id, title: title(area, lcid) ?? area.attrs.Id, titleLabels: titleLabels(child(area, 'Titles')),
    groups: (area.children ?? []).filter(node => node.name === 'Group').map(group => ({
      id: group.attrs.Id, title: title(group, lcid) ?? group.attrs.Id, titleLabels: titleLabels(child(group, 'Titles')),
      items: (group.children ?? []).filter(node => node.name === 'SubArea').map(item => {
        const destination = item.attrs.Entity ? { entity: item.attrs.Entity.toLowerCase() } : tableNavigation(item.attrs.Url) ?? pageNavigation(item.attrs);
        return {
        id: item.attrs.Id, title: title(item, lcid), titleLabels: titleLabels(child(item, 'Titles')), entity: item.attrs.Entity?.toLowerCase(),
        ...destination,
        supported: destination?.supported ?? Boolean(destination), reason: destination?.reason ?? (destination ? undefined : 'This navigation type is not supported locally yet.'),
      }; }),
    })),
  }));
}

/** AppModule / AppModuleSiteMap exports, including components in Customizations.xml. */
export function parseAppDefinitions(root, { lcid = 1033 } = {}) {
  const apps = [...nodes(root, 'AppModule'), ...nodes(root, 'appmodule')].map(node => ({
    id: id(childText(node, 'AppModuleId') ?? childText(node, 'appmoduleid') ?? node.attrs.AppModuleId),
    uniqueName: childText(node, 'UniqueName') ?? childText(node, 'uniquename') ?? node.attrs.UniqueName,
    name: label(child(node, 'LocalizedNames'), lcid) ?? childText(node, 'Name') ?? childText(node, 'name'),
    nameLabels: labelsOf(child(node, 'LocalizedNames')),
    description: (() => { const descriptions = descendants(child(node, 'Descriptions'), 'Description'); return (descriptions.find(row => Number(row.attrs.languagecode) === Number(lcid)) ?? descriptions[0])?.attrs.description ?? childText(node, 'Description') ?? childText(node, 'description'); })(),
    descriptionLabels: Object.fromEntries(descendants(child(node, 'Descriptions'), 'Description').filter(row => row.attrs.languagecode && row.attrs.description != null).map(row => [row.attrs.languagecode, row.attrs.description])),
    iconResourceId: id(childText(node, 'WebResourceId') ?? childText(node, 'webresourceid')) || undefined,
    components: [...descendants(node, 'AppModuleComponent'), ...descendants(node, 'appmodulecomponent')].map(component => ({
      type: Number(component.attrs.type ?? component.attrs.componenttype),
      id: id(component.attrs.id ?? component.attrs.objectid),
      entity: component.attrs.schemaName?.toLowerCase() ?? component.attrs.logicalname?.toLowerCase(),
    })),
    navigation: parseSiteMap(node, { lcid }),
  })).filter(app => app.uniqueName || app.id);
  const maps = nodes(root, 'AppModuleSiteMap').map(node => ({
    uniqueName: childText(node, 'AppModuleUniqueName') ?? childText(node, 'SiteMapUniqueName') ?? childText(node, 'UniqueName'),
    appId: id(childText(node, 'AppModuleId')),
    navigation: parseSiteMap(node, { lcid }),
  }));
  if (!maps.length && !apps.length && nodes(root, 'SiteMap').length)
    maps.push({ navigation: parseSiteMap(root, { lcid }) });
  const dashboards = parseDashboards(root, { lcid });
  return { apps, appMaps: maps, ...(dashboards.length ? { dashboards } : {}) };
}

const SUBGRID_CLASS = 'e7a81278-8635-4d9e-8d4d-59480b391c5b';
const DASHBOARD_CONTROL_KINDS = { '9fdf5f91-88b1-47f4-ad53-c11efc01a01d': 'web resource', 'fd2a7985-3187-444e-908d-6624b21f69c0': 'IFRAME' };
/** Organization-owned dashboards (systemform type 0; Learn understand-dashboards-dashboard-components-formxml) as
 * { id, name, components }: a list (sub-grid control with TargetEntityType/ViewId) is a `grid` component the shell renders
 * over the view query engine; a chart (VisualizationId), web resource, IFRAME or any other control is a component with
 * `supported: false` and its reason, listed on the page. Reads `<Dashboard>` elements and type 0 `<systemform>` elements. */
export function parseDashboards(root, { lcid = 1033 } = {}) {
  const found = new Map();
  const add = (node, form) => {
    const formId = id(childText(node, 'FormId') ?? childText(node, 'formid') ?? descendants(node, 'formid')[0]?.text);
    if (!formId || !form || found.has(formId)) return;
    const components = descendants(form, 'cell').flatMap(cell => {
      const control = child(cell, 'control');
      if (!control) return [];
      const classid = id(control.attrs.classid), parameter = name => descendants(control, name)[0]?.text.trim();
      const base = { id: control.attrs.id ?? cell.attrs.id ?? classid, name: label(child(cell, 'labels'), lcid) ?? control.attrs.id ?? classid };
      if (classid !== SUBGRID_CLASS) return [{ ...base, kind: DASHBOARD_CONTROL_KINDS[classid] ?? 'control', classid, supported: false,
        reason: `${DASHBOARD_CONTROL_KINDS[classid] ?? `Control ${classid}`} components are not rendered on local dashboards.` }];
      const entity = parameter('TargetEntityType')?.toLowerCase(), chart = id(parameter('VisualizationId'));
      // unverified: without ChartGridMode a component with a VisualizationId opens as its chart; All shows the chart and its list.
      const mode = parameter('ChartGridMode') ?? (chart ? 'Chart' : 'Grid');
      return [
        ...(mode !== 'Chart' ? [{ ...base, kind: 'grid', entity, view: id(parameter('ViewId')), pageSize: Number(parameter('RecordsPerPage')) || 10,
          searchEnabled: parameter('EnableQuickFind') === 'true', viewPickerEnabled: parameter('EnableViewPicker') === 'true',
          views: parameter('ViewIds')?.split(',').map(value => id(value.trim())).filter(Boolean) }] : []),
        ...(chart && mode !== 'Grid' ? [{ ...base, kind: 'chart', entity, chart, supported: false, reason: 'Charts are not rendered on local dashboards.' }] : []),
      ];
    });
    found.set(formId, { id: formId, name: label(child(node, 'LocalizedNames'), lcid) ?? formId, components });
  };
  for (const node of nodes(root, 'Dashboard')) add(node, descendants(node, 'form')[0]);
  for (const systemform of nodes(root, 'systemform')) if (childText(systemform, 'type') === '0') add(systemform, child(systemform, 'form'));
  return [...found.values()];
}

/** The one dashboard verdict (catalogue page and source-graph requirement row): `tables` maps a logical name to
 * `{ views: [{ id }] }`; a list whose table or view is not there is unsupported with its reason. */
export const dashboardPage = (dashboard, tables) => ({ ...dashboard, components: (dashboard.components ?? []).map(component => {
  if (component.kind !== 'grid') return component;
  const table = Object.hasOwn(tables, component.entity ?? '') ? tables[component.entity] : undefined;
  const reason = !table ? `The list table ${component.entity ?? ''} has no imported metadata or local mapping.`
    : component.view && !(table.views ?? []).some(view => view.id === component.view) ? 'The list view is not imported for its table.' : undefined;
  return { ...component, supported: !reason, ...(reason ? { reason } : {}) };
}) });

/** Packed Customizations.xml carries forms and saved queries under each Entity. */
export function embeddedAppComponents(root, { entity: enclosingEntity, lcid = 1033, file } = {}) {
  const forms = [], views = [];
  const entities = root.name === 'Entity' ? [root] : descendants(root, 'Entity');
  const containers = entities.length ? entities.map(node => ({ node, entity: (child(child(node, 'EntityInfo'), 'entity')?.attrs.Name || childText(node, 'Name') || child(node, 'Name')?.attrs.OriginalName || node.attrs.Name)?.toLowerCase() })) : [{ node: root, entity: enclosingEntity?.toLowerCase() }];
  for (const { node, entity } of containers) {
    if (!entity) continue;
    for (const systemform of nodes(node, 'systemform')) {
      const form = child(systemform, 'form'); if (!form) continue;
      const type = childText(systemform, 'type');
      forms.push({ id: id(childText(systemform, 'formid')), entity, name: label(child(systemform, 'LocalizedNames'), lcid) ?? '', nameLabels: labelsOf(child(systemform, 'LocalizedNames')), xml: serializeXml(form), active: childText(systemform, 'FormActivationState') !== '0', file,
        ...(type !== undefined ? { systemFormType: Number(type) } : {}) });
    }
    for (const view of nodes(node, 'savedquery')) {
      const fetch = child(view, 'fetchxml'), inline = child(fetch, 'fetch');
      views.push({ id: id(childText(view, 'savedqueryid')), entity, name: label(child(view, 'LocalizedNames'), lcid) ?? '', nameLabels: labelsOf(child(view, 'LocalizedNames')), queryType: Number(childText(view, 'querytype')) || 0,
        isDefault: childText(view, 'isdefault') === '1', fetchXml: inline ? serializeXml(inline) : fetch?.text.trim() ?? '',
        fields: descendants(child(view, 'layoutxml'), 'cell').filter(cell => cell.attrs.ishidden !== '1').map(cell => ({ name: cell.attrs.name, width: Number(cell.attrs.width) || 180 })), file });
    }
  }
  return { forms, views };
}

export function compileForm(form, fields, lcid = 1033) {
  if (!form?.xml) return null;
  const root = parseSolutionXml(form.xml);
  const custom = new Set(descendants(root, 'controlDescription').filter(description => descendants(description, 'customControl').length).map(description => id(description.attrs.forControl)));
  const bindings = new Map(descendants(root, 'controlDescription').map(description => [id(description.attrs.forControl),
    descendants(description, 'customControl').map(control => ({ attributes: { ...control.attrs }, xml: serializeXml(control) }))]));
  const pcfBinding = control => {
    const candidates = bindings.get(id(control.attrs.uniqueid)) ?? bindings.get(id(control.attrs.id)) ?? [];
    // Desktop metadata is preferred; phone/tablet bindings stay preserved in sourceControl.
    const candidate = candidates.find(entry => entry.attributes.formFactor === '0') ?? candidates.find(entry => entry.attributes.formFactor == null);
    if (!candidate?.attributes.name) return undefined;
    const node = parseSolutionXml(candidate.xml), parameters = child(node, 'parameters');
    // A dataset component binds <data-set name="…"> with its view and table; scalar properties stay field/value bindings.
    return { name: candidate.attributes.name, bindings: Object.fromEntries((parameters?.children ?? []).map(parameter => parameter.name === 'data-set'
      ? [parameter.attrs.name, { dataset: { view: id(childText(parameter, 'ViewId')) || undefined, entity: childText(parameter, 'TargetEntityType')?.toLowerCase(), relationship: childText(parameter, 'RelationshipName') || undefined } }]
      : [parameter.name, String(parameter.attrs.type).toLowerCase() === 'bound' ? { field: parameter.text.trim() } : { value: parameter.text.trim() }])) };
  };
  const sourceControl = control => ({ id: control.attrs.id ?? null, uniqueId: control.attrs.uniqueid ?? null,
    classId: control.attrs.classid ?? null, attributes: { ...control.attrs }, xml: serializeXml(control),
    customBindings: bindings.get(id(control.attrs.uniqueid)) ?? bindings.get(id(control.attrs.id)) ?? [] });
  const sectionColumns = section => /^[1-4]$/.test(section.attrs.columns ?? '') ? Number(section.attrs.columns) : /^1{2,4}$/.test(section.attrs.columns ?? '') ? section.attrs.columns.length : 1;
  const layoutCells = section => {
    const width = sectionColumns(section), occupied = [], result = [];
    for (const [row, definition] of descendants(section, 'row').entries()) {
      let column = 0;
      for (const cell of definition.children.filter(node => node.name === 'cell')) {
        const colspan = Math.max(1, Math.min(Number(cell.attrs.colspan) || 1, width)), rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
        while (Array.from({ length: colspan }, (_, offset) => (occupied[column + offset] ?? 0) > row).some(Boolean)) column++;
        for (let offset = 0; offset < colspan; offset++) occupied[column + offset] = row + rowspan;
        result.push({ cell, position: { row, column, colspan, ...(cell.attrs.rowspan ? { rowspan } : {}), showLabel: cell.attrs.showlabel !== 'false' } }); column += colspan;
      }
    }
    return result;
  };
  const tabs = descendants(root, 'tab').map(tab => ({
    id: tab.attrs.name ?? tab.attrs.id, label: label(child(tab, 'labels'), lcid) ?? tab.attrs.name ?? 'General',
    visible: tab.attrs.visible !== 'false',
    columnWidths: (child(tab, 'columns')?.children ?? []).filter(column => column.name === 'column').map(column => Number.parseFloat(column.attrs.width) || 100),
    sections: descendants(tab, 'section').map(section => ({
      label: label(child(section, 'labels'), lcid) ?? '',
      showLabel: section.attrs.showlabel !== 'false', visible: section.attrs.visible !== 'false',
      column: (child(tab, 'columns')?.children ?? []).findIndex(column => descendants(column, 'section').includes(section)),
      columns: sectionColumns(section),
      ...(Number(section.attrs.labelwidth) > 0 ? { labelWidth: Number(section.attrs.labelwidth) } : {}),
      ...(section.attrs.celllabelposition ? { labelPosition: section.attrs.celllabelposition.toLowerCase() } : {}),
      ...(section.attrs.celllabelalignment ? { labelAlignment: section.attrs.celllabelalignment.toLowerCase() } : {}),
      fields: layoutCells(section).flatMap(({ cell, position }) => {
        const control = child(cell, 'control');
        if (!control) return [{ ...position, spacer: true, supported: true, visible: cell.attrs.visible !== 'false' }];
        const name = control.attrs.datafieldname;
        if (id(control.attrs.classid) === SUBGRID_CLASS) {
          const parameter = name => descendants(control, name)[0]?.text.trim();
          const datasetPcf = custom.has(id(control.attrs.uniqueid)) || custom.has(id(control.attrs.id)) ? pcfBinding(control) : undefined;
          return [{ ...position, sourceControl: sourceControl(control), label: label(child(cell, 'labels'), lcid) ?? control.attrs.id, visible: cell.attrs.visible !== 'false',
            ...(datasetPcf ? { pcf: datasetPcf } : {}), supported: true, subgrid: { entity: parameter('TargetEntityType')?.toLowerCase(), view: id(parameter('ViewId')), relationship: parameter('RelationshipName'),
              pageSize: Number(parameter('RecordsPerPage')) || 10, searchEnabled: parameter('EnableQuickFind') === 'true',
              viewPickerEnabled: parameter('EnableViewPicker') === 'true', views: parameter('ViewIds')?.split(',').map(value => id(value.trim())).filter(Boolean) } }];
        }
        const isCustom = custom.has(id(control.attrs.uniqueid)) || custom.has(id(control.attrs.id));
        const pcf = isCustom ? pcfBinding(control) : undefined;
        const supported = Boolean(name && fields[name] && (!isCustom || pcf));
        // Modern forms can export the text class ID for a state choice. The
        // column's type and create/update permissions govern its behavior.
        return [{ ...position, sourceControl: sourceControl(control), name, label: label(child(cell, 'labels'), lcid) ?? fields[name]?.label ?? name ?? control.attrs.id,
          visible: cell.attrs.visible !== 'false' && control.attrs.visible !== 'false', disabled: control.attrs.disabled === 'true',
          ...(pcf ? { pcf } : {}), supported,
          ...(!supported ? { reason: !name ? 'This control is not supported locally yet.' : !fields[name] ? 'Column metadata is unavailable.' : 'This custom control is not supported locally yet.' } : {}) }];
      }),
    })),
  }));
  // formContext attributes are the columns bound anywhere on this form (body, header, footer); others are absent.
  const attributes = [...new Set(descendants(root, 'control').map(control => control.attrs.datafieldname?.toLowerCase()).filter(name => name && fields[name]))];
  // Header and footer cells keep their control names (Learn formContext.getControl: `header_<column>`); the shell does not
  // render them, so their state setters refuse by name. Business process flow stage columns are not compiled (BPFs do not run).
  const regionControls = ['header', 'footer'].flatMap(region => descendants(root, region).flatMap(node => descendants(node, 'control')).map(control => ({ region,
    id: control.attrs.id ?? `${region}_${control.attrs.datafieldname?.toLowerCase()}`, name: control.attrs.datafieldname?.toLowerCase() }))).filter(control => control.name && fields[control.name]);
  return { id: form.id, name: form.name, tabs, attributes, regionControls, source: 'solution',
    hasScripts: descendants(root, 'Library').length > 0 || descendants(root, 'event').length > 0,
    libraries: descendants(root, 'Library').map(node => node.attrs.name).filter(Boolean),
    clientEvents: descendants(root, 'event').map(node => ({ name: String(node.attrs.name ?? '').toLowerCase(), attribute: node.attrs.attribute, active: node.attrs.active !== 'false',
      handlers: descendants(node, 'Handler').map(handler => ({ library: handler.attrs.libraryName, functionName: handler.attrs.functionName,
        enabled: handler.attrs.enabled !== 'false', passExecutionContext: handler.attrs.passExecutionContext === 'true', parameters: handler.attrs.parameters ?? '' })) })),
    dependencies: { libraries: descendants(root, 'Library').map(node => ({ attributes: { ...node.attrs }, xml: serializeXml(node) })),
      events: descendants(root, 'event').map(node => ({ attributes: { ...node.attrs }, xml: serializeXml(node) })) },
    xml: undefined };
}

/** Exported classic ribbon commands. Unsupported actions/rules remain visible and disabled. */
export function parseRibbonCommands(root) {
  if (typeof root === 'string') root = parseSolutionXml(root);
  const definitions = new Map(nodes(root, 'CommandDefinition').map(node => [node.attrs.Id, node]));
  const labels = new Map(nodes(root, 'LocLabel').map(node => [node.attrs.Id, descendants(node, 'Title').find(row => row.attrs.languagecode === '1033')?.attrs.description ?? descendants(node, 'Title')[0]?.attrs.description]));
  const ruleDefinitions = new Map([...nodes(root, 'DisplayRule'), ...nodes(root, 'EnableRule')].filter(node => node.children.length).map(node => [node.attrs.Id, node]));
  const rules = (definition, kind) => (child(definition, kind)?.children ?? []).map(reference => {
    const rule = ruleDefinitions.get(reference.attrs.Id);
    return rule ? { id: reference.attrs.Id, clauses: rule.children.map(clause => ({ type: clause.name, ...clause.attrs })) } : { id: reference.attrs.Id, clauses: [{ type: 'UnsupportedRule' }] };
  });
  return nodes(root, 'Button').filter(button => button.attrs.Command).map(button => {
    const definition = definitions.get(button.attrs.Command), actionNodes = child(definition, 'Actions')?.children ?? [];
    const actions = actionNodes.map(action => ({ type: action.name, library: action.attrs.Library, functionName: action.attrs.FunctionName,
      parameters: action.children.map(parameter => ({ kind: parameter.name === 'CrmParameter' ? 'crm' : parameter.name === 'StringParameter' ? 'string' : parameter.name === 'IntParameter' || parameter.name === 'DecimalParameter' ? 'number' : parameter.name === 'BoolParameter' ? 'boolean' : 'unsupported', value: parameter.attrs.Value })) }));
    const displayRules = rules(definition, 'DisplayRules'), enableRules = rules(definition, 'EnableRules');
    const supportedRules = [...displayRules, ...enableRules].every(rule => rule.clauses.every(clause => ['FormStateRule', 'ValueRule', 'EntityRule', 'SelectionCountRule'].includes(clause.type)));
    const supported = Boolean(actions.length && actions.every(action => action.type === 'JavaScriptFunction' && action.library && action.functionName && action.parameters.every(parameter => parameter.kind !== 'unsupported' && (parameter.kind !== 'crm' || ['PrimaryControl', 'SelectedControlSelectedItemIds', 'SelectedEntityTypeName'].includes(parameter.value)))) && supportedRules);
    const rawLabel = button.attrs.LabelText ?? button.attrs.Id;
    return { id: button.attrs.Id, label: rawLabel.startsWith('$LocLabels:') ? labels.get(rawLabel.slice(11)) ?? button.attrs.Id : rawLabel,
      // Ribbon locations identify HomePageGrid, MainTab/Form or SubGrid. The latter is not yet hosted.
      locations: /SubGrid/i.test(button.attrs.Id) ? [] : /HomePageGrid/i.test(button.attrs.Id) ? ['grid'] : /Form|MainTab/i.test(button.attrs.Id) ? ['form'] : ['form', 'grid'],
      actions, displayRules, enableRules, supported, reason: supported ? undefined : 'This exported ribbon action or rule is outside the local client API support.' };
  });
}

/** Modern command designer AppAction export, using declared local WebResource IDs. */
export function parseAppActionCommand(root, { webresourcesById = new Map(), lcid = 1033 } = {}) {
  if (typeof root === 'string') root = parseSolutionXml(root);
  if (root.name !== 'appaction') return null;
  const entity = childText(child(root, 'contextentity'), 'logicalname') ?? childText(root, 'contextvalue');
  const resourceId = id(childText(child(root, 'onclickeventjavascriptwebresourceid'), 'webresourceid'));
  const library = webresourcesById instanceof Map ? webresourcesById.get(resourceId) : webresourcesById[resourceId];
  let parameters = [], parameterError = false;
  try {
    const source = JSON.parse(childText(root, 'onclickeventjavascriptparameters') || '[]');
    if (!Array.isArray(source)) throw new Error('Expected parameter array');
    parameters = source.map(parameter => {
      // The captured exported contract uses 5 for PrimaryControl. Other modern
      // parameter kinds require a verified mapping before they are admitted.
      const kind = Number(parameter.type) === 5 ? 'crm' : 'unsupported';
      return { kind, value: Number(parameter.type) === 5 ? 'PrimaryControl' : parameter.value };
    });
  } catch { parameterError = true; }
  const location = Number(childText(root, 'location')), labelNode = child(root, 'buttonlabeltext');
  const sequenceText = childText(root, 'sequence'), sequence = sequenceText?.trim() ? Number(sequenceText) : undefined;
  // Native form command elements use the exported AppAction name, which differs
  // from the canonical uniquename. Only the observed form/context contract is
  // mapped; other locations remain available by canonical ID without guessing.
  const nativeName = childText(root, 'name');
  const nativeControlIds = childText(root, 'context') === '1' && location === 0 && /^[a-z][a-z0-9_]*$/i.test(entity ?? '')
    && nativeName && nativeName.length <= 1024 && !/[|\x00-\x1f]/.test(nativeName)
    ? [`${entity.toLowerCase()}|NoRelationship|Form|${nativeName}`] : [];
  const supported = Boolean(entity && library && childText(root, 'onclickeventjavascriptfunctionname') && childText(root, 'context') === '1' && childText(root, 'statecode') !== '1' && childText(root, 'onclickeventtype') === '2' && childText(root, 'type') === '0' && !parameterError && parameters.every(parameter => parameter.kind !== 'unsupported') && [0, 1].includes(location) && childText(root, 'isdisabled') !== '1');
  return { entity: entity?.toLowerCase(), id: root.attrs.uniquename ?? childText(root, 'name'), nativeControlIds,
    ...(Number.isFinite(sequence) ? { sequence } : {}),
    label: label(labelNode, lcid) ?? labelNode?.attrs.default ?? childText(root, 'name'), locations: childText(root, 'hidden') === '1' ? [] : location === 0 ? ['form'] : location === 1 ? ['grid'] : [],
    supported, reason: supported ? undefined : 'This modern command requires a supported JavaScript action, parameter and local exported resource.',
    actions: [{ type: 'JavaScriptFunction', library, functionName: childText(root, 'onclickeventjavascriptfunctionname'), parameters }], displayRules: [], enableRules: [], source: 'appaction' };
}
