import { parseSolutionXml, descendants } from '../solution-xml.mjs';
import { standardFields } from '../dataverse-standard.mjs';

const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();

/** Static source prerequisites only; execution still validates and authorizes its query. */
export function viewColumnPrerequisites({ metadata = {}, mappings = {} } = {}) {
  const fields = new Map();
  for (const entity of new Set([...Object.keys(mappings ?? {}), ...Object.keys(metadata.entities ?? {})])) {
    const mapping = mappings?.[entity] ?? {},
      exported = metadata.entities?.[entity] ?? {};
    fields.set(
      norm(entity),
      new Set(
        [
          ...Object.keys(mapping.fields ?? {}),
          ...Object.keys(mapping.fieldMetadata ?? {}),
          ...Object.keys(exported.fields ?? {}),
          ...Object.keys(standardFields(entity)),
          ...[mapping.idColumn, exported.primaryIdAttribute].filter(Boolean),
        ].map(norm),
      ),
    );
  }
  const results = [];
  for (const view of metadata.views ?? []) {
    const missing = new Map(),
      aliases = new Map(),
      output = new Map();
    const check = (entity, column) => {
      entity = norm(entity);
      column = norm(column);
      if (!entity || !column || fields.get(entity)?.has(column)) return;
      missing.set(`${entity}/${column}`, { entity, column });
    };
    if (view.fetchXml) {
      let root;
      try {
        root = parseSolutionXml(view.fetchXml);
      } catch {
        continue;
      }
      const entities = descendants(root, 'entity');
      const register = (node) => {
        if (node.name === 'entity' || node.name === 'link-entity') {
          const entity = norm(node.attrs.name);
          aliases.set(norm(node.attrs.alias || entity), entity);
        }
        for (const child of node.children ?? []) register(child);
      };
      register(root);
      const visit = (node, parentEntity) => {
        const own = node.name === 'entity' || node.name === 'link-entity';
        const entity = own ? norm(node.attrs.name) : parentEntity;
        if (node.name === 'link-entity') {
          check(entity, node.attrs.from);
          check(parentEntity, node.attrs.to);
        }
        if (['attribute', 'condition', 'order'].includes(node.name)) {
          const target = node.attrs.entityname
            ? (aliases.get(norm(node.attrs.entityname)) ?? norm(node.attrs.entityname))
            : entity;
          const column = node.attrs.name ?? node.attrs.attribute;
          // An order may name a projected aggregate alias rather than a physical column.
          if (!(node.name === 'order' && node.attrs.alias)) check(target, column);
          if (node.name === 'attribute' && node.attrs.alias)
            output.set(norm(node.attrs.alias), { entity: target, column });
          if (node.attrs.valueof) {
            const parts = norm(node.attrs.valueof).split('.');
            check(parts.length > 1 ? (aliases.get(parts[0]) ?? parts[0]) : entity, parts.at(-1));
          }
        }
        for (const child of node.children ?? []) visit(child, entity);
      };
      for (const entity of entities) visit(entity, norm(view.entity));
    }
    for (const field of view.fields ?? []) {
      const name = norm(typeof field === 'string' ? field : field.name);
      if (output.has(name)) continue;
      const split = name.indexOf('.');
      if (split > 0 && aliases.has(name.slice(0, split)))
        check(aliases.get(name.slice(0, split)), name.slice(split + 1));
      else check(view.entity, name);
    }
    for (const app of metadata.modelDrivenApps ?? []) {
      const declared = (app.components ?? []).filter((component) => component.type === 26);
      const matching = (metadata.views ?? []).filter(
        (candidate) =>
          candidate.entity === view.entity && declared.some((component) => norm(component.id) === norm(candidate.id)),
      );
      if (matching.length && !matching.includes(view)) continue;
      const tables = new Set(
        [
          ...(app.entities ?? []),
          ...(app.components ?? []).filter((component) => component.type === 1).map((component) => component.entity),
          ...(app.navigation ?? []).flatMap((area) =>
            area.groups.flatMap((group) => group.items.map((item) => item.entity)),
          ),
        ]
          .filter(Boolean)
          .map(norm),
      );
      if (!tables.has(norm(view.entity))) continue;
      for (const gap of missing.values())
        results.push({
          app: app.uniqueName ?? app.id,
          table: view.entity,
          view: view.id,
          viewName: view.name,
          source: view.file ?? view.sourceFile ?? app.sourceFile ?? null,
          ...gap,
        });
    }
  }
  return results;
}
