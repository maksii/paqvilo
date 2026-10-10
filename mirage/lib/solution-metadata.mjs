import path from "node:path";
import { createHash } from "node:crypto";
import { decodeXml, portalField as field } from "./importer.mjs";
import {
  parseSolutionXml,
  descendants,
  child,
  childText as text,
  label,
  serializeXml as serialize,
} from "./solution-xml.mjs";
import {
  scanSolutionSources,
  buildSolutionSchema,
  tableFields,
} from "./solution-schema.mjs";
import { mapLimit } from "./solution-cache.mjs";

export { parseSolutionXml, descendants };

const norm = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const FORM_PARSER_ID = "metadata-form@2";
const VIEW_PARSER_ID = "metadata-view@1";
const IO_CONCURRENCY = 24;

/** Systemform documents plus the tables/views they depend on (quick views, subgrids, lookups). */
function parseFormDocument(xml, entity, file, lcid) {
  const document = parseSolutionXml(xml);
  const forms = [];
  for (const systemform of document.name === "systemform"
    ? [document]
    : descendants(document, "systemform")) {
    const form = child(systemform, "form");
    if (!form) continue;
    forms.push({
      id: norm(text(systemform, "formid") ?? path.basename(file, ".xml")),
      entity,
      name: label(child(systemform, "LocalizedNames"), lcid) ?? "",
      xml: serialize(form),
      file,
      active: text(systemform, "FormActivationState") !== "0",
    });
  }
  return {
    forms,
    viewRefs: [...xml.matchAll(/<DefaultViewId>\s*([^<]+)<\/DefaultViewId>/gi)].map((m) => norm(m[1])),
    entityRefs: [
      ...xml.matchAll(/QuickFormId\s+entityname=(?:"|&quot;)([^"&]+)|<TargetEntityType>([^<]+)<\/TargetEntityType>/gi),
    ].map((m) => norm(m[1] ?? m[2])),
  };
}

function parseViewDocument(xml, entity, file, lcid) {
  const document = parseSolutionXml(xml);
  const views = [];
  for (const view of document.name === "savedquery"
    ? [document]
    : descendants(document, "savedquery")) {
    const fetch = descendants(child(view, "fetchxml"), "fetch")[0];
    const layout = child(view, "layoutxml");
    views.push({
      id: norm(text(view, "savedqueryid") ?? path.basename(file, ".xml")),
      entity,
      name: label(child(view, "LocalizedNames"), lcid) ?? "",
      fetchXml: fetch
        ? serialize(fetch)
        : decodeXml(child(view, "fetchxml")?.text.trim() ?? ""),
      fields: descendants(layout, "cell").map((c) => ({
        name: c.attrs.name,
        width: Number(c.attrs.width) || undefined,
      })),
      file,
    });
  }
  return { views };
}

/** Portal tables whose solution metadata the runtime needs (forms, lists, steps, Web API, grants). */
export function portalMetadataEntities(portal) {
  return [
    ...new Set(
      [...(portal.forms ?? []), ...(portal.lists ?? [])]
        .map((f) => f.entityName)
        .concat(
          (portal.records ?? [])
            .filter((r) => r.kind === "advancedformstep")
            .map((r) => field(r, "targetentitylogicalname", field(r, "entityname"))),
        )
        .concat(
          (portal.records ?? [])
            .filter((r) => r.kind === "tablepermission" && Number(field(r, "statecode", 0)) !== 1)
            .map((r) => field(r, "entitylogicalname")),
        )
        .concat(
          Object.entries(portal.settings ?? {})
            .filter(
              ([name, value]) =>
                /^Webapi\/[a-z][a-z0-9_]*\/(?:enabled|UseFieldsFromView)$/i.test(name) &&
                String(value).toLowerCase() === "true",
            )
            .map(([name]) => name.split("/")[1]),
        )
        .filter(Boolean)
        .map((name) => String(name).toLowerCase()),
    ),
  ];
}

/**
 * Discover unpacked solution forms/views and table columns for portal tables.
 * Roots may be repositories, solution trees or a common parent; the shared scan
 * orders layers and caches parsed files (see solution-schema.mjs).
 */
