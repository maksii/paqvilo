#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startupProgress } from './startup-progress.mjs';
import {
  commandExitCode,
  parseOptions,
  LENSE_OPTIONS as options,
  LENSE_COMMAND_OPTIONS as allowed,
  MIRAGE_ACTION_OPTIONS,
  MODEL_DRIVEN_INSPECT_OPTIONS,
  agentActionOptions,
} from './cli-options.mjs';
import { lenseCommandHelp } from './cli-help.mjs';
import { failureDocument, jsonEnvelope } from './cli-envelope.mjs';

// Loaded by the commands that read the catalogue: its settings contracts load the Mirage library, which help, a
// refused command line and the commands that need no catalogue must not wait for.
const configuration = () => import('./config.mjs');

const HELP = `paqvilo lense - work on Power Pages portal sources locally, laid over an online environment

Usage: paqvilo lense <command> [options]
       (in a project: npx --no-install paqvilo lense <command> [options])

Commands
  dev      open a browser on the environment with local sources laid over it; reloads on save
           local setup URL is printed during dev; use paqvilo setup before sources are ready
  list     the sites and environments you can choose from, and what is in effect
  use      remember which site and environment you work on (writes .env):  use [site] [environment]
  map      print how online resources map to local files (add --check to test every URL online)
  status   compare local web files with what the environment serves right now
  verify   prove the loop works: edits a temporary copy of the sources and checks the browser shows it
  doctor   check configuration, mappings and baseline offline (use --all for every site)
  analyze  review Power Platform source quality, security and performance offline
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
  setup    alias of paqvilo setup: the local configuration workspace at /_setup/

Which site and environment (default: .env, then paqvilo.config.yml)
  --site <name>     site from paqvilo.config.yml
  --env <name>      catalogue environment, or declared model-driven reference ID
  --pick            ask for site and environment now
  --url <url>       use this site URL instead of a configured environment
  --source <dir>    use this extract folder instead of the configured one; with analyze --config,
                    it overrides the selected site's portal source; analyze without --config reads it as a standalone folder
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
  --profile-directory <dir> child profile in that root, such as Default or Profile 1;
                         with --cdp-url, the open profile of the attached browser to use
  --cdp-url <url|channel> dev/list/doctor: attach to an already running browser by its debugging
                         endpoint, or by channel (msedge, chrome) when its remote debugging switch is on

Other
  --path <urlpath>  dev: optional first tab only; verify: page to test
  --verify-path <urlpath>
                    verify: add a page to the verification matrix (repeatable)
  --headless        dev/verify: no browser window
  --headed          dev/verify: show the browser window
  --signed-in       verify: use the signed-in profile of "dev" instead of an anonymous one
  --no-write        map: return the report without writing mapping files
  --no-reload       dev: do not reload tabs when sources change
  --no-overrides    dev: show the environment as it is served, with no local sources laid over it (reference view)
  --debug-port <n>  dev: launched browser's debugger port (0 = off; incompatible with CDP attachment)
  --check           map: request every mapped URL online
  --settings        list: also show every setting .env understands
  --all             doctor/analyze: check the default environment of each site
                    audit: check every configured environment of each site offline
  --mirage          doctor: also gate Sources diagnostics and Mirage configuration
  --lint-profiles   doctor: lint all exported deployment-profiles as warnings
  --fail-on <none|error|warning|hint> doctor/analyze: static analysis threshold
  --analysis-limit <ceiling>=<n> doctor/analyze: raise or lower one static analysis ceiling (repeatable)
                    doctor defaults to none (advisory); analyze defaults to error
  --json            list/map/status/doctor/analyze/audit/resources/verify/agent: machine readable output;
                    mirage (except dev) and model-driven inspect too
  --event-cursor <token> model-driven inspect: continue its source event registration report
  --include-event-parameters model-driven inspect: explicitly include source parameter literals

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
  --timeout <ms>   agent: operation deadline (sessions: per-session probe budget)
  --full-page       agent screenshot: capture the full page
  --include-panel   agent screenshot: keep the dev panel in the image
  --width <n>       agent viewport: viewport width
  --height <n>      agent viewport: viewport height
  --styles <list>  agent snapshot: comma-separated computed CSS properties
  --pierce          agent snapshot: also read closed shadow roots and cross-origin frames
  --samples <n>    agent coverage: how many unidentified elements to list (0-200, default 40)
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
  --runtime <kind>  mirage: power-pages, model-driven or dataverse-api (default: the project's or catalogue's)
  --simulation <level> mirage: dry-run keeps records in memory, simulation saves them as pack data,
                    deep also allows schema changes
  --solution-root <dir> mirage: add a solution source root (repeatable; default:
                    mirage.solutionRoots, else unpacked solutions next to the portal repository)
  --resource-map <file> model-driven: JSON version 1 resources [{path,resource}] binding
                    observed native PCF paths to declared Solution component resources
  --local-simulation model-driven: loopback-only panel workflow; no remote targets
  --startup-timeout <ms> mirage start/dev and model-driven dev: longest start-up silence without progress
                    (default: 120000; absolute cap 600000 ms)
  --allow-live-writes mirage dev/start: let the runtime send create, update and delete
                    requests to the live environment once _sim's live-writes switch is on
                    (default: off; without it no live write can leave the runtime)
  --out <file>      mirage init: project file to write (default: the site's catalogued
                    mirage.project, else .paqvilo/mirage/<site>.project.yml)
  --force           mirage init: replace an existing project file
  --strict          verify: fail on new diagnostics; audit: fail on incomplete coverage
`;

