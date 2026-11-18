import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/inspect-metadata.mjs [--connection FILE]

Run from the toolkit checkout. Reads solution component types and ChainNode privileges from the live environment.

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const r = await c.get(
  "EntityDefinitions(LogicalName='solutioncomponent')/Attributes(LogicalName='componenttype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet",
);
console.log(
  JSON.stringify(
    r.OptionSet.Options.filter((o) => o.Value >= 370).map((o) => ({
      value: o.Value,
      label: o.Label.UserLocalizedLabel?.Label,
    })),
    null,
    2,
  ),
);
const privileges = await c.get("EntityDefinitions(LogicalName='pqvd_chainnode')?$select=Privileges");
console.log(JSON.stringify(privileges));