export async function importSolutionMetadata(
  roots,
  { entities, portal, lcid = 1033, scan, schema, cache, cacheFile, order = "explicit" } = {},
) {
  if (portal && !entities) entities = portalMetadataEntities(portal);
  roots = Array.isArray(roots) ? roots : [roots];
  scan ??= await scanSolutionSources(roots, { cache, cacheFile, order });
  schema ??= buildSolutionSchema(scan, { lcid });
  const names = entities?.length ? new Set(entities.map(norm)) : null;
  const diagnostics = [];
  const fingerprint = createHash("sha256");
  const files = scan.layers.flatMap((layer) =>
    layer.files.filter((file) => ["entity", "form", "view"].includes(file.kind)).map((file) => ({ ...file, entity: norm(file.entityDir) })),
  );
  const parse = async (file) => {
    if (file.parsed) return file.parsed;
    try {
      const parser = file.kind === "form" ? parseFormDocument : parseViewDocument;
      const { value, hash } = await scan.cache.parse(
        file.path,
        (file.kind === "form" ? FORM_PARSER_ID : VIEW_PARSER_ID) + ":" + lcid,
        (xml) => parser(xml, file.entity, file.path, lcid),
        { stamp: file.stamp },
      );
      file.hash = hash;
      file.parsed = value;
    } catch (error) {
      file.parsed = { forms: [], views: [], viewRefs: [], entityRefs: [] };
      diagnostics.push({ code: "SOLUTION_METADATA_PARSE_ERROR", file: file.path, message: error.message });
    }
    return file.parsed;
  };
  // Follow form dependencies into other tables (quick views and subgrids).
  // A portal's basic forms alone do not describe its complete solution inputs.
  if (names) {
    const viewEntities = new Map(
      files.filter((f) => f.kind === "view").map((f) => [norm(path.basename(f.path, ".xml")), f.entity]),
    );
    const inspected = new Set();
    let expanded;
    do {
      expanded = false;
      const pending = files.filter((f) => f.kind === "form" && names.has(f.entity) && !inspected.has(f));
      await mapLimit(pending, IO_CONCURRENCY, parse);
      for (const file of pending) {
        inspected.add(file);
        for (const viewId of file.parsed.viewRefs ?? []) {
          const entity = viewEntities.get(viewId);
          if (entity && !names.has(entity)) {
            names.add(entity);
            expanded = true;
          }
        }
        for (const entity of file.parsed.entityRefs ?? [])
          if (!names.has(entity)) {
            names.add(entity);
            expanded = true;
          }
      }
    } while (expanded);
  }
  const candidates = files.filter((file) => !names || names.has(file.entity));
  await mapLimit(candidates.filter((f) => f.kind !== "entity"), IO_CONCURRENCY, parse);
  const forms = [],
    views = [];
  const entityDocs = new Map(
    scan.layers.flatMap((layer) => layer.documents.map((doc) => [doc.file, doc.hash])),
  );
  for (const file of candidates) {
    fingerprint.update(file.path).update("\0").update(file.hash ?? entityDocs.get(file.path) ?? "").update("\0");
    if (file.kind === "form") forms.push(...file.parsed.forms);
    else if (file.kind === "view") views.push(...file.parsed.views);
  }
  // Table columns come from the merged schema; only tables with exported definitions are listed.
  const tables = {};
  for (const [name, table] of Object.entries(schema.tables)) {
    if (names && !names.has(name)) continue;
    if (!table.layers?.length && table.origin !== "dataverse-reference") continue;
    tables[name] = {
      entity: name,
      fields: tableFields(schema, name, { lcid, diagnostics }),
      sources: [...table.sources],
      entitySet: table.entitySet,
      entitySetSource: table.entitySetSource,
      primaryIdAttribute: table.primaryIdAttribute,
      primaryNameAttribute: table.primaryNameAttribute,
      schemaComplete: table.schemaComplete,
      completeness: table.completeness,
    };
  }
  const dedupe = (rows, kind) => {
    const map = new Map();
    for (const row of rows) {
      const key = `${row.entity}/${row.id}`;
      const before = map.get(key);
      if (
        before &&
        (kind === "form"
          ? before.xml !== row.xml
          : before.fetchXml !== row.fetchXml)
      )
        diagnostics.push({
          code: "SOLUTION_LAYER_VARIANTS",
          kind,
          id: row.id,
          entity: row.entity,
          selected: row.file,
          previous: before.file,
          message:
            "Multiple source layers provide this component; the last selected root and source file wins. This does not identify the deployed layer.",
        });
      map.set(key, row);
    }
    return [...map.values()];
  };
  const metadata = {
    roots: scan.inputs.filter((input) => !["missing", "unsupported"].includes(input.type)).map((input) => input.input),
    layers: schema.layers,
    entities: tables,
    forms: dedupe(forms, "form"),
    views: dedupe(views, "view"),
    diagnostics,
    filesRead: candidates.length,
    fingerprint: fingerprint.digest("hex"),
  };
  if (portal) {
    const applied = applySolutionMetadata(portal, metadata);
    return {
      ...metadata,
      ...applied,
      summary: {
        sources: metadata.roots,
        layers: schema.layers.length,
        filesRead: metadata.filesRead,
        forms: metadata.forms.length,
        views: metadata.views.length,
        resolved: applied.counts,
        unresolved: applied.diagnostics.filter((d) =>
          /UNRESOLVED|MAPPING_ERROR/.test(d.code),
        ).length,
      },
    };
  }
  return metadata;
}

