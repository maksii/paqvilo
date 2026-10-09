#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadConfig, loadCatalogue } from './config.mjs';

const HELP = `paqvilo lense - work on Power Pages portal sources locally, laid over an online environment

Usage: paqvilo lense <command> [options]
       npm run lense -- <command> [options]

Commands
  dev      open a browser on the environment with local sources laid over it; reloads on save
  list     the sites and environments you can choose from, and what is in effect
  use      remember which site and environment you work on (writes .env):  use [site] [environment]
  map      print how online resources map to local files (add --check to test every URL online)
  status   compare local web files with what the environment serves right now
  verify   prove the loop works: edits a temporary copy of the sources and checks the browser shows it
  doctor   check configuration, mappings and baseline offline (use --all for every site)
  audit    independently inventory export code and expose mapping gaps (offline)
  resources discover editable files, XML fields, pages and metadata relationships offline
  agent    inspect/control a running local session: sessions, status, pages, events, state,
           snapshot, screenshot, navigate, reload, viewport, stop (always JSON)
  mirage init|start|dev|status|inspect|stop
           local Mirage runtime: init writes a project file from the catalogue site; dev opens
           the runtime with the paqvilo panel and stops it again when the browser closes; with
           portals=all, one Mirage per catalogue site, switched in the panel with live targets

Which site and environment (default: .env, then paqvilo.config.yml)
  --site <name>     site from paqvilo.config.yml
  --env <name>      environment of that site
  --pick            ask for site and environment now
  --url <url>       use this site URL instead of a configured environment
  --source <dir>    use this extract folder instead of the configured one
  --repo <dir>      portal checkout/worktree root for all shared relative site sources
  --config <file>   another catalogue file
  --portals <selected|all> dev/list: one origin or the catalogue; mirage init/start/dev/stop:
                    one Mirage or one per catalogue site (default from config)

How sources are laid over the site
  --scope <all|changed>   every local file, or only files that differ from the baseline
  --baseline <ref>        chosen Git comparison ref (HEAD, a branch, merge-base:<branch>)

Browser selection (dev/list/verify/doctor)
  --browser <channel>    msedge, chrome or chromium
  --profile <name>       named persistent toolkit profile
  --user-data-dir <dir>  explicit existing browser user-data root
  --profile-directory <dir> child profile in that root, such as Default or Profile 1
  --cdp-url <url>        dev/list/doctor: attach to an already running browser

Other
  --path <urlpath>  dev: optional first tab only; verify: page to test
  --headless        dev/verify: no browser window
  --headed          dev/verify: show the browser window
  --signed-in       verify: use the signed-in profile of "dev" instead of an anonymous one
  --no-reload       dev: do not reload tabs when sources change
  --debug-port <n>  dev: port a debugger can attach to (0 = off)
  --check           map: request every mapped URL online
  --settings        list: also show every setting .env understands
  --all             doctor/audit: check every configured site's default environment offline
  --json            list/map/status/doctor/audit/resources/verify: machine readable output

Offline resource discovery
  --page <urlpath>  resources: sources related by indexed metadata to this page
  --kind <kind>     resources: filter a resource kind (repeatable)
  --search <text>   resources: case-insensitive name/path/URL/ID filter
  --changed         resources: select changes against the chosen baseline
  --limit <n>       resources: 1..500 entries (default 100); agent: result limit
  --offset <n>      resources: pagination offset (default 0)

Agent session access
  --session <file>  agent: discovery file of a running local session
  --page-id <id>    agent: page identifier from agent pages
  --selector <css>  agent: DOM selector for snapshot
  --after <n>       agent: event sequence cursor
  --output <path>   agent screenshot: PNG destination
  --timeout <ms>   agent: operation deadline
  --full-page       agent screenshot: capture the full page
  --include-panel   agent screenshot: keep the dev panel in the image
  --width <n>       agent viewport: viewport width
  --height <n>      agent viewport: viewport height
  --styles <list>  agent snapshot: comma-separated computed CSS properties
  --sign-in-timeout <ms> verify: sign-in deadline
  --project <file>  mirage: Mirage multi-source project configuration
                    (default: the site's catalogued mirage.project, when configured)
  --portal <id>     mirage: portal ID within --project (defaults to its primary portal)
  --port <n>        mirage: local Mirage port (0 chooses a free port; default:
                    mirage.port of the catalogue, else 8787)
  --state <file>    mirage: simulation state file
  --preset <name>   mirage: apply a scenario preset when starting (default: mirage.preset)
  --solution-root <dir> mirage: add a solution source root (repeatable; default:
                    mirage.solutionRoots, else sibling *.Solutions.* repositories)
  --startup-timeout <ms> mirage: readiness deadline (default: 120000)
  --allow-live-writes mirage dev/start: let the runtime send create, update and delete
                    requests to the live environment once _sim's live-writes switch is on
                    (default: off; without it no live write can leave the runtime)
  --out <file>      mirage init: project file to write (default: the site's catalogued
                    mirage.project, else .paqvilo/mirage/<site>.project.yml)
  --force           mirage init: replace an existing project file
  --strict          verify: fail on new diagnostics; audit: fail on blocked or unmapped resources
`;

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      site: { type: 'string' },
      env: { type: 'string' },
      pick: { type: 'boolean' },
      url: { type: 'string' },
      source: { type: 'string' },
      repo: { type: 'string' },
      config: { type: 'string' },
      portals: { type: 'string' },
      browser: { type: 'string' },
      profile: { type: 'string' },
      'user-data-dir': { type: 'string' },
      'profile-directory': { type: 'string' },
      'cdp-url': { type: 'string' },
      scope: { type: 'string' },
      baseline: { type: 'string' },
      path: { type: 'string' },
      headless: { type: 'boolean' },
      headed: { type: 'boolean' },
      'signed-in': { type: 'boolean' },
      'no-reload': { type: 'boolean' },
      'debug-port': { type: 'string' },
      check: { type: 'boolean' },
      settings: { type: 'boolean' },
      all: { type: 'boolean' },
      page: { type: 'string' },
      kind: { type: 'string', multiple: true },
      search: { type: 'string' },
      changed: { type: 'boolean' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      session: { type: 'string' },
      'page-id': { type: 'string' },
      selector: { type: 'string' },
      after: { type: 'string' },
      output: { type: 'string' },
      timeout: { type: 'string' },
      'full-page': { type: 'boolean' },
      'include-panel': { type: 'boolean' },
      width: { type: 'string' },
      height: { type: 'string' },
      styles: { type: 'string' },
      'sign-in-timeout': { type: 'string' },
      project: { type: 'string' },
      portal: { type: 'string' },
      port: { type: 'string' },
      state: { type: 'string' },
      preset: { type: 'string' },
      'solution-root': { type: 'string', multiple: true },
      'startup-timeout': { type: 'string' },
      'allow-live-writes': { type: 'boolean' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  if (process.argv.includes('--json') || process.argv[2] === 'agent') console.log(JSON.stringify({ schemaVersion: 1, command: process.argv[2] ?? null, ok: false, error: { code: 'INVALID_ARGUMENT', message: err.message } }));
  else console.error(`paqvilo: ${err.message}\nRun with --help to see supported options.`);
  process.exit(1);
}

const command = positionals[0];
if (values.help || !command) {
  if (values.json || command === 'agent') console.log(JSON.stringify({ schemaVersion: 1, command: 'help', ok: Boolean(command || values.help), usage: HELP }));
  else console.log(HELP);
  process.exit(command || values.help ? 0 : 1);
}

// `needsSite: false` commands work on the catalogue and must run even when nothing is selectable yet
const commands = {
  dev: { load: () => import('./commands/dev.mjs'), needsSite: true },
  map: { load: () => import('./commands/map.mjs'), needsSite: true },
  status: { load: () => import('./commands/status.mjs'), needsSite: true },
  verify: { load: () => import('./commands/verify.mjs'), needsSite: true },
  list: { load: () => import('./commands/list.mjs'), needsSite: false },
  use: { load: () => import('./commands/use.mjs'), needsSite: false },
  doctor: { load: () => import('./commands/doctor.mjs'), needsSite: false },
  audit: { load: () => import('./commands/audit.mjs'), needsSite: false },
  resources: { load: () => import('./commands/resources.mjs'), needsSite: true },
  agent: { load: () => import('./commands/agent.mjs'), needsSite: false },
  mirage: { load: () => import('./commands/mirage.mjs'), needsSite: true },
};

if (!Object.hasOwn(commands, command)) {
  if (values.json) console.log(JSON.stringify({ schemaVersion: 1, command, ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${command}"` } }));
  else console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}

try {
  if (!['use', 'agent', 'mirage'].includes(command) && positionals.length > 1) throw new Error(`Unexpected argument "${positionals[1]}" for ${command}`);
  if (command === 'use' && positionals.length > 3) throw new Error('use accepts only a site and an environment');
  if (command === 'agent' && positionals.length > 2) throw new Error('agent accepts only one action');
  if (command === 'mirage' && positionals.length > 2) throw new Error('mirage accepts one action: init, start, dev, status, inspect or stop');
  const selection = ['site', 'env', 'url', 'source', 'repo', 'config', 'scope', 'baseline'];
  const browserSelection = ['browser', 'profile', 'user-data-dir', 'profile-directory'];
  const allowed = {
    dev: [...selection, ...browserSelection, 'cdp-url', 'portals', 'pick', 'path', 'headless', 'headed', 'no-reload', 'debug-port'],
    map: [...selection, 'pick', 'check', 'json'], status: [...selection, 'pick', 'json'],
    verify: [...selection, ...browserSelection, 'pick', 'path', 'headless', 'headed', 'signed-in', 'json', 'strict', 'sign-in-timeout'],
    doctor: [...selection, ...browserSelection, 'cdp-url', 'all', 'json'], list: [...selection, ...browserSelection, 'cdp-url', 'portals', 'settings', 'json'],
    audit: [...selection, 'all', 'strict', 'json'],
    use: ['config', 'repo', 'site', 'env'],
    resources: [...selection, 'json', 'page', 'kind', 'search', 'changed', 'limit', 'offset'],
    agent: ['config', 'session', 'page-id', 'selector', 'limit', 'after', 'output', 'timeout', 'full-page', 'include-panel', 'width', 'height', 'styles', 'path', 'json'],
    mirage: [...selection, ...browserSelection, 'cdp-url', 'portals', 'project', 'portal', 'port', 'state', 'preset', 'solution-root', 'startup-timeout', 'allow-live-writes', 'headless', 'headed', 'no-reload', 'debug-port', 'out', 'force', 'json'],
  };
  for (const option of Object.keys(values)) if (!allowed[command].includes(option)) throw new Error(`--${option} is not supported by ${command}`);
  if (values.pick && values.json) throw new Error('--pick cannot be combined with --json; provide --site and --env explicitly');
  if (values.headless && values.headed) throw new Error('--headless and --headed cannot be used together');
  if (values.all && (values.site || values.env)) throw new Error(`${command} --all cannot be combined with --site or --env`);
  const { load, needsSite } = commands[command];
  let cfg = null;
  if (needsSite && !(command === 'mirage' && (positionals[1] ?? 'status') === 'status')) {
    if (values.pick) {
      const { pickSiteAndEnv } = await import('./prompt.mjs');
      const catalogue = loadCatalogue(values);
      const current = { site: catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite, env: catalogue.settings.values.PAQVILO_ENV };
      Object.assign(values, await pickSiteAndEnv(catalogue, { site: values.site, env: values.env }, current));
    }
    cfg = await loadConfig(values, process.env, { checkSource: !(command === 'mirage' && values.project) });
    if (command === 'mirage' && values.project && !values.config) {
      cfg.configDir = path.dirname(path.resolve(values.project));
      cfg.stateDir = path.join(cfg.configDir, '.paqvilo');
      cfg.portals = 'selected';
    }
  }
  const { default: run } = await load();
  const code = await run(cfg, values, positionals.slice(1));
  // Let large JSON reports drain to piped stdout before exiting.
  if (typeof code === 'number') process.exitCode = code;
} catch (err) {
  if (values.json || command === 'agent') console.log(JSON.stringify({ schemaVersion: 1, command, ok: false, error: { code: 'COMMAND_FAILED', message: err.message } }));
  else console.error(`paqvilo: ${err.message}`);
  if (process.env.PAQVILO_DEBUG) console.error(err.stack);
  process.exitCode = 1;
}
