import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Exercise catalogue tools from the actual npm-installed package. */
export function verifyConsumerToolOwnership(bin, project, site = 'example') {
  const packageRoot = path.resolve(path.dirname(bin), '..');
  const config = path.join(project, 'paqvilo.config.yml');
  const stateRoot = path.join(project, '.paqvilo') + path.sep;
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
  if (!first.summary.timings.cache.file.startsWith(stateRoot))
    throw new Error('Installed report cache escaped the consumer project.');
  if (second.summary.timings.cache.hits <= 0 || second.summary.timings.cache.misses !== 0)
    throw new Error('Installed report did not reuse unchanged solution parses.');
  if (fs.existsSync(path.join(packageRoot, '.paqvilo')))
    throw new Error('Installed tools wrote a cache inside the package directory.');
  console.log(
    `Installed catalogue report cache reused: ${second.summary.timings.cache.hits} hits; solutions ${first.summary.timings.solutionsMs} ms cold, ${second.summary.timings.solutionsMs} ms warm.`,
  );
}
