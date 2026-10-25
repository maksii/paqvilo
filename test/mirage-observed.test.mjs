// Observed platform behaviour (sites.<id>.mirage.observed): what a portal export cannot
// reveal, recorded with its evidence. It passes through the catalogue, is validated as the
// Mirage validates it, is written into project files by mirage init and is reported by
// list and doctor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createFixture } from './fixture.mjs';
import { loadConfig } from '../lense/config.mjs';
import { toolkitCommandHint, runToolkit as run } from './toolkit-cli.mjs';
// Reads of one catalogue state run concurrently: each CLI process costs a quarter of a second to start.
const runAll = (...commands) => Promise.all(commands.map((args) => run(...args)));
const json = (result) => {
  assert.ok(result.stdout.trim(), result.stderr);
  return JSON.parse(result.stdout);
};
const mirageOf = (result, site) => json(result).reports.find((item) => item.site === site).mirage;
const OBSERVED = { loginPath: '/SignIn', webApiInnerError: 'all-errors', evidence: 'notes/observed-signin.json' };
const solutionXml = (name) =>
  `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>1.0.0.0</Version><Managed>2</Managed><Publisher><CustomizationPrefix>sample</CustomizationPrefix></Publisher><RootComponents /></SolutionManifest></ImportExportXml>`;

