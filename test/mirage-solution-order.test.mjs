// Solution layer order: catalogue roots are a set layered in their dependency order (the order
// Solution discovery, bootstrap and the data scaffold use) unless a site sets
// mirage.solutionOrder: explicit. Synthetic Solution trees and loopback Mirages only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createFixture } from './fixture.mjs';
import { loadConfig } from '../lense/config.mjs';
import { mirageSettings } from '../lense/config-schema.mjs';
import { derivedSolutionOrder, initProject, mirageReadiness } from '../lense/commands/mirage.mjs';

const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
function run(...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')));
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 150_000 });
}
const STANDARD = ['createdon', 'createdby', 'modifiedon', 'modifiedby', 'statecode', 'statuscode'];
const attribute = (name, type) => `<attribute PhysicalName="${name}"><Type>${type}</Type><Name>${name}</Name><LogicalName>${name.toLowerCase()}</LogicalName></attribute>`;
/** A full table definition has the primary key and every standard system column. */
const entityXml = (name, full) => `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes>${
  full ? attribute(`${name}Id`, 'primarykey') + STANDARD.map((column) => attribute(column, column.endsWith('by') ? 'lookup' : 'datetime')).join('') : ''
}${attribute('sample_name', 'nvarchar')}</attributes></entity></EntityInfo></Entity>`;
const solutionXml = (name) => `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>1.0.0.0</Version><Managed>2</Managed><Publisher><CustomizationPrefix>sample</CustomizationPrefix></Publisher><RootComponents /></SolutionManifest></ImportExportXml>`;

/** Two Solution roots whose name order is the opposite of their dependency order. */
function solutionRoots(work) {
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const extension = path.join(work, 'solutions', 'A_Extension');
  const core = path.join(work, 'solutions', 'Z_Core');
  write(path.join(extension, 'Other', 'Solution.xml'), solutionXml('A_Extension'));
  write(path.join(extension, 'Entities', 'sample_item', 'Entity.xml'), entityXml('sample_item', false));
  write(path.join(core, 'Other', 'Solution.xml'), solutionXml('Z_Core'));
  write(path.join(core, 'Entities', 'sample_item', 'Entity.xml'), entityXml('sample_item', true));
  return { extension, core };
}

