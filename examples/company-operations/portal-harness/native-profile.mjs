import { readFile, writeFile } from 'node:fs/promises';
import { snapshotHash } from './native-capture.mjs';

const identityFields = ['sdkmessageprocessingstepid', 'name', '_eventhandler_value', '_sdkmessageid_value', '_sdkmessagefilterid_value', '_impersonatinguserid_value', '_sdkmessageprocessingstepsecureconfigid_value', 'stage', 'rank', 'mode', 'configuration'];
const sameIdentity = (a, b) => identityFields.every(field => a[field] === b[field]);

export function planLateQueryProfile(registry, queryTypeId) {
  const messageIds = new Set(registry.messages.filter(message => message.name === 'RetrieveMultiple').map(message => message.sdkmessageid));
  const steps = registry.steps.filter(step => step._eventhandler_value === queryTypeId && messageIds.has(step._sdkmessageid_value) && step.mode === 0);
  const groups = new Map();
  for (const step of steps) {const key = step._sdkmessagefilterid_value; if (!key) throw new Error('Query observer profile requires table-bound registrations.'); const group = groups.get(key) ?? []; group.push(step); groups.set(key, group);}
  if (!groups.size) throw new Error('No registered query observer source.');
  const changes = [];
  for (const group of groups.values()) {
    const retained = group.filter(step => step.stage === 20 && step.rank === 9900 && step.statecode === 0);
    if (retained.length !== 1 || JSON.parse(retained[0].configuration).order !== 9900) throw new Error('Each native query table must have one active late PreOperation observer.');
    for (const step of group) if (step !== retained[0] && step.statecode === 0) {
      if (![[10, 1], [20, 1], [10, 10], [20, 10], [40, 9900]].some(([stage, rank]) => step.stage === stage && step.rank === rank)) throw new Error('Unqualified query observer registration would be disabled.');
      changes.push({id: step.sdkmessageprocessingstepid, before: step, desired: {statecode: 1, statuscode: 2}});
    }
  }
  return {schemaVersion: 1, profile: 'FinalQuery.PreOperation20.Order9900', tables: groups.size, preserved: steps.length - changes.length, retained: steps.filter(step => !changes.some(change => change.id === step.sdkmessageprocessingstepid)), changes, sourceStepStateHash: snapshotHash(registry.steps)};
}

/** A recoverable lease: journal before every mutation, conditional writes and
 * exact identity/configuration checks. Restoration never adopts foreign drift. */
export async function applyQueryProfile(client, plan, journalFile) {
  const journal = {...plan, startedAt: new Date().toISOString(), entries: [], state: 'preflight'};
  const save = () => writeFile(journalFile, JSON.stringify(journal, null, 2) + '\n');
  await writeFile(journalFile, JSON.stringify(journal, null, 2) + '\n', {flag: 'wx'});
  for (const retained of plan.retained) {
    const current = await client.get(`sdkmessageprocessingsteps(${retained.sdkmessageprocessingstepid})`);
    if (!sameIdentity(retained, current) || current.statecode !== retained.statecode || current.statuscode !== retained.statuscode) throw new Error('Retained final query observer drift.');
  }
  for (const change of plan.changes) {
    const current = await client.get(`sdkmessageprocessingsteps(${change.id})`);
    if (!sameIdentity(change.before, current) || current.statecode !== change.before.statecode || current.statuscode !== change.before.statuscode || !current['@odata.etag']) throw new Error('Query profile source drift or missing ETag.');
    journal.entries.push({...change, before: current, status: 'preflight'});
  }
  await save();
  for (const entry of journal.entries) {
    entry.status = 'pending-disable'; await save();
    await client.request(`sdkmessageprocessingsteps(${entry.id})`, {method: 'PATCH', body: entry.desired, ifMatch: entry.before['@odata.etag']});
    const actual = await client.get(`sdkmessageprocessingsteps(${entry.id})`);
    if (!sameIdentity(entry.before, actual) || actual.statecode !== 1 || actual.statuscode !== 2) throw new Error('Query profile disable readback failed.');
    entry.status = 'disabled'; await save();
  }
  journal.state = 'active'; journal.activatedAt = new Date().toISOString(); await save(); return journal;
}

export async function restoreQueryProfile(client, journalFile) {
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));
  if (journal.profile !== 'FinalQuery.PreOperation20.Order9900') throw new Error('Unknown native profile recovery journal.');
  const save = () => writeFile(journalFile, JSON.stringify(journal, null, 2) + '\n');
  for (const entry of journal.entries) {
    const actual = await client.get(`sdkmessageprocessingsteps(${entry.id})`);
    const knownState = (actual.statecode === entry.before.statecode && actual.statuscode === entry.before.statuscode) || (actual.statecode === 1 && actual.statuscode === 2);
    if (!sameIdentity(entry.before, actual) || !actual['@odata.etag'] || !knownState) throw new Error('Query profile restoration refused concurrent identity/state drift.');
    if (actual.statecode !== entry.before.statecode || actual.statuscode !== entry.before.statuscode) {
      entry.status = 'pending-restore'; await save();
      await client.request(`sdkmessageprocessingsteps(${entry.id})`, {method: 'PATCH', body: {statecode: entry.before.statecode, statuscode: entry.before.statuscode}, ifMatch: actual['@odata.etag']});
    }
    const restored = await client.get(`sdkmessageprocessingsteps(${entry.id})`);
    if (!sameIdentity(entry.before, restored) || restored.statecode !== entry.before.statecode || restored.statuscode !== entry.before.statuscode) throw new Error('Query profile restoration readback failed.');
    entry.status = 'restored'; await save();
  }
  journal.state = 'restored'; journal.restoredAt = new Date().toISOString(); await save(); return journal;
}
