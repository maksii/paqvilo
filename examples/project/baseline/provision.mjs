#!/usr/bin/env node
// Baseline fixture provisioning: idempotent, scripted, additive. Applies the generated manifest
// through the toolkit's Dataverse provisioning API, then the extras the manifest does not model
// (table flags, special column kinds, customer and polymorphic lookups, image, status reasons,
// quick-find flags, default views, business rules, column security), publishes, and exports the
// unmanaged fixture solution next to this script for Mirage's solution roots.
//
//   node examples/project/baseline/provision.mjs --connection <private connection.json> [--apply] [--export]
//
// Without --apply nothing is written: the script prints the plan. The connection file is a
// private application connection created with `paqvilo dataverse register|connect`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  loadConnection,
  connectedClient,
  readManifest,
  applyManifest,
  publishManifest,
  planManifest,
  exportSolution,
  checkKeys,
} from 'paqvilo/lense/dataverse/index.mjs';
import { metadataXml } from 'paqvilo/lense/dataverse/provision.mjs';
import { businessRuleXaml, businessRuleClientData } from './business-rules.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const LCID = 1033;
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: LCID }] });
const managed = (Value) => ({ Value, CanBeChanged: true });
const log = (entry) => console.log(JSON.stringify(entry));

async function attribute(client, table, name) {
  const rows = await client
    .list(
      `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,MetadataId,AttributeType&$filter=LogicalName eq '${name}'`,
    )
    .catch((error) => {
      if (/HTTP 404/.test(error.message)) return [];
      throw error;
    });
  return rows[0] ?? null;
}

function extraColumnPayload(column) {
  const base = {
    SchemaName: column.name,
    DisplayName: label(column.label),
    RequiredLevel: {
      Value: 'None',
      CanBeChanged: true,
      ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
    },
    IsAuditEnabled: managed(true),
  };
  switch (column.kind) {
    case 'autonumber':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        ...base,
        MaxLength: column.maxLength,
        FormatName: { Value: 'Text' },
        AutoNumberFormat: column.format,
      };
    case 'integer':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        ...base,
        MinValue: -2147483648,
        MaxValue: 2147483647,
        Format: column.format,
      };
    case 'bigint':
      return { '@odata.type': 'Microsoft.Dynamics.CRM.BigIntAttributeMetadata', ...base };
    case 'datetime':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        ...base,
        DateTimeBehavior: { Value: column.behavior },
        Format: column.format,
      };
    case 'localchoice':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
        ...base,
        ...(column.default !== undefined ? { DefaultFormValue: column.default } : {}),
        OptionSet: {
          '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
          IsGlobal: false,
          OptionSetType: 'Picklist',
          Options: column.options.map(([text, value]) => ({ Value: value, Label: label(text) })),
        },
      };
    case 'string':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        ...base,
        MaxLength: column.maxLength,
        FormatName: { Value: 'Text' },
        ...(column.isValidForUpdate === false ? { IsValidForUpdate: false } : {}),
      };
    case 'calculated':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        ...base,
        MaxLength: column.maxLength,
        FormatName: { Value: 'Text' },
        SourceType: 1,
      };
    case 'formula':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        ...base,
        MaxLength: column.maxLength,
        FormatName: { Value: 'Text' },
        SourceType: 3,
        FormulaDefinition: column.formula,
      };
    case 'rollup':
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        ...base,
        MinValue: 0,
        MaxValue: 2147483647,
        Format: 'None',
        SourceType: 2,
        FormulaDefinition: rollupXaml(column),
      };
    case 'file':
      return { '@odata.type': 'Microsoft.Dynamics.CRM.FileAttributeMetadata', ...base, MaxSizeInKB: column.maxSizeKb };
    default:
      throw new Error(`Unsupported extra column kind ${column.kind}`);
  }
}

/** Rollup definition: COUNT of related rows through the lookup (classic rollup XAML). */
function rollupXaml(column) {
  return `<RollupDefinition xmlns="http://schemas.microsoft.com/crm/2014/rollup"><SourceEntity Name="${column.table}"/><Aggregate Function="COUNT"><Attribute Name="${column.related}id" Entity="${column.related}" Path="${column.lookup}"/></Aggregate></RollupDefinition>`;
}