function formSchema(form, definition, metadata, dependencyDepth = 0) {
  if (dependencyDepth > 8)
    throw new Error("Quick form dependency nesting exceeds eight levels");
  const tree = parseSolutionXml(form.xml);
  const richTextControls = new Map(
    descendants(tree, "controlDescription").flatMap((description) => {
      const custom = descendants(description, "customControl").find(
        (control) =>
          control.attrs.name ===
          "MscrmControls.RichTextEditor.RichTextEditorControl",
      );
      return custom
        ? [
            [
              norm(description.attrs.forControl),
              {
                name: custom.attrs.name,
                configUrl:
                  text(child(custom, "parameters"), "configUrl") ?? null,
              },
            ],
          ]
        : [];
    }),
  );
  const selectedTab = norm(field(definition.metadata, "tabname"));
  const tabs = descendants(tree, "tab");
  // Legacy tab selection (platform-internals-reference.md 6.1.3): no tab name renders
  // every visible tab; otherwise the first tab whose name matches, else the first whose
  // label matches, else the first visible tab.
  const visibleTabs = tabs.filter((t) => t.attrs.visible === undefined || t.attrs.visible === "true");
  let tabSelection = null;
  let chosen = tabs;
  if (selectedTab) {
    const byName = tabs.find((t) => norm(t.attrs.name) === selectedTab || norm(t.attrs.id) === selectedTab);
    const byLabel = byName ? null : tabs.find((t) => norm(label(child(t, "labels"))) === selectedTab);
    const tab = byName ?? byLabel ?? visibleTabs[0] ?? null;
    tabSelection = { requested: field(definition.metadata, "tabname"), matched: byName ? "name" : byLabel ? "label" : tab ? "first-visible" : "none", tab: tab?.attrs.name ?? null };
    chosen = tab ? [tab] : [];
  }
  const fields = [];
  const layout = [];
  const known = metadata.entities[form.entity]?.fields ?? {};
  for (const tab of chosen) {
    // Native portal controls omit systemform tabs explicitly marked invisible.
    // Their repeated bindings must not become extra required browser controls.
    if (tab.attrs.visible === "false") continue;
    const columns = [];
    for (const column of child(tab, "columns")?.children ?? []) {
      const sections = [];
      for (const section of child(column, "sections")?.children ?? []) {
        if (section.attrs.visible === "false") continue;
        const rows = [];
        for (const row of child(section, "rows")?.children ?? []) {
          const cells = [];
          for (const cell of row.children) {
            const control = child(cell, "control");
            const parameters = child(control, "parameters");
            if (norm(control?.attrs.classid) === "06375649-c143-495e-a496-c962e5b4488e" || control?.attrs.indicationOfNotes === "true") {
              cells.push({
                type: "notes",
                id: control.attrs.id,
                label: label(child(cell, "labels")) || "Notes",
                hidden: cell.attrs.visible === "false",
                colspan: Number(cell.attrs.colspan) || 1,
                rowspan: Number(cell.attrs.rowspan) || 1,
              });
              continue;
            }
            if (control?.attrs.indicationOfSubgrid === "true") {
              const entity = norm(text(parameters, "TargetEntityType"));
              const viewId = norm(text(parameters, "ViewId"));
              const view = metadata.views.find(
                (v) => v.entity === entity && v.id === viewId,
              );
              cells.push({
                type: "subgrid",
                id: control.attrs.id,
                entity,
                viewId,
                relationship: text(parameters, "RelationshipName"),
                fields: (view?.fields ?? []).map((f) => ({
                  ...metadata.entities[entity]?.fields[f.name],
                  ...f,
                })),
                fetchXml: view?.fetchXml,
                label: label(child(cell, "labels")),
                colspan: Number(cell.attrs.colspan) || 1,
                rowspan: Number(cell.attrs.rowspan) || 1,
              });
              continue;
            }
            const quickForms = text(parameters, "QuickForms");
            if (quickForms) {
              const reference = descendants(
                parseSolutionXml(quickForms),
                "QuickFormId",
              )[0];
              const quickForm = metadata.forms.find(
                (f) =>
                  f.id === norm(reference?.text) &&
                  f.entity === norm(reference?.attrs.entityname),
              );
              cells.push({
                type: "quickform",
                id: control.attrs.id,
                lookup: norm(control.attrs.datafieldname),
                entity: norm(reference?.attrs.entityname),
                schema: quickForm
                  ? formSchema(
                      quickForm,
                      {
                        name: label(child(cell, "labels")) ?? quickForm.name,
                        mode: 100000002,
                        metadata: {},
                      },
                      metadata,
                      dependencyDepth + 1,
                    )
                  : null,
                label: label(child(cell, "labels")),
                colspan: Number(cell.attrs.colspan) || 1,
              });
              continue;
            }
            if (!control?.attrs.datafieldname) {
              cells.push({ spacer: true, colspan: Number(cell.attrs.colspan) || 1, rowspan: Number(cell.attrs.rowspan) || 1 });
              continue;
            }
            const name = norm(control.attrs.datafieldname);
            const lookupViewId = norm(text(parameters, "DefaultViewId"));
            const lookupView = metadata.views.find(
              (view) => view.id === lookupViewId,
            );
            const controlDefinition = {
              ...known[name],
              name,
              id: control.attrs.id ?? name,
              label: label(child(cell, "labels")) ?? known[name]?.label ?? name,
              readOnly:
                control.attrs.disabled === "true" ||
                (Number(definition.mode) === 100000000
                  ? known[name]?.validForCreate === false
                  : known[name]?.validForUpdate === false),
              hidden: cell.attrs.visible === "false",
              showLabel: cell.attrs.showlabel !== "false",
              controlClassId: norm(control.attrs.classid),
              ...(richTextControls.has(norm(control.attrs.uniqueid))
                ? {
                    richText: richTextControls.get(
                      norm(control.attrs.uniqueid),
                    ),
                  }
                : {}),
              lookupViewId,
              ...(lookupView
                ? {
                    lookupView: {
                      id: lookupView.id,
                      entity: lookupView.entity,
                      fetchXml: lookupView.fetchXml,
                      fields: lookupView.fields,
                      sourceFile: lookupView.file,
                    },
                  }
                : {}),
              colspan: Number(cell.attrs.colspan) || 1,
              rowspan: Number(cell.attrs.rowspan) || 1,
            };
            fields.push(controlDefinition);
            cells.push(controlDefinition);
          }
          rows.push(cells);
        }
        sections.push({
          name: section.attrs.name,
          label: label(child(section, "labels")),
          showLabel: section.attrs.showlabel === "true",
          columnWidths: /^1{1,4}$/.test(section.attrs.columns ?? "") ? [...section.attrs.columns].map(() => 100 / section.attrs.columns.length) : undefined,
          rows,
        });
      }
      columns.push({ width: column.attrs.width, sections });
    }
    layout.push({
      name: tab.attrs.name,
      label: label(child(tab, "labels")),
      showLabel: tab.attrs.showlabel === "true",
      columns,
    });
  }
  return {
    entity: form.entity,
    title: definition.name,
    formId: form.id,
    formName: form.name,
    fields,
    layout,
    source: "unpacked-systemform",
    sourceFile: form.file,
    mode: definition.mode,
    ...(tabSelection ? { tabSelection } : {}),
  };
}

