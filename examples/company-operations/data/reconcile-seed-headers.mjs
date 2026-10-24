import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue, loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { privateJson } from '../../../lense/dataverse/connection.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The seed headers are explicitly unexecuted placeholders, never observations.
export async function reconcileSeedHeaders(connection) {
  const info = await loadConnection(connection),
    client = connectedClient(info);
  await client.verify(info.organisationId);
  const catalogue = await readCatalogue(path.join(project, 'data/stress-catalogue.json')),
    journal = { startedAt: new Date().toISOString(), entries: [] };
  const file = path.join(project, '.paqvilo/dataverse', `seed-header-migration-${Date.now()}.json`);
  for (const row of catalogue.records.filter((r) => r.table === 'pqvd_testrun')) {
    const actual = await client.get(
      `pqvd_testruns(${row.id})?$select=pqvd_runkey,pqvd_runstate,pqvd_manifesthash,pqvd_finishedat`,
    );
    if (
      actual.pqvd_runkey !== row.fields.pqvd_runkey ||
      !actual.pqvd_runkey.startsWith('CO-SEED-') ||
      actual.pqvd_runstate !== row.fields.pqvd_runstate ||
      actual.pqvd_finishedat
    )
      throw new Error('Seed header was executed or repurposed; migration refused.');
    if (actual.pqvd_manifesthash === row.fields.pqvd_manifesthash) continue;
    const results = await client.list(
        `pqvd_testresults?$select=pqvd_testresultid&$filter=_pqvd_runid_value eq ${row.id}&$top=1`,
      ),
      ops = await client.list(
        `pqvd_testoperations?$select=pqvd_testoperationid,pqvd_capturestate,pqvd_clientfinishedat,pqvd_backendfirstat&$filter=_pqvd_runid_value eq ${row.id}`,
      );
    if (results.length) throw new Error('Observed results attached to seed header; migration refused.');
    for (const operation of ops) {
      const fixture = catalogue.records.find(
        (r) => r.table === 'pqvd_testoperation' && r.id === operation.pqvd_testoperationid,
      );
      if (
        !fixture ||
        operation.pqvd_capturestate !== fixture.fields.pqvd_capturestate ||
        operation.pqvd_clientfinishedat ||
        operation.pqvd_backendfirstat
      )
        throw new Error('Executed operation attached to seed header; migration refused.');
      const events = await client.list(
        `pqvd_pluginevents?$select=pqvd_plugineventid&$filter=_pqvd_operationid_value eq ${operation.pqvd_testoperationid}&$top=1`,
      );
      if (events.length) throw new Error('Observed events attached to seed header; migration refused.');
    }
    journal.entries.push({
      key: row.key,
      id: row.id,
      before: actual.pqvd_manifesthash,
      after: row.fields.pqvd_manifesthash,
      status: 'Planned',
    });
    await privateJson(file, journal);
    await client.request(`pqvd_testruns(${row.id})`, {
      method: 'PATCH',
      ifMatch: actual['@odata.etag'],
      body: { pqvd_manifesthash: row.fields.pqvd_manifesthash },
    });
    journal.entries.at(-1).status = 'Updated';
    await privateJson(file, journal);
  }
  journal.finishedAt = new Date().toISOString();
  await privateJson(file, journal);
  return { updated: journal.entries.length, journal: file };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    connection = args[args.indexOf('--connection') + 1];
  if (!args.includes('--connection') || !connection) throw new Error('--connection required');
  console.log(JSON.stringify(await reconcileSeedHeaders(connection)));
}
