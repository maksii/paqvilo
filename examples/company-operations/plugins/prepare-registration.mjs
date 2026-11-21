import { readManifest } from '../../../lense/dataverse/index.mjs';
import { registration } from './registration.mjs';
import { cli, formatJson } from '../cli.mjs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/prepare-registration.mjs [--out FILE]

Regenerates the plug-in step registry from dataverse/manifest.json. Offline.

  --out FILE  output file (default: plugins/registrations.json in this example);
              a relative path resolves from the working directory`,
  { out: { type: 'string' } },
);
const root = dirname(fileURLToPath(import.meta.url));
const manifest = await readManifest(resolve(root, '../dataverse/manifest.json'));
const value = registration(manifest);
await writeFile(values.out ? resolve(values.out) : resolve(root, 'registrations.json'), formatJson(value));
console.log(
  JSON.stringify({
    assemblies: value.assemblies.length,
    pluginTypes: value.assemblies.reduce((n, a) => n + a.types.length, 0),
    steps: value.steps.length,
    mode: 'AuthoredRegistry.RequiresLiveMetadataQualification',
  }),
);
