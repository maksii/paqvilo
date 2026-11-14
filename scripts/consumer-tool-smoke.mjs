import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Compare the actual state location without accepting a linked escape or rejecting an aliased project. */
export function consumerStateIsOwned(project, file) {
  const root = path.join(fs.realpathSync.native(project), '.paqvilo');
  const relative = path.relative(root, fs.realpathSync.native(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Exercise catalogue tools from the actual npm-installed package. */
export function verifyConsumerToolOwnership(bin, project, site = 'example') {
  const packageRoot = path.resolve(path.dirname(bin), '..');
  const config = path.join(project, 'paqvilo.config.yml');
  const report = () => {
    const result = spawnSync(
      process.execPath,
      [bin, 'mirage', 'bootstrap-report', '--config', config, '--site', site, '--json'],
      {
        cwd: path.dirname(project),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.status !== 0) throw new Error(`Installed bootstrap report failed: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const first = report();
  const second = report();
  const coldFile = first.summary.timings.cache.file;
  const warmFile = second.summary.timings.cache.file;
  if (![coldFile, warmFile].every((file) => consumerStateIsOwned(project, file)))
    throw new Error('Installed report cache escaped the consumer project.');
  if (path.relative(fs.realpathSync.native(coldFile), fs.realpathSync.native(warmFile)) !== '')
    throw new Error('Installed report did not reuse the same consumer cache file.');
  if (second.summary.timings.cache.hits <= 0 || second.summary.timings.cache.misses !== 0)
    throw new Error('Installed report did not reuse unchanged solution parses.');
  if (fs.existsSync(path.join(packageRoot, '.paqvilo')))
    throw new Error('Installed tools wrote a cache inside the package directory.');
  console.log(
    `Installed catalogue report cache reused: ${second.summary.timings.cache.hits} hits; solutions ${first.summary.timings.solutionsMs} ms cold, ${second.summary.timings.solutionsMs} ms warm.`,
  );
}