/** A synthetic portal, one Solution root and a catalogue writer for sites with the given mirage settings. */
function workspace(t) {
  const portal = createFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-observed-')));
  t.after(() => {
    portal.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const root = path.join(work, 'solutions', 'Core');
  fs.mkdirSync(path.join(root, 'Other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Other', 'Solution.xml'), solutionXml('Core'));
  const config = path.join(work, 'paqvilo.config.yml');
  const write = (sites) =>
    fs.writeFileSync(
      config,
      YAML.stringify({
        defaultSite: Object.keys(sites)[0],
        sites: Object.fromEntries(
          Object.entries(sites).map(([id, mirage]) => [
            id,
            {
              source: portal.dir,
              environments: { dev: 'https://portal.example.com' },
              mirage: { solutionRoots: [root], ...mirage },
            },
          ]),
        ),
      }),
    );
  return { work, config, write };
}

test('mirage.observed passes through the catalogue to list and doctor; a malformed block is reported', async (t) => {
  const { config, write } = workspace(t);
  write({ site: { observed: OBSERVED }, plain: {} });
  assert.deepEqual((await loadConfig({ config, site: 'site', env: 'dev' })).mirageConfig.observed, OBSERVED);
  assert.equal((await loadConfig({ config, site: 'plain', env: 'dev' })).mirageConfig.observed, null);

  const [list, doctorSite, printed, doctorPlain] = await runAll(
    ['list', '--config', config, '--json'],
    ['doctor', '--config', config, '--site', 'site', '--json'],
    ['doctor', '--config', config, '--site', 'site'],
    ['doctor', '--config', config, '--site', 'plain', '--json'],
  );
  const byId = Object.fromEntries(json(list).sites.map((site) => [site.name, site]));
  assert.deepEqual(byId.site.mirage.resolved.observed, OBSERVED);
  assert.equal(byId.plain.mirage.resolved.observed, null);

  const mirage = mirageOf(doctorSite, 'site');
  assert.deepEqual([mirage.observed, mirage.observedSource], [OBSERVED, 'catalogue']);
  assert.deepEqual(mirage.errors, []);
  assert.match(
    printed.stdout,
    /mirage observed \(catalogue\): loginPath \/SignIn, webApiInnerError all-errors \(evidence: notes\/observed-signin\.json\)/,
  );
  const plain = mirageOf(doctorPlain, 'plain');
  assert.deepEqual([plain.observed, plain.observedSource], [null, null]);

  // Observed response headers are validated (names lowercased) and printed per response kind.
  write({
    headers: {
      observed: {
        headers: {
          page: { 'X-Content-Type-Options': 'nosniff' },
          webFile: { 'access-control-allow-origin': 'https://embed.example.com' },
        },
        evidence: 'notes/headers.json',
      },
    },
  });
  const [headersJson, headersPrinted] = await runAll(
    ['doctor', '--config', config, '--site', 'headers', '--json'],
    ['doctor', '--config', config, '--site', 'headers'],
  );
  const headers = mirageOf(headersJson, 'headers');
  assert.deepEqual(headers.observed, {
    headers: {
      page: { 'x-content-type-options': 'nosniff' },
      webFile: { 'access-control-allow-origin': 'https://embed.example.com' },
    },
    evidence: 'notes/headers.json',
  });
  assert.match(
    headersPrinted.stdout,
    /mirage observed \(catalogue\): headers \(page x-content-type-options=nosniff; webFile access-control-allow-origin=https:\/\/embed\.example\.com\) \(evidence: notes\/headers\.json\)/,
  );

  // An observation without its evidence, or with a value the Mirage does not know, is a
  // Mirage configuration error; a block that is not an object is rejected with the catalogue.
  write({
    site: { observed: { loginPath: '/SignIn' } },
    other: { observed: { webApiInnerError: 'sometimes', evidence: 'notes/x.json' } },
  });
  const [doctorMissing, doctorUnknown] = await runAll(
    ['doctor', '--config', config, '--site', 'site', '--json'],
    ['doctor', '--config', config, '--site', 'other', '--json'],
  );
  const missing = mirageOf(doctorMissing, 'site');
  assert.equal(missing.ready, false);
  assert.match(
    missing.errors.map((error) => error.message).join('\n'),
    /sites\.site\.mirage\.observed\.evidence must name the observation behind loginPath/,
  );
  const unknown = mirageOf(doctorUnknown, 'other');
  assert.match(
    unknown.errors.map((error) => error.message).join('\n'),
    /sites\.other\.mirage\.observed\.webApiInnerError must be all-errors or dataverse-errors/,
  );
  write({ site: { observed: '/SignIn' } });
  await assert.rejects(
    loadConfig({ config, site: 'site', env: 'dev' }),
    /sites\.site\.mirage\.observed must be an object/,
  );
});

test('mirage init records observed behaviour on the project portal, and the project file then applies', async (t) => {
  const { work, config, write } = workspace(t);
  write({ site: { observed: OBSERVED } });
  const project = path.join(work, 'site.project.yml');
  const init = await run('mirage', 'init', '--config', config, '--site', 'site', '--out', project, '--json');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).portal.observed, OBSERVED);
  assert.deepEqual(YAML.parse(fs.readFileSync(project, 'utf8')).portals[0].observed, OBSERVED);
  const printed = await run('mirage', 'init', '--config', config, '--site', 'site', '--out', project, '--force');
  assert.equal(printed.status, 0, printed.stdout + printed.stderr);
  assert.match(
    printed.stdout,
    /observed {3}loginPath \/SignIn, webApiInnerError all-errors \(evidence: notes\/observed-signin\.json\)/,
  );

  // With the project catalogued, its portal entry is what the Mirage applies; a catalogue
  // block that has changed since init is reported, not silently used.
  const changed = { loginPath: '/Account/Login', evidence: 'notes/observed-account-login.json' };
  write({ site: { project, observed: changed } });
  const doctor = mirageOf(await run('doctor', '--config', config, '--site', 'site', '--json'), 'site');
  assert.deepEqual([doctor.observed, doctor.observedSource], [OBSERVED, 'project']);
  const warning = doctor.warnings.find((item) => item.includes('sites.site.mirage.observed differs'));
  assert.match(warning, /observed differs from portal site in .*site\.project\.yml, whose observed behaviour applies/);
  const recommended = toolkitCommandHint([
    'mirage',
    'init',
    '--config',
    config,
    '--repo',
    work,
    '--site',
    'site',
    '--force',
  ]);
  assert.ok(warning.endsWith(`run ${recommended} to rewrite the project file`), warning);
  write({ site: { project, observed: OBSERVED } });
  const same = mirageOf(await run('doctor', '--config', config, '--site', 'site', '--json'), 'site');
  assert.deepEqual([same.observed, same.observedSource], [OBSERVED, 'project']);
  assert.doesNotMatch(same.warnings.join('\n'), /observed differs/);

  // An invalid block is refused before anything is written.
  const refused = path.join(work, 'refused.project.yml');
  write({ site: { observed: { loginPath: 'SignIn', evidence: 'notes/x.json' } } });
  const failed = await run('mirage', 'init', '--config', config, '--site', 'site', '--out', refused, '--json');
  assert.equal(failed.status, 1);
  assert.match(
    JSON.parse(failed.stdout).error.message,
    /sites\.site\.mirage\.observed\.loginPath must be a site-relative path such as \/SignIn/,
  );
  assert.equal(fs.existsSync(refused), false);
});