async function ensureExtraColumn(client, column, { apply, solution, journal }) {
  const existing = await attribute(client, column.table, column.name);
  const entry = { kind: 'column', table: column.table, name: column.name, extra: column.kind ?? 'flags' };
  if (column.manual) {
    // Maker-portal-only definitions: verified, never created here (see the inventory's manual steps).
    entry.action = existing ? 'exists' : 'manual-step-pending';
    journal.push(entry);
    log(entry);
    return;
  }
  if (!column.viaManifest) {
    if (!existing) {
      entry.action = 'create';
      if (apply)
        await client.request(`EntityDefinitions(LogicalName='${column.table}')/Attributes`, {
          method: 'POST',
          body: extraColumnPayload(column),
          solution,
        });
    } else entry.action = 'exists';
  } else entry.action = 'exists';
  // Every extra column must be a member of the fixture solution (an earlier run may have created it outside).
  if (apply) {
    const meta = existing ?? (await attribute(client, column.table, column.name));
    if (meta?.MetadataId) await includeComponent(client, meta.MetadataId, 2, solution);
  }
  // Flags on existing or manifest-created columns: secured, default value, rich text format.
  if (column.secured || column.defaultValue !== undefined || column.default !== undefined || column.richText) {
    const current = await client
      .get(`EntityDefinitions(LogicalName='${column.table}')/Attributes(LogicalName='${column.name}')`)
      .catch(() => null);
    if (current) {
      const patch = {};
      if (column.secured && current.IsSecured !== true) patch.IsSecured = true;
      if (column.defaultValue !== undefined && current.DefaultValue !== column.defaultValue)
        patch.DefaultValue = column.defaultValue;
      if (column.richText && current.FormatName?.Value !== 'RichText') patch.FormatName = { Value: 'RichText' };
      if (column.default !== undefined && current.DefaultFormValue !== column.default)
        patch.DefaultFormValue = column.default;
      if (Object.keys(patch).length) {
        entry.flags = Object.keys(patch);
        if (apply) {
          const { '@odata.context': _context, ...body } = current;
          await client.request(
            `EntityDefinitions(LogicalName='${column.table}')/Attributes(LogicalName='${column.name}')`,
            { method: 'PUT', body: { ...body, ...patch }, solution, mergeLabels: true },
          );
        }
      }
    }
  }
  journal.push(entry);
  log(entry);
}

async function ensureCustomerLookup(client, spec, { apply, solution, journal }) {
  const existing = await attribute(client, spec.table, spec.name);
  const entry = { kind: 'customer-lookup', table: spec.table, name: spec.name, action: existing ? 'exists' : 'create' };
  if (!existing && apply) {
    await client.request('CreateCustomerRelationships', {
      method: 'POST',
      body: {
        SolutionUniqueName: solution,
        Lookup: {
          '@odata.type': 'Microsoft.Dynamics.CRM.ComplexLookupAttributeMetadata',
          SchemaName: spec.name,
          DisplayName: label(spec.label),
          RequiredLevel: {
            Value: 'None',
            CanBeChanged: true,
            ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
          },
        },
        OneToManyRelationships: ['account', 'contact'].map((target) => ({
          '@odata.type': 'Microsoft.Dynamics.CRM.ComplexOneToManyRelationshipMetadata',
          SchemaName: spec.relationships[target],
          ReferencedEntity: target,
          ReferencingEntity: spec.table,
        })),
      },
    });
  }
  journal.push(entry);
  log(entry);
}

async function ensurePolymorphicLookup(client, spec, { apply, solution, journal }) {
  const existing = await attribute(client, spec.table, spec.name);
  const entry = {
    kind: 'polymorphic-lookup',
    table: spec.table,
    name: spec.name,
    action: existing ? 'exists' : 'create',
  };
  if (!existing && apply) {
    await client.request('CreatePolymorphicLookupAttribute', {
      method: 'POST',
      body: {
        SolutionUniqueName: solution,
        OneToManyRelationships: spec.targets.map((target) => ({
          '@odata.type': 'Microsoft.Dynamics.CRM.ComplexOneToManyRelationshipMetadata',
          SchemaName: spec.relationships[target],
          ReferencedEntity: target,
          ReferencingEntity: spec.table,
          CascadeConfiguration: {
            Assign: 'NoCascade',
            Delete: 'RemoveLink',
            Merge: 'NoCascade',
            Reparent: 'NoCascade',
            Share: 'NoCascade',
            Unshare: 'NoCascade',
          },
        })),
        Lookup: {
          '@odata.type': 'Microsoft.Dynamics.CRM.ComplexLookupAttributeMetadata',
          SchemaName: spec.name,
          DisplayName: label(spec.label),
          RequiredLevel: {
            Value: 'None',
            CanBeChanged: true,
            ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
          },
        },
      },
    });
  }
  journal.push(entry);
  log(entry);
}

async function ensureImage(client, spec, { apply, solution, journal }) {
  const existing = await attribute(client, spec.table, 'entityimage');
  const entry = { kind: 'image', table: spec.table, action: existing ? 'exists' : 'create' };
  if (!existing && apply)
    await client.request(`EntityDefinitions(LogicalName='${spec.table}')/Attributes`, {
      method: 'POST',
      body: {
        '@odata.type': 'Microsoft.Dynamics.CRM.ImageAttributeMetadata',
        SchemaName: spec.schemaName,
        DisplayName: label('Image'),
        RequiredLevel: {
          Value: 'None',
          CanBeChanged: true,
          ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
        },
        IsPrimaryImage: true,
        MaxSizeInKB: spec.maxSizeKb,
        CanStoreFullImage: true,
      },
      solution,
    });
  journal.push(entry);
  log(entry);
}

