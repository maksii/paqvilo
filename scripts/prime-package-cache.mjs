// Contributor bootstrap prepares the exact metadata needed by the offline tarball smoke test.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run npm run setup:repo or npm run cache:package.');
const lock = JSON.parse(fs.readFileSync('npm-shrinkwrap.json', 'utf8'));
const specs = [...new Set(Object.entries(lock.packages).filter(([name, entry]) => name && !entry.dev && !entry.link).map(([name, entry]) => `${name.split('node_modules/').pop()}@${entry.version}`))];
for (const spec of specs) {
  const result = spawnSync(process.execPath, [npmCli, 'cache', 'add', spec], { stdio: 'inherit', windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error(result.error?.message ?? `Cannot prepare offline package metadata for ${spec}`);
}
console.log(`Offline package cache prepared for ${specs.length} locked packages.`);
