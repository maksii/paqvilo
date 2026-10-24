import { randomUUID } from 'node:crypto';
import { dispatcher } from './compile.mjs';
import { componentId } from './deploy.mjs';
import { escapeXml, stable } from './core.mjs';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';
import { savePrivateJson } from './private-journal.mjs';

export function decodeBatchResponse(body, {operations, actor, roles, datasetVersion}) {
  const root = parseXmlDocument(body, {root: 'co-batch-response'});
  if (root.text.trim() || root.children.length !== operations.length) throw new Error('Batch envelope count or loose error text mismatch.');
  const find = (node, name) => node.name === name ? node : node.children.map(child => find(child, name)).find(Boolean);
  const seen = new Set(), expectedRoles = [...roles].sort();
  return root.children.map(node => {
    if (node.name !== 'co-test-response') throw new Error('Unexpected batch child envelope.');
    const id = node.attrs['operation-id'], operation = operations.find(operation => operation.id === id);
    if (!operation || seen.has(id)) throw new Error('Batch response has a foreign or repeated operation.'); seen.add(id);
    const observedRoles = (find(node, 'roles')?.children ?? []).map(role => role.text).sort();
    if (node.attrs['contact-id'] !== actor || node.attrs['dataset-version'] !== datasetVersion || node.attrs['case-id'] !== operation.plan.id || stable(observedRoles) !== stable(expectedRoles)) throw new Error('Batch response actor, role, case or dataset binding changed.');
    const rows = (find(node, 'records')?.children ?? []).map(record => Object.fromEntries(record.children.map(field => [field.attrs.name, field.attrs.null?.toLowerCase() === 'true' ? null : field.text])));
    const paging = find(node, 'paging'), more = paging?.attrs.more?.toLowerCase();
    return {operationId: id, outcome: node.attrs.outcome, rows, more: more === 'true' ? true : more === 'false' ? false : null,
      authoredFetchXml: find(node, 'authored-fetchxml')?.text, effectiveFetchXml: find(node, 'effective-fetchxml')?.text};
  });
}

export function batchDispatcher(manifest, maxQueries = 30) {
  if (!Number.isSafeInteger(maxQueries) || maxQueries < 1 || maxQueries > 30) throw new Error('Batch query bound must be 1..30.');
  const allPlans = {...manifest, cases: [...manifest.cases, ...(manifest.stressCases ?? [])]};
  const source = dispatcher(allPlans).replace('request.params.operationId', 'batch_operation_id');
  return `{% assign batch_operation_ids = request.params.operationIds | split: '|' %}<co-batch-response version="1">{% if batch_operation_ids.size >= 1 and batch_operation_ids.size <= ${maxQueries} %}{% for batch_operation_id in batch_operation_ids %}{% assign visibility_query = nil %}${source}{% endfor %}{% else %}<co-test-response outcome="rejected"><error>Batch operation bound exceeded.</error></co-test-response>{% endif %}</co-batch-response>`;
}

/** Add an isolated endpoint without changing the existing single-query page,
 * query partials, field allowlists or table-permission graph. */
