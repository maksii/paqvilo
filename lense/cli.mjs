#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadConfig, loadCatalogue } from './config.mjs';
import { startupProgress } from './startup-progress.mjs';

const HELP = `paqvilo lense - work on Power Pages portal sources locally, laid over an online environment

Usage: paqvilo lense <command> [options]
       npm run lense -- <command> [options]

Commands
  dev      open a browser on the environment with local sources laid over it; reloads on save
           local setup URL is printed during dev; use paqvilo setup before sources are ready
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
  model-driven inspect|dev --project FILE [--env REFERENCE | --url ORIGIN]
           inspect or overlay exported Solution webresources and mapped PCF bundles;
           dev provides X-ray, agent/debugger access and reloads its own app tab on save
  mirage init|start|dev|status|inspect|stop
           local Mirage runtime: init writes a project file from the catalogue site; dev opens
           the runtime with the paqvilo panel and stops it again when the browser closes; with
           portals=all, one Mirage per catalogue site, switched in the panel with live targets

Which site and environment (default: .env, then paqvilo.config.yml)
  --site <name>     site from paqvilo.config.yml
  --env <name>      catalogue environment, or declared model-driven reference ID
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
  --no-write        map: return the report without writing mapping files
  --no-reload       dev: do not reload tabs when sources change
  --debug-port <n>  dev: launched browser's debugger port (0 = off; incompatible with CDP attachment)
  --check           map: request every mapped URL online
  --settings        list: also show every setting .env understands
  --all             doctor/audit: check every configured site's default environment offline
  --mirage          doctor: also gate Sources diagnostics and Mirage configuration
  --lint-profiles   doctor: lint all exported deployment-profiles as warnings
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
  --apply-configuration          mirage: also apply the selected preset’s linked configuration
  --preset-mode bootstrap|always  mirage: seed new state only, or reset on every start
  --preset <name>   mirage: apply a scenario preset when starting (default: mirage.preset)
  --solution-root <dir> mirage: add a solution source root (repeatable; default:
                    mirage.solutionRoots, else unpacked solutions next to the portal repository)
  --resource-map <file> model-driven: JSON version 1 resources [{path,resource}] binding
                    observed native PCF paths to declared Solution component resources
  --local-simulation model-driven: loopback-only panel workflow; no remote targets
  --startup-timeout <ms> mirage/model-driven dev: startup deadline (default: 120000)
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
      'no-write': { type: 'boolean' },
      'no-overrides': { type: 'boolean' },
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
      'resource-map': { type: 'string' },
      runtime: { type: 'string' },
      simulation: { type: 'string' },
      portal: { type: 'string' },
      port: { type: 'string' },
      state: { type: 'string' },
      preset: { type: 'string' },
      'preset-mode': { type: 'string' },
      'apply-configuration': { type: 'boolean' },
      'solution-root': { type: 'string', multiple: true },
      'startup-timeout': { type: 'string' },
      'local-simulation': { type: 'boolean' },
      'allow-live-writes': { type: 'boolean' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      strict: { type: 'boolean' },
      mirage: { type: 'boolean' },
      'lint-profiles': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  const code = err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unsupported_option' : 'invalid_argument';
  const parseArguments = process.argv.slice(2);
  const separator = parseArguments.indexOf('--');
  const jsonRequested = (separator < 0 ? parseArguments : parseArguments.slice(0, separator)).includes('--json');
  if (jsonRequested || process.argv[2] === 'agent')
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command: process.argv[2] ?? null,
        ...(process.argv[2] === 'agent'
          ? { action: process.argv[3]?.startsWith('--') ? 'sessions' : (process.argv[3] ?? 'sessions') }
          : {}),
        ok: false,
        offline: true,
        writesFiles: [],
        errors: [{ code, message: err.message }],
        error: { code, message: err.message },
      }),
    );
  else console.error(`paqvilo: ${err.message}\nRun with --help to see supported options.`);
  process.exit(1);
}

const command = positionals[0];
if (values.json || command === 'agent') {
  const print = console.log.bind(console);
  console.log = (value) => {
    let result;
    try {
      result = JSON.parse(value);
    } catch {
      return print(value);
    }
    const normalizeError = (error) =>
      typeof error === 'string'
        ? { code: command === 'doctor' ? 'check_failed' : 'command_failed', message: error }
        : {
            ...error,
            code: error?.code ?? 'check_failed',
            message: error?.message ?? error?.reason ?? 'Command failed',
          };
    if (Array.isArray(result)) result = { results: result };
    if (Array.isArray(result.reports))
      result.reports = result.reports.map((report) => ({
        ...report,
        errors: (report.errors ?? []).map(normalizeError),
        ...(report.mirage
          ? { mirage: { ...report.mirage, errors: (report.mirage.errors ?? []).map(normalizeError) } }
          : {}),
      }));
    const errors = (
      result.errors ??
      (result.error
        ? [result.error]
        : (result.reports ?? []).flatMap((report) => [
            ...(report.errors ?? []),
            ...(result.checks?.includes('mirage') && report.mirage?.ready === false ? report.mirage.errors : []),
          ]))
    ).map(normalizeError);
    print(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          offline:
            result.command === 'help' ||
            (command === 'mirage'
              ? ['init', 'inspect'].includes(positionals[1])
              : !['agent', 'dev', 'verify', 'status'].includes(command)),
          ...result,
          ...(command === 'agent' ? { action: positionals[1] ?? 'sessions' } : {}),
          ok: result.ok ?? result.ready ?? result.passed ?? errors.length === 0,
          writesFiles: Array.isArray(result.writesFiles) ? result.writesFiles : [],
          errors,
        },
        null,
        2,
      ),
    );
  };
}
if (command === undefined) {
  if (values.json || command === 'agent')
    console.log(JSON.stringify({ schemaVersion: 1, command: 'help', ok: true, usage: HELP }));
  else console.log(HELP);
  process.exit(0);
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
  'model-driven': { load: () => import('./commands/model-driven.mjs'), needsSite: false },
  mirage: { load: () => import('./commands/mirage.mjs'), needsSite: true },
};

if (!Object.hasOwn(commands, command)) {
  if (values.json)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command,
        ok: false,
        error: { code: 'unknown_command', message: `Unknown command "${command}"` },
      }),
    );
  else console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}

if (values.help) {
  if (values.json || command === 'agent')
    console.log(JSON.stringify({ schemaVersion: 1, command: 'help', ok: true, usage: HELP }));
  else console.log(HELP);
  process.exit(0);
}

let phase = 'arguments';
let startup;
try {
  if (!['use', 'agent', 'mirage', 'model-driven'].includes(command) && positionals.length > 1)
    throw new Error(`Unexpected argument "${positionals[1]}" for ${command}`);
  if (command === 'model-driven' && positionals.length > 2)
    throw new Error('model-driven accepts one action: inspect or dev');
  if (command === 'use' && positionals.length > 3) throw new Error('use accepts only a site and an environment');
  if (command === 'agent' && positionals.length > 2) throw new Error('agent accepts only one action');
  if (command === 'mirage' && positionals.length > 2)
    throw new Error('mirage accepts one action: init, start, dev, status, inspect or stop');
  const selection = ['site', 'env', 'url', 'source', 'repo', 'config', 'scope', 'baseline'];
  const browserSelection = ['browser', 'profile', 'user-data-dir', 'profile-directory'];
  const allowed = {
    dev: [
      ...selection,
      ...browserSelection,
      'cdp-url',
      'portals',
      'pick',
      'path',
      'headless',
      'headed',
      'no-reload',
      'no-overrides',
      'debug-port',
    ],
    map: [...selection, 'pick', 'check', 'no-write', 'json'],
    status: [...selection, 'pick', 'json'],
    verify: [
      ...selection,
      ...browserSelection,
      'pick',
      'path',
      'headless',
      'headed',
      'signed-in',
      'json',
      'strict',
      'sign-in-timeout',
    ],
    doctor: [...selection, ...browserSelection, 'cdp-url', 'all', 'mirage', 'lint-profiles', 'json'],
    list: [...selection, ...browserSelection, 'cdp-url', 'portals', 'settings', 'json'],
    audit: [...selection, 'all', 'strict', 'json'],
    use: ['config', 'repo', 'site', 'env'],
    resources: [...selection, 'json', 'page', 'kind', 'search', 'changed', 'limit', 'offset'],
    agent: [
      'config',
      'session',
      'page-id',
      'selector',
      'limit',
      'after',
      'output',
      'timeout',
      'full-page',
      'include-panel',
      'width',
      'height',
      'styles',
      'path',
      'json',
    ],
    'model-driven': [
      'config',
      ...browserSelection,
      'cdp-url',
      'project',
      'env',
      'url',
      'path',
      'resource-map',
      'local-simulation',
      'startup-timeout',
      'headless',
      'headed',
      'no-reload',
      'debug-port',
      'timeout',
      'output',
      'json',
    ],
    mirage: [
      ...selection,
      ...browserSelection,
      'cdp-url',
      'portals',
      'project',
      'portal',
      'port',
      'state',
      'preset',
      'preset-mode',
      'apply-configuration',
      'solution-root',
      'startup-timeout',
      'allow-live-writes',
      'headless',
      'headed',
      'no-reload',
      'debug-port',
      'out',
      'force',
      'json',
      'runtime',
      'simulation',
    ],
  };
  for (const option of Object.keys(values))
    if (!allowed[command].includes(option))
      throw Object.assign(new Error(`--${option} is not supported by ${command}`), { code: 'unsupported_option' });
  for (const [option, value] of Object.entries(values)) {
    if (
      !['search', 'port'].includes(option) &&
      (Array.isArray(value) ? value.some((item) => item === '') : value === '')
    )
      throw new Error(`--${option} must not be empty`);
  }
  if (values.portals !== undefined && !['selected', 'all'].includes(values.portals))
    throw new Error('--portals must be selected or all');
  if (values.scope !== undefined && !['all', 'changed'].includes(values.scope))
    throw new Error('--scope must be all or changed');
  if (
    values['debug-port'] !== undefined &&
    (!/^\d+$/.test(values['debug-port']) || Number(values['debug-port']) > 65535)
  )
    throw new Error('--debug-port must be an integer from 0 to 65535');
  if (
    values['sign-in-timeout'] !== undefined &&
    (!/^\d+$/.test(values['sign-in-timeout']) ||
      Number(values['sign-in-timeout']) < 1 ||
      Number(values['sign-in-timeout']) > 900000)
  )
    throw new Error('--sign-in-timeout must be an integer between 1 and 900000 milliseconds');
  if (command === 'use') {
    if (positionals[1] !== undefined && values.site !== undefined)
      throw new Error('use accepts the site either as a positional argument or --site, not both');
    if (positionals[2] !== undefined && values.env !== undefined)
      throw new Error('use accepts the environment either as a positional argument or --env, not both');
  }

  if (values.pick && values.json)
    throw new Error('--pick cannot be combined with --json; provide --site and --env explicitly');
  if (values.headless && values.headed) throw new Error('--headless and --headed cannot be used together');
  if (values.all && (values.site || values.env))
    throw new Error(`${command} --all cannot be combined with --site or --env`);
  if (command === 'resources') (await import('./commands/resources.mjs')).resourceFilters(values);
  if (command === 'model-driven')
    (await import('./commands/model-driven.mjs')).validateModelDrivenArguments(values, positionals[1] ?? 'dev');
  if (command === 'mirage')
    (await import('./commands/mirage.mjs')).validateMirageArguments(values, positionals[1] ?? 'status');
  const { load, needsSite } = commands[command];
  if (
    command === 'dev' ||
    (command === 'mirage' && ['start', 'dev'].includes(positionals[1])) ||
    (command === 'model-driven' && (positionals[1] ?? 'dev') === 'dev')
  ) {
    startup = startupProgress({ structured: values.json });
    values.startup = startup;
  }
  phase = 'configuration';
  let cfg = null;
  let standaloneProject = null;
  if (
    command === 'mirage' &&
    (positionals[1] ?? 'status') !== 'status' &&
    values.project &&
    !values.config &&
    !values.site
  ) {
    const { loadProjectConfig } = await import('../mirage/lib/project-config.mjs');
    const candidate = await loadProjectConfig(values.project);
    if (candidate.runtime?.kind !== 'power-pages') standaloneProject = candidate;
  }
  const standalone =
    command === 'mirage' && (standaloneProject || (values.runtime && values.runtime !== 'power-pages'));
  let standaloneCatalogue;
  if (
    command === 'mirage' &&
    (positionals[1] ?? 'status') !== 'status' &&
    !values.project &&
    (values.config || values.site)
  ) {
    const catalogue = loadCatalogue(values),
      name = values.site ?? catalogue.root.defaultSite;
    if (catalogue.sites[name]?.mirage?.runtime?.kind && catalogue.sites[name].mirage.runtime.kind !== 'power-pages')
      standaloneCatalogue = (await import('./standalone-mirage.mjs')).standaloneCatalogueConfiguration(
        catalogue,
        name,
        values,
      );
  }
  if (standaloneCatalogue) cfg = standaloneCatalogue;
  else if (standalone)
    cfg = (await import('./standalone-mirage.mjs')).standaloneMirageConfiguration(standaloneProject, values);
  else if (needsSite && !(command === 'mirage' && (positionals[1] ?? 'status') === 'status')) {
    if (values.pick) {
      const { pickSiteAndEnv } = await import('./prompt.mjs');
      const catalogue = loadCatalogue(values);
      const current = {
        site: catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite,
        env: catalogue.settings.values.PAQVILO_ENV,
      };
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
  phase = 'execution';
  const code = await run(cfg, values, positionals.slice(1));
  // Let large JSON reports drain to piped stdout before exiting.
  if (typeof code === 'number') process.exitCode = code;
} catch (err) {
  startup?.fail(err.message);
  if (values.json || command === 'agent')
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command,
        ok: false,
        writesFiles: err.writesFiles ?? [],
        error: {
          code:
            err.code ??
            (phase === 'arguments'
              ? 'invalid_argument'
              : phase === 'configuration'
                ? 'configuration_error'
                : 'command_failed'),
          message: err.message,
          ...(err.status ? { status: err.status } : {}),
        },
      }),
    );
  else console.error(`paqvilo: ${err.message}`);
  const starting = command === 'dev' || (command === 'mirage' && ['dev', 'start'].includes(positionals[1]));
  // Starting a project that has no configuration yet opens setup in the browser, when a person runs it in a terminal.
  if (
    starting &&
    err.code === 'CONFIG_NOT_FOUND' &&
    !values.json &&
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    !values.project
  ) {
    console.error(
      'There is no project configuration yet. Opening setup in your browser to create it; press Ctrl+C here when you are done.',
    );
    startup?.close();
    startup = null;
    process.exitCode = await (
      await import('./commands/setup.mjs')
    ).runSetup(['--config', values.config ?? './paqvilo.config.yml', '--open']);
  } else {
    if (!values.json && starting)
      console.error(
        `Configure this project with: paqvilo setup${values.config ? ` --config ${JSON.stringify(values.config)}` : values.project ? ` --project ${JSON.stringify(values.project)}` : ''}`,
      );
    if (process.env.PAQVILO_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
} finally {
  startup?.close();
}
