import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, HOME_ID } from './fixture.mjs';

test('offline benchmark loads the current Lense implementation and measures refreshes without source writes', (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  fixture.write('web-files/theme.css', 'body { color: navy; }\n');
  fixture.write(
    'web-files/theme.css.webfile.yml',
    `adx_name: theme.css\nadx_partialurl: theme.css\nadx_parentpageid: ${HOME_ID}\nfilename: theme.css\nmimetype: text/css\n`,
  );
  const config = fixture.file('benchmark.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      sourceRoot: fixture.dir,
      sites: {
        invented: { source: '.', environments: { local: 'http://127.0.0.1:8787' } },
      },
    }),
  );
  const before = fixture.read('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../scripts/benchmark.mjs', import.meta.url)),
      '--config',
      config,
      '--site',
      'invented',
      '--samples',
      '1',
      '--json',
    ],
    {
      cwd: fixture.dir,
      // A hook's GIT_DIR would make the fixture's baseline the toolkit repository.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
      ),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.implementation, path.resolve(import.meta.dirname, '../lense'));
  assert.equal(report.offline, true);
  assert.equal(report.sourceWrites, false);
  for (const name of [
    'startup',
    'webFilePrepare',
    'webFileChangeTracking',
    'webFileRefresh',
    'inlineRefresh',
    'fullRefresh',
    'unrelatedSave',
  ]) {
    assert.equal(report.timings[name].samplesMs.length, 1, name);
    assert.ok(Number.isFinite(report.timings[name].medianMs), name);
  }
  assert.equal(fixture.read('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js'), before);
});