let values, positionals;
try {
  ({ values, positionals } = parseOptions({
    allowPositionals: true,
    options,
  }));
} catch (err) {
  const code = err.code === 'unsupported_option' ? 'unsupported_option' : 'invalid_argument';
  const parseArguments = process.argv.slice(2);
  const separator = parseArguments.indexOf('--');
  const jsonRequested = (separator < 0 ? parseArguments : parseArguments.slice(0, separator)).includes('--json');
  const { positionals: parsedPositionals } = parseArgs({
    args: parseArguments,
    options,
    allowPositionals: true,
    strict: false,
  });
  const [parsedCommand, parsedAction] = parsedPositionals;
  if (jsonRequested || parsedCommand === 'agent')
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command: parsedCommand ?? null,
        ...(parsedCommand === 'agent' ? { action: parsedAction ?? 'sessions' } : {}),
        ok: false,
        offline: true,
        writesFiles: [],
        errors: [{ code, message: err.message }],
        error: { code, message: err.message },
      }),
    );
  else console.error(`paqvilo: ${err.message}`);
  process.exit(1);
}

const command = positionals[0];
if (values.json || command === 'agent') {
  const print = console.log.bind(console);
  console.log = (value) => print(jsonEnvelope(value, { command, positionals }));
}
if (command === undefined) {
  const suppliedOptions = Object.keys(values).filter((option) => !['json', 'help'].includes(option));
  if (suppliedOptions.length && !values.help) {
    const message = `A lense command is required when using --${suppliedOptions[0]}`;
    if (values.json)
      console.log(JSON.stringify({ command: null, ok: false, error: { code: 'invalid_argument', message } }));
    else console.error(`paqvilo: ${message}. Run with --help to see supported commands.`);
    process.exit(1);
  }
  if (values.json) console.log(JSON.stringify({ schemaVersion: 1, command: 'help', ok: true, usage: HELP }));
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
  analyze: { load: () => import('./commands/analyze.mjs'), needsSite: false },
  audit: { load: () => import('./commands/audit.mjs'), needsSite: false },
  resources: { load: () => import('./commands/resources.mjs'), needsSite: true },
  agent: { load: () => import('./commands/agent.mjs'), needsSite: false },
  'model-driven': { load: () => import('./commands/model-driven.mjs'), needsSite: false },
  mirage: { load: () => import('./commands/mirage.mjs'), needsSite: true },
};

if (!Object.hasOwn(commands, command)) {
  // One line naming the command and the valid ones; full help only for --help.
  const { paqviloCommand } = await import('./command-hint.mjs');
  const message = `Unknown command "${command}". Choose ${Object.keys(commands).join(', ')}. Run ${paqviloCommand(['lense', '--help'])} for options.`;
  if (values.json)
    console.log(JSON.stringify({ schemaVersion: 1, command, ok: false, error: { code: 'unknown_command', message } }));
  else console.error(`paqvilo: ${message}`);
  process.exit(1);
}

/**
 * An option the command, or its named action, does not take is refused beside --help as without it (docs/cli.md,
 * argument errors): only whether each option belongs is checked here, not its value.
 */
