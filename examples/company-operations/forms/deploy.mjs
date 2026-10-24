import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient, readManifest } from '../../../lense/dataverse/index.mjs';
import { privateJson } from '../../../lense/dataverse/connection.mjs';
import { compileForms } from './catalogue.mjs';
import { metadataXml } from '../../../lense/dataverse/provision.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function inspectFormMetadata(client, schema) {
  const metadata = {};
  for (const table of schema.tables.filter((t) => t.name !== 'transactioncurrency')) {
    metadata[table.name] = await client.get(
      `EntityDefinitions(LogicalName='${table.name}')?$select=LogicalName,PrimaryIdAttribute,PrimaryNameAttribute,ObjectTypeCode&$expand=Attributes($select=LogicalName,AttributeType,AttributeTypeName,DisplayName,IsValidForUpdate)`,
    );
  }
  return metadata;
}
export async function deployForms({ connection, apply = false }) {
  const info = await loadConnection(connection),
    client = connectedClient(info);
  await client.verify(info.organisationId);
  const originalFetch = client.fetch;
  client.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      await privateJson(path.join(project, '.paqvilo/forms/last-error.json'), {
        http: response.status,
        code: body?.error?.code,
        message: body?.error?.message,
      });
    }
    return response;
  };
  const schema = await readManifest(path.join(project, 'dataverse/manifest.json')),
    metadata = await inspectFormMetadata(client, schema),
    catalogue = compileForms(schema, metadata);
  const folder = path.join(project, '.paqvilo/forms');
  await fs.mkdir(folder, { recursive: true });
  await privateJson(path.join(folder, 'catalogue.json'), catalogue);
  const journal = { startedAt: new Date().toISOString(), apply, entries: [], checked: 0 };
  const file = path.join(folder, `${apply ? 'apply' : 'audit'}-${Date.now()}.json`);
  const solutions = await client.list(
    "solutions?$select=solutionid,uniquename&$filter=startswith(uniquename,'Paqvilo')",
  );
  const include = async (id, type, solution) => {
    const sid = solutions.find((s) => s.uniquename === solution)?.solutionid;
    if (!sid) throw new Error('Missing form solution ' + solution);
    const found = await client.list(
      `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sid} and componenttype eq ${type} and objectid eq ${id}`,
    );
    if (!found.length)
      await client.request('AddSolutionComponent', {
        method: 'POST',
        body: { ComponentId: id, ComponentType: type, SolutionUniqueName: solution, AddRequiredComponents: false },
      });
  };
  const compare = (actual, body) =>
    Object.entries(body).every(([k, v]) =>
      ['formxml', 'fetchxml', 'layoutxml'].includes(k)
        ? typeof actual[k] === 'string' && metadataXml(actual[k]) === metadataXml(v)
        : actual[k] === v,
    );
  const save = async (route, id, body, solution, type) => {
    const before = await client.optional(`${route}(${id})`);
    if (before && body.name && before.name !== body.name)
      throw new Error('Stable form/view ID collides with unrelated component');
    const differs = !before || !compare(before, body);
    journal.entries.push({
      id,
      route,
      name: body.name,
      status: differs ? (before ? 'update' : 'create') : 'exists',
      ...(differs && before ? { before } : {}),
      desired: body,
    });
    await privateJson(file, journal);
    if (apply) {
      if (differs) {
        if (before && route === 'savedqueries' && body.fetchxml && body.layoutxml) {
          // This environment validates generated Lookup layout columns against the
          // persisted FetchXML. Commit selection first, then its matching layout.
          if (before.fetchxml !== body.fetchxml)
            await client.request(`${route}(${id})`, { method: 'PATCH', body: { fetchxml: body.fetchxml }, solution });
          const remaining = { ...body };
          delete remaining.fetchxml;
          if (!compare(before, remaining))
            await client.request(`${route}(${id})`, { method: 'PATCH', body: remaining, solution });
        } else
          await client.request(before ? `${route}(${id})` : route, {
            method: before ? 'PATCH' : 'POST',
            body: before ? body : { ...body, [route === 'systemforms' ? 'formid' : 'savedqueryid']: id },
            solution,
          });
      }
      await include(id, type, solution);
    }
  };
  for (const v of catalogue.views)
    await save(
      'savedqueries',
      v.id,
      { name: v.name, returnedtypecode: v.table, querytype: 0, fetchxml: v.fetchXml, layoutxml: v.layoutXml },
      v.solution,
      26,
    );
  for (const f of catalogue.forms)
    await save(
      'systemforms',
      f.id,
      { name: f.name, objecttypecode: f.table, type: 2, formxml: f.formXml, formactivationstate: 1 },
      f.solution,
      60,
    );
  journal.quickFindImport = [];
  for (const v of catalogue.adjustments) {
    const rows = await client.list(
      `savedqueries?$select=savedqueryid,name,querytype,fetchxml,layoutxml,isquickfindquery&$filter=returnedtypecode eq '${v.table}' and querytype eq ${v.queryType}`,
    );
    if (rows.length !== 1)
      throw new Error(`Expected single generated ${v.table} view type ${v.queryType}, found ${rows.length}`);
    const body = {
      fetchxml: v.fetchXml,
      layoutxml: v.layoutXml,
      ...(v.queryType === 4 ? { isquickfindquery: true } : {}),
    };
    if (v.queryType === 4) {
      if (!compare(rows[0], body)) journal.quickFindImport.push({ ...v, id: rows[0].savedqueryid, before: rows[0] });
      if (apply) await include(rows[0].savedqueryid, 26, v.solution);
      continue;
    }
    await save('savedqueries', rows[0].savedqueryid, body, v.solution, 26);
  }
  for (const table of schema.tables.filter((t) => !t.existing)) {
    const defaultView = catalogue.views.find((v) => v.table === table.name),
      rows = await client.list(
        `savedqueries?$select=savedqueryid,name,isdefault&$filter=returnedtypecode eq '${table.name}' and querytype eq 0`,
      );
    for (const row of rows)
      if (row.isdefault !== (row.savedqueryid === defaultView.id))
        await save(
          'savedqueries',
          row.savedqueryid,
          { isdefault: row.savedqueryid === defaultView.id },
          defaultView.solution,
          26,
        );
  }
  if (apply) {
    await client.request('PublishXml', {
      method: 'POST',
      body: {
        ParameterXml: `<importexportxml><entities>${schema.tables
          .filter((t) => t.name !== 'transactioncurrency')
          .map((t) => `<entity>${t.name}</entity>`)
          .join('')}</entities></importexportxml>`,
      },
    });
    for (const f of catalogue.forms) {
      const actual = await client.get(`systemforms(${f.id})?$select=formid,name,formxml`);
      if (actual.name !== f.name || f.fields.some((name) => !actual.formxml.includes(`datafieldname="${name}"`)))
        throw new Error(`Form readback failed ${f.name}`);
      journal.checked++;
    }
    for (const v of catalogue.views) {
      const actual = await client.get(`savedqueries(${v.id})?$select=savedqueryid,name,fetchxml,layoutxml`);
      if (!compare(actual, { name: v.name, fetchxml: v.fetchXml, layoutxml: v.layoutXml }))
        throw new Error(`View readback failed ${v.name}`);
      journal.checked++;
    }
  }
  journal.finishedAt = new Date().toISOString();
  await privateJson(file, journal);
  await privateJson(path.join(folder, 'quickfind-import.json'), journal.quickFindImport);
  return {
    forms: catalogue.forms.length,
    views: catalogue.views.length,
    adjustments: catalogue.adjustments.length,
    quickFindImport: journal.quickFindImport.length,
    changed: journal.entries.filter((e) => e.status !== 'exists').length,
    checked: journal.checked,
    journal: file,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    connection = args[args.indexOf('--connection') + 1];
  if (!connection || !args.includes('--connection')) throw new Error('--connection required');
  console.log(JSON.stringify(await deployForms({ connection, apply: args.includes('--apply') })));
}