async function ensureStatusReasons(client, table, reasons, { apply, solution, journal }) {
  const current = await client.optional(
    `EntityDefinitions(LogicalName='${table}')/Attributes(LogicalName='statuscode')/Microsoft.Dynamics.CRM.StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`,
  );
  if (!current) {
    journal.push({ kind: 'status-reason', table, action: 'skipped', reason: 'table not provisioned yet' });
    return;
  }
  const have = new Set((current.OptionSet?.Options ?? []).map((option) => option.Value));
  for (const reason of reasons) {
    const entry = {
      kind: 'status-reason',
      table,
      value: reason.value,
      action: have.has(reason.value) ? 'exists' : 'create',
    };
    if (!have.has(reason.value) && apply)
      await client.request('InsertStatusValue', {
        method: 'POST',
        body: {
          EntityLogicalName: table,
          AttributeLogicalName: 'statuscode',
          Label: label(reason.label),
          StateCode: reason.state,
          Value: reason.value,
          SolutionUniqueName: solution,
        },
      });
    journal.push(entry);
    log(entry);
  }
}

async function includeComponent(client, id, type, solution) {
  const solutions = await client.list(`solutions?$select=solutionid&$filter=uniquename eq '${solution}'`);
  const solutionId = solutions[0]?.solutionid;
  if (!solutionId) throw new Error(`Solution ${solution} is missing.`);
  const found = await client.list(
    `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutionId} and componenttype eq ${type} and objectid eq ${id}`,
  );
  if (!found.length)
    await client.request('AddSolutionComponent', {
      method: 'POST',
      body: { ComponentId: id, ComponentType: type, SolutionUniqueName: solution, AddRequiredComponents: false },
    });
}

