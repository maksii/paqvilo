import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { writeScaffold } from './scaffold.mjs';
import { editorFiles } from './project-editor.mjs';
import { identifier } from './config-schema.mjs';

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
  const dev = `${lense('dev')} --headed --browser ${browser} --profile lense`;
  const local = `${mirage('dev')} --headed --browser ${browser} --profile mirage --preset-mode bootstrap`;
  const unit = packs.length ? packs.map(pack => `${pack.directory}/test/*.test.mjs`).join(' ') : 'test/*.test.mjs';
  const scripts = {
    setup: `npm install --ignore-scripts && paqvilo doctor --setup --browser ${browser}${vscode ? ' && paqvilo init --refresh-editor --config ./paqvilo.config.yml' : ''}`,
    'check:setup': `paqvilo doctor --setup --browser ${browser}`,
    'check:scaffold': 'paqvilo init --check --config ./paqvilo.config.yml',
    lense: 'paqvilo lense', mirage: 'paqvilo mirage',
    dev: `${dev} --portals all`, 'dev:pick': `${dev} --pick --portals selected`, 'dev:debug': 'npm run dev -- --debug-port 9222',
  };
  for (const site of sites) {
    scripts[`dev:${site}`] = `${dev} --site ${site} --portals selected`;
    scripts[`dev:${site}:debug`] = `npm run dev:${site} -- --debug-port 9222`;
  }
  for (const command of ['list', 'use', 'doctor', 'map', 'status', 'resources', 'agent', 'verify']) scripts[command] = lense(command);
  scripts['audit:resources'] = lense('audit');
  Object.assign(scripts, { 'mirage:init': mirage('init'), 'mirage:dev': `${local} --portals all`, 'mirage:dev:debug': 'npm run mirage:dev -- --debug-port 9223' });
  for (const site of sites) {
    scripts[`mirage:dev:${site}`] = `${local} --site ${site} --portals selected`;
    scripts[`mirage:dev:${site}:debug`] = `npm run mirage:dev:${site} -- --debug-port 9223`;
  }
  for (const command of ['start', 'status', 'stop']) scripts[`mirage:${command}`] = mirage(command);
  scripts['mirage:capture'] = mirage('capture-shell');
  scripts.test = `node --test --test-concurrency=4 --test-timeout=180000 ${unit}`;
  scripts['test:browser'] = 'node tools/test-browser.mjs';
  scripts.validate = 'npm test && npm run test:browser';
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
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
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
    'package.json': json({ name, private: true, type: 'module', engines: { node: '>=22' }, scripts, devDependencies: { paqvilo: toolkit }, paqvilo: { scaffold: 1, vscode } }),
    'paqvilo.config.yml': String(doc),
    '.gitignore': await template('gitignore.template'), '.gitattributes': await template('gitattributes.template'),
    '.editorconfig': await template('editorconfig.template'), '.node-version': '22\n',
    'README.md': await template('README.md', { name }), 'AGENTS.md': await template('AGENTS.md', { name }),
    'tools/test-browser.mjs': await template('test-browser.mjs.template', { testRoots: JSON.stringify([...packs.map(pack => `${pack.directory}/test-browser`), 'test-browser']) }),
    '.env.example': `# Personal settings; CLI > shell > .env > catalogue. Paths resolve from this catalogue.\n#PAQVILO_REPO=${sourceRoot}\n#PAQVILO_SITE=${sites[0]}\n#PAQVILO_ENV=${env}\n#PAQVILO_BROWSER=${browser}\n#PAQVILO_PROFILE=feature\n#PAQVILO_SCOPE=all\n#PAQVILO_BASELINE=HEAD\n#PAQVILO_PORTALS=all\n` + sites.map(site => /^[a-z0-9]+$/.test(site) ? `#PAQVILO_${site.toUpperCase()}_SOURCE=${sourceRoot}/${site}-portal\n#PAQVILO_${site.toUpperCase()}_ENV_${env.toUpperCase().replaceAll('-', '_')}=https://${site}-${env}.example.test\n` : `# Site ${site}: use paqvilo.config.local.yml for per-site overrides (environment variable site IDs support alphanumerics only).\n`).join(''),
    'docs/workflows.md': '# Project workflows\n\nRun these commands from the project folder. Lense browser actions and explicit shell capture can reach live portals; use only authorized environments. Mirage development and the generated tests use local sources.\n\n| npm script | Command |\n| --- | --- |\n' + Object.entries(scripts).map(([script, command]) => `| \`npm run ${script}\` | \`${command}\` |`).join('\n') + '\n',
  };
  if (packs.length) files['support/mirage.mjs'] = await template('support-mirage.mjs.template');
  else files['test/catalogue.test.mjs'] = await template('no-pack.test.mjs.template');
  for (const pack of packs) {
    files[`${pack.directory}/pack.mjs`] = await template('pack.mjs.template', { pack: pack.id });
    files[`${pack.directory}/README.md`] = await template('pack-README.md', { pack: pack.id });
    files[`${pack.directory}/test/pack.test.mjs`] = await template('pack.test.mjs.template', { pack: pack.id, support: packs.length === 1 ? '../../support/mirage.mjs' : '../../../support/mirage.mjs' });
    for (const folder of ['lib', 'generators', 'fixtures', 'acceptance', 'tools', 'test-browser']) files[`${pack.directory}/${folder}/.gitkeep`] = '';
  }
  for (const site of sites) files[`test-browser/fixtures/${site}/.gitkeep`] = '';
  files['test-browser/smoke.test.mjs'] = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nimport { ${packs.length ? 'mirage' : 'createSimulator'} } from '${packs.length ? '../support/mirage.mjs' : 'paqvilo/mirage'}';\n\n// TODO(paqvilo-init): add exported loopback fixtures and meaningful page assertions\nfor (const site of ${JSON.stringify(sites)}) {\n  const sourceDir = fileURLToPath(new URL(\`./fixtures/\${site}/\`, import.meta.url));\n  const present = fs.existsSync(new URL(\`./fixtures/\${site}/website.yml\`, import.meta.url));\n  test(\`\${site}: local portal smoke\`, { skip: present ? false : 'Add this site fixture (website.yml) before claiming page coverage' }, async () => {\n    const simulator = await ${packs.length ? 'mirage.' : ''}createSimulator({ sourceDir, port: 0, watch: false });\n    try {\n      const response = await fetch(simulator.url, { redirect: 'manual' });\n      assert.equal(response.status, 200);\n    } finally { await simulator.close(); }\n  });\n}\n`;
  if (vscode) {
    // Relative initial paths keep scaffolds byte-identical across target folders.
    const webRoot = path.isAbsolute(sourceRoot) ? sourceRoot : '${workspaceFolder}/' + sourceRoot.replaceAll('\\', '/').replace(/^\.\//, '');
    Object.assign(files, editorFiles({ name, sites, browser, sourceRoot: webRoot, scripts }));
  }
  const report = await writeScaffold(directory, files, { intoExisting: options.intoExisting });
  return { schemaVersion: 1, ok: true, ...report, next: ['npm run setup', 'paqvilo init --check', 'npm run validate'] };
}
