import { registerRuntimeShutdown } from './lib/runtime-shutdown.mjs';
import { holdStartToken } from '../lense/process-identity.mjs';
import { startChannelReporter } from '../lense/start-channel.mjs';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPortalSource } from './lib/source-dialect.mjs';
import { shareSolutionParses } from './lib/solution-cache.mjs';
import { runtimePort } from './lib/runtime-port.mjs';
import { RUNTIME_KINDS, choiceMessage, runtimeSettings } from './lib/runtime-config.mjs';
import { SIMULATION_LEVELS, simulationSettings } from './lib/simulation-settings.mjs';
import { MIRAGE_COMMANDS, MIRAGE_CORE_COMMANDS, MIRAGE_DATA_USAGE, unknownMirageCommand } from './tool-registry.mjs';
import { assertPathOptions, joinNegativeValues, parseRaw } from './tool-options.mjs';
import { readJsonOption } from './lib/path-options.mjs';
import { mirageFailureCode } from './cli-output.mjs';

// A command this entry does not run: a toolkit Mirage command (init, dev, trace, ...) runs through paqvilo mirage.
const unknownCommandError = (command) =>
  Object.assign(
    new Error(
      MIRAGE_COMMANDS.includes(command)
        ? `Unknown command: ${command} for mirage/cli.mjs, which runs ${MIRAGE_CORE_COMMANDS.join(', ')}. Run paqvilo mirage ${command}.`
        : unknownMirageCommand(command),
    ),
    { code: 'unknown_command' },
  );

// Loaded on first use: the server's module graph takes seconds to load, and data, verify and help never start it.
const createSimulator = async (options) => {
  const started = performance.now();
  options.onStartup?.({ phase: 'runtime-module-load', elapsedMs: 0 });
  const runtime = await import('./server.mjs');
  options.onStartup?.({ phase: 'runtime-module-ready', elapsedMs: Math.round(performance.now() - started) });
  return runtime.createSimulator(options);
};
// The administration entry /_sim/ on the runtime's admin origin: the Power Pages handle reports it as /__sim/.
const adminEntryOf = (simulator) => new URL('/_sim/', simulator.adminUrl).href;
// The command modules load after the invocation has been parsed and checked: their module graph is most of this
// process's start-up, and an invocation refused for its options or its command never needs it.
let importPortal, createPortalRenderer, builtinPresets, presetDescriptor, resolveSolutionRoots, loadOrganizationSources;
let bootstrapProject, loadProjectConfig, projectOrigin, projectStateFile, projectSummary;
let resolveDeploymentProfiles, loadDeploymentProfiles, deploymentProfilesSummary;
let runtimeOptions, configuredSettingKeys, startupPresetChoice, commandLinePreset;
const loadPresets = async () => ({ builtinPresets, presetDescriptor } = await import('./lib/presets.mjs'));
const loadCommandModules = async () => {
  await loadPresets();
  ({ importPortal } = await import('./lib/importer.mjs'));
  ({ createPortalRenderer } = await import('./lib/liquid.mjs'));
  ({ resolveSolutionRoots } = await import('./lib/solution-roots.mjs'));
  ({ loadOrganizationSources } = await import('./lib/solution-runtime-source.mjs'));
  ({ bootstrapProject, loadProjectConfig, projectOrigin, projectStateFile, projectSummary } =
    await import('./lib/project-config.mjs'));
  ({ resolveDeploymentProfiles, loadDeploymentProfiles, deploymentProfilesSummary } =
    await import('./lib/deployment-profiles.mjs'));
  ({ runtimeOptions, configuredSettingKeys, startupPresetChoice, commandLinePreset } =
    await import('./lib/config-keys.mjs'));
};
// The input files and directories a command names must exist; checked after the option and value checks, before reading.
const INPUT_PATHS = {
  config: 'file',
  project: 'file',
  source: 'dir',
  repo: 'dir',
  'solution-root': 'dir',
  scenario: 'file',
  'pack-module': 'module',
};
const valueOptions = new Set([
  'source',
  'runtime',
  'simulation',
  'repo',
  'config',
  'site',
  'env',
  'port',
  'state',
  'state-dir',
  'origin',
  'cdp',
  'preset',
  'preset-mode',
  'path',
  'stylesheet',
  'parent-snippet',
  'child-snippet',
  'output',
  'local',
  'solution-root',
  'solution-order',
  'project',
  'portal',
  'deployment-profile',
  'pack',
  'pack-module',
  'profile',
  'seed',
  'rows',
  'out',
  'count',
  'scenario',
  'data-model',
]);

