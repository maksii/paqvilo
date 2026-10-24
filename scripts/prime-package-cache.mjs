// Contributor bootstrap prepares the exact metadata needed by the offline tarball smoke test.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run npm run setup:repo or npm run cache:package.');
const lock = JSON.parse(fs.readFileSync('npm-shrinkwrap.json', 'utf8'));
const specs = [
  ...new Set(
    Object.entries(lock.packages)
      .filter(([name, entry]) => name && !entry.dev && !entry.link)
      .map(([name, entry]) => `${name.split('node_modules/').pop()}@${entry.version}`),
  ),
];
for (const spec of specs) {
  const result = spawnSync(process.execPath, [npmCli, 'cache', 'add', spec], {
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(result.error?.message ?? `Cannot prepare offline package metadata for ${spec}`);
}
console.log(`Offline package cache prepared for ${specs.length} locked packages.`);

// npm may select a newer compatible transitive dependency when a tarball is
// installed into a fresh consumer. Resolve that actual package layout first,
// then cache its archives too; the smoke install itself remains offline.
const parent = path.resolve('.paqvilo', 'distribution');
fs.mkdirSync(parent, { recursive: true });
const preparation = fs.mkdtempSync(path.join(parent, 'cache-'));
const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? `Cannot prepare consumer cache: ${result.stderr}`);
  return result.stdout;
};
const packed = JSON.parse(
  run(['pack', '--json', '--ignore-scripts', '--pack-destination', preparation], process.cwd()),
)[0];
fs.writeFileSync(
  path.join(preparation, 'package.json'),
  JSON.stringify({
    name: 'paqvilo-cache-preparation',
    private: true,
    dependencies: { paqvilo: `file:${path.join(preparation, packed.filename).replaceAll('\\', '/')}` },
  }),
);
run(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], preparation);
const consumerLock = JSON.parse(fs.readFileSync(path.join(preparation, 'package-lock.json'), 'utf8'));
const archives = [
  ...new Set(
    Object.values(consumerLock.packages)
      .filter((entry) => !entry.dev && /^https:\/\//.test(entry.resolved ?? ''))
      .map((entry) => entry.resolved),
  ),
];
for (const archive of archives) run(['cache', 'add', archive], preparation);
console.log(
  `Consumer package cache prepared for ${archives.length} resolved archives; subsequent smoke installs remain offline.`,
);
