// `paqvilo list`: the sites and environments that can be chosen, and what is in effect now.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalogue, loadDevTargets, ENV_SETTINGS, resolveMirageConfig, mirageOnlySite } from '../config.mjs';
import { detectFormat } from '../portal-model.mjs';
import { browserProfileInfo } from '../browser-profile.mjs';
import { resolveCatalogue } from '../resolved-catalogue.mjs';
import { scanSolutionSources } from '../../mirage/lib/solution-schema.mjs';
import { inventoryCounts } from '../model-driven.mjs';
import { miragePaths } from './mirage.mjs';

const chooseLazily = (condition, yes, no) => {
  if (condition()) return yes();
  return no();
};

// Catalogue URLs and first-tab paths may contain private query values. They are
// displayed for selection, but the query itself is not needed to identify them.
function displayLocation(value) {
  if (typeof value !== 'string') return value;
  const query = value.indexOf('?');
  const fragment = value.indexOf('#');
  const end = [query, fragment].filter((index) => index >= 0).reduce((a, b) => Math.min(a, b), value.length);
  return value.slice(0, end) + (query >= 0 && (fragment < 0 || query < fragment) ? '?[redacted]' : '');
}

/** Portal extracts in the repository, whether configured or not. */
export function discoverExtracts(startDir) {
  let root = startDir;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    /* NOSONAR */ root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
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
      if (e.isDirectory() && !/^(?:node_modules|\.git|\.paqvilo|\.vscode)$/.test(e.name))
        walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function mirageText(resolved, rel, { port = true } = {}) {
  return [
    resolved.project ? `project ${rel(resolved.project)}` : null,
    resolved.solutionRoots.length ? `${resolved.solutionRoots.length} Solution root(s)` : null,
    resolved.dataPacks.length ? `${resolved.dataPacks.length} data pack(s)` : null,
    resolved.preset ? `preset ${resolved.preset}` : null,
    port && resolved.port !== null ? `port ${resolved.port}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function listSites(catalogue) {
  const rel = (dir) => path.relative(catalogue.configDir, dir).replaceAll('\\', '/') || '.';
  const mirageOf = (site) => ({
    configured: site.mirage ?? null,
    resolved: resolveMirageConfig(site.mirage, {
      configDir: catalogue.configDir,
      sourceRoot: catalogue.sourceRoot,
      sourceDir: site.sourceDir,
    }),
  });
  const sites = Object.entries(catalogue.sites).map(([name, site]) => ({
    name,
    source: site.sourceDir,
    format: site.sourceDir ? detectFormat(site.sourceDir) : null,
    defaultEnv: site.defaultEnv ?? Object.keys(site.environments)[0] ?? null,
    environments: Object.entries(site.environments).map(([env, e]) => ({
      name: env,
      ...e,
      url: displayLocation(e.url),
      ...(e.startPath !== undefined ? { startPath: displayLocation(e.startPath) } : {}),
    })),
    mirage: mirageOf(site),
    mirageOnly: mirageOnlySite(site),
  }));
  return { sites, rel };
}

async function scanSiteInventories(sites, cacheFile, writesFiles) {
  for (const site of sites) {
    const roots = site.mirage.resolved.solutionRoots;
    if (!roots.length) continue;
    try {
      const scan = await scanSolutionSources(roots, {
        cacheFile,
        order: site.mirage.resolved.solutionOrder ?? 'derived',
      });
      try {
        if (await scan.cache?.save({ prune: false })) writesFiles.add(cacheFile);
      } catch {
        /* the cache only saves parsing time */
      }
      site.inventory = {
        level: 'inventory',
        counts: inventoryCounts(scan.inventory),
        components: scan.inventory.length,
        cache: scan.cache?.stats ?? null,
      };
    } catch (error) {
      site.inventory = { error: error.message };
    }
  }
}

function listCoverage(inEffect, targets, sites, args, catalogue, problem) {
  return {
    mode: inEffect?.portals ?? args.portals ?? catalogue.settings.values.PAQVILO_PORTALS ?? catalogue.root.portals,
    ready: !problem,
    configuredTargetCount: sites.reduce((count, site) => count + site.environments.length, 0),
    targets: targets.map((target) => ({
      site: target.siteName,
      env: target.envName,
      origin: target.origin,
      source: target.sourceDir,
      scope: target.site.scope,
      baseline: target.site.markup.baseline,
      startPath: displayLocation(target.site.startPath),
      caution: target.caution,
      initial: target === inEffect,
    })),
  };
}

function safeSettings(catalogue) {
  return Object.fromEntries(
    Object.entries(catalogue.settings.values).map(([key, value]) => [
      key,
      key === 'PAQVILO_START_PATH' || /^(?:https?|wss?):\/\//i.test(value) ? displayLocation(value) : value,
    ]),
  );
}

function listProfileMode(browser) {
  return chooseLazily(
    () => browser.cdpUrl,
    () => 'attached',
    () =>
      chooseLazily(
        () => browser.userDataDir,
        () => 'external',
        () =>
          chooseLazily(
            () => browser.profile,
            () => 'named',
            () => 'default',
          ),
      ),
  );
}

function printListJson({
  usable,
  problemCode,
  problem,
  writesFiles,
  catalogue,
  resolved,
  sites,
  inEffect,
  profileInfo,
  coverage,
  settings,
  args,
  unconfigured,
}) {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'list',
        ok: usable,
        errors: usable ? [] : [{ code: problemCode, message: problem ?? 'No usable site and environment' }],
        offline: true,
        writesFiles: [...writesFiles],
        sourceRoot: catalogue.sourceRoot,
        resolved,
        sites,
        inEffect: inEffect && {
          site: inEffect.siteName,
          env: inEffect.envName,
          url: inEffect.origin,
          source: inEffect.sourceDir,
          scope: inEffect.site.scope,
          baseline: inEffect.site.markup.baseline,
          portals: inEffect.portals,
          browser: {
            channel: inEffect.browser.channel,
            headless: inEffect.browser.headless,
            debugPort: inEffect.browser.debugPort,
            bypassCSP: inEffect.browser.bypassCSP,
            mode: inEffect.browser.cdpUrl ? 'attach' : 'launch',
            profileMode: listProfileMode(inEffect.browser),
            profile: inEffect.browser.profile,
            profileDir: inEffect.browser.profileDir,
            userDataDir: inEffect.browser.userDataDir,
            profileDirectory: inEffect.browser.profileDirectory,
            profileInfo,
          },
          agent: inEffect.agent,
          mirage: inEffect.mirageConfig,
          panel: inEffect.panel,
          liveReload: inEffect.liveReload,
          sourceMaps: inEffect.sourceMaps,
          editor: inEffect.editor,
          chosen: inEffect.chosen,
        },
        coverage,
        problem,
        settings,
        ...(args.settings
          ? {
              supportedSettings: {
                ...ENV_SETTINGS,
                'PAQVILO_<SITE>_SOURCE': 'sources folder of a site (overrides the catalogue; a new name adds a site)',
                'PAQVILO_<SITE>_ENV_<NAME>': 'adds an environment to a site',
              },
            }
          : {}),
        unconfigured,
      },
      null,
      2,
    ),
  );
}

function siteDisplayState(site) {
  return chooseLazily(
    () => site.mirageOnly,
    () =>
      `${site.mirage.resolved.runtime?.kind ?? site.mirage.configured.runtime.kind} Mirage site, no portal export needed`,
    () =>
      chooseLazily(
        () => !site.source,
        () => 'no source folder configured',
        () =>
          chooseLazily(
            () => site.format,
            () => `${site.format} extract`,
            () => 'FOLDER NOT FOUND or not an extract',
          ),
      ),
  );
}

function printEnvironment(site, env, current, width, inEffect) {
  const mark = current && inEffect.envName === env.name ? '*' : ' ';
  const extras = [
    env.name === site.defaultEnv ? 'default' : null,
    env.caution ? 'CAUTION: real data' : null,
    env.baseline ? `baseline ${env.baseline}` : null,
    env.scope ? `scope ${env.scope}` : null,
  ].filter(Boolean);
  console.log(
    `    ${mark} ${env.name.padEnd(width)}  ${env.url}${extras.length ? '   (' + extras.join(', ') + ')' : ''}`,
  );
}

function printSite(site, context) {
  const { inEffect, rel, mirageText } = context;
  const current = inEffect?.siteName === site.name;
  const state = siteDisplayState(site);
  console.log(`${current ? '*' : ' '} ${site.name.padEnd(10)} ${site.source ? rel(site.source) : ''}   [${state}]`);
  const width = Math.max(0, ...site.environments.map((env) => env.name.length));
  for (const env of site.environments) printEnvironment(site, env, current, width, inEffect);
  if (!site.environments.length && !site.mirageOnly) console.log('      (no environments configured)');
  const mirage = mirageText(site.mirage.resolved, { port: false });
  if (mirage) console.log(`      mirage: ${mirage}`);
  if (site.inventory?.components)
    console.log(
      `      inventory (listed, not coverage): ${Object.entries(site.inventory.counts)
        .map(([kind, levels]) => `${Object.values(levels).reduce((a, b) => a + b, 0)} ${kind}`)
        .join(', ')}`,
    );
}

function inEffectProfile(browser, inEffect) {
  return chooseLazily(
    () => browser.cdpUrl,
    () => 'attached browser',
    () =>
      chooseLazily(
        () => browser.userDataDir,
        () =>
          'existing root ' +
          browser.userDataDir +
          (browser.profileDirectory ? ', directory ' + browser.profileDirectory : ''),
        () =>
          chooseLazily(
            () => browser.profile,
            () => 'named toolkit profile ' + browser.profile,
            () =>
              'default toolkit profile (' +
              (inEffect.portals === 'all' ? 'catalogue' : inEffect.siteName + '-' + inEffect.envName) +
              ')',
          ),
      ),
  );
}

function printInEffect(inEffect, profileInfo, mirageText) {
  if (!inEffect) return;
  console.log(`in effect:  ${inEffect.siteName} @ ${inEffect.envName}  ${inEffect.origin}`);
  console.log(`            site from ${inEffect.chosen.site}, environment from ${inEffect.chosen.env}`);
  console.log(`            sources ${inEffect.sourceDir}`);
  console.log(
    `            scope ${inEffect.site.scope}, baseline ${inEffect.site.markup.baseline}, browser ${inEffect.browser.channel}, debug port ${inEffect.browser.debugPort ?? 'off'}`,
  );
  const profile = inEffectProfile(inEffect.browser, inEffect);
  console.log(`            browser profile: ${profile}`);
  if (profileInfo.userDataDir)
    console.log(
      `            user-data root ${profileInfo.userDataDir}, profile directory ${profileInfo.profileDirectory}`,
    );
  console.log(
    `            mirage ${mirageText(inEffect.mirageConfig) || 'defaults (sibling Solution discovery, port 8787)'}`,
  );
  for (const note of inEffect.notes) console.log(`            note: ${note}`);
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function printListText({
  catalogue,
  sites,
  inEffect,
  usable,
  problem,
  profileInfo,
  coverage,
  settings,
  args,
  unconfigured,
  rel,
  mirageText,
}) {
  console.log(`catalogue: ${catalogue.configFile}`);
  console.log(`checkout:  ${catalogue.sourceRoot}`);
  console.log(
    `personal:  ${catalogue.settings.file}${fs.existsSync(catalogue.settings.file) ? '' : '   (not there yet: copy .env.example, or run "npm run use")'}\n`,
  );
  for (const site of sites) printSite(site, { inEffect, rel, mirageText });
  console.log('');
  if (inEffect) printInEffect(inEffect, profileInfo, mirageText);
  else console.log(`in effect:  ${usable ? 'no Lense target' : 'nothing usable'} - ${problem}`);
  console.log(
    `\ndev coverage: ${coverage.mode}, ${coverage.targets.length} target(s); ${coverage.configuredTargetCount} configured portal/environment entries${coverage.ready ? '' : ' (not ready)'}`,
  );
  for (const target of coverage.targets)
    console.log(
      `  ${target.initial ? '*' : ' '} ${target.site} @ ${target.env}  ${target.origin}  <- ${rel(target.source)}`,
    );
  const set = Object.entries(settings);
  if (set.length) {
    console.log('\nyour settings:');
    for (const [key, value] of set) console.log(`  ${key}=${value}   (${catalogue.settings.origin[key]})`);
  }
  if (args.settings) {
    console.log('\nsettings you can put in .env:');
    for (const [key, what] of Object.entries(ENV_SETTINGS)) console.log(`  ${key.padEnd(24)} ${what}`);
    console.log(
      `  ${'PAQVILO_<SITE>_SOURCE'.padEnd(24)} sources folder of a site (yours overrides the catalogue; a new name adds a site)`,
    );
    console.log(`  ${'PAQVILO_<SITE>_ENV_<NAME>'.padEnd(24)} adds an environment <name> to a site`);
  }
  if (unconfigured.length) {
    console.log('\nextracts in the repository that no site points at:');
    for (const dir of unconfigured) console.log(`  ${rel(dir)}   [${detectFormat(dir)}]`);
    console.log('  add them under "sites:" in paqvilo.config.yml (source + environments) to work on them.');
  }
  console.log('\nchoose:  npm run use            (remembers it in .env)');
  console.log('         npm run dev -- --site <site> --env <environment>     (this run only)');
}

export default async function list(_cfg, args) {
  const catalogue = loadCatalogue(args);
  let inEffect = null;
  let targets = [];
  let problem = null;
  let problemCode = 'configuration_error';
  try {
    const resolved = await loadDevTargets(args);
    inEffect = resolved.initial;
    targets = resolved.targets;
  } catch (err) {
    problem = err.message;
    problemCode = err.code ?? problemCode;
  }
  const { sites, rel } = listSites(catalogue);
  const showMirageText = (resolved, options) => mirageText(resolved, rel, options);
  // A Mirage-only selected site is a valid catalogue choice, not a broken one: list reports it and succeeds.
  const usable = Boolean(inEffect) || problemCode === 'mirage_only_site';
  // Solution inventory (canvas apps, connectors, dashboards...): listed with counts, never coverage.
  // The same solution cache the derived Solution order uses (lense/commands/mirage.mjs), so a repeated list parses only what changed.
  const cacheFile = path.join(
    miragePaths(null, { config: catalogue.configFile }).discoveryRoot,
    'cache/solution-discovery.json',
  );
  const writesFiles = new Set();
  await scanSiteInventories(sites, cacheFile, writesFiles);
  const configured = new Set(sites.map((s) => s.source && path.resolve(s.source).toLowerCase()));
  const unconfigured = discoverExtracts(catalogue.sourceRoot).filter((dir) => !configured.has(dir.toLowerCase()));
  const coverage = listCoverage(inEffect, targets, sites, args, catalogue, problem);
  const profileInfo = inEffect ? browserProfileInfo(inEffect) : null;
  const settings = safeSettings(catalogue);

  if (args.json) {
    let resolved;
    try {
      resolved = await resolveCatalogue(args);
    } catch (error) {
      resolved = { error: error.message };
    }
    printListJson({
      usable,
      problemCode,
      problem,
      writesFiles,
      catalogue,
      resolved,
      sites,
      inEffect,
      profileInfo,
      coverage,
      settings,
      args,
      unconfigured,
    });
    return usable ? 0 : 1;
  }
  printListText({
    catalogue,
    sites,
    inEffect,
    usable,
    problem,
    profileInfo,
    coverage,
    settings,
    args,
    unconfigured,
    rel,
    mirageText: showMirageText,
  });
  return usable ? 0 : 1;
}