export function applySolutionMetadata(portal, metadata) {
  const componentSchemas = {};
  const diagnostics = [...metadata.diagnostics];
  const withSaveFields = (schema, definition) => {
    const onSaveFields = (portal.records ?? [])
      .filter(
        (row) =>
          ["basicformmetadata", "advancedformmetadata"].includes(row.kind) &&
          field(row, "setvalueonsave", false) === true &&
          (norm(field(row, "entityform")) === norm(definition.id) ||
            norm(field(row, "webformstep")) === norm(definition.id)),
      )
      .map((row) => {
        const name = norm(field(row, "attributelogicalname")),
          attribute = metadata.entities[schema.entity]?.fields[name];
        if (!attribute)
          throw new Error(
            `On-save attribute '${name}' is absent in the imported table metadata`,
          );
        return { ...attribute, name };
      });
    const associationName = norm(
      field(
        definition.metadata,
        "targetentityportaluserlookupattribute",
        field(definition.metadata, "portaluserlookupattribute"),
      ),
    );
    let currentUserAssociationField;
    if (
      field(definition.metadata, "associatecurrentportaluser", false) ===
        true &&
      associationName
    ) {
      const attribute =
        metadata.entities[schema.entity]?.fields[associationName];
      if (!attribute)
        throw new Error(
          `Current-user association attribute '${associationName}' is absent in the imported table metadata`,
        );
      currentUserAssociationField = { ...attribute, name: associationName };
    }
    return {
      ...schema,
      onSaveFields,
      ...(currentUserAssociationField ? { currentUserAssociationField } : {}),
    };
  };
  const resolve = (definition) => {
    const formId = norm(field(definition.metadata, "formid"));
    let choices = metadata.forms.filter(
      (f) =>
        f.entity === norm(definition.entityName) &&
        f.active &&
        (formId
          ? f.id === formId
          : norm(f.name.trim()) === norm(definition.formName?.trim())),
    );
    if (!choices.length) return null;
    // Legacy form selection (platform-internals-reference.md 6.1.3): the first systemform
    // with the name. Dataverse retrieval order is not observable locally; layer and file
    // order stand in for it and the other candidates are reported.
    if (choices.length > 1)
      diagnostics.push({
        code: "SYSTEMFORM_NAME_AMBIGUOUS",
        id: definition.id,
        entity: definition.entityName,
        name: definition.formName,
        formId: choices[0].id,
        sourceFile: choices[0].file,
        candidates: choices.map((choice) => ({ formId: choice.id, sourceFile: choice.file })),
        message: `${choices.length} active systemforms are named ${definition.formName}; the first (${choices[0].id}) is used. Set the form ID on the basic form to choose another.`,
      });
    const schema = formSchema(choices[0], definition, metadata);
    if (schema.tabSelection && !["name", "label"].includes(schema.tabSelection.matched))
      diagnostics.push({
        code: "SYSTEMFORM_TAB_FALLBACK",
        id: definition.id,
        formId: schema.formId,
        requested: schema.tabSelection.requested,
        tab: schema.tabSelection.tab,
        message: schema.tabSelection.tab
          ? `No tab of ${schema.formName} is named or labelled '${schema.tabSelection.requested}'; the first visible tab '${schema.tabSelection.tab}' is rendered.`
          : `No tab of ${schema.formName} is named or labelled '${schema.tabSelection.requested}' and the form has no visible tab.`,
      });
    return withSaveFields(schema, definition);
  };
  for (const definition of portal.forms) {
    try {
      const schema = resolve(definition);
      if (schema) {
        componentSchemas[definition.id] = schema;
        componentSchemas[definition.name] = schema;
      } else
        diagnostics.push({
          code: "SYSTEMFORM_UNRESOLVED",
          id: definition.id,
          entity: definition.entityName,
          name: definition.formName,
          message:
            "No matching systemform exists in the selected solution sources",
        });
    } catch (error) {
      diagnostics.push({
        code: "SYSTEMFORM_MAPPING_ERROR",
        id: definition.id,
        message: error.message,
      });
    }
  }
  for (const list of portal.lists) {
    const viewId = norm(field(list.metadata, "view"));
    const view = metadata.views.find(
      (v) => v.entity === norm(list.entityName) && v.id === viewId,
    );
    if (view) {
      const schema = {
        entity: view.entity,
        title: list.name,
        viewId: view.id,
        fetchXml: view.fetchXml,
        fields: view.fields.map((f) => ({
          ...metadata.entities[view.entity]?.fields[f.name],
          ...f,
        })),
        source: "unpacked-savedquery",
        sourceFile: view.file,
      };
      componentSchemas[list.id] = schema;
      componentSchemas[list.name] = schema;
    } else
      diagnostics.push({
        code: "SYSTEMVIEW_UNRESOLVED",
        id: list.id,
        viewId,
        entity: list.entityName,
        message:
          "No matching savedquery exists in the selected solution sources",
      });
  }
  for (const form of portal.advancedForms ?? []) {
    const steps = portal.records.filter(
      (r) =>
        r.kind === "advancedformstep" &&
        norm(field(r, "webform")) === form.id &&
        Number(field(r, "statecode", 0)) !== 1,
    );
    const schemas = [];
    for (const step of steps) {
      try {
        if (Number(field(step, "type")) === 100000003) {
          const target = portal.pages.find(
            (p) => p.id === norm(field(step, "redirectwebpage")),
          );
          const redirectUrl = target?.url ?? field(step, "redirecturl");
          if (!redirectUrl)
            throw new Error(
              "Redirect step has no resolvable exported target page or URL",
            );
          schemas.push({
            stepId: step.id,
            type: "redirect",
            redirectUrl,
            appendRecordId: field(
              step,
              "redirecturlappendentityidquerystring",
              false,
            ),
            recordQueryName: field(step, "redirecturlquerystringname", "id"),
            js: step.customJavascript,
          });
          continue;
        }
        const definition = {
          id: step.id,
          name: step.name,
          entityName: field(
            step,
            "targetentitylogicalname",
            field(step, "entityname"),
          ),
          formName: field(step, "formname"),
          // PAC omits default-valued columns; the platform default is Insert.
          mode: field(step, "mode", 100000000),
          metadata: step,
        };
        const schema = resolve(definition);
        if (schema) {
          schema.stepId = step.id;
          schema.nextStepId = norm(field(step, "nextstep"));
          schema.js = step.customJavascript;
          schema.metadata = step;
          schemas.push(schema);
          componentSchemas[step.id] = schema;
        }
      } catch (error) {
        diagnostics.push({
          code: "ADVANCEDFORM_STEP_MAPPING_ERROR",
          id: step.id,
          message: error.message,
        });
      }
    }
    const start = norm(field(form.metadata, "startstep"));
    const schema = schemas.find((s) => s.stepId === start) ?? schemas[0];
    if (schema)
      componentSchemas[form.id] = {
        ...schema,
        steps: schemas,
        initialStepId: start,
      };
    else
      diagnostics.push({
        code: "ADVANCEDFORM_UNRESOLVED",
        id: form.id,
        message: "No mapped form step exists in the solution sources",
      });
  }
  return {
    componentSchemas,
    diagnostics,
    counts: {
      forms: portal.forms.filter((f) => componentSchemas[f.id]).length,
      formsTotal: portal.forms.length,
      lists: portal.lists.filter((f) => componentSchemas[f.id]).length,
      listsTotal: portal.lists.length,
      advancedForms: (portal.advancedForms ?? []).filter(
        (f) => componentSchemas[f.id],
      ).length,
      solutionForms: metadata.forms.length,
      solutionViews: metadata.views.length,
      entities: Object.keys(metadata.entities).length,
    },
  };
}