export async function deployBatchEndpoint(client, config, manifest, journalFile) {
  const {website, role, published, language} = config;
  const namespace = config.batchNamespace ?? 'batch', partialUrl = config.batchPartialUrl ?? 'batch', label = config.batchLabel ?? 'Batch';
  if (!/^[a-z][a-z\d-]{0,31}$/.test(namespace) || !/^[a-z][a-z\d-]{0,31}$/.test(partialUrl) || !/^[A-Za-z ]{1,40}$/.test(label)) throw new Error('Explicit bounded batch endpoint identity required.');
  const id = key => componentId(website, `campaign-${namespace}:` + key);
  const components = [
    {key: 'template', type: 8, name: `CO Campaign ${label} Liquid Dispatcher`, content: {source: batchDispatcher(manifest), mimetype: 'application/xml'}},
    {key: 'pagetemplate', type: 6, name: `CO Campaign ${label} Liquid`, content: {entityname: 'adx_webpage', type: 756150001, usewebsiteheaderandfooter: false, webtemplateid: id('template')}},
    {key: 'page', type: 2, name: `CO Campaign ${label} Liquid`, content: {isroot: true, parentpageid: componentId(website, 'page:shell'), partialurl: partialUrl, pagetemplateid: id('pagetemplate'), publishingstateid: published, title: `Campaign ${label} Liquid`, hiddenfromsitemap: true}},
    {key: 'access', type: 10, name: `CO Campaign ${label} Require Runner`, content: {adx_webpageaccesscontrolrule_webrole: [role], right: 2, scope: 1, webpageid: id('page')}},
    ...(language ? [{key: 'contentpage', type: 2, name: `CO Campaign ${label} Liquid`, language, content: {isroot: false, rootwebpageid: id('page'), pagetemplateid: id('pagetemplate'), partialurl: partialUrl, publishingstateid: published, title: `Campaign ${label} Liquid`, hiddenfromsitemap: true}}] : []),
  ];
  const journal = {schemaVersion: 1, siteId: website, startedAt: new Date().toISOString(), manifestHash: manifest.manifestHash, entries: []};
  const save = () => savePrivateJson(journalFile, structuredClone(journal));
  await savePrivateJson(journalFile, structuredClone(journal), {exclusive: true});
  for (const component of components) {
    const endpoint = `powerpagecomponents(${id(component.key)})`, before = await client.optional(endpoint);
    if (before && (before._powerpagesiteid_value !== website || before.name !== component.name || before.powerpagecomponenttype !== component.type)) throw new Error('Batch component identity collision.');
    const body = {name: component.name, powerpagecomponenttype: component.type, content: JSON.stringify(component.content)};
    if (component.language) body['powerpagesitelanguageid@odata.bind'] = `/powerpagesitelanguages(${component.language})`;
    const entry = {id: id(component.key), key: component.key, before, planned: body, status: 'pending'}; journal.entries.push(entry); await save();
    if (!before) await client.request('powerpagecomponents', {method: 'POST', body: {...body, powerpagecomponentid: entry.id, 'powerpagesiteid@odata.bind': `/powerpagesites(${website})`}});
    else if (before.content !== body.content) {
      if (!before['@odata.etag']) throw new Error('Batch update requires an ETag.');
      await client.request(endpoint, {method: 'PATCH', body, ifMatch: before['@odata.etag']});
    }
    const actual = await client.get(endpoint);
    if (actual.content !== body.content || actual.statecode !== 0 || actual._powerpagesiteid_value !== website) throw new Error('Batch component readback failed.');
    entry.status = 'verified'; await save();
  }
  journal.finishedAt = new Date().toISOString(); await save();
  return {pageId: id('page'), path: `/permission-lab/${partialUrl}/`, components: components.length, journalFile};
}

/** Precreate recording intents using the configured application. The requests
 * being measured still come from the authenticated portal browser. Native
 * Create guards execute through the merged CreateMultiple pipeline. */