function workspace(t, mirage) {
  const portal = createFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-solution-order-')));
  t.after(() => { portal.cleanup(); fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const roots = solutionRoots(work);
  const config = path.join(work, 'paqvilo.config.yml');
  fs.writeFileSync(config, JSON.stringify({
    defaultSite: 'site',
    sites: { site: { source: portal.dir, environments: { dev: 'https://portal.example.com' }, mirage: { solutionRoots: [roots.extension, roots.core], ...mirage(work) } } },
  }, null, 2));
  return { work, config, roots };
}

test('Solution roots are layered in their dependency order, whatever the order they are listed in', async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-solution-derive-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { extension, core } = solutionRoots(work);
  assert.deepEqual(await derivedSolutionOrder([extension, core]), [core, extension]);
  assert.deepEqual(await derivedSolutionOrder([core, extension]), [core, extension]);
  assert.deepEqual(await derivedSolutionOrder([extension]), [extension]);
  assert.throws(() => mirageSettings({ solutionOrder: 'alphabetical' }, 'sites.site.mirage'), /solutionOrder must be derived .* or explicit/);
  assert.doesNotThrow(() => mirageSettings({ solutionOrder: 'explicit' }, 'sites.site.mirage'));
});

test('init writes solutionOrder derived with the solutions in dependency order; an explicit site keeps its list and is told the difference', async (t) => {
  const derivedSite = workspace(t, (work) => ({ project: path.join(work, 'derived.project.yml') }));
  const derivedCfg = await loadConfig({ config: derivedSite.config }, {});
  assert.equal(derivedCfg.mirageConfig.solutionOrder, 'derived');
  const written = await initProject(derivedCfg, {});
  assert.equal(written.solutionOrder, 'derived');
  assert.deepEqual(written.solutions.map((solution) => path.basename(solution.root)), ['Z_Core', 'A_Extension']);
  const document = YAML.parse(fs.readFileSync(written.file, 'utf8'));
  assert.equal(document.solutionOrder, 'derived');
  assert.deepEqual(document.solutions.map((solution) => solution.id), ['Z_Core', 'A_Extension']);
  assert.ok(!written.notes.some((note) => note.includes('solutionOrder')));

  const explicitSite = workspace(t, (work) => ({ project: path.join(work, 'explicit.project.yml'), solutionOrder: 'explicit' }));
  const explicitCfg = await loadConfig({ config: explicitSite.config }, {});
  const kept = await initProject(explicitCfg, {});
  assert.equal(kept.solutionOrder, 'explicit');
  assert.deepEqual(kept.solutions.map((solution) => path.basename(solution.root)), ['A_Extension', 'Z_Core']);
  assert.equal(YAML.parse(fs.readFileSync(kept.file, 'utf8')).solutionOrder, 'explicit');
  assert.ok(kept.notes.some((note) => note.includes('solutionOrder: explicit keeps the listed order A_Extension → Z_Core; the dependency order is Z_Core → A_Extension')));
});

test('doctor reports the order a runtime uses and warns when an explicit order differs from the dependency order', async (t) => {
  const dependencies = { projects: [{ name: 'mirage', ready: true }] };
  const checkPort = async () => true;
  const derivedSite = workspace(t, () => ({}));
  const derived = await mirageReadiness(await loadConfig({ config: derivedSite.config }, {}), { dependencies, checkPort });
  assert.equal(derived.solutionRoots.order, 'derived');
  assert.deepEqual(derived.solutionRoots.roots.map((root) => path.basename(root.path)), ['Z_Core', 'A_Extension']);
  assert.ok(!derived.warnings.some((warning) => warning.includes('dependency order')));

  const explicitSite = workspace(t, () => ({ solutionOrder: 'explicit' }));
  const explicit = await mirageReadiness(await loadConfig({ config: explicitSite.config }, {}), { dependencies, checkPort });
  assert.equal(explicit.solutionRoots.order, 'explicit');
  assert.deepEqual(explicit.solutionRoots.roots.map((root) => path.basename(root.path)), ['A_Extension', 'Z_Core']);
  assert.deepEqual(explicit.solutionRoots.derivedOrder.map((root) => path.basename(root)), ['Z_Core', 'A_Extension']);
  assert.ok(explicit.warnings.some((warning) => /sites\.site\.mirage layers its Solution roots in the listed order A_Extension → Z_Core \(solutionOrder: explicit\), which differs from their dependency order Z_Core → A_Extension/.test(warning)), explicit.warnings.join('\n'));

  // A project file that keeps an explicit order out of dependency order is reported the same way.
  const projectSite = workspace(t, (work) => ({ project: path.join(work, 'old.project.yml') }));
  const project = path.join(projectSite.work, 'old.project.yml');
  fs.writeFileSync(project, YAML.stringify({ version: 1, portals: [{ id: 'site', path: (await loadConfig({ config: projectSite.config }, {})).sourceDir }], solutions: [{ id: 'ext', path: projectSite.roots.extension }, { id: 'core', path: projectSite.roots.core }], solutionOrder: 'explicit' }));
  const old = await mirageReadiness(await loadConfig({ config: projectSite.config }, {}), { dependencies, checkPort });
  assert.equal(old.solutionRoots.order, 'explicit');
  assert.ok(old.warnings.some((warning) => warning.includes(`Mirage project ${project} layers its Solution roots in the listed order A_Extension → Z_Core`) && warning.includes('Set solutionOrder: derived or rerun mirage init --force')), old.warnings.join('\n'));
});

test('mirage start hands the Mirage its catalogue Solution roots in dependency order unless the site keeps an explicit order', { timeout: 300_000 }, async (t) => {
  for (const [mirage, expected] of [[{}, ['Z_Core', 'A_Extension']], [{ solutionOrder: 'explicit' }, ['A_Extension', 'Z_Core']]]) {
    const site = workspace(t, () => ({ port: 0, ...mirage }));
    const started = run('mirage', 'start', '--config', site.config, '--startup-timeout', '120000', '--json');
    try {
      assert.equal(started.status, 0, started.stdout + started.stderr);
      const session = JSON.parse(started.stdout);
      assert.deepEqual(session.launch.solutionRoots.map((root) => path.basename(root)), expected);
      const state = await (await fetch(new URL('/_sim/api/state?summary=1', session.url))).json();
      assert.deepEqual(state.status.bootstrap.solutionRoots.map((root) => path.basename(root)), expected, 'the runtime layers them in that order');
    } finally {
      const stopped = run('mirage', 'stop', '--config', site.config, '--json');
      assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    }
  }
});