/** Forms and views: create when missing, update when the stored XML differs (whitespace-insensitive). */
async function ensureFormsAndViews(client, extrasSpec, { apply, solution, journal }) {
  const same = (a, b) => {
    try {
      return metadataXml(String(a ?? '')) === metadataXml(String(b ?? ''));
    } catch {
      return String(a ?? '') === String(b ?? '');
    }
  };
  const platformViewIds = {};
  const retirements = [];
  const objectTypeCodes = {};
  const objectTypeCode = async (table) => {
    objectTypeCodes[table] ??= (
      await client.get(`EntityDefinitions(LogicalName='${table}')?$select=ObjectTypeCode`)
    ).ObjectTypeCode;
    return objectTypeCodes[table];
  };
  const resolveViewTokens = async (xml) => {
    for (const [, table] of xml.matchAll(/\{OBJECT_TYPE_CODE:([a-z0-9_]+)\}/g))
      xml = xml.split(`{OBJECT_TYPE_CODE:${table}}`).join(String(await objectTypeCode(table)));
    return xml.replace(/\{PLATFORM_VIEW:([a-z0-9_]+):(\d+)\}/g, (token, table, type) => {
      const id = platformViewIds[`${table}:${type}`];
      if (!id)
        throw new Error(
          `Platform view for ${table} querytype ${type} is unresolved; rerun after the table's views exist.`,
        );
      return `{${id.toUpperCase()}}`;
    });
  };
  // Platform-generated views (quick find, lookup, associated) exist once per table: adjust, never duplicate.
  for (const adjustment of extrasSpec.platformViewAdjustments ?? []) {
    const rows = await client
      .list(
        `savedqueries?$select=savedqueryid,name,fetchxml,layoutxml,isquickfindquery&$filter=returnedtypecode eq '${adjustment.table}' and querytype eq ${adjustment.queryType} and savedqueryid ne ${adjustment.retiredFixtureViewId}`,
      )
      .catch(() => []);
    const entry = {
      kind: 'platform-view',
      table: adjustment.table,
      queryType: adjustment.queryType,
      found: rows.length,
    };
    if (rows.length !== 1) {
      entry.action = 'unresolved';
      journal.push(entry);
      log(entry);
      continue;
    }
    const view = rows[0];
    platformViewIds[`${adjustment.table}:${adjustment.queryType}`] = view.savedqueryid;
    entry.id = view.savedqueryid;
    entry.name = view.name;
    const fetchxml = adjustment.retainDefault
      ? null
      : await fs.readFile(path.join(root, 'dataverse', adjustment.fetchFile), 'utf8');
    const layoutxml = adjustment.retainDefault
      ? null
      : await resolveViewTokens(await fs.readFile(path.join(root, 'dataverse', adjustment.layoutFile), 'utf8'));
    if (adjustment.retainDefault)
      entry.action = 'platform-default-retained'; // still a solution member below, so the export carries it
    else if (same(view.fetchxml, fetchxml) && same(view.layoutxml, layoutxml)) entry.action = 'exists';
    else {
      entry.action = 'update';
      if (apply) {
        if (!same(view.fetchxml, fetchxml))
          await client.request(`savedqueries(${view.savedqueryid})`, { method: 'PATCH', body: { fetchxml }, solution });
        await client.request(`savedqueries(${view.savedqueryid})`, { method: 'PATCH', body: { layoutxml }, solution });
      }
    }
    if (apply) await includeComponent(client, view.savedqueryid, 26, solution);
    // Retire the fixture's own earlier copy of this view type once no form references it.
    const retired = await client.optional(`savedqueries(${adjustment.retiredFixtureViewId})?$select=savedqueryid`);
    if (retired) {
      entry.retired = adjustment.retiredFixtureViewId;
      retirements.push(adjustment.retiredFixtureViewId);
    }
    journal.push(entry);
    log(entry);
  }
  for (const view of extrasSpec.views) {
    const fetchxml = await fs.readFile(path.join(root, 'dataverse', view.fetchFile), 'utf8');
    const layoutxml = await resolveViewTokens(await fs.readFile(path.join(root, 'dataverse', view.layoutFile), 'utf8'));
    const existing = await client.optional(
      `savedqueries(${view.id})?$select=savedqueryid,name,fetchxml,layoutxml,querytype,isdefault,isquickfindquery`,
    );
    const changed =
      existing &&
      (existing.name !== view.name || !same(existing.fetchxml, fetchxml) || !same(existing.layoutxml, layoutxml));
    const entry = {
      kind: 'view',
      id: view.id,
      name: view.name,
      action: existing ? (changed ? 'update' : 'exists') : 'create',
    };
    if (apply) {
      if (!existing)
        await client.request('savedqueries', {
          method: 'POST',
          body: {
            savedqueryid: view.id,
            name: view.name,
            returnedtypecode: view.table,
            querytype: view.queryType,
            fetchxml,
            layoutxml,
            ...(view.isQuickFind ? { isquickfindquery: true } : {}),
          },
          solution,
        });
      else if (changed) {
        // Commit the selection first, then the matching layout (the platform validates layout columns against stored FetchXML).
        if (!same(existing.fetchxml, fetchxml))
          await client.request(`savedqueries(${view.id})`, { method: 'PATCH', body: { fetchxml }, solution });
        await client.request(`savedqueries(${view.id})`, {
          method: 'PATCH',
          body: { name: view.name, layoutxml },
          solution,
        });
      }
      await includeComponent(client, view.id, 26, solution);
    }
    journal.push(entry);
    log(entry);
  }
  // Quick view forms first: main forms reference them from quick view controls.
  for (const form of [...extrasSpec.forms].sort((a, b) => (a.type === 6 ? 0 : 1) - (b.type === 6 ? 0 : 1))) {
    const formxml = await resolveViewTokens(await fs.readFile(path.join(root, 'dataverse', form.file), 'utf8'));
    const existing = await client.optional(`systemforms(${form.id})?$select=formid,name,formxml,type`);
    const changed = existing && (existing.name !== form.name || !same(existing.formxml, formxml));
    const entry = {
      kind: 'form',
      id: form.id,
      name: form.name,
      action: existing ? (changed ? 'update' : 'exists') : 'create',
    };
    if (apply) {
      if (!existing)
        await client.request('systemforms', {
          method: 'POST',
          body: {
            formid: form.id,
            name: form.name,
            objecttypecode: form.table,
            type: form.type,
            formxml,
            formactivationstate: 1,
          },
          solution,
        });
      else if (changed)
        await client.request(`systemforms(${form.id})`, {
          method: 'PATCH',
          body: { name: form.name, formxml },
          solution,
        });
      await includeComponent(client, form.id, 60, solution);
    }
    journal.push(entry);
    log(entry);
  }
  // Table creation also makes platform "Active …"/"Inactive …" public views. Dataverse refuses to delete them
  // ("System-defined views cannot be deleted"), so a fixture view of the same name takes the default flag and the
  // platform twin stays as a non-default system view (the journal records it; the inventory lists it).
  const fixtureIds = new Set(extrasSpec.views.map((v) => v.id.toLowerCase()));
  for (const table of new Set(extrasSpec.views.map((v) => v.table))) {
    const names = new Set(extrasSpec.views.filter((v) => v.table === table).map((v) => v.name));
    const rows = await client.list(
      `savedqueries?$select=savedqueryid,name,isdefault&$filter=returnedtypecode eq '${table}' and querytype eq 0`,
    );
    for (const row of rows) {
      if (fixtureIds.has(row.savedqueryid.toLowerCase()) || !names.has(row.name)) continue;
      const fixture = extrasSpec.views.find((v) => v.table === table && v.name === row.name);
      const entry = {
        kind: 'platform-twin-view',
        table,
        name: row.name,
        id: row.savedqueryid,
        action: row.isdefault ? (apply ? 'undefault' : 'pending') : 'exists',
      };
      if (apply && row.isdefault) {
        try {
          await client.request(`savedqueries(${row.savedqueryid})`, {
            method: 'PATCH',
            body: { isdefault: false },
            solution,
          });
          if (fixture.isDefault)
            await client.request(`savedqueries(${fixture.id})`, {
              method: 'PATCH',
              body: { isdefault: true },
              solution,
            });
        } catch (error) {
          entry.action = 'undefault-refused';
          entry.error = String(error.message).slice(0, 120);
        }
      }
      journal.push(entry);
      log(entry);
    }
  }
  for (const id of retirements) {
    const entry = { kind: 'retired-view', id, action: apply ? 'delete' : 'pending' };
    if (apply) {
      try {
        await client.request(`savedqueries(${id})`, { method: 'DELETE' });
      } catch (error) {
        // Another component (a site list or subgrid setting) still names this view: keep it, report it.
        entry.action = 'delete-refused-referenced';
        entry.error = String(error.message).slice(0, 120);
      }
    }
    journal.push(entry);
    log(entry);
  }
}

