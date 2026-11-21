import fs from 'node:fs/promises';
import { cli } from './cli.mjs';

cli(`Usage: node editor-workspace.mjs

Run from this project's folder. Writes portal.code-workspace with this checkout's resolved source folders from
./paqvilo.config.yml. Offline.`);
// Imported after the arguments are handled, so --help and argument errors work before npm install.
const { resolveCatalogue } = await import('paqvilo/lense').catch((error) => {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'paqvilo'")) throw error;
  process.stderr.write('The paqvilo package is not installed in this project. Run npm install first.\n');
  process.exit(1);
});
const resolved = await resolveCatalogue({ config: './paqvilo.config.yml' });
const folders = [
  ...new Set([
    process.cwd(),
    resolved.sourceRoot,
    ...resolved.sites.flatMap((site) => [site.sourceDir, ...site.solutionRoots]),
  ]),
];
await fs.writeFile(
  'portal.code-workspace',
  JSON.stringify({ folders: folders.map((path) => ({ path })) }, null, 2) + '\n',
);
console.log('Wrote portal.code-workspace using this checkout’s resolved source paths.');
