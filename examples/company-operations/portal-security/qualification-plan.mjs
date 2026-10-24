import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildBlueprint } from './blueprint.mjs';
import {
  buildQualificationDomain,
  scopeHierarchyVariantDomain,
  requiredNativeWitnesses,
} from './qualification-domain.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const manifestFile = option('--manifest');
if (!manifestFile)
  throw new Error('Provide the exact deployed harness --manifest. This planner performs no native mutations.');
const output = path.resolve(
  option('--out') ?? path.join(project, '.paqvilo/portal-security/qualification-' + Date.now() + '.json'),
);
if (!output.split(path.sep).includes('.paqvilo'))
  throw new Error('Store campaign input/evidence metadata under ignored .paqvilo.');
const [schema, catalogue, manifest] = await Promise.all([
  read(path.join(project, 'dataverse/manifest.json')),
  read(path.join(project, 'data/stress-catalogue.json')),
  read(manifestFile),
]);
const witnessFiles = option('--witnesses') ? await read(option('--witnesses')) : {};
if (
  !witnessFiles ||
  typeof witnessFiles !== 'object' ||
  Array.isArray(witnessFiles) ||
  Object.keys(witnessFiles).some((name) => !requiredNativeWitnesses.includes(name))
)
  throw new Error('Witnesses must map the five required native witness names to frozen private snapshot paths.');
const witnesses = {};
for (const [name, file] of Object.entries(witnessFiles)) {
  if (typeof file !== 'string' || !path.resolve(file).split(path.sep).includes('.paqvilo'))
    throw new Error('Native snapshots must stay in ignored .paqvilo.');
  witnesses[name] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}
const domain = buildQualificationDomain({
  blueprint: buildBlueprint(schema, catalogue),
  schema,
  catalogue,
  manifest,
  witnesses,
});
const plan = {
  preparedAt: new Date().toISOString(),
  qualification: 'plan-only',
  domain,
  scopeHierarchy: scopeHierarchyVariantDomain(),
  liveMutation: false,
  nativeExecution: false,
  protocol: [
    'Coordinator-owned mutation lease and exact before-state restoration',
    'Freeze native configuration/data/settings/template snapshots before and after each mask',
    'Require role associations and two repeated received-query principal footprints to stabilize',
    'Record exact authored/received query bytes, context and complete paged outcomes in both runtimes',
    'Persist a qualified comparison for every unique matrix cell; gaps remain incomplete',
  ],
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(plan, null, 2) + '\n');
console.log(
  JSON.stringify({
    kind: plan.qualification,
    domainHash: domain.domainHash,
    businessRoles: domain.businessRoles.length,
    roleMasks: domain.roleMaskCount,
    permissionReadCells: domain.readDomain.denominator,
    scopeHierarchyRequirements: plan.scopeHierarchy.denominator,
    missingNativeWitnesses: domain.missingNativeWitnesses,
    output,
    nativeExecution: false,
  }),
);