async function ensureViewFlags(client, extrasSpec, { apply, journal }) {
  for (const view of extrasSpec.quickFindViews ?? []) {
    const current = await client.optional(`savedqueries(${view.id})?$select=isquickfindquery,querytype`);
    if (!current) continue;
    const entry = { kind: 'quick-find-flag', id: view.id, action: current.isquickfindquery ? 'exists' : 'update' };
    if (!current.isquickfindquery && apply)
      await client.request(`savedqueries(${view.id})`, { method: 'PATCH', body: { isquickfindquery: true } });
    journal.push(entry);
    log(entry);
  }
  for (const view of extrasSpec.defaultViews) {
    const current = await client.optional(`savedqueries(${view.id})?$select=isdefault`);
    if (!current) continue;
    const entry = { kind: 'default-view', id: view.id, action: current.isdefault ? 'exists' : 'update' };
    if (!current.isdefault && apply)
      await client.request(`savedqueries(${view.id})`, { method: 'PATCH', body: { isdefault: true } });
    journal.push(entry);
    log(entry);
  }
}

// Activation reserializes XAML and regenerates designer labels. Compare the executable
// workflow, retaining operands, typed literals, action order and localized messages.
export function ruleFingerprint(xaml) {
  if (!xaml) return null;
  // Property elements use Type.Member names, beyond the shared metadata parser's grammar.
  const tree = JSON.parse(metadataXml(String(xaml).replace(/(<\/?[\w:-]+)\.(?=\w)/g, '$1-')));
  const scopes = new WeakMap();
  const resolve = (name, scope) => {
    const at = name.indexOf(':');
    const prefix = at < 0 ? '' : name.slice(0, at),
      local = at < 0 ? name : name.slice(at + 1);
    return scope[prefix] ? `{${scope[prefix]}}${local}` : name;
  };
  const bind = (node, inherited) => {
    const scope = { ...inherited };
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name === 'xmlns') scope[''] = value;
      else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
    }
    scopes.set(node, scope);
    for (const child of node.children) bind(child, scope);
  };
  bind(tree, {});
  const local = (node) => node.name.slice(node.name.indexOf(':') + 1);
  const find = (node) => (local(node) === 'Workflow' ? node : node.children.map(find).find(Boolean));
  const workflow = find(tree);
  if (!workflow) throw new Error('Business rule XAML has no executable Workflow.');
  const expression = (value) => {
    const text = value.trim();
    if (!text.startsWith('[') || !text.endsWith(']')) return value;
    // Ignore VB formatting outside strings; quoted whitespace and doubled quotes are data.
    const tokens = [...text.matchAll(/"(?:""|[^"])*"|[A-Za-z_]\w*|[^\s]/g)].map(([token]) => token);
    if (tokens.includes("'")) return value; // Keep unfamiliar VB comments strictly comparable.
    return tokens.map((token) => (token.startsWith('"') ? token : token.toLowerCase()));
  };
  const canonical = (node) => {
    const scope = scopes.get(node);
    const attrs = Object.entries(node.attrs)
      .filter(([name]) => !name.startsWith('xmlns') && !['DisplayName', 'LabelId'].includes(name))
      .map(([name, value]) => {
        const key = name.slice(name.indexOf(':') + 1);
        if (['TypeArguments', 'TargetType'].includes(key) || (local(node) === 'ReferenceLiteral' && key === 'Value'))
          value = value.replace(/\b[\w]+:[\w]+/g, (type) => resolve(type, scope));
        return [name.includes(':') ? resolve(name, scope) : name, expression(value)];
      })
      .sort(([a], [b]) => a.localeCompare(b));
    const children = node.children.map(canonical);
    // These property bags are dictionaries. Activity collections retain execution order.
    if (['ActivityReference-Arguments', 'ActivityReference-Properties'].includes(local(node))) {
      children.sort((a, b) =>
        JSON.stringify(a.attrs.find(([key]) => key.endsWith('}Key'))?.[1] ?? '').localeCompare(
          JSON.stringify(b.attrs.find(([key]) => key.endsWith('}Key'))?.[1] ?? ''),
        ),
      );
    }
    return {
      name: resolve(node.name, scope),
      attrs,
      text: expression(local(node) === 'String' ? node.text : node.text.trim()),
      children,
    };
  };
  return JSON.stringify(canonical(workflow));
}