function refuseOptionsOfOtherActions(action) {
  const given = Object.keys(values).filter((option) => option !== 'help');
  const refuse = (option, owner) => {
    throw Object.assign(new Error(`--${option} is not supported by ${owner}`), { code: 'unsupported_option' });
  };
  for (const option of given) if (!allowed[command].includes(option)) refuse(option, command);
  let actionOptions = null;
  if (command === 'mirage' && Object.hasOwn(MIRAGE_ACTION_OPTIONS, action ?? 'status'))
    actionOptions = new Set(MIRAGE_ACTION_OPTIONS[action ?? 'status']);
  else if (command === 'agent') actionOptions = agentActionOptions(action ?? 'sessions');
  else if (command === 'model-driven' && action === 'inspect') actionOptions = MODEL_DRIVEN_INSPECT_OPTIONS;
  const owner = `${command} ${action ?? (command === 'agent' ? 'sessions' : 'status')}`;
  if (actionOptions) for (const option of given) if (!actionOptions.has(option)) refuse(option, owner);
}

if (values.help) {
  try {
    refuseOptionsOfOtherActions(positionals[1]);
  } catch (error) {
    if (values.json || command === 'agent')
      console.log(JSON.stringify(failureDocument(error, { command, phase: 'arguments' })));
    else console.error(`paqvilo: ${error.message}`);
    process.exit(1);
  }
  const usage = lenseCommandHelp(command, positionals[1], HELP);
  if (values.json || command === 'agent')
    console.log(JSON.stringify({ schemaVersion: 1, command: 'help', ok: true, usage }));
  else console.log(usage);
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
  for (const option of Object.keys(values))
    if (!allowed[command].includes(option))
      throw Object.assign(new Error(`--${option} is not supported by ${command}`), { code: 'unsupported_option' });
  for (const [option, value] of Object.entries(values)) {
    if (!['search', 'port'].includes(option) && (Array.isArray(value) ? value.includes('') : value === ''))
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
  if (command === 'mirage' && values.path !== undefined) {
    if (positionals[1] !== 'dev') throw new Error('--path is supported only by mirage dev');
    if (
      !values.path.startsWith('/') ||
      values.path.startsWith('//') ||
      values.path.includes('\\') ||
      [...values.path].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    )
      throw new Error('--path must be an origin-relative path');
  }

  if (values.pick && values.json)
    throw new Error('--pick cannot be combined with --json; provide --site and --env explicitly');
  if (values.path !== undefined && values['verify-path'] !== undefined)
    throw new Error('--path cannot be combined with --verify-path');
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
  // An explicit catalogue must exist, whether or not the command reads it; only mirage status and stop still select the
  // runtimes recorded for a removed catalogue (commands/mirage.mjs).
  const removedCatalogueSelects = command === 'mirage' && ['status', 'stop'].includes(positionals[1] ?? 'status');
  if (values.config !== undefined && !removedCatalogueSelects) {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    if (!existsSync(values.config))
      throw (await configuration()).catalogueNotFound(resolve(values.config), { explicit: true });
  }
  let cfg = null;
  const pick = async (selection) => {
    const { pickSiteAndEnv } = await import('./prompt.mjs');
    const catalogue = (await configuration()).loadCatalogue(selection);
    const current = {
      site: catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite,
      env: catalogue.settings.values.PAQVILO_ENV,
    };
    Object.assign(selection, await pickSiteAndEnv(catalogue, { site: selection.site, env: selection.env }, current));
  };
  // A Mirage command resolves a standalone runtime's configuration or the catalogue site's (commands/mirage.mjs).
  if (command === 'mirage')
    cfg = await (
      await import('./commands/mirage.mjs')
    ).mirageCommandConfiguration(values, positionals[1] ?? 'status', { pick });
  else if (needsSite) {
    if (values.pick) await pick(values);
    cfg = await (await configuration()).loadConfig(values, process.env, { checkSource: true });
  }
  const { default: run } = await load();
  phase = 'execution';
  const code = await run(cfg, values, positionals.slice(1));
  // Let large JSON reports drain to piped stdout before exiting.
  if (typeof code === 'number') process.exitCode = commandExitCode(code, process.exitCode);
} catch (err) {
  startup?.fail(err.message);
  if (values.json || command === 'agent') console.log(JSON.stringify(failureDocument(err, { command, phase })));
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
    // Only a configuration problem is answered by setup; a refused argument is not.
    if (!values.json && starting && phase === 'configuration') {
      const { paqviloCommand } = await import('./command-hint.mjs');
      const setup = values.config
        ? paqviloCommand(['setup'], { config: values.config })
        : paqviloCommand(['setup'], { extra: values.project ? ['--project', values.project] : [] });
      console.error(`Configure this project with: ${setup}`);
    }
    if (process.env.PAQVILO_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
} finally {
  startup?.close();
}
