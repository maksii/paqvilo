import { id } from './registration.mjs';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/update-guard-config.mjs [--connection FILE]

Run from the toolkit checkout. Writes the registered chain-step IDs into the three ChainNode guards in the live
environment (writes).

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const ids = [
  id('step/ChainA/pqvd_crudprobe/Update/40/100/0'),
  id('step/ChainB/pqvd_chainnode/Create/40/100/0'),
  id('step/ChainC/pqvd_chainnode/Update/40/100/0'),
];
for (const message of ['Create', 'Update', 'Delete']) {
  const step = id(`step/ChainNodeGuard/pqvd_chainnode/${message}/20/5/0`);
  const row = await c.get(`sdkmessageprocessingsteps(${step})?$select=configuration`);
  const configuration = JSON.parse(row.configuration);
  configuration.chainStepIds = ids;
  await c.request(`sdkmessageprocessingsteps(${step})`, {
    method: 'PATCH',
    body: { configuration: JSON.stringify(configuration) },
  });
}
console.log(
  JSON.stringify({
    state: 'Updated',
    guards: 3,
    chainProvenance: 'Configured step IDs + trusted parent identity + immutable operation binding',
  }),
);