async function ensureBusinessRules(client, rules, { apply, solution, journal }) {
  for (const rule of rules) {
    const xaml = businessRuleXaml(rule);
    if (!xaml) {
      journal.push({
        kind: 'business-rule',
        id: rule.id,
        name: rule.name,
        action: 'skipped',
        reason: 'no XAML author yet',
      });
      continue;
    }
    const existing = await client.optional(
      `workflows(${rule.id})?$select=workflowid,name,statecode,processtriggerscope,processtriggerformid,xaml,triggeronupdateattributelist`,
    );
    // Designer rules keep scope 4; processtriggerscope is 2 = Entity or 1 = Form, with processtriggerformid
    // naming the form (null = All forms). Verified against the environment's own rules and option set.
    const scope = {
      entity: { processtriggerscope: 2 },
      'all-forms': { processtriggerscope: 1 },
      form: { processtriggerscope: 1, processtriggerformid: rule.formId },
    }[rule.scope ?? 'entity'];
    if (!scope || (rule.scope === 'form' && !/^[0-9a-f-]{36}$/i.test(rule.formId ?? '')))
      throw new Error(`Unsupported business rule scope for ${rule.name}`);
    const body = {
      name: rule.name,
      category: 2,
      type: 1,
      primaryentity: rule.table,
      scope: 4,
      ...scope,
      mode: 0,
      businessprocesstype: 0,
      xaml,
      clientdata: businessRuleClientData(rule),
      triggeroncreate: true,
      triggeronupdateattributelist: rule.when.field,
      description: `Paqvilo baseline fixture rule ${rule.name}`,
    };
    const wantForm = scope.processtriggerformid ?? null;
    const scopeChanged =
      existing &&
      (existing.processtriggerscope !== scope.processtriggerscope ||
        (existing.processtriggerformid ?? null) !== wantForm);
    const definitionChanged =
      existing &&
      (ruleFingerprint(existing.xaml) !== ruleFingerprint(xaml) ||
        existing.triggeronupdateattributelist !== body.triggeronupdateattributelist);
    const entry = {
      kind: 'business-rule',
      id: rule.id,
      name: rule.name,
      action: !existing
        ? 'create'
        : scopeChanged
          ? 'scope-updated'
          : definitionChanged
            ? 'definition-updated'
            : existing.statecode === 1
              ? 'active'
              : 'exists',
    };
    if (apply) {
      if (!existing)
        await client.request('workflows', { method: 'POST', body: { workflowid: rule.id, ...body }, solution });
      else if (scopeChanged || definitionChanged) {
        // Scope and definition live on the activated rule: deactivate, patch, reactivate.
        if (existing.statecode === 1)
          await client.request(`workflows(${rule.id})`, { method: 'PATCH', body: { statecode: 0, statuscode: 1 } });
        await client.request(`workflows(${rule.id})`, {
          method: 'PATCH',
          body: {
            processtriggerscope: scope.processtriggerscope,
            processtriggerformid: wantForm,
            xaml,
            clientdata: body.clientdata,
            triggeronupdateattributelist: body.triggeronupdateattributelist,
          },
          solution,
        });
      }
      const state = await client.get(`workflows(${rule.id})?$select=statecode`);
      if (state.statecode !== 1) {
        await client.request(`workflows(${rule.id})`, { method: 'PATCH', body: { statecode: 1, statuscode: 2 } });
        entry.activated = true;
      }
    }
    journal.push(entry);
    log(entry);
  }
}

async function ensureWebResource(client, spec, { apply, solution, journal }) {
  const rows = await client.list(`webresourceset?$select=webresourceid,content&$filter=name eq '${spec.name}'`);
  const content = spec.content;
  const entry = {
    kind: 'web-resource',
    name: spec.name,
    action: rows.length ? (rows[0].content === content ? 'exists' : 'update') : 'create',
  };
  if (apply) {
    if (!rows.length)
      await client.request('webresourceset', {
        method: 'POST',
        body: { name: spec.name, displayname: spec.displayName, webresourcetype: spec.type, content },
        solution,
      });
    else if (rows[0].content !== content)
      await client.request(`webresourceset(${rows[0].webresourceid})`, {
        method: 'PATCH',
        body: { content },
        solution,
      });
    const id =
      rows[0]?.webresourceid ??
      (await client.list(`webresourceset?$select=webresourceid&$filter=name eq '${spec.name}'`))[0]?.webresourceid;
    if (id) {
      await includeComponent(client, id, 61, solution);
      await client.request('PublishXml', {
        method: 'POST',
        body: {
          ParameterXml: `<importexportxml><webresources><webresource>{${id}}</webresource></webresources></importexportxml>`,
        },
      });
    }
  }
  journal.push(entry);
  log(entry);
}

/** Predecessor web resources, deleted once the forms no longer reference them (deletion also drops solution membership). */
async function retireWebResources(client, names, { apply, journal }) {
  for (const name of names) {
    const rows = await client.list(`webresourceset?$select=webresourceid&$filter=name eq '${name}'`);
    const entry = {
      kind: 'retired-web-resource',
      name,
      action: rows.length ? (apply ? 'delete' : 'pending') : 'absent',
    };
    if (rows.length && apply) await client.request(`webresourceset(${rows[0].webresourceid})`, { method: 'DELETE' });
    journal.push(entry);
    log(entry);
  }
}

