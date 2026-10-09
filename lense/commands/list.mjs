// `paqvilo list`: the sites and environments that can be chosen, and what is in effect now.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalogue, loadDevTargets, ENV_SETTINGS, resolveMirageConfig } from '../config.mjs';
import { detectFormat } from '../portal-model.mjs';
import { browserProfileInfo } from '../browser-profile.mjs';

/** Portal extracts in the repository, whether configured or not. */
export function discoverExtracts(startDir) {
  let root = startDir;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: startDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim();
  } catch {
    /* not a git repository: look below the start folder only */
  }
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (detectFormat(dir)) {
      found.push(path.resolve(dir));
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !/^(?:node_modules|\.git|\.paqvilo|\.vscode)$/.test(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

export default async function list(_cfg, args) {
  const catalogue = loadCatalogue(args);
  let inEffect = null;
  let targets = [];
  let problem = null;
  try {
    const resolved = await loadDevTargets(args);
    inEffect = resolved.initial;
    targets = resolved.targets;
  } catch (err) {
    problem = err.message;
  }
  const rel = (dir) => path.relative(catalogue.configDir, dir).replace(/\\/g, '/') || '.';

  // Mirage settings as written (merged over defaults.mirage) and as the mirage command uses them.
  const mirageOf = (site) => ({ configured: site.mirage ?? null, resolved: resolveMirageConfig(site.mirage, { configDir: catalogue.configDir, sourceRoot: catalogue.sourceRoot }) });
  const mirageText = (resolved, { port = true } = {}) => [
    resolved.project ? `project ${rel(resolved.project)}` : null,
    resolved.solutionRoots.length ? `${resolved.solutionRoots.length} Solution root(s)` : null,
    resolved.dataPacks.length ? `${resolved.dataPacks.length} data pack(s)` : null,
    resolved.preset ? `preset ${resolved.preset}` : null,
    port && resolved.port !== null ? `port ${resolved.port}` : null,
  ].filter(Boolean).join(', ');
  const sites = Object.entries(catalogue.sites).map(([name, site]) => ({
    name,
    source: site.sourceDir,
    format: site.sourceDir ? detectFormat(site.sourceDir) : null,
    defaultEnv: site.defaultEnv ?? Object.keys(site.environments)[0] ?? null,
    environments: Object.entries(site.environments).map(([env, e]) => ({ name: env, ...e })),
    mirage: mirageOf(site),
  }));
  const configured = new Set(sites.map((s) => s.source && path.resolve(s.source).toLowerCase()));
  const unconfigured = discoverExtracts(catalogue.sourceRoot).filter((dir) => !configured.has(dir.toLowerCase()));
  const coverage = {
    mode: inEffect?.portals ?? args.portals ?? catalogue.settings.values.PAQVILO_PORTALS ?? catalogue.root.portals,
    ready: !problem,
    configuredTargetCount: sites.reduce((count, site) => count + site.environments.length, 0),
    targets: targets.map((target) => ({ site: target.siteName, env: target.envName, origin: target.origin, source: target.sourceDir,
      scope: target.site.scope, baseline: target.site.markup.baseline, startPath: target.site.startPath, caution: target.caution, initial: target === inEffect })),
  };
  const profileInfo = inEffect ? browserProfileInfo(inEffect) : null;

  if (args.json) {
    console.log(JSON.stringify({ schemaVersion: 1, command: 'list', offline: true, sourceRoot: catalogue.sourceRoot, sites, inEffect: inEffect && {
      site: inEffect.siteName, env: inEffect.envName, url: inEffect.origin, source: inEffect.sourceDir, scope: inEffect.site.scope, baseline: inEffect.site.markup.baseline, portals: inEffect.portals,
      browser: { channel: inEffect.browser.channel, headless: inEffect.browser.headless, debugPort: inEffect.browser.debugPort, bypassCSP: inEffect.browser.bypassCSP, mode: inEffect.browser.cdpUrl ? 'attach' : 'launch',
        profileMode: inEffect.browser.cdpUrl ? 'attached' : inEffect.browser.userDataDir ? 'external' : inEffect.browser.profile ? 'named' : 'default',
        profile: inEffect.browser.profile, profileDir: inEffect.browser.profileDir, userDataDir: inEffect.browser.userDataDir, profileDirectory: inEffect.browser.profileDirectory, profileInfo },
      agent: inEffect.agent,
      mirage: inEffect.mirageConfig,
      panel: inEffect.panel, liveReload: inEffect.liveReload, sourceMaps: inEffect.sourceMaps, editor: inEffect.editor, chosen: inEffect.chosen,
    }, coverage, problem, settings: catalogue.settings.values, ...(args.settings ? { supportedSettings: { ...ENV_SETTINGS,
      'PAQVILO_<SITE>_SOURCE': 'sources folder of a site (overrides the catalogue; a new name adds a site)',
      'PAQVILO_<SITE>_ENV_<NAME>': 'adds an environment to a site',
    } } : {}), unconfigured }, null, 2));
    return inEffect ? 0 : 1;
  }

  console.log(`catalogue: ${catalogue.configFile}`);
  console.log(`checkout:  ${catalogue.sourceRoot}`);
  console.log(`personal:  ${catalogue.settings.file}${fs.existsSync(catalogue.settings.file) ? '' : '   (not there yet: copy .env.example, or run "npm run use")'}\n`);
  for (const site of sites) {
    const current = inEffect?.siteName === site.name;
    const state = !site.source ? 'no source folder configured' : site.format ? `${site.format} extract` : 'FOLDER NOT FOUND or not an extract';
    console.log(`${current ? '*' : ' '} ${site.name.padEnd(10)} ${site.source ? rel(site.source) : ''}   [${state}]`);
    const width = Math.max(0, ...site.environments.map((e) => e.name.length));
    for (const env of site.environments) {
      const mark = current && inEffect.envName === env.name ? '*' : ' ';
      const extras = [env.name === site.defaultEnv ? 'default' : null, env.caution ? 'CAUTION: real data' : null, env.baseline ? `baseline ${env.baseline}` : null, env.scope ? `scope ${env.scope}` : null].filter(Boolean);
      console.log(`    ${mark} ${env.name.padEnd(width)}  ${env.url}${extras.length ? `   (${extras.join(', ')})` : ''}`);
    }
    if (!site.environments.length) console.log('      (no environments configured)');
    const mirage = mirageText(site.mirage.resolved, { port: false });
    if (mirage) console.log(`      mirage: ${mirage}`);
  }

  console.log('');
  if (inEffect) {
    console.log(`in effect:  ${inEffect.siteName} @ ${inEffect.envName}  ${inEffect.origin}`);
    console.log(`            site from ${inEffect.chosen.site}, environment from ${inEffect.chosen.env}`);
    console.log(`            sources ${inEffect.sourceDir}`);
    console.log(`            scope ${inEffect.site.scope}, baseline ${inEffect.site.markup.baseline}, browser ${inEffect.browser.channel}, debug port ${inEffect.browser.debugPort ?? 'off'}`);
    const browser = inEffect.browser;
    console.log(`            browser profile: ${browser.cdpUrl ? 'attached browser' : browser.userDataDir ? `existing root ${browser.userDataDir}${browser.profileDirectory ? `, directory ${browser.profileDirectory}` : ''}` : browser.profile ? `named toolkit profile ${browser.profile}` : `default toolkit profile (${inEffect.portals === 'all' ? 'catalogue' : `${inEffect.siteName}-${inEffect.envName}`})`}`);
    if (profileInfo.userDataDir) console.log(`            user-data root ${profileInfo.userDataDir}, profile directory ${profileInfo.profileDirectory}`);
    console.log(`            mirage ${mirageText(inEffect.mirageConfig) || 'defaults (sibling Solution discovery, port 8787)'}`);
    for (const note of inEffect.notes) console.log(`            note: ${note}`);
  } else {
    console.log(`in effect:  nothing usable - ${problem}`);
  }
  console.log(`\ndev coverage: ${coverage.mode}, ${coverage.targets.length} target(s); ${coverage.configuredTargetCount} configured portal/environment entries${coverage.ready ? '' : ' (not ready)'}`);
  for (const target of coverage.targets) console.log(`  ${target.initial ? '*' : ' '} ${target.site} @ ${target.env}  ${target.origin}  <- ${rel(target.source)}`);

  const set = Object.entries(catalogue.settings.values);
  if (set.length) {
    console.log('\nyour settings:');
    for (const [key, value] of set) console.log(`  ${key}=${value}   (${catalogue.settings.origin[key]})`);
  }
  if (args.settings) {
    console.log('\nsettings you can put in .env:');
    for (const [key, what] of Object.entries(ENV_SETTINGS)) console.log(`  ${key.padEnd(24)} ${what}`);
    console.log(`  ${'PAQVILO_<SITE>_SOURCE'.padEnd(24)} sources folder of a site (yours overrides the catalogue; a new name adds a site)`);
    console.log(`  ${'PAQVILO_<SITE>_ENV_<NAME>'.padEnd(24)} adds an environment <name> to a site`);
  }

  if (unconfigured.length) {
    console.log('\nextracts in the repository that no site points at:');
    for (const dir of unconfigured) console.log(`  ${rel(dir)}   [${detectFormat(dir)}]`);
    console.log('  add them under "sites:" in paqvilo.config.yml (source + environments) to work on them.');
  }
  console.log('\nchoose:  npm run use            (remembers it in .env)');
  console.log('         npm run dev -- --site <site> --env <environment>     (this run only)');
  return inEffect ? 0 : 1;
}