export async function prepareBatchIntents(client, {manifest, actor, roles, plans, journalFile}) {
  if (!Array.isArray(plans) || !plans.length || plans.length > 256) throw new Error('Intent preparation requires 1..256 physical plans.');
  if (plans.some(plan => !Number.isInteger(plan.page ?? 1) || (plan.page ?? 1) < 1 || (plan.page ?? 1) > (manifest.maxPages ?? 20))) throw new Error('Intent page number exceeds the frozen paging bound.');
  const journal = {schemaVersion: 1, startedAt: new Date().toISOString(), actor, roles, source: 'SDK-created immutable recording intents; measured reads are portal requests', runId: randomUUID(), entries: []};
  const save = () => savePrivateJson(journalFile, structuredClone(journal));
  await savePrivateJson(journalFile, structuredClone(journal), {exclusive: true});
  const nav = (table, field) => manifest.navigation?.[table]?.[field] ?? (() => {throw new Error('Verified native recording navigation is missing.');})();
  const run = {pqvd_testrunid: journal.runId, pqvd_name: 'CO Campaign ' + new Date().toISOString(), pqvd_runkey: randomUUID(),
    [nav('pqvd_testruns', 'pqvd_runnercontactid') + '@odata.bind']: `/contacts(${actor})`, pqvd_suiteversion: manifest.suiteVersion,
    pqvd_manifesthash: manifest.manifestHash, pqvd_datasetversion: manifest.datasetVersion, pqvd_sourcehash: manifest.sourceHash,
    pqvd_environment: 'Company Operations Demo', pqvd_startedat: new Date().toISOString(), pqvd_runstate: manifest.choices.pqvd_runstate.Running, pqvd_rolesnapshot: stable(roles)};
  journal.entries.push({kind: 'run', status: 'pending', body: run}); await save();
  await client.request('pqvd_testruns', {method: 'POST', body: run}); journal.entries[0].status = 'created'; await save();
  const runRecord=await client.get(`pqvd_testruns(${journal.runId})`);
  if(runRecord.pqvd_testrunid!==journal.runId||runRecord._pqvd_runnercontactid_value!==actor||!runRecord['@odata.etag'])throw new Error('Native owned Run readback failed.');
  journal.runRecord=runRecord;await save();
  const pairIds = new Map(plans.map(plan => [plan.id, randomUUID()]));
  const intents = plans.flatMap(plan => (plan.queryType === 'odata' ? ['webapi'] : ['liquid', 'webapi']).map(lane => ({plan, lane, id: randomUUID(), pairId: pairIds.get(plan.id)})));
  const targets = intents.map(intent => ({'@odata.type': 'Microsoft.Dynamics.CRM.pqvd_testoperation', pqvd_testoperationid: intent.id,
    pqvd_name: `${intent.plan.id} ${intent.lane} batch`, [nav('pqvd_testoperations', 'pqvd_runid') + '@odata.bind']: `/pqvd_testruns(${journal.runId})`,
    pqvd_pairkey: intent.pairId, pqvd_caseid: intent.plan.id, pqvd_lane: intent.lane === 'liquid' ? 183270000 : 183270001,
    pqvd_variant: intent.plan.variant ?? 'fetchxml', pqvd_phase: manifest.choices.pqvd_phase.Baseline, pqvd_attempt: 1,
    pqvd_pagenumber: intent.plan.page ?? 1, pqvd_expectedmessage: 'RetrieveMultiple', pqvd_roottable: intent.plan.table}));
  journal.entries.push({kind: 'operations', status: 'pending', ids: intents.map(intent => intent.id), bodies: targets}); await save();
  for (let offset = 0; offset < targets.length; offset += 60) {
    journal.entries[1].pendingOffset = offset; await save();
    await client.request('pqvd_testoperations/Microsoft.Dynamics.CRM.CreateMultiple', {method: 'POST', body: {Targets: targets.slice(offset, offset + 60)}});
    journal.entries[1].completedThrough = Math.min(offset + 60, targets.length); delete journal.entries[1].pendingOffset; await save();
  }
  const rows = [];
  for (let offset = 0; offset < intents.length; offset += 60) {
    const xml = `<fetch><entity name="pqvd_testoperation"><all-attributes/><filter><condition attribute="pqvd_testoperationid" operator="in">${intents.slice(offset, offset + 60).map(intent => `<value>${escapeXml(intent.id)}</value>`).join('')}</condition></filter></entity></fetch>`;
    rows.push(...await client.list(`pqvd_testoperations?fetchXml=${encodeURIComponent(xml)}`));
  }
  for (const intent of intents) {
    intent.operation = rows.find(row => row.pqvd_testoperationid === intent.id);
    if (!intent.operation || intent.operation._pqvd_runnercontactid_value !== actor || intent.operation.pqvd_markeroperation !== 'CO-OP:' + intent.id || !intent.operation.pqvd_markerutc?.startsWith('CO-UTC:')) throw new Error('Batch intent stamp/actor readback failed.');
    intent.operation.runId = journal.runId;
  }
  journal.entries[1].status = 'verified'; journal.operations = rows; journal.finishedAt = new Date().toISOString(); await save();
  return {runId: journal.runId, intents, runRecord, journalFile};
}