/** Existing platform forms/views the site renders: solution membership only, the component itself is never written. */
async function ensurePlatformComponents(client, components, { apply, solution, journal }) {
  for (const component of components) {
    if (component.type === 2) {
      // Columns: resolved by logical name (MetadataId is environment-assigned for custom tables).
      const meta = await attribute(client, component.table, component.name);
      const entry = {
        kind: 'platform-component',
        type: 2,
        table: component.table,
        name: component.name,
        id: meta?.MetadataId ?? null,
        action: meta ? (apply ? 'include' : 'pending') : 'missing-or-mismatched',
      };
      if (meta && apply) await includeComponent(client, meta.MetadataId, 2, solution);
      journal.push(entry);
      log(entry);
      continue;
    }
    const row =
      component.type === 60
        ? await client
            .optional(`systemforms(${component.id})?$select=name,objecttypecode`)
            .then((r) => r && { name: r.name, table: r.objecttypecode })
        : await client
            .optional(`savedqueries(${component.id})?$select=name,returnedtypecode`)
            .then((r) => r && { name: r.name, table: r.returnedtypecode });
    const entry = {
      kind: 'platform-component',
      type: component.type,
      table: component.table,
      id: component.id,
      name: component.name,
    };
    if (!row || row.name !== component.name || row.table !== component.table) entry.action = 'missing-or-mismatched';
    else {
      entry.action = apply ? 'include' : 'pending';
      if (apply) await includeComponent(client, component.id, component.type, solution);
    }
    journal.push(entry);
    log(entry);
  }
}

/** Fixture tables are exported with all subcomponents (root component behaviour 0): self-contained solution. */
async function ensureTableRoots(client, tables, { apply, solution, journal }) {
  for (const table of tables) {
    const meta = await client.optional(`EntityDefinitions(LogicalName='${table}')?$select=MetadataId`);
    const entry = { kind: 'table-root', table, action: meta ? (apply ? 'include-all' : 'pending') : 'missing' };
    if (meta && apply)
      await client.request('AddSolutionComponent', {
        method: 'POST',
        body: {
          ComponentId: meta.MetadataId,
          ComponentType: 1,
          SolutionUniqueName: solution,
          AddRequiredComponents: false,
          DoNotIncludeSubcomponents: false,
        },
      });
    journal.push(entry);
    log(entry);
  }
}

async function ensureColumnSecurity(client, profile, { apply, solution, journal }) {
  const profiles = await client.list(
    `fieldsecurityprofiles?$select=fieldsecurityprofileid,name&$filter=name eq '${profile.name.replace(/'/g, "''")}'`,
  );
  let id = profiles[0]?.fieldsecurityprofileid ?? null;
  const entry = {
    kind: 'column-security-profile',
    name: profile.name,
    action: id ? 'exists' : 'create',
    permissions: [],
  };
  if (!id && apply) {
    const result = await client.request('fieldsecurityprofiles', {
      method: 'POST',
      body: { name: profile.name, description: 'Paqvilo baseline fixture: denies the secured column' },
      solution,
    });
    id = result.entityId?.match(/\(([0-9a-f-]{36})\)/i)?.[1] ?? null;
  }
  if (id) {
    for (const column of profile.columns) {
      const meta = await attribute(client, column.table, column.name);
      if (!meta) continue;
      const existing = await client.list(
        `fieldpermissions?$select=fieldpermissionid&$filter=_fieldsecurityprofileid_value eq ${id} and attributelogicalname eq '${column.name}' and entityname eq '${column.table}'`,
      );
      entry.permissions.push({ column: column.name, action: existing.length ? 'exists' : 'create' });
      if (!existing.length && apply)
        await client.request('fieldpermissions', {
          method: 'POST',
          body: {
            entityname: column.table,
            attributelogicalname: column.name,
            canread: column.read,
            canupdate: column.update,
            cancreate: column.create,
            'fieldsecurityprofileid@odata.bind': `/fieldsecurityprofiles(${id})`,
          },
          solution,
        });
    }
  }
  journal.push(entry);
  log(entry);
}

