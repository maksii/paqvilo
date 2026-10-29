import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveReportInputs, bootstrapReport } from '../bootstrap-report.mjs';
import { resolveTarget } from '../render-sweep.mjs';
import { TOOL_OPTIONS, parseToolArgs } from '../tool-options.mjs';
import { MIRAGE_TOOLS } from '../tool-registry.mjs';
import { assertProjectOutput } from '../lib/project-output.mjs';
import { withProcessSlot } from './process-slots.mjs';
import { settleFileTimes } from './support/file-times.mjs';

const bin = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
// Resolves with the exit status instead of rejecting, so callers can assert failures too.
const runMirage = (args, timeout) =>
  withProcessSlot(
    () =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          [bin, 'mirage', ...args],
          { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout },
          (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
        ),
      ),
  );

async function fixture(t) {
  // The real path: reports name cache and state files as the OS resolves them (8.3 aliases expanded).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-tool-project-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'portal/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/web-pages/home/Home.webpage.copy.html': '<html><head></head><body><p>Fixture</p></body></html>',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName></SolutionManifest></ImportExportXml>',
    'solution/Entities/sample_item/Entity.xml':
      '<Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute PhysicalName="sample_name"><Type>nvarchar</Type><LogicalName>sample_name</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    'paqvilo.config.yml':
      'sourceRoot: .\nsites:\n  synthetic:\n    source: portal\n    environments: { dev: https://synthetic.example.test }\n    mirage:\n      solutionRoots: [./solution]\n',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return { root, config: path.join(root, 'paqvilo.config.yml') };
}

test('catalogue reports reuse their project cache and sweep selects the same project state', async (t) => {
  // The reuse assertions below concern files written moments ago.
  settleFileTimes(t);
  const { root, config } = await fixture(t);
  const input = await resolveReportInputs({ config, site: 'synthetic' });
  assert.equal(input.cacheFile, path.join(root, '.paqvilo/simulator/synthetic/cache/solution-sources.json'));
  const first = await bootstrapReport(input);
  const second = await bootstrapReport(await resolveReportInputs({ config, site: 'synthetic' }));
  assert.ok(first.summary.timings.cache.misses > 0);
  assert.ok(second.summary.timings.cache.hits > 0);
  assert.equal(second.summary.timings.cache.misses, 0);
  assert.deepEqual(second.tables, first.tables);
  const target = await resolveTarget({ config, site: 'synthetic' });
  assert.equal(target.stateFile, path.join(root, '.paqvilo/simulator/synthetic/state.json'));
  const uncached = await bootstrapReport(input, { noCache: true });
  assert.equal(uncached.summary.timings.cache.file, null);
  assert.equal(uncached.summary.timings.cache.hits, 0);
});

test('generated output rejects the installed package and a junction back into it', async (t) => {
  const { root } = await fixture(t);
  const installed = path.join(root, 'node_modules/paqvilo');
  await fs.mkdir(installed, { recursive: true });
  assert.throws(
    () => assertProjectOutput(path.join(installed, '.paqvilo/cache.json'), installed),
    /inside the installed package/,
  );
  assert.doesNotThrow(() => assertProjectOutput(path.join(root, '.paqvilo/cache.json'), installed));
  const alias = path.join(root, 'aliased-package');
  await fs.symlink(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => assertProjectOutput(path.join(alias, '.paqvilo/cache.json'), installed),
    /inside the installed package/,
  );
});

test('catalogue option tables produce registry help accepted by each parser and execute outside the project cwd', async (t) => {
  const { root, config } = await fixture(t);
  const runs = [];
  for (const [name, definitions] of Object.entries(TOOL_OPTIONS)) {
    const help = MIRAGE_TOOLS[name];
    for (const [key, definition] of Object.entries(definitions)) {
      if (key === 'help') continue;
      assert.ok(help.includes(`--${key}`), `${name}: ${key}`);
      const value =
        definition.label === 'SITE=ENV'
          ? 'synthetic=dev'
          : definition.label === 'PORTAL=NAME'
            ? 'synthetic=fixture'
            : 'fixture';
      assert.doesNotThrow(() => parseToolArgs(name, [`--${key}`, ...(definition.type === 'string' ? [value] : [])]));
    }
    // trace reads a running runtime's /_sim/api/trace, not the catalogue: its parser and help are checked above, and
    // cli-contract.test.mjs covers its structured errors without a runtime.
    if (name === 'trace') continue;
    const args = [name, '--config', config, '--json'];
    if (name !== 'portal-matrix') args.push('--site', 'synthetic');
    if (name === 'portal-matrix') args.push('--only', 'import,bootstrap,liquid,webapi');
    runs.push(runMirage(args, 30000).then((result) => ({ name, result })));
  }
  for (const { name, result } of await Promise.all(runs)) {
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.equal(typeof JSON.parse(result.stdout), 'object', name);
  }
  assert.ok((await fs.readdir(path.join(root, '.paqvilo/portal-matrix'))).length);
});

test('parity and conformance help name their real required plan options', async (t) => {
  const { root, config } = await fixture(t);
  const missing = path.join(root, 'missing-plan.json');
  assert.ok(MIRAGE_TOOLS['parity-suite'].includes('--scenarios FILE'));
  assert.ok(!MIRAGE_TOOLS['parity-suite'].includes('--plan'));
  assert.ok(MIRAGE_TOOLS['liquid-conformance'].includes('--suite FILE'));
  const results = await Promise.all(
    [
      [
        'parity-suite',
        '--config',
        config,
        '--site',
        'synthetic',
        '--out',
        path.join(root, '.paqvilo/parity'),
        '--scenarios',
        missing,
      ],
      ['liquid-conformance', '--suite', missing, '--json'],
    ].map((args) => runMirage(args, 10000)),
  );
  for (const [index, result] of results.entries()) {
    assert.notEqual(result.status, 0);
    const message = index === 1 ? JSON.parse(result.stdout).error.message : result.stderr;
    if (index === 1) assert.equal(result.stderr, '');
    assert.match(message, /ENOENT/);
    assert.doesNotMatch(message, /Unknown (?:argument|option)|ERR_PARSE_ARGS/);
  }
});
