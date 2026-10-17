import fs from 'node:fs/promises';
import { resolveCatalogue } from 'paqvilo/lense';

const resolved = await resolveCatalogue({ config: './paqvilo.config.yml' });
const folders = [...new Set([process.cwd(), resolved.sourceRoot, ...resolved.sites.flatMap(site => [site.sourceDir, ...site.solutionRoots])])];
await fs.writeFile('portal.code-workspace', JSON.stringify({ folders: folders.map(path => ({ path })) }, null, 2) + '\n');
console.log('Wrote portal.code-workspace using this checkout’s resolved source paths.');