async function main() {
  const { values } = parseArgs({
    options: {
      connection: { type: 'string' },
      apply: { type: 'boolean' },
      export: { type: 'boolean' },
      'skip-manifest': { type: 'boolean' },
    },
  });
  if (!values.connection) throw new Error('--connection <private connection.json> is required.');
  const apply = Boolean(values.apply);
  const info = await loadConnection(values.connection);
  const client = connectedClient(info);
  // The toolkit client withholds server bodies; keep the last failure privately for diagnosis.
  const privateDir = path.join(root, '.paqvilo/baseline');
  await fs.mkdir(privateDir, { recursive: true });
  const nativeFetch = client.fetch;
  client.fetch = async (...params) => {
    const response = await nativeFetch(...params);
    if (!response.ok) {
      const text = await response
        .clone()
        .text()
        .catch(() => '');
      await fs.writeFile(
        path.join(privateDir, 'last-api-error.json'),
        JSON.stringify(
          {
            time: new Date().toISOString(),
            url: String(params[0]).replace(/^https?:\/\/[^/]+/, ''),
            status: response.status,
            body: text.slice(0, 4000).replace(/Bearer\s+\S+/g, 'Bearer [redacted]'),
          },
          null,
          2,
        ),
      );
      console.error(
        JSON.stringify({
          apiError: response.status,
          url: String(params[0])
            .replace(/^https?:\/\/[^/]+/, '')
            .slice(0, 160),
          message: (() => {
            try {
              return JSON.parse(text).error?.message?.slice(0, 400);
            } catch {
              return text.slice(0, 200);
            }
          })(),
        }),
      );
    }
    return response;
  };
  // Metadata writes queue behind the platform's customization job: wait and retry on 429.
  const nativeRequest = client.request.bind(client);
  client.request = async (relative, options = {}) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await nativeRequest(relative, options);
      } catch (error) {
        if (error.status !== 429 || attempt >= 12) throw error;
        const wait = Math.min(90, Number(error.retryAfter) || 15 * attempt);
        log({ retry: relative.slice(0, 120), attempt, waitSeconds: wait });
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    }
  };
  await client.verify(info.organisationId);
  const manifest = await readManifest(path.join(root, 'dataverse/manifest.json'));
  const extrasSpec = JSON.parse(await fs.readFile(path.join(root, 'dataverse/extras.json'), 'utf8'));
  const solution = extrasSpec.solution;
  const journal = [];
  const stamp = Date.now();
  if (!values['skip-manifest']) {
    if (apply) {
      const result = await applyManifest(manifest, {
        client,
        journalFile: path.join(privateDir, `manifest-apply-${stamp}.json`),
        expectedOrganisationId: info.organisationId,
        onProgress: (entry) => log({ manifest: entry.key ?? entry.kind, status: entry.status ?? entry.state }),
      });
      log({ manifest: 'applied', summary: result.summary ?? null });
    } else {
      const plan = await planManifest(manifest, { client });
      log({ manifest: 'plan', summary: plan.summary });
    }
  }
  const options = { apply, solution, journal };
  for (const column of extrasSpec.columns.filter((c) => c.kind !== 'rollup'))
    await ensureExtraColumn(client, column, options);
  await ensureCustomerLookup(client, extrasSpec.customerLookup, options);
  await ensurePolymorphicLookup(client, extrasSpec.polymorphicLookup, options);
  await ensureImage(client, extrasSpec.image, options);
  for (const column of extrasSpec.columns.filter((c) => c.kind === 'rollup'))
    await ensureExtraColumn(client, column, options);
  for (const [table, reasons] of Object.entries(extrasSpec.statusReasons))
    await ensureStatusReasons(client, table, reasons, options);
  if (extrasSpec.webResource) await ensureWebResource(client, extrasSpec.webResource, options); // forms reference it
  await ensureFormsAndViews(client, extrasSpec, options);
  await ensureViewFlags(client, extrasSpec, options);
  await ensureBusinessRules(client, extrasSpec.businessRules, options);
  await ensureColumnSecurity(client, extrasSpec.columnSecurityProfile, options);
  if (extrasSpec.platformComponents) await ensurePlatformComponents(client, extrasSpec.platformComponents, options);
  if (extrasSpec.includeAllSubcomponents) await ensureTableRoots(client, extrasSpec.includeAllSubcomponents, options);
  if (apply) {
    log(await publishManifest(manifest, client));
    log(await checkKeys(manifest, client));
  }
  // The published forms must stop naming a predecessor before Dataverse lets it go (the dependency follows the published form).
  if (extrasSpec.webResource?.retire) await retireWebResources(client, extrasSpec.webResource.retire, options);
  await fs.writeFile(
    path.join(privateDir, `${apply ? 'apply' : 'plan'}-${stamp}.json`),
    JSON.stringify({ apply, startedAt: new Date(stamp).toISOString(), journal }, null, 2),
  );
  if (values.export) {
    const zip = path.join(privateDir, `${solution}-${stamp}.zip`);
    const unpack = path.join(root, 'solution');
    await fs.rm(unpack, { recursive: true, force: true });
    log(await exportSolution({ client, solutionName: solution, zipFile: zip, unpackFolder: unpack }));
    // System-layer requirements (unmodified platform columns the solution lists itself) are always present on import.
    const missing = [
      ...(await fs.readFile(path.join(unpack, 'Other', 'Solution.xml'), 'utf8')).matchAll(
        /<MissingDependency>[\s\S]*?<\/MissingDependency>/g,
      ),
    ].filter(([entry]) => !/<Required\b[^>]*\bsolution="System \(/.test(entry)).length;
    if (missing)
      throw new Error(
        `Exported solution is not self-contained: ${missing} MissingDependency entries in Other/Solution.xml.`,
      );
  }
  log({
    done: true,
    apply,
    entries: journal.length,
    changes: journal.filter((e) => !['exists', 'active'].includes(e.action)).length,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
