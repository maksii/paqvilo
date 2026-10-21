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
        const destination = item.attrs.Entity ? { entity: item.attrs.Entity.toLowerCase() } : tableNavigation(item.attrs.Url);
        return {
        id: item.attrs.Id, title: title(item, lcid), titleLabels: titleLabels(child(item, 'Titles')), entity: item.attrs.Entity?.toLowerCase(),
        ...destination,
        // Non-table destinations have no renderer yet. Keep their place and explain it.
        supported: Boolean(destination), reason: destination ? undefined : 'This navigation type is not supported locally yet.',
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
  return { apps, appMaps: maps };
}

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
    return { name: candidate.attributes.name, bindings: Object.fromEntries((parameters?.children ?? []).map(parameter => [parameter.name,
      String(parameter.attrs.type).toLowerCase() === 'bound' ? { field: parameter.text.trim() } : { value: parameter.text.trim() }])) };
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
        if (id(control.attrs.classid) === 'e7a81278-8635-4d9e-8d4d-59480b391c5b') {
          const parameter = name => descendants(control, name)[0]?.text.trim();
          return [{ ...position, sourceControl: sourceControl(control), label: label(child(cell, 'labels'), lcid) ?? control.attrs.id, visible: cell.attrs.visible !== 'false',
            supported: true, subgrid: { entity: parameter('TargetEntityType')?.toLowerCase(), view: id(parameter('ViewId')), relationship: parameter('RelationshipName'),
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
  return { id: form.id, name: form.name, tabs, source: 'solution',
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
