import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { writeScaffold } from './scaffold.mjs';
import { editorFiles } from './project-editor.mjs';
import { identifier } from './config-schema.mjs';
import { developmentScript, developmentWorkflows } from './project-workflows.mjs';

const TEMPLATE = new URL('../templates/project/', import.meta.url);
const json = value => JSON.stringify(value, null, 2) + '\n';
const slug = /^[a-z0-9][a-z0-9-]*$/;
const unsafe = /^(?:constructor|prototype|__proto__|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeId(value, label) {
  if (!slug.test(value) || unsafe.test(value) || value.length > 64) throw new Error(`${label} must be a lowercase slug of at most 64 characters and cannot be a reserved name`);
}
const distinct = (values, label) => {
  for (const value of values) safeId(value, label);
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
  return values;
};
async function template(name, values = {}) {
  const body = await fs.readFile(new URL(name, TEMPLATE), 'utf8');
  return body.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => {
    if (values[key] === undefined) throw new Error(`Missing template value: ${key}`);
    return values[key];
  });
}

export function projectScripts({ sites, browser, packs, vscode }) {
  const config = '--config ./paqvilo.config.yml';
  const lense = command => `paqvilo lense ${command} ${config}`;
  const mirage = command => `paqvilo mirage ${command} ${config}`;
  const unit = packs.length ? packs.map(pack => `${pack.directory}/test/*.test.mjs`).join(' ') : 'test/*.test.mjs';
  const scripts = {
    setup: 'node tools/bootstrap.mjs && npm run check:setup',
    'check:setup': 'paqvilo doctor --setup --config ./paqvilo.config.yml',
    'check:scaffold': 'paqvilo init --check --config ./paqvilo.config.yml',
    'check:project': 'paqvilo init --ready --config ./paqvilo.config.yml',
    configure: 'paqvilo setup --config ./paqvilo.config.yml --open',
    lense: 'paqvilo lense', mirage: 'paqvilo mirage',
  };
  if (vscode) scripts['editor:refresh'] = 'paqvilo init --refresh-editor --config ./paqvilo.config.yml';
  const workflows = developmentWorkflows({ sites });
  for (const [name, workflow] of Object.entries(workflows)) {
    scripts[name] = developmentScript(name, workflow);
  }
  for (const command of ['list', 'use', 'doctor', 'map', 'status', 'resources', 'agent', 'verify']) scripts[command] = lense(command);
  scripts['audit:resources'] = lense('audit');
  scripts['mirage:init'] = mirage('init');
  for (const command of ['start', 'status', 'stop']) scripts[`mirage:${command}`] = mirage(command);
  scripts['mirage:capture'] = mirage('capture-shell');
  scripts.test = `node --test --test-concurrency=4 --test-timeout=180000 ${unit}`;
  scripts['test:browser'] = 'node tools/test-browser.mjs';
  scripts.validate = 'npm test && npm run test:browser';
  scripts['validate:configured'] = 'npm run check:project && npm test && npm run test:browser -- --strict';
  return scripts;
}

