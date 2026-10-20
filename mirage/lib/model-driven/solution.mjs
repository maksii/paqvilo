import { descendants, child, childText, label, parseSolutionXml, serializeXml } from '../solution-xml.mjs';

const id = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const nodes = (root, name) => root.name === name ? [root] : descendants(root, name);
const title = (node, lcid) => {
  const titles = descendants(node, 'Title');
  return (titles.find(row => Number(row.attrs.LCID) === Number(lcid)) ?? titles[0])?.attrs.Title
    ?? label(child(node, 'LocalizedNames'), lcid) ?? node.attrs.Title;
};

/** Data-only navigation. URLs, scripts and resource IDs are never executed as app code. */
export function parseSiteMap(root, { lcid = 1033 } = {}) {
  if (typeof root === 'string') root = parseSolutionXml(root);
  const map = nodes(root, 'SiteMap')[0];
  if (!map) return [];
  return nodes(map, 'Area').map(area => ({
    id: area.attrs.Id, title: title(area, lcid) ?? area.attrs.Id,
    groups: (area.children ?? []).filter(node => node.name === 'Group').map(group => ({
      id: group.attrs.Id, title: title(group, lcid) ?? group.attrs.Id,
      items: (group.children ?? []).filter(node => node.name === 'SubArea').map(item => ({
        id: item.attrs.Id, title: title(item, lcid), entity: item.attrs.Entity?.toLowerCase(),
        // Non-table destinations have no renderer yet. Keep their place and explain it.
        supported: Boolean(item.attrs.Entity), reason: item.attrs.Entity ? undefined : 'This navigation type is not supported locally yet.',
      })),
    })),
  }));
}

/** AppModule / AppModuleSiteMap exports, including components in Customizations.xml. */
export function parseAppDefinitions(root, { lcid = 1033 } = {}) {
  const apps = [...nodes(root, 'AppModule'), ...nodes(root, 'appmodule')].map(node => ({
    id: id(childText(node, 'AppModuleId') ?? childText(node, 'appmoduleid') ?? node.attrs.AppModuleId),
    uniqueName: childText(node, 'UniqueName') ?? childText(node, 'uniquename') ?? node.attrs.UniqueName,
    name: label(child(node, 'LocalizedNames'), lcid) ?? childText(node, 'Name') ?? childText(node, 'name'),
    components: [...descendants(node, 'AppModuleComponent'), ...descendants(node, 'appmodulecomponent')].map(component => ({
      type: Number(component.attrs.type ?? component.attrs.componenttype),
      id: id(component.attrs.id ?? component.attrs.objectid),
      entity: component.attrs.schemaName?.toLowerCase() ?? component.attrs.logicalname?.toLowerCase(),
    })),
    navigation: parseSiteMap(node, { lcid }),
  })).filter(app => app.uniqueName || app.id);
  const maps = nodes(root, 'AppModuleSiteMap').map(node => ({
    uniqueName: childText(node, 'AppModuleUniqueName') ?? childText(node, 'UniqueName'),
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
      forms.push({ id: id(childText(systemform, 'formid')), entity, name: label(child(systemform, 'LocalizedNames'), lcid) ?? '', xml: serializeXml(form), active: childText(systemform, 'FormActivationState') !== '0', file,
        ...(type !== undefined ? { systemFormType: Number(type) } : {}) });
    }
    for (const view of nodes(node, 'savedquery')) {
      const fetch = child(view, 'fetchxml'), inline = child(fetch, 'fetch');
      views.push({ id: id(childText(view, 'savedqueryid')), entity, name: label(child(view, 'LocalizedNames'), lcid) ?? '', queryType: Number(childText(view, 'querytype')) || 0,
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
  const tabs = descendants(root, 'tab').map(tab => ({
    id: tab.attrs.name ?? tab.attrs.id, label: label(child(tab, 'labels'), lcid) ?? tab.attrs.name ?? 'General',
    visible: tab.attrs.visible !== 'false',
    columnWidths: (child(tab, 'columns')?.children ?? []).filter(column => column.name === 'column').map(column => Number.parseFloat(column.attrs.width) || 100),
    sections: descendants(tab, 'section').map(section => ({
      label: label(child(section, 'labels'), lcid) ?? '',
      showLabel: section.attrs.showlabel !== 'false', visible: section.attrs.visible !== 'false',
      column: (child(tab, 'columns')?.children ?? []).findIndex(column => descendants(column, 'section').includes(section)),
      columns: /^1{1,4}$/.test(section.attrs.columns ?? '') ? section.attrs.columns.length : 1,
      fields: descendants(section, 'cell').flatMap(cell => {
        const control = child(cell, 'control');
        if (!control) return [];
        const name = control.attrs.datafieldname;
        const rows = descendants(section, 'row'), row = rows.find(row => row.children.includes(cell));
        const position = { row: rows.indexOf(row), column: row?.children.slice(0, row.children.indexOf(cell)).reduce((sum, item) => sum + (Number(item.attrs.colspan) || 1), 0) ?? 0,
          colspan: Number(cell.attrs.colspan) || 1, showLabel: cell.attrs.showlabel !== 'false' };
        if (id(control.attrs.classid) === 'e7a81278-8635-4d9e-8d4d-59480b391c5b') {
          const parameter = name => descendants(control, name)[0]?.text.trim();
          return [{ ...position, label: label(child(cell, 'labels'), lcid) ?? control.attrs.id, visible: cell.attrs.visible !== 'false',
            supported: true, subgrid: { entity: parameter('TargetEntityType')?.toLowerCase(), view: id(parameter('ViewId')), relationship: parameter('RelationshipName'),
              pageSize: Number(parameter('RecordsPerPage')) || 10, searchEnabled: parameter('EnableQuickFind') === 'true' } }];
        }
        const isCustom = custom.has(id(control.attrs.uniqueid)) || custom.has(id(control.attrs.id));
        return [{ ...position, name, label: label(child(cell, 'labels'), lcid) ?? fields[name]?.label ?? name ?? control.attrs.id,
          visible: cell.attrs.visible !== 'false' && control.attrs.visible !== 'false', disabled: control.attrs.disabled === 'true',
          supported: Boolean(name && fields[name] && !isCustom),
          reason: isCustom ? 'This custom control is not supported locally yet.' : name ? 'Column metadata is unavailable.' : 'This control is not supported locally yet.' }];
      }),
    })),
  }));
  return { id: form.id, name: form.name, tabs, source: 'solution',
    hasScripts: descendants(root, 'Library').length > 0 || descendants(root, 'event').length > 0,
    xml: undefined };
}