// The options each direct Mirage command accepts: the parser refuses any other, and its help lists exactly these.
const sourceOptions = [
  'source',
  'config',
  'site',
  'env',
  'repo',
  'project',
  'portal',
  'solution-root',
  'solution-order',
  'data-model',
];
const runtimeOptionNames = ['runtime', 'simulation'];
export const MIRAGE_COMMAND_OPTIONS = Object.freeze({
  inspect: [
    ...sourceOptions,
    ...runtimeOptionNames,
    'deployment-profile',
    'preset',
    'preset-mode',
    'apply-configuration',
    'json',
  ],
  preflight: [...sourceOptions, ...runtimeOptionNames, 'preset', 'pack-module', 'scenario', 'strict', 'json'],
  serve: [
    ...sourceOptions,
    ...runtimeOptionNames,
    'port',
    'state',
    'state-dir',
    'origin',
    'cdp',
    'preset',
    'preset-mode',
    'apply-configuration',
    'deployment-profile',
    'pack-module',
    'no-watch',
    'allow-live-writes',
    'start-token',
    'json',
  ],
  render: [
    ...sourceOptions,
    ...runtimeOptionNames,
    'state',
    'state-dir',
    'origin',
    'cdp',
    'preset',
    'preset-mode',
    'apply-configuration',
    'deployment-profile',
    'pack-module',
    'path',
    'output',
  ],
  'capture-stylesheets': [
    ...sourceOptions,
    ...runtimeOptionNames,
    'state',
    'state-dir',
    'origin',
    'cdp',
    'deployment-profile',
    'pack-module',
    'stylesheet',
  ],
  'capture-snippet-composition': [
    ...sourceOptions,
    ...runtimeOptionNames,
    'state',
    'state-dir',
    'origin',
    'cdp',
    'deployment-profile',
    'pack-module',
    'path',
    'parent-snippet',
    'child-snippet',
  ],
  data: [
    ...sourceOptions.filter((option) => option !== 'solution-order'),
    'pack',
    'pack-module',
    'profile',
    'seed',
    'rows',
    'state',
    'out',
    'count',
    'materialize-persona-memberships',
    'json',
  ],
});
// Each option of the direct commands: its value placeholder ('' for a flag) and what it does. Help is generated from
// this table and MIRAGE_COMMAND_OPTIONS, so it lists exactly what the parser accepts.
const OPTION_HELP = Object.freeze({
  source: ['DIR', 'Exported portal source directory.'],
  config: ['FILE', 'Toolkit catalogue for --site.'],
  site: ['ID', 'Catalogue site.'],
  env: ['ID', "Catalogue environment (default: the site's defaultEnv)."],
  repo: ['DIR', 'Portal checkout (instead of PAQVILO_REPO).'],
  project: ['FILE', 'Mirage project file.'],
  portal: ['ID', 'Portal of --project (default: its defaultPortal).'],
  'solution-root': ['DIR', 'Unpacked solution root (repeatable).'],
  'solution-order': ['derived|explicit', 'Keep the listed solution order with explicit.'],
  'data-model': ['standard|enhanced', 'Data model of a YAML source (a .powerpages-site export defaults to enhanced).'],
  runtime: ['power-pages|model-driven|dataverse-api', 'Runtime kind.'],
  simulation: ['dry-run|simulation|deep', 'Simulation level.'],
  port: ['PORT', "Listening port (default: the site's mirage.port, else 8787)."],
  state: [
    'FILE',
    'Runtime state file (data generate and scaffold read it and write the result back to it unless an output file is named; scaffold creates it from the portal when it does not exist).',
  ],
  'state-dir': [
    'DIR',
    'Local state and evidence directory (default: .paqvilo beside --config or --project, else here).',
  ],
  origin: ['HTTPS_ORIGIN', 'Live portal origin for reference reads.'],
  cdp: ['URL', 'DevTools endpoint of the intended connected browser.'],
  preset: [
    'NAME',
    "Data preset (serve defaults to the project's or catalogue site's preset; other commands apply it only when passed).",
  ],
  'preset-mode': ['bootstrap|always', 'When the startup preset applies.'],
  'apply-configuration': ['', "Apply the selected data preset's configuration."],
  'deployment-profile': ['NAME', 'Legacy exported Pages deployment profile.'],
  'pack-module': ['PATH', 'Trusted data pack module (repeatable).'],
  path: ['/PAGE/', 'Portal-relative page path (default /).'],
  output: ['FILE', 'Rendered page file.'],
  stylesheet: ['PATH', 'Live stylesheet to capture (repeatable).'],
  'parent-snippet': ['NAME', 'Content snippet that renders the child.'],
  'child-snippet': ['NAME', 'Content snippet rendered by the parent.'],
  'no-watch': ['', 'Do not reload on source changes.'],
  'allow-live-writes': [
    '',
    'Permit live create, update and delete requests; the /_sim/ live writes switch still decides (off by default).',
  ],
  'start-token': ['TOKEN', 'Set by the toolkit command that starts and records this runtime.'],
  scenario: ['FILE', 'Scenario JSON { id, requires: [...] } that scopes blocking.'],
  strict: ['', 'Block on every unsatisfied requirement.'],
  pack: ['PACK_ID', 'Data pack whose rows generate merges into the state (generate only).'],
  profile: ['NAME', 'Generation profile (generate: default deep; scaffold: smoke or dev, default smoke).'],
  seed: ['S', 'Random seed: generate passes it to the pack, scaffold uses it for its rows.'],
  rows: ['N', 'Rows scaffold generates per table (scaffold only).'],
  out: [
    'FILE',
    'State file generate or scaffold writes the merged state to (default: --state, updated in place); the JSON report goes to standard output.',
  ],
  count: ['NAME=N', 'Rows the pack generates for one of its tables (generate only; repeatable).'],
  'materialize-persona-memberships': [
    '',
    "Also write the pack's persona web-role memberships into the state (generate only; needs the portal source).",
  ],
  json: ['', 'JSON output.'],
});
// What each direct command does, its usage and, where docs/cli.md documents them, its exit codes.
const COMMAND_HELP = Object.freeze({
  serve: {
    purpose: 'Serve a portal, project or standalone runtime locally.',
    usage: [
      'paqvilo mirage serve [--site SITE --env ENV] [--repo PATH]',
      'paqvilo mirage serve --source PATH --port 8787',
      'paqvilo mirage serve --project mirage.project.yml [--portal PORTAL_ID] --port 8787',
    ],
    exit: 'JSON readiness report; --json also makes errors JSON; failure 1.',
  },
  inspect: {
    purpose: 'Print the bootstrap report of a project or portal source (JSON, with or without --json).',
    usage: [
      'paqvilo mirage inspect --project mirage.project.yml --json',
      'paqvilo mirage inspect --source PATH --json',
    ],
    exit: 'failure 1.',
  },
  render: {
    purpose: 'Render one portal page to a file.',
    usage: ['paqvilo mirage render --source PATH --path /PAGE/ --output .paqvilo/page.html'],
  },
  'capture-stylesheets': {
    purpose: 'Capture live stylesheets through the intended connected browser into the local asset cache.',
    usage: [
      'paqvilo mirage capture-stylesheets --site SITE --env ENV --cdp http://127.0.0.1:PORT --stylesheet /styles/theme.css',
    ],
  },
  'capture-snippet-composition': {
    purpose: 'Capture how a live parent snippet composes a child snippet, through the intended connected browser.',
    usage: [
      'paqvilo mirage capture-snippet-composition --site SITE --env ENV --cdp http://127.0.0.1:PORT --path /PAGE/ --parent-snippet NAME --child-snippet NAME',
    ],
  },
  data: {
    purpose: 'Generate pack data or scaffold sample data into a state file (JSON report).',
    usage: MIRAGE_DATA_USAGE.split('\n').map((line) => line.replace(/^ {2}/, '')),
    exit: 'failure 1.',
  },
  preflight: {
    purpose: 'Report the runtime requirements a configuration satisfies and which of them block.',
    usage: [
      'paqvilo mirage preflight (--project FILE [--portal ID] | --config FILE --site ID [--env ID] | --source DIR [--solution-root DIR ...]) [--runtime KIND] [--preset ID] [--scenario FILE] [--strict] [--json]',
    ],
    exit: '0 nothing blocking in scope; 1 blocking requirement(s); 2 invocation or configuration error.',
  },
});
/** One help line per option: --name VALUE, then what it does. */
const mirageOptionLines = (names) =>
  names
    .map((name) => {
      const [value, text] = OPTION_HELP[name];
      const flag = value ? `--${name} ${value}` : `--${name}`;
      return `  ${flag}  ${text}`;
    })
    .join('\n');
/** The help of one direct Mirage command, from COMMAND_HELP and the options it accepts. */
function mirageCommandHelp(command) {
  const { purpose, usage, exit } = COMMAND_HELP[command];
  return [
    `paqvilo mirage ${command}: ${purpose}`,
    '',
    'Usage:',
    ...usage.map((line) => `  ${line}`),
    '',
    'Options:',
    mirageOptionLines(MIRAGE_COMMAND_OPTIONS[command]),
    '  -h, --help  Show this help.',
    ...(exit ? ['', `Exit status: ${exit}`] : []),
  ].join('\n');
}

/** The runtime options, solution roots and startup-preset catalogue that preflight checks, resolved as serve resolves them. */
async function preflightScope(args, { cwd, project, profileMirage, runtime }) {
  let options;
  let presetCatalogue = profileMirage;
  if (runtime.kind !== 'power-pages') {
    if (args.source || args.portal)
      throw new Error('Standalone runtimes select a project or solution roots without a portal or source.');
    options = {
      ...runtimeOptions({ project, catalogue: profileMirage }),
      solutionRoots: project?.solutionRoots ?? args['solution-root'] ?? profileMirage?.solutionRoots ?? [],
      solutionOrder: project?.solutionOrder ?? args['solution-order'] ?? profileMirage?.solutionOrder,
    };
  } else if (project) {
    const portal = project.portals.find((p) => p.id === (args.portal ?? project.defaultPortal));
    options = {
      ...runtimeOptions({ project, portal }),
      sourceDir: portal.sourceDir,
      solutionRoots: portal.solutionRoots,
      solutionOrder: project.solutionOrder,
      dataModel: portal.dataModel ?? undefined,
    };
  } else {
    const { loadConfig } = await import('../lense/config.mjs');
    const cfg =
      args.source && !args.site
        ? null
        : await loadConfig({
            site: args.site,
            env: args.env,
            cwd,
            source: args.source,
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.config ? { config: args.config } : {}),
          });
    // args.source is already an absolute, normalised path: the parser resolves every path argument against cwd.
    const sourceDir = args.source ?? cfg.sourceDir,
      siteMirage = cfg?.mirageConfig ?? null;
    const roots = await resolveSolutionRoots({
      sourceDir,
      explicitRoots: args['solution-root'],
      explicitOrder: args['solution-order'],
      catalogue: siteMirage,
    });
    options = {
      ...runtimeOptions({ catalogue: siteMirage }),
      sourceDir,
      solutionRoots: roots.roots,
      solutionOrder: roots.order,
      dataModel: args['data-model'] ?? siteMirage?.dataModel ?? undefined,
    };
    presetCatalogue = siteMirage;
  }
  return { options, presetCatalogue };
}