export async function prepareProject(directory, options = {}) {
  const name = options.name ?? path.basename(path.resolve(directory));
  safeId(name, '--name');
  const sites = distinct(options.sites ?? ['portal'], '--site');
  if (!sites.length || sites.length > 100) throw new Error('--site requires between 1 and 100 sites');
  const packIds = options.noPack ? [] : distinct(options.packs ?? [name], '--pack');
  if (options.noPack && options.packs?.length) throw new Error('--no-pack cannot be combined with --pack');
  const env = options.defaultEnv ?? 'dev';
  safeId(env, '--default-env'); identifier(env, '--default-env');
  const browser = options.browser ?? 'msedge';
  if (!['msedge', 'chrome', 'chromium'].includes(browser)) throw new Error('--browser must be msedge, chrome or chromium');
  const sourceRoot = options.sourceRoot ?? './sources';
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim() || /[\x00-\x1f\x7f]/.test(sourceRoot)) throw new Error('--source-root must be a non-empty path without control characters');
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { version } = metadata;
  const docs = metadata.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') + '/blob/main/';
  const toolkit = options.toolkit ?? `^${version}`;
  if (!toolkit.trim() || /[\x00-\x1f\x7f]/.test(toolkit)) throw new Error('--toolkit must be a non-empty dependency specification');
  const packs = packIds.map(id => ({ id, directory: packIds.length === 1 ? 'pack' : `packs/${id}` }));
  const vscode = !options.noVscode;
  const scripts = projectScripts({ sites, browser, packs, vscode });
  const config = { sourceRoot, defaultSite: sites[0], portals: 'all', sites: Object.fromEntries(sites.map((site, index) => [site, {
    source: `${site}-portal`, defaultEnv: env, environments: { [env]: `https://${site}-${env}.example.test` },
    mirage: { port: 8787 + index, ...(packs.length ? { dataPacks: packs.map(pack => ({ id: pack.id, module: `./${pack.directory}/pack.mjs` })) } : {}) },
  }])), defaults: { scope: 'all', markup: { baseline: 'HEAD' }, mirage: { solutionRoots: [] } }, browser: { channel: browser } };
  const doc = new YAML.Document(config);
  doc.commentBefore = ' Shared catalogue. Personal choices belong in .env or paqvilo.config.local.yml.';
  doc.get('sourceRoot', true).comment = ' TODO(paqvilo-init): folder holding portal exports and unpacked Solutions';
  for (const site of sites) {
    doc.getIn(['sites', site, 'source'], true).comment = ' TODO(paqvilo-init): export folder relative to sourceRoot';
    doc.getIn(['sites', site, 'environments', env], true).comment = ' TODO(paqvilo-init): real development portal URL; mark real-data environments caution: true';
  }
  doc.getIn(['defaults', 'mirage', 'solutionRoots'], true).comment = ' TODO(paqvilo-init): list unpacked Solution roots relative to sourceRoot, or confirm none are needed';
  const files = {
    'package.json': json({ name, private: true, type: 'module', engines: { node: metadata.engines.node }, scripts, devDependencies: { paqvilo: toolkit }, paqvilo: { scaffold: 1, vscode } }),
    'paqvilo.config.yml': String(doc),
    '.gitignore': await template('gitignore.template'), '.gitattributes': await template('gitattributes.template'),
    '.editorconfig': await template('editorconfig.template'), '.node-version': metadata.engines.node.match(/\d+/)[0] + '\n',
    'README.md': await template('README.md', { name, docs, version, node: metadata.engines.node.match(/\d+/)[0], editorStep: vscode ? 'Run `npm run editor:refresh` after configuration changes; inspect any script proposals and edited-file alternatives.' : 'Editor generation is disabled; use `paqvilo init --refresh-editor --workspace-only` if you want an ignored workspace file.' }), 'AGENTS.md': await template('AGENTS.md', { name, docs }),
    'tools/bootstrap.mjs': await template('bootstrap.mjs.template'),
    'docs/configuration.md': await template('configuration.md', { docs }),
    'docs/configuration.example.yml': await template('configuration.example.yml'),
    'docs/data-lifecycle.md': await template('data-lifecycle.md', { docs }),
    'support/site.mjs': await template('support-site.mjs.template'),
    'tools/browser-reporter.mjs': await template('browser-reporter.mjs.template'),
    'docs/acceptance.md': await template('acceptance.md.template'),
    'tools/test-browser.mjs': await template('test-browser.mjs.template', { testRoots: JSON.stringify([...packs.map(pack => `${pack.directory}/test-browser`), 'test-browser']) }),
    '.env.example': `# Personal settings; CLI > shell > .env > catalogue. Paths resolve from this catalogue.\n#PAQVILO_REPO=${sourceRoot}\n#PAQVILO_SITE=${sites[0]}\n#PAQVILO_ENV=${env}\n#PAQVILO_BROWSER=${browser}\n#PAQVILO_PROFILE=feature\n#PAQVILO_SCOPE=all\n#PAQVILO_BASELINE=HEAD\n#PAQVILO_PORTALS=all\n` + sites.map(site => /^[a-z0-9]+$/.test(site) ? `#PAQVILO_${site.toUpperCase()}_SOURCE=${sourceRoot}/${site}-portal\n#PAQVILO_${site.toUpperCase()}_ENV_${env.toUpperCase().replaceAll('-', '_')}=https://${site}-${env}.example.test\n` : `# Site ${site}: use paqvilo.config.local.yml for per-site overrides (environment variable site IDs support alphanumerics only).\n`).join(''),
    'docs/workflows.md': await template('workflows.md', { commands: Object.entries(scripts).map(([script, command]) => `| \`npm run ${script}\` | \`${command}\` |`).join('\n') }),
  };
  if (packs.length) files['support/mirage.mjs'] = await template('support-mirage.mjs.template');
  else files['test/catalogue.test.mjs'] = await template('no-pack.test.mjs.template');
  for (const pack of packs) {
    files[`${pack.directory}/pack.mjs`] = await template('pack.mjs.template', { pack: pack.id });
    files[`${pack.directory}/README.md`] = await template('pack-README.md', { pack: pack.id, docs, project: packs.length === 1 ? '..' : '../..' });
    files[`${pack.directory}/test/pack.test.mjs`] = await template('pack.test.mjs.template', { pack: pack.id, support: packs.length === 1 ? '../../support/mirage.mjs' : '../../../support/mirage.mjs' });
    for (const folder of ['lib', 'generators', 'fixtures', 'acceptance', 'tools', 'test-browser']) files[`${pack.directory}/${folder}/.gitkeep`] = '';
  }
  for (const site of sites) files[`test-browser/fixtures/${site}/.gitkeep`] = '';
  files['test-browser/smoke.test.mjs'] = await template('smoke.test.mjs.template', {
    binding: packs.length ? "import { mirage } from '../support/mirage.mjs';" : "import { createSimulator } from 'paqvilo/mirage';",
    factory: packs.length ? 'mirage.createSimulator' : 'createSimulator', sites: JSON.stringify(sites),
  });
  if (vscode) {
    // Relative initial paths keep scaffolds byte-identical across target folders.
    const webRoot = path.isAbsolute(sourceRoot) ? sourceRoot : '${workspaceFolder}/' + sourceRoot.replaceAll('\\', '/').replace(/^\.\//, '');
    Object.assign(files, editorFiles({ name, sites, browser, sourceRoot: webRoot, scripts }));
  }
  const report = await writeScaffold(directory, files, { intoExisting: options.intoExisting });
  return { schemaVersion: 1, ok: true, ...report, ...(options.intoExisting ? { adoption: 'Files were added without merging existing package/configuration. Run paqvilo init --ready to review integration diagnostics.' } : {}), next: ['npm run setup', 'npm run configure', ...(vscode ? ['npm run editor:refresh'] : []), 'npm run check:scaffold', 'npm run check:project', 'npm run validate', 'npm run validate:configured'] };
}