/** The scenario of preflight, named as the invocation spelled it in the report; null without --scenario. */
async function readScenario(args, givenScenario) {
  if (!args.scenario) return null;
  const value = await readJsonOption('scenario', args.scenario);
  // A refused scenario names the option and the file it came from; the message never quotes the file's values.
  const { scenarioSettings } = await import('./lib/capability-report.mjs');
  try {
    scenarioSettings(value);
  } catch (error) {
    throw new Error(`--scenario file ${args.scenario} is not a valid scenario: ${error.message}.`, { cause: error });
  }
  return { ...value, file: givenScenario };
}

/** Prints a preflight report: the document with --json, else one line for each requirement in scope that is not satisfied. */
function printPreflight(report, json, out) {
  if (json) out(JSON.stringify(report, null, 2));
  else
    out(
      [
        `Preflight (${report.runtime.kind}): ${report.summary.total} ${report.summary.total === 1 ? 'requirement' : 'requirements'}, ${report.summary.satisfied} satisfied, ${report.summary.blocking} blocking.`,
        ...report.requirements
          .filter((row) => row.inScope && row.status !== 'satisfied')
          .map(
            (row) =>
              `  ${row.blocking ? 'BLOCKING ' : ''}${row.status} ${row.id}${row.message ? ' - ' + row.message : ''}`,
          ),
      ].join('\n'),
    );
}

/** The `preflight` command for these arguments: prints its report and resolves to the exit code. */
async function runPreflight(args, { cwd, givenScenario, project, profileMirage, runtime, simulation, out }) {
  // Same input resolution as serve; sources are loaded without listeners (lib/capability-report.mjs).
  const { preflight, preflightExitCode } = await import('./lib/capability-report.mjs');
  const { options, presetCatalogue } = await preflightScope(args, { cwd, project, profileMirage, runtime });
  const scenario = await readScenario(args, givenScenario);
  const startup = startupPresetChoice(args, { project, catalogue: presetCatalogue });
  const report = await preflight({
    ...options,
    runtime,
    simulation,
    project: project && projectSummary(project),
    lcid: project?.lcid,
    dataPacks: [...(options.dataPacks ?? []), ...(args['pack-module'] ?? []).map((module) => ({ module }))],
    scenario,
    strict: args.strict === true,
    preset: startup.preset,
  });
  printPreflight(report, args.json, out);
  return preflightExitCode(report);
}

/**
 * Runs one mirage command for its arguments and resolves to the exit code, or to null for a `serve` whose runtime
 * keeps running. Only the process entry (cli.mjs) passes `processEntry`: the start token, the start-up alive reports
 * and the start channel belong to a process, so an in-process caller leaves them alone. Output goes to the given
 * streams, and paths in the arguments resolve against `cwd`, not the process's working directory.
 * @returns {Promise<number | null>}
 */
export async function runMirageCommand( // NOSONAR: the command dispatch of the former module-level entry, kept in one place so the process and in-process entries run the same statements
  argv,
  { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), processEntry = false } = {},
) {
  const out = (text) => stdout.write(`${text}\n`);
  const err = (text) => stderr.write(`${text}\n`);
  let exitCode = 0;
  // Start-up progress goes to the start-up log (stderr) and, when a toolkit command started this runtime and waits for
  // it, to that command (lense/start-channel.mjs).
  const announceStartup = processEntry ? startChannelReporter() : () => {};
  const reportStartup = (event) => {
    err(JSON.stringify({ type: 'runtime-startup', ...event }));
    announceStartup(event);
  };
  const terminator = argv.indexOf('--');
  const jsonRequested = (terminator < 0 ? argv : argv.slice(0, terminator)).includes('--json');
  const invocationCommand = () => {
    for (let i = 0; i < argv.length; i++) {
      const word = argv[i];
      if (word === '--') return argv[i + 1];
      if (!word.startsWith('-')) return word;
      const key = word.startsWith('--') && !word.includes('=') ? word.slice(2) : '';
      if (valueOptions.has(key)) i++;
    }
  };
  const invocationError = (error) => {
    if (jsonRequested)
      out(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: mirageFailureCode(error), message: error.message },
        }),
      );
    else err(error.message);
  };
  let parsed;
  try {
    const options = {
      source: { type: 'string' },
      runtime: { type: 'string' },
      simulation: { type: 'string' },
      repo: { type: 'string' },
      // The toolkit catalogue file (lense/config.mjs), as the toolkit's own --config.
      config: { type: 'string' },
      site: { type: 'string' },
      // Without --env the catalogue site's defaultEnv applies (lense/config.mjs).
      env: { type: 'string' },
      port: { type: 'string', default: '8787' },
      state: { type: 'string' },
      'state-dir': { type: 'string' },
      origin: { type: 'string' },
      cdp: { type: 'string' },
      preset: { type: 'string' },
      'preset-mode': { type: 'string' },
      'apply-configuration': { type: 'boolean' },
      path: { type: 'string', default: '/' },
      stylesheet: { type: 'string', multiple: true },
      'parent-snippet': { type: 'string' },
      'child-snippet': { type: 'string' },
      output: { type: 'string' },
      local: { type: 'string' },
      'solution-root': { type: 'string', multiple: true },
      'solution-order': { type: 'string' },
      project: { type: 'string' },
      portal: { type: 'string' },
      'deployment-profile': { type: 'string' },
      pack: { type: 'string' },
      'pack-module': { type: 'string', multiple: true },
      profile: { type: 'string' },
      seed: { type: 'string' },
      rows: { type: 'string' },
      out: { type: 'string' },
      count: { type: 'string', multiple: true },
      'materialize-persona-memberships': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      // preflight: a scenario JSON file { id, requires: [...] } scopes blocking; --strict blocks on every unsatisfied requirement.
      scenario: { type: 'string' },
      strict: { type: 'boolean' },
      'no-watch': { type: 'boolean' },
      // Live create, update and delete requests are impossible without this runtime flag.
      'allow-live-writes': { type: 'boolean' },
      // standard or enhanced: the data model of a YAML source (a .powerpages-site export
      // defaults to enhanced); a project portal and a catalogue site set dataModel instead.
      'data-model': { type: 'string' },
      // Given by the toolkit command that starts and records this runtime (lense/process-identity.mjs).
      'start-token': { type: 'string' },
    };
    parsed = parseRaw({ args: joinNegativeValues(argv, options), allowPositionals: true, tokens: true, options });
  } catch (error) {
    invocationError(error);
    // preflight reports invocation errors with exit code 2.
    return invocationCommand() === 'preflight' ? 2 : 1;
  }
  const { values: args, positionals, tokens } = parsed;
  // An explicit --port wins; without one, serve uses the catalogue site's mirage.port as the lifecycle commands do
  // (docs/cli.md: the site's mirage.port, else 8787).
  const portGiven = tokens.some((token) => token.kind === 'option' && token.name === 'port');
  const servePort = (catalogue) => runtimePort(portGiven ? args.port : (catalogue?.port ?? args.port));
  // The scenario file as the invocation spelled it: the preflight report names that file, not its resolved path.
  const givenScenario = args.scenario;
  // Paths in the arguments name files relative to the invocation's working directory.
  for (const name of ['config', 'project', 'source', 'state', 'state-dir', 'output', 'scenario', 'out', 'repo'])
    if (typeof args[name] === 'string') args[name] = path.resolve(cwd, args[name]);
  if (args['solution-root']) args['solution-root'] = args['solution-root'].map((value) => path.resolve(cwd, value));
  if (args['pack-module'])
    args['pack-module'] = args['pack-module'].map((value) =>
      value.startsWith('./') || value.startsWith('../') ? path.resolve(cwd, value) : value,
    );
  // Held until this process ends: it shows the launcher's record of this runtime to be about a running process.
  if (processEntry) holdStartToken(args['start-token']);
  let statePath = args['state-dir'];
  if (statePath == null) {
    let base;
    if (args.config) base = path.dirname(path.resolve(args.config));
    else if (args.project) base = path.dirname(path.resolve(args.project));
    else base = cwd;
    statePath = path.join(base, '.paqvilo');
  }
  const stateDir = path.resolve(statePath);
  const command = positionals[0] ?? 'serve';
  if (processEntry && command === 'serve' && process.env.MIRAGE_SETUP_RUNTIME) {
    // Started by a toolkit command that waits for this runtime: until its discovery record is published, the runtime
    // says every few seconds that its event loop turns ('alive', lense/startup-progress.mjs), and once it is published
    // that it is ready ('ready', announced where each serve path publishes its record). The launcher's start-up
    // silence bound then ends a runtime that stopped, not one whose start takes long on a loaded host.
    const published = path.join(stateDir, 'simulator', `session-${process.pid}.json`);
    const alive = setInterval(() => {
      fs.access(published).then(
        () => clearInterval(alive),
        () => reportStartup({ phase: 'alive', elapsedMs: Math.round(performance.now()) }),
      );
    }, 5000);
    alive.unref();
  }
  if (args.help && command !== 'help' && !MIRAGE_CORE_COMMANDS.includes(command)) {
    invocationError(unknownCommandError(command));
    return 1;
  }
  if (args.help && positionals.length && MIRAGE_CORE_COMMANDS.includes(command)) {
    out(mirageCommandHelp(command));
    return 0;
  }
  if (args.help || command === 'help') {
    await loadPresets();
    out(`Power Pages local mirage

Commands: ${MIRAGE_COMMANDS.join(', ')}
Also accepted: setup (the same as paqvilo setup)

  paqvilo mirage serve [--site SITE --env ENV] [--repo PATH]
  paqvilo mirage serve --source PATH --port 8787
  paqvilo mirage inspect --project mirage.project.yml --json
  paqvilo mirage serve --project mirage.project.yml --port 8787
  paqvilo mirage serve --project mirage.project.yml --portal PORTAL_ID
  paqvilo mirage inspect --source PATH --json
  paqvilo mirage preflight (--project FILE [--portal ID] | --config FILE --site ID [--env ID] | --source DIR [--solution-root DIR ...]) [--runtime KIND] [--preset ID] [--scenario FILE] [--strict] [--json]
    exit 0: nothing blocking in scope; 1: blocking requirement(s); 2: invocation or configuration error
  paqvilo mirage render --source PATH --path /PAGE/ --output .paqvilo/page.html
  paqvilo mirage capture-stylesheets --site SITE --env ENV --cdp http://127.0.0.1:PORT --stylesheet /styles/theme.css
  paqvilo mirage capture-snippet-composition --site SITE --env ENV --cdp http://127.0.0.1:PORT --path /PAGE/ --parent-snippet NAME --child-snippet NAME
  ${MIRAGE_DATA_USAGE}

Options (each command accepts its own subset; paqvilo mirage COMMAND --help lists them):
${mirageOptionLines(Object.keys(OPTION_HELP))}
Solution roots (--solution-root, else the catalogue site's mirage solutionRoots, else unpacked solution repositories discovered next to the portal repository) are a set layered definition-before-extension; --solution-order explicit (or solutionOrder: explicit in the catalogue site or project file) keeps the listed order.
Admin: /_sim/. New workspaces use local data/page modes; saved modes persist.
Default state and evidence paths are under .paqvilo. Map deploymentProfiles in config and pin locally in /_sim/ → Environment; legacy exported Pages profiles use --deployment-profile.
Presets (registry; a portal lists only packs that match it): ${Object.entries(
      Object.keys(builtinPresets).reduce((groups, id) => {
        const pack = presetDescriptor(builtinPresets, id)?.pack ?? 'generic';
        if (!groups[pack]) groups[pack] = [];
        groups[pack].push(id);
        return groups;
      }, {}),
    )
      .map(([pack, ids]) => `${pack}: ${ids.join(', ')}`)
      .join('; ')}
Live access uses the selected connected browser identity. Exact parity requires passing evidence.`);
    return 0;
  }
  try {
    if (!MIRAGE_CORE_COMMANDS.includes(command)) throw unknownCommandError(command);
    if (command !== 'data' && positionals.length > 1)
      throw new Error(`Unexpected positional argument: ${positionals[1]}`);
    // Defaults are not evidence that an option was supplied: inspect only parser tokens.
    const matrix = MIRAGE_COMMAND_OPTIONS;
    const isCapture = ['capture-stylesheets', 'capture-snippet-composition'].includes(command);
    const allowed = new Set([...matrix[command], 'help', ...(isCapture ? ['preset'] : [])]);
    for (const token of tokens) {
      if (token.kind === 'option' && !allowed.has(token.name))
        throw Object.assign(new Error(`--${token.name} is not supported by mirage ${command}`), {
          code: 'unsupported_option',
        });
      if (token.kind === 'option' && token.name === 'port') runtimePort(token.value);
      if (token.kind === 'option' && token.value === '') throw new Error(`--${token.name} requires a nonempty value`);
    }

    if (args.portal && !args.project) throw new Error('--portal selects a portal from --project.');
    if (args.project && args.source) throw new Error('Use either --project or --source, not both.');
    // preflight's usage presents --project, --config --site and --source as alternatives (serve and data deliberately
    // take a --site's settings under --project).
    if (command === 'preflight' && args.project && (args.config || args.site))
      throw new Error('Use either --project or --config/--site, not both.');
    // The command-line value is named as typed; a project or catalogue value keeps naming its key.
    if (args.runtime !== undefined && !RUNTIME_KINDS.includes(args.runtime))
      throw new Error(choiceMessage('--runtime', RUNTIME_KINDS, args.runtime));
    if (args.simulation !== undefined && !SIMULATION_LEVELS.includes(args.simulation))
      throw new Error(choiceMessage('--simulation', SIMULATION_LEVELS, args.simulation));
    if (isCapture && !args.cdp) throw new Error(`${command} requires --cdp for the intended connected browser.`);
    if (isCapture && args.preset)
      throw new Error(`${command} does not apply presets. Apply --preset when starting serve.`);

    if (command === 'serve' && !processEntry) throw new Error('mirage serve runs as its own process.');
    if (command === 'render' && (!args.path.startsWith('/') || args.path.startsWith('//') || args.path.includes('\\')))
      throw new Error('Render path must be portal-relative.');
    await loadCommandModules();
    if (command === 'data') {
      const { runDataCommand, validateDataCommand } = await import('./lib/data-generation.mjs');
      validateDataCommand(positionals.slice(1), args);
      assertPathOptions(args, INPUT_PATHS);
      // data scaffold resolves its portal like serve: a project file and portal,
      // an explicit --source (solution roots discovered unless --solution-root),
      // or the toolkit catalogue site/environment (--site/--env/--repo).
      const resolved =
        positionals[1] === 'scaffold' || (positionals[1] === 'generate' && args['materialize-persona-memberships'])
          ? await resolveDataSource(args, cwd)
          : {};
      // The catalogue site's data packs (its mirage.dataPacks), as serve registers them, beside --pack-module.
      const siteMirage = args.project ? undefined : await catalogueSiteMirage(args, cwd, null);
      out(
        JSON.stringify(
          await runDataCommand(positionals.slice(1), {
            ...args,
            ...resolved,
            catalogueDataPacks: siteMirage?.dataPacks ?? [],
          }),
          null,
          2,
        ),
      );
    } else {
      assertPathOptions(args, INPUT_PATHS);
      const project = args.project ? await loadProjectConfig(args.project) : null;
      const profileMirage = await catalogueSiteMirage(args, cwd, project);
      const runtime = runtimeSettings(
        args.runtime ? { kind: args.runtime } : (project?.runtime ?? profileMirage?.runtime),
      );
      const simulation = simulationSettings(
        args.simulation ? { level: args.simulation } : (project?.simulation ?? profileMirage?.simulation),
      );
      if (project && args.source) throw new Error('Use either --project or --source, not both.');
      if (project && args['solution-root']?.length)
        throw new Error('--solution-root is supplied by the project configuration.');
      if (project && args['solution-order'])
        throw new Error('--solution-order is supplied by the project configuration (solutionOrder).');
      if (project && args['data-model'])
        throw new Error("--data-model is supplied by the project configuration (the portal's dataModel).");
      if (args['data-model'] != null && !['standard', 'enhanced'].includes(args['data-model']))
        throw new Error('--data-model must be standard or enhanced.');
      if (project && args.portal && !project.portals.some((p) => p.id === args.portal))
        throw new Error(`Portal '${args.portal}' is not configured in ${project.configFile}`);
      if (command === 'preflight')
        exitCode = await runPreflight(args, { cwd, givenScenario, project, profileMirage, runtime, simulation, out });
      else if (runtime.kind !== 'power-pages') {
        if (!['serve', 'inspect'].includes(command)) throw new Error(`${command} requires a Power Pages runtime.`);
        if (args.source || args.portal || args.cdp)
          throw new Error(
            'Standalone runtimes select a project or solution roots without a portal, source, or live browser.',
          );
        const roots = project?.solutionRoots ?? args['solution-root'] ?? profileMirage?.solutionRoots ?? [];
        if (command === 'inspect') {
          // The same Dataverse API validation as serve's startup (lib/standalone-runtime.mjs).
          const { standaloneDataverseSettings } = await import('./lib/dataverse-settings.mjs');
          standaloneDataverseSettings(runtime.kind, runtimeOptions({ project, catalogue: profileMirage }).dataverse);
          const choice = startupPresetChoice(args, { project, catalogue: profileMirage });
          const source = await loadOrganizationSources({
            solutionRoots: roots,
            solutionOrder: project?.solutionOrder ?? args['solution-order'],
            modelDriven: project?.modelDriven ?? profileMirage?.modelDriven,
            lcid: project?.lcid,
          });
          out(
            JSON.stringify(
              {
                runtime,
                simulation,
                startupPreset: { name: choice.preset, mode: choice.presetMode, from: choice.from },
                portals: [],
                solutions: roots,
                applications: source.metadata.modelDrivenApps,
                modelDriven: project?.modelDriven ?? profileMirage?.modelDriven ?? { trustedExtensions: false },
                clientExtensions: {
                  resources: source.clientResources.resources.map(({ name, type }) => ({ name, type })),
                  controls: source.clientResources.pcf.controls.map(({ name, controlType }) => ({ name, controlType })),
                },
                entities: Object.keys(source.metadata.entities),
                diagnostics: [
                  ...(project?.diagnostics ?? []),
                  ...source.metadata.diagnostics,
                  ...source.solutionData.diagnostics,
                  ...source.clientResources.diagnostics,
                ],
              },
              null,
              2,
            ),
          );
        } else {
          const stateFile = path.resolve(
            args.state ??
              (project
                ? projectStateFile(project, 'organization', path.join(stateDir, 'simulator/projects'))
                : path.join(stateDir, 'simulator', runtime.kind, 'state.json')),
          );
          let stop;
          const standaloneProjectRoot = () => {
            if (project) return path.dirname(project.configFile);
            if (args.config) return path.dirname(path.resolve(args.config));
            return cwd;
          };
          const standaloneSetup = () => {
            if (args.config)
              return {
                config: path.resolve(args.config),
                site: args.site,
                ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
              };
            if (project)
              return {
                project: project.configFile,
                ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
              };
            return undefined;
          };
          // Settings of every registered key (config-keys.mjs); command-line choices follow.
          const startup =
            command === 'serve'
              ? startupPresetChoice(args, { project, catalogue: profileMirage })
              : commandLinePreset(args);
          const simulator = await createSimulator({
            ...runtimeOptions({ project, catalogue: profileMirage }),
            configuredSettings: configuredSettingKeys({ project, catalogue: profileMirage }),
            onStartup: reportStartup,
            runtime,
            simulation,
            solutionRoots: roots,
            solutionOrder: project?.solutionOrder ?? args['solution-order'],
            stateFile,
            port: servePort(profileMirage),
            project: project && projectSummary(project),
            projectRoot: standaloneProjectRoot(),
            dataPacks: [
              ...(profileMirage?.dataPacks ?? []),
              ...(args['pack-module'] ?? []).map((module) => ({ module })),
            ],
            setup: standaloneSetup(),
            preset: startup.preset,
            presetMode: startup.presetMode,
            presetConfiguration: startup.presetConfiguration,
            watch: !args['no-watch'] && project?.watch !== false,
            onShutdown: () => stop?.(),
          });
          const discovery = path.join(stateDir, 'simulator', `session-${process.pid}.json`);
          await fs.mkdir(path.dirname(discovery), { recursive: true });
          await fs.writeFile(
            discovery,
            JSON.stringify(
              {
                pid: process.pid,
                runtime,
                project: project?.configFile ?? null,
                sourceDir: null,
                stateFile,
                url: simulator.url,
                adminUrl: adminEntryOf(simulator),
                appsUrl: simulator.appsUrl,
                discovery,
              },
              null,
              2,
            ),
          );
          out(
            JSON.stringify(
              {
                pid: process.pid,
                runtime,
                simulation: simulator.status().simulation,
                url: simulator.url,
                adminUrl: adminEntryOf(simulator),
                appsUrl: simulator.appsUrl,
                dataverse: simulator.status().dataverse,
                discovery,
              },
              null,
              2,
            ),
          );
          ({ stop } = registerRuntimeShutdown({ close: () => simulator.close(), discovery }));
          reportStartup({ phase: 'ready', elapsedMs: Math.round(performance.now()) });
        }
      } else if (project && command === 'inspect') {
        const selected = args.portal ? project.portals.filter((p) => p.id === args.portal) : project.portals;
        const bootstrapped = await bootstrapProject({ ...project, portals: selected });
        // A source with zero recognised pages is not a portal: fail loudly, naming its layout.
        for (const { portal } of bootstrapped.portals) assertPortalSource(portal);
        const choice = startupPresetChoice(args, { project, catalogue: profileMirage });
        out(
          JSON.stringify(
            {
              configFile: project.configFile,
              version: project.version,
              defaultPortal: project.defaultPortal,
              lcid: project.lcid,
              solutionOrder: project.solutionOrder,
              startupPreset: { name: choice.preset, mode: choice.presetMode, from: choice.from },
              portals: bootstrapped.portals.map(
                ({
                  id,
                  sourceDir,
                  origin,
                  reference,
                  solutions,
                  portal,
                  metadata,
                  solutionData,
                  deploymentProfiles,
                  activeProfiles,
                }) => ({
                  id,
                  sourceDir: portal.sourceDir ?? sourceDir,
                  origin: projectOrigin(project, { origin, reference }),
                  solutions,
                  format: portal.format,
                  layout: portal.source?.dialect ?? null,
                  dataModel: portal.dataModel,
                  dataModelSource: portal.dataModelSource,
                  profileSelection: deploymentProfilesSummary(deploymentProfiles, activeProfiles),
                  serverLogics: (portal.serverLogics ?? []).map((item) => item.name),
                  cloudFlows: (portal.cloudFlows ?? []).map((item) => item.name),
                  solutionData: solutionData.stats,
                  pages: portal.pages.map((page) => ({
                    id: page.id,
                    name: page.name,
                    url: page.url,
                    pageTemplateId: page.pageTemplateId,
                  })),
                  templates: new Set(Object.values(portal.templates)).size,
                  snippets: Object.keys(portal.snippets).length,
                  assets: portal.webFiles.length,
                  forms: portal.forms.length,
                  lists: portal.lists.length,
                  liquidSyntax: createPortalRenderer(portal).inspectCapabilities(),
                  solutionMetadata: metadata.summary,
                  diagnostics: [...portal.diagnostics, ...metadata.diagnostics],
                }),
              ),
              solutions: project.solutions,
              references: project.references,
              defaultReference: project.defaultReference?.id ?? null,
              dataPacks: project.dataPacks,
              // Findings of the project file itself (an unknown key of a version-1 project is ignored and reported).
              diagnostics: project.diagnostics ?? [],
              solutionDiagnostics: bootstrapped.solutionData.diagnostics,
            },
            null,
            2,
          ),
        );
        exitCode = bootstrapped.portals.some(({ portal, metadata }) =>
          [...portal.diagnostics, ...metadata.diagnostics].some((d) => d.code?.startsWith('invalid')),
        )
          ? 1
          : 0;
      } else if (project && command === 'serve' && !args.portal) {
        const port = runtimePort(args.port);
        if (port && port + project.portals.length - 1 > 65535)
          throw new Error('The configured portal count exceeds the available port range.');
        const sessions = [];
        let stop;
        // The portals share their Solution roots: each file is parsed once during startup.
        const sharedParses = shareSolutionParses();
        try {
          for (let index = 0; index < project.portals.length; index++) {
            const portal = project.portals[index];
            // Each portal keeps its own state directory (cache/, assets/ and evidence/ live
            // next to the state file): --state DIR/FILE becomes DIR/<portal>/FILE.
            const stateFile = args.state
              ? (() => {
                  const state = path.parse(path.resolve(args.state));
                  return path.join(state.dir, portal.id, state.base);
                })()
              : projectStateFile(project, portal.id, path.join(stateDir, 'simulator/projects'));
            const startup = startupPresetChoice(args, { project, catalogue: profileMirage });
            const simulator = await createSimulator({
              // The catalogue site that --config --site names (lense start --project passes them) applies under the project.
              ...runtimeOptions({ project, portal, catalogue: profileMirage }),
              configuredSettings: configuredSettingKeys({ project, portal, catalogue: profileMirage }),
              onStartup: reportStartup,
              setup: args.config
                ? {
                    config: path.resolve(args.config),
                    site: args.site,
                    ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
                  }
                : {
                    project: project.configFile,
                    ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
                  },
              sourceDir: portal.sourceDir,
              stateFile,
              preset: startup.preset,
              presetMode: startup.presetMode,
              presetConfiguration: startup.presetConfiguration,
              port: port ? port + index : 0,
              origin: projectOrigin(project, portal) ?? args.origin,
              solutionRoots: portal.solutionRoots,
              project: projectSummary(project, portal.id),
              deploymentProfile: portal.deploymentProfile ?? undefined,
              watch: !args['no-watch'] && project.watch !== false,
              onShutdown: () => stop?.(),
              // A source with zero recognised pages is refused, naming its layout.
              requirePortalSource: true,
              allowLiveWrites: args['allow-live-writes'] === true,
            });
            sessions.push({ portal, simulator, stateFile });
            // Keep the runtime in the cleanup set even when browser attachment fails.
            if (args.cdp) await simulator.live.connect(args.cdp);
          }
        } catch (error) {
          await Promise.all(sessions.map(({ simulator }) => simulator.close()));
          throw error;
        } finally {
          sharedParses.close();
        }
        const discovery = path.join(stateDir, 'simulator', `session-${process.pid}.json`);
        await fs.mkdir(path.dirname(discovery), { recursive: true });
        await fs.writeFile(
          discovery,
          JSON.stringify(
            {
              pid: process.pid,
              project: project.configFile,
              portals: sessions.map(({ portal, simulator, stateFile }) => ({
                id: portal.id,
                sourceDir: portal.sourceDir,
                stateFile,
                url: simulator.url,
                adminUrl: adminEntryOf(simulator),
                appsUrl: simulator.appsUrl,
                identityProvider: { origin: simulator.identityProvider.origin, port: simulator.identityProvider.port },
              })),
              discovery,
            },
            null,
            2,
          ),
        );
        out(
          JSON.stringify(
            {
              project: project.configFile,
              portals: sessions.map(({ portal, simulator, stateFile }) => {
                const { config: startedConfig, status: startedStatus } = simulator.state({ summary: true });
                return {
                  id: portal.id,
                  sourceDir: portal.sourceDir,
                  stateFile,
                  url: simulator.url,
                  adminUrl: adminEntryOf(simulator),
                  appsUrl: simulator.appsUrl,
                  // Portal pages carry only site-setting headers unless confinement is opted in.
                  confinePortalPages: startedConfig.confinePortalPages,
                  signInPath: startedStatus.bootstrap.signInPath,
                  startupPreset: startedStatus.startupPreset,
                  // External sign-in's local identity provider: its own loopback port, closed with the runtime.
                  identityProvider: {
                    origin: simulator.identityProvider.origin,
                    port: simulator.identityProvider.port,
                  },
                  // "disabled" unless started with --allow-live-writes.
                  liveWrites: simulator.live.status().liveWrites,
                };
              }),
              discovery,
            },
            null,
            2,
          ),
        );
        ({ stop } = registerRuntimeShutdown({
          close: async () => {
            const results = await Promise.allSettled(sessions.map(({ simulator }) => simulator.close()));
            const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
            if (errors.length) throw new AggregateError(errors, 'Runtime shutdown failed');
          },
          discovery,
        }));
        reportStartup({ phase: 'ready', elapsedMs: Math.round(performance.now()) });
      } else {
        let sourceDir = args.source,
          origin = args.origin;
        let configuredPortal = null;
        let siteMirage = null;
        let sourceConfigFile = args.config;
        if (project) {
          configuredPortal = project.portals.find((p) => p.id === (args.portal ?? project.defaultPortal));
          sourceDir = configuredPortal.sourceDir;
          origin = projectOrigin(project, configuredPortal) ?? origin;
          if (args.config && args.site) {
            const { loadConfig } = await import('../lense/config.mjs');
            siteMirage = (await loadConfig({ config: args.config, site: args.site, env: args.env, cwd })).mirageConfig;
          }
        } else if (!sourceDir) {
          const { loadConfig } = await import('../lense/config.mjs');
          const cfg = await loadConfig({
            site: args.site,
            env: args.env,
            cwd,
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.config ? { config: args.config } : {}),
          });
          sourceDir = cfg.sourceDir;
          sourceConfigFile = cfg.configFile;
          origin ??= /^https:\/\//i.test(cfg.origin ?? '') ? cfg.origin : null;
          args.site ??= cfg.siteName;
          siteMirage = cfg.mirageConfig ?? null;
        } else if (args.site) {
          // --source with a catalogued --site (as `mirage dev` launches serve): the site's
          // mirage settings (observed behaviour, catalogued roots) still apply; --source replaces only its source.
          const { loadConfig } = await import('../lense/config.mjs');
          const cfg = await loadConfig({
            site: args.site,
            env: args.env,
            cwd,
            source: args.source,
            ...(args.repo ? { repo: args.repo } : {}),
            ...(args.config ? { config: args.config } : {}),
          });
          sourceConfigFile = cfg.configFile;
          siteMirage = cfg.mirageConfig ?? null;
        }
        const deploymentProfile = args['deployment-profile'] ?? configuredPortal?.deploymentProfile;
        // The data model of a YAML source: --data-model, else the project portal's or catalogue
        // site's dataModel, else the source's default (lib/importer.mjs).
        const dataModel =
          args['data-model'] ?? (project ? configuredPortal?.dataModel : siteMirage?.dataModel) ?? undefined;
        if (command === 'inspect') {
          const profileConfig = resolveDeploymentProfiles(
            siteMirage?.deploymentProfiles ?? configuredPortal?.deploymentProfiles,
          );
          if (deploymentProfile && Object.keys(profileConfig.profiles).length)
            throw new Error('Use deploymentProfiles or legacy deploymentProfile, not both.');
          const activeProfiles = await loadDeploymentProfiles(profileConfig);
          // A source with zero recognised pages is not a portal: fail loudly, naming its layout.
          const portal = assertPortalSource(
            await importPortal(sourceDir, {
              deploymentProfile: activeProfiles.pagesFile ? activeProfiles.profile : deploymentProfile,
              deploymentProfileFile: activeProfiles.pagesFile,
              dataModel,
            }),
          );
          const choice = startupPresetChoice(args, { project, catalogue: siteMirage });
          out(
            JSON.stringify(
              {
                sourceDir: portal.sourceDir,
                startupPreset: { name: choice.preset, mode: choice.presetMode, from: choice.from },
                profileSelection: deploymentProfilesSummary(profileConfig, activeProfiles),
                format: portal.format,
                layout: portal.source?.dialect ?? null,
                dataModel: portal.dataModel,
                dataModelSource: portal.dataModelSource,
                serverLogics: (portal.serverLogics ?? []).map((item) => item.name),
                cloudFlows: (portal.cloudFlows ?? []).map((item) => item.name),
                pages: portal.pages.map((p) => ({
                  id: p.id,
                  name: p.name,
                  url: p.url,
                  pageTemplateId: p.pageTemplateId,
                })),
                templates: new Set(Object.values(portal.templates)).size,
                snippets: Object.keys(portal.snippets).length,
                assets: portal.webFiles.length,
                forms: portal.forms.length,
                lists: portal.lists.length,
                liquidSyntax: createPortalRenderer(portal).inspectCapabilities(),
                diagnostics: portal.diagnostics,
              },
              null,
              2,
            ),
          );
          exitCode = portal.diagnostics.some((d) => d.code?.startsWith('invalid')) ? 1 : 0;
        } else if (
          command === 'serve' ||
          command === 'render' ||
          command === 'capture-stylesheets' ||
          command === 'capture-snippet-composition'
        ) {
          const capturing = ['capture-stylesheets', 'capture-snippet-composition'].includes(command);
          if (capturing && !args.cdp) throw new Error(`${command} requires --cdp for the intended connected browser.`);
          if (capturing && args.preset)
            throw new Error(`${command} does not apply presets. Apply --preset when starting serve.`);
          if (command === 'capture-stylesheets' && !args.stylesheet?.length)
            throw new Error('capture-stylesheets requires --stylesheet PATH (repeatable).');
          if (command === 'capture-snippet-composition' && (!args['parent-snippet'] || !args['child-snippet']))
            throw new Error('capture-snippet-composition requires --parent-snippet NAME and --child-snippet NAME.');
          // Refused before the runtime starts (and prints its startup events): the capture reads the live HTTPS portal.
          if (capturing && !/^https:\/\//i.test(origin ?? ''))
            throw new Error(
              `${command} needs the live portal's HTTPS origin: select an --env whose origin is HTTPS or pass --origin https://<portal host>.`,
            );
          const port = command === 'serve' ? servePort(profileMirage) : 0;
          const stateFile = path.resolve(
            args.state ??
              (project
                ? projectStateFile(project, configuredPortal.id, path.join(stateDir, 'simulator/projects'))
                : path.join(stateDir, 'simulator', args.site ?? 'default', 'state.json')),
          );
          // Solution roots are resolved as bootstrap-report resolves them: --solution-root,
          // else the catalogue site's mirage roots, else discovery; layered in derived
          // order unless --solution-order explicit (or the site's solutionOrder: explicit).
          const resolvedRoots = project
            ? { roots: configuredPortal.solutionRoots, order: project.solutionOrder }
            : await resolveSolutionRoots({
                sourceDir,
                explicitRoots: args['solution-root'],
                explicitOrder: args['solution-order'],
                catalogue: siteMirage,
                cacheFile: path.join(path.dirname(stateFile), 'cache', 'solution-sources.json'),
              });
          const solutionRoots = resolvedRoots.roots;
          if (command === 'render' && args.output) {
            const { assertReportOutput } = await import('./lib/report-output.mjs');
            await assertReportOutput(args.output, {
              sourceRoots: [sourceDir, ...solutionRoots],
              inputFiles: [sourceConfigFile, project?.configFile, stateFile],
            });
          }
          let stop;
          const powerPagesSetup = () => {
            if (args.config)
              return {
                config: path.resolve(args.config),
                site: args.site,
                ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
              };
            if (project)
              return {
                project: project.configFile,
                ...(process.env.MIRAGE_SETUP_RUNTIME ? {} : { command: 'mirage serve' }),
              };
            return null;
          };
          const powerPagesProjectRoot = () => {
            if (args.config) return path.dirname(path.resolve(args.config));
            if (project?.configFile) return path.dirname(project.configFile);
            return cwd;
          };
          // Only a runtime started to serve takes the project or catalogue default; render and the captures use the command line.
          const startup =
            command === 'serve'
              ? startupPresetChoice(args, { project, catalogue: siteMirage })
              : commandLinePreset(args);
          const simulator = await createSimulator({
            // Settings of every registered key (config-keys.mjs: project portal, project, catalogue site).
            ...runtimeOptions({ project, portal: configuredPortal, catalogue: siteMirage }),
            configuredSettings: configuredSettingKeys({ project, portal: configuredPortal, catalogue: siteMirage }),
            onStartup: reportStartup,
            setup: powerPagesSetup(),
            sourceDir,
            dataPacks: [...(siteMirage?.dataPacks ?? []), ...(args['pack-module'] ?? []).map((module) => ({ module }))],
            runtime,
            simulation,
            projectRoot: powerPagesProjectRoot(),
            ...(project ? { project: projectSummary(project, configuredPortal.id) } : {}),
            stateFile,
            preset: startup.preset,
            presetMode: startup.presetMode,
            presetConfiguration: startup.presetConfiguration,
            port,
            origin,
            solutionRoots,
            solutionOrder: resolvedRoots.order,
            deploymentProfile,
            dataModel,
            watch: command === 'serve' && !args['no-watch'] && project?.watch !== false,
            ...(command === 'serve' ? { onShutdown: () => stop?.() } : {}),
            // A source with zero recognised pages is refused, naming its layout.
            requirePortalSource: true,
            allowLiveWrites: args['allow-live-writes'] === true,
          });
          try {
            if (args.cdp) await simulator.live.connect(args.cdp);
            if (capturing) {
              const state = simulator.state();
              const capturePayload = () =>
                command === 'capture-stylesheets'
                  ? { paths: args.stylesheet }
                  : { path: args.path, parentName: args['parent-snippet'], childName: args['child-snippet'] };
              const response = await fetch(`${simulator.url}/__sim/api/assets/${command}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Sim-CSRF': state.csrf,
                },
                body: JSON.stringify(capturePayload()),
              });
              const report = await response.json();
              const capture = report.report ?? report;
              out(
                JSON.stringify(
                  {
                    ...report,
                    counts: {
                      captured: capture.captured?.length ?? 0,
                      failures: capture.failures?.length ?? 0,
                    },
                  },
                  null,
                  2,
                ),
              );
              exitCode = response.ok ? 0 : 1;
              await simulator.close();
            } else if (command === 'render') {
              const target = new URL(args.path, simulator.url);
              if (target.origin !== simulator.url) throw new Error('Render path escaped the local simulator.');
              // A redirect is reported, never followed: the runtime's answer is the render result.
              const response = await fetch(target, { redirect: 'manual' });
              const location = response.headers.get('location');
              const redirected = response.status >= 300 && response.status < 400;
              if (redirected) {
                await response.body?.cancel();
                if (!args.output) {
                  await simulator.close();
                  throw new Error(
                    `Render path ${args.path} answered ${response.status} to ${location}; render the target path instead.`,
                  );
                }
                out(
                  JSON.stringify(
                    {
                      status: response.status,
                      location,
                      output: null,
                      diagnostics: simulator.state().diagnostics,
                    },
                    null,
                    2,
                  ),
                );
              } else if (args.output) {
                const output = path.resolve(args.output);
                await fs.mkdir(path.dirname(output), { recursive: true });
                // A response without a body (204, 304) still writes the file, empty.
                await pipeline(
                  response.body ? Readable.fromWeb(response.body) : Readable.from([]),
                  createWriteStream(output),
                );
                out(
                  JSON.stringify(
                    {
                      status: response.status,
                      output,
                      diagnostics: simulator.state().diagnostics,
                    },
                    null,
                    2,
                  ),
                );
              } else out(await response.text());
              exitCode = response.ok ? 0 : 1;
              await simulator.close();
            } else {
              const discovery = path.join(stateDir, 'simulator', `session-${process.pid}.json`);
              await fs.mkdir(path.dirname(discovery), { recursive: true });
              await fs.writeFile(
                discovery,
                JSON.stringify(
                  {
                    pid: process.pid,
                    url: simulator.url,
                    adminUrl: adminEntryOf(simulator),
                    appsUrl: simulator.appsUrl,
                    identityProvider: {
                      origin: simulator.identityProvider.origin,
                      port: simulator.identityProvider.port,
                    },
                    sourceDir,
                    stateFile,
                  },
                  null,
                  2,
                ),
              );
              const { config: startedConfig, status: startedStatus } = simulator.state({ summary: true });
              out(
                JSON.stringify(
                  {
                    url: simulator.url,
                    adminUrl: adminEntryOf(simulator),
                    appsUrl: simulator.appsUrl,
                    sourceDir,
                    stateFile,
                    discovery,
                    // Portal pages carry only site-setting headers unless confinement is opted in.
                    confinePortalPages: startedConfig.confinePortalPages,
                    signInPath: startedStatus.bootstrap.signInPath,
                    startupPreset: startedStatus.startupPreset,
                    // External sign-in's local identity provider: its own loopback port, closed with the runtime.
                    identityProvider: {
                      origin: simulator.identityProvider.origin,
                      port: simulator.identityProvider.port,
                    },
                    // "disabled" unless started with --allow-live-writes.
                    liveWrites: simulator.live.status().liveWrites,
                  },
                  null,
                  2,
                ),
              );
              ({ stop } = registerRuntimeShutdown({ close: () => simulator.close(), discovery }));
              reportStartup({ phase: 'ready', elapsedMs: Math.round(performance.now()) });
            }
          } catch (error) {
            await simulator.close();
            throw error;
          }
        } else throw new Error(`Unknown command: ${command}`);
      }
    }
  } catch (error) {
    invocationError(error);
    exitCode = command === 'preflight' ? 2 : 1;
  }
  return command === 'serve' && exitCode === 0 ? null : exitCode;
}

/** Portal source and solution roots for data commands, resolved like serve. */
async function resolveDataSource(options, cwd) {
  return options.project ? projectDataSource(options) : catalogueDataSource(options, cwd);
}

/**
 * The Mirage settings of the catalogue site a command names (--site), or of the catalogue's default site when --config
 * names a catalogue without --site, --project or --source: the site Power Pages commands select (PAQVILO_SITE, then
 * defaultSite, then the first site). A standalone site (no portal) is read from the catalogue as it is, so its packs,
 * Solution roots and personas apply to standalone runtimes too. Undefined without a catalogue or for an unknown site.
 */
async function catalogueSiteMirage(args, cwd, project) {
  if (!args.site && !(args.config && !project && !args.source)) return undefined;
  const { loadCatalogue, resolveMirageConfig } = await import('../lense/config.mjs');
  const catalogue = loadCatalogue({ ...args, cwd });
  const name =
    args.site ??
    catalogue.settings.values.PAQVILO_SITE ??
    catalogue.root.defaultSite ??
    Object.keys(catalogue.sites)[0];
  const selected = catalogue.sites[name];
  if (!selected) return undefined;
  return resolveMirageConfig(selected.mirage, {
    configDir: catalogue.configDir,
    sourceRoot: catalogue.sourceRoot,
    ...(selected.sourceDir ? { sourceDir: selected.sourceDir } : {}),
  });
}

/** A data command's portal from --project [--portal]. */
async function projectDataSource(options) {
  if (options.source) throw new Error('Use either --project or --source, not both.');
  if (options['solution-root']?.length) throw new Error('--solution-root is supplied by the project configuration.');
  if (options['data-model'])
    throw new Error("--data-model is supplied by the project configuration (the portal's dataModel).");
  const project = await loadProjectConfig(options.project);
  const portalId = options.portal ?? project.defaultPortal;
  const portal = project.portals.find((candidate) => candidate.id === portalId);
  if (!portal) throw new Error(`Portal '${portalId}' is not configured in ${project.configFile}`);
  return {
    source: portal.sourceDir,
    dataModel: portal.dataModel ?? undefined,
    'solution-root': portal.solutionRoots,
    resolution: { kind: 'project', configFile: project.configFile, portal: portal.id },
  };
}

/** A data command's portal from --source or a catalogue site (alone, or named with --source as serve accepts it). */
async function catalogueDataSource(options, cwd) {
  let cfg = null;
  if (!options.source || options.site) {
    const { loadConfig } = await import('../lense/config.mjs');
    cfg = await loadConfig({
      site: options.site,
      env: options.env,
      cwd,
      source: options.source,
      ...(options.repo ? { repo: options.repo } : {}),
      ...(options.config ? { config: options.config } : {}),
    });
  }
  const source = options.source ? path.resolve(cwd, options.source) : cfg.sourceDir;
  // The same resolution as serve: --solution-root, else the catalogue site's solutionRoots, else discovery.
  const roots = await resolveSolutionRoots({
    sourceDir: source,
    explicitRoots: options['solution-root'],
    catalogue: cfg?.mirageConfig,
  });
  const solutionRoots = { cli: 'explicit', catalogue: 'catalogue', discovered: 'discovered' }[roots.source];
  return {
    source,
    'solution-root': roots.roots,
    dataModel: options['data-model'] ?? cfg?.mirageConfig.dataModel,
    resolution: options.source
      ? { kind: 'source', solutionRoots }
      : { kind: 'catalogue', site: cfg.siteName, env: options.env, solutionRoots },
  };
}
