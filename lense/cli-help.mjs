import { DATAVERSE_COMMAND_OPTIONS, LENSE_COMMAND_OPTIONS, MIRAGE_ACTION_OPTIONS } from './cli-options.mjs';

// Help stays independent of command implementations, configuration and runtime modules.
const commands = {
  dev: { summary: 'open an environment with local source overlays' },
  list: { summary: 'list catalogue sites, environments and the effective selection' },
  use: { summary: 'remember the site and environment in .env', syntax: ' [site] [environment]' },
  map: { summary: 'map online resources to local source files' },
  status: { summary: 'compare local web files with the selected environment' },
  verify: { summary: 'verify the browser workflow using a temporary source copy' },
  doctor: { summary: 'check configuration, mappings and baseline offline' },
  analyze: { summary: 'review source quality, security and performance offline' },
  audit: { summary: 'inventory exported code and report source mapping gaps offline' },
  resources: { summary: 'discover editable source files and metadata relationships offline' },
  agent: {
    summary: 'inspect or control an owned local session (always JSON)',
    actions: [
      'sessions',
      'status',
      'pages',
      'events',
      'state',
      'snapshot',
      'screenshot',
      'navigate',
      'reload',
      'viewport',
      'stop',
    ],
  },
  'model-driven': {
    summary: 'inspect or overlay exported Solution sources',
    actions: ['inspect', 'dev'],
    defaultAction: 'dev',
    optionHelp: {
      project: '  --project <file>  project file declaring the selected Solution sources',
      timeout: '  --timeout <ms>    dev: stop the session after 1..3600000 milliseconds (not supported by inspect)',
      output: '  --output <file>   dev: write a JSON session report when the session stops (not supported by inspect)',
      json: '  --json            inspect: print its report as JSON; with --help: print this help as JSON',
    },
  },
  mirage: {
    summary: 'manage a local simulation runtime',
    actions: ['init', 'start', 'dev', 'status', 'inspect', 'stop'],
    actionSummary: {
      init: 'write the Mirage project file for a catalogue site',
      start: 'start a local Mirage runtime in the background and print its address',
      dev: 'start a local Mirage runtime and open it with the paqvilo panel; it stops when the browser closes',
      status: 'list the local Mirage runtimes and whether they are ready',
      inspect: 'inspect the sources a Mirage runtime would load, offline',
      stop: 'stop the Mirage runtimes this toolkit started',
    },
  },
};

/**
 * Options the overview describes for several commands, described for each command that accepts them: by
 * `mirage <action>`, then by command, then `*`. A missing entry uses the overview's own description.
 */
const sharedOptionHelp = {
  env: {
    'model-driven': '  --env <name>      declared model-driven reference ID',
    '*': '  --env <name>      catalogue environment',
  },
  source: {
    analyze: null,
    '*': '  --source <dir>    use this extract folder instead of the configured one',
  },
  portals: {
    mirage: '  --portals <selected|all> one Mirage or one per catalogue site (default from config)',
    '*': '  --portals <selected|all> one origin or every catalogue origin (default from config)',
  },
  'cdp-url': { '*': '  --cdp-url <url>        attach to an already running browser' },
  path: {
    dev: '  --path <urlpath>  optional first tab only',
    verify: '  --path <urlpath>  page to test',
    agent: '  --path <urlpath>  navigate: portal path to open',
    'model-driven': '  --path <urlpath>  dev: start path of the app tab',
    'mirage dev': '  --path <urlpath>  optional first tab only',
    mirage: '  --path <urlpath>  dev: optional first tab only',
  },
  headless: { '*': '  --headless        no browser window' },
  headed: { '*': '  --headed          show the browser window' },
  'no-reload': { '*': '  --no-reload       do not reload tabs when sources change' },
  'debug-port': {
    '*': "  --debug-port <n>  launched browser's debugger port (0 = off; incompatible with CDP attachment)",
  },
  json: {
    ...Object.fromEntries(
      ['start', 'status', 'inspect', 'stop'].map((action) => [
        `mirage ${action}`,
        '  --json            machine readable output',
      ]),
    ),
    mirage: '  --json            machine readable output (not supported by mirage dev)',
    '*': '  --json            machine readable output',
  },
  limit: {
    resources: '  --limit <n>       1..500 entries (default 100)',
    agent: '  --limit <n>       result limit',
  },
  all: {
    doctor: "  --all             check every configured site's default environment offline",
    analyze: "  --all             review every catalogue site's declared sources separately",
    audit: "  --all             inventory every configured site's default environment offline",
  },
  'fail-on': {
    doctor: '  --fail-on <none|error|warning|hint> static analysis threshold (default: none, advisory)',
    analyze: '  --fail-on <none|error|warning|hint> static analysis threshold (default: error)',
  },
  strict: {
    verify: '  --strict          fail on new diagnostics',
    audit: '  --strict          fail on blocked or unmapped resources',
  },
  'startup-timeout': {
    'mirage start':
      '  --startup-timeout <ms> longest start-up silence without progress\n                    (default: 120000; absolute cap 600000 ms)',
    'mirage dev':
      '  --startup-timeout <ms> longest start-up silence without progress\n                    (default: 120000; absolute cap 600000 ms)',
    mirage:
      '  --startup-timeout <ms> start/dev: longest start-up silence without progress\n                    (default: 120000; absolute cap 600000 ms)',
    'model-driven':
      '  --startup-timeout <ms> dev: longest start-up silence without progress\n                    (default: 120000; absolute cap 600000 ms)',
  },
  'allow-live-writes': {
    mirage: null,
    '*': "  --allow-live-writes let the runtime send create, update and delete\n                    requests to the live environment once _sim's live-writes switch is on\n                    (default: off; without it no live write can leave the runtime)",
  },
  site: { 'mirage status': '  --site <name>     only the runtimes of this catalogue site' },
  project: { analyze: "  --project <file>  review a Mirage project's declared sources without a portal" },
};

function optionDocumentation(overview) {
  const documentation = new Map();
  let current;
  for (const line of overview.split('\n')) {
    const option = /^ {2}--([\w-]+)/.exec(line);
    if (option) {
      current = [line];
      documentation.set(option[1], current);
    } else if (current && /^ {3,}\S/.test(line)) current.push(line);
    else current = undefined;
  }
  return documentation;
}

/** The overview's description of an option without the leading name of the command it is shown for. */
function withoutCommandQualifier(text, command) {
  const name = command.replaceAll('-', String.raw`\-`);
  return text.replace(new RegExp(String.raw`(?<=^ {2}--\S+(?: \S+)?\s+)${name}(?:: | (?=[\w/-]+: ))`), '');
}

/** The selected command's existing option contract, without loading or executing it. */
export function lenseCommandHelp(command, action, overview) {
  const definition = commands[command];
  const selected = definition.actions?.includes(action) ? action : undefined;
  const executable = command === 'mirage' ? 'paqvilo mirage' : `paqvilo lense ${command}`;
  let syntax = definition.syntax ?? '';
  if (definition.actions) syntax = ` ${selected ?? definition.actions.join('|')}`;
  const defaultNote = !selected && definition.defaultAction ? ` (default: ${definition.defaultAction})` : '';
  const actionSummary = selected && definition.actionSummary?.[selected];
  const title = actionSummary
    ? `${executable} ${selected} — ${actionSummary}`
    : `${executable} — ${definition.summary}`;
  const accepted = (actionSummary && MIRAGE_ACTION_OPTIONS[selected]) || LENSE_COMMAND_OPTIONS[command];
  const documentation = optionDocumentation(overview);
  const options = accepted.map((name) => {
    if (definition.optionHelp?.[name]) return definition.optionHelp[name];
    const shared = sharedOptionHelp[name] ?? {};
    const specific = [`${command} ${selected}`, command, '*'].find((key) => Object.hasOwn(shared, key));
    if (specific && shared[specific] !== null) return shared[specific];
    const lines = documentation.get(name);
    if (!lines) throw new Error(`Missing help for --${name}`);
    return withoutCommandQualifier(lines.join('\n'), command);
  });
  if (!accepted.includes('json')) options.push('  --json            print this help as JSON (with --help)');
  options.push('  --help, -h        show this command help');
  return `${title}\n\nUsage: ${executable}${syntax} [options]${defaultNote}\n\nOptions\n${options.join('\n')}\n`;
}

const readsLive = 'Live environment: reads only; it changes nothing in Dataverse.';
const writesLive = (what) => `Live environment: WRITES — ${what}.`;
const dataverseCommands = {
  register: {
    summary: 'register a provisioning application with the active PAC administrator profile',
    access: writesLive(
      'creates an Entra application and its Dataverse application user through PAC, then saves its DPAPI-protected connection',
    ),
    notes:
      'Refused with REGISTRATION_EXISTS when a *.json file beside --connection records this environment or name, or when\nthe tenant already lists an application with this name; reuse it with inspect or verify.',
  },
  inspect: {
    summary: 'show a connection file without its credentials',
    access: 'Live environment: not contacted; reads only the --connection file.',
  },
  connect: {
    summary: 'finish a partial registration with the same application and its client secret',
    access:
      'Live environment: reads only (verifies the application identity and its roles); writes the --connection file and\nupdates the --registration file.',
  },
  verify: { summary: 'verify the application identity and organisation of a connection', access: readsLive },
  plan: {
    summary: 'plan the metadata a manifest declares',
    access:
      'Live environment: not contacted without --connection (offline payload plan); with it, reads only and changes\nnothing in Dataverse.',
  },
  apply: {
    summary: 'create the missing manifest components; incompatible existing metadata is refused, nothing is deleted',
    access: writesLive('creates tables, columns, choices, keys, relationships, forms and views'),
  },
  publish: {
    summary: 'publish only the tables and choices the manifest declares',
    access: writesLive('publishes customisations'),
  },
  keys: {
    summary: 'report asynchronous alternate-key activation; exits 2 until every key is Active',
    access: readsLive,
  },
  'audit-lookups': {
    summary: 'complete auditing on the declared custom lookups after relationship creation',
    access: writesLive('updates the audit setting of declared lookup columns'),
  },
  'scope-solutions': {
    summary: 'narrow declared table roots to explicit subcomponents before exporting',
    access: writesLive('changes the components of the declared Solutions'),
  },
  export: {
    summary: 'export an unmanaged Solution and optionally unpack it with PAC',
    access: `${readsLive} Writes the --out ZIP (and --unpack folder) locally.`,
  },
  'data-plan': {
    summary: 'inventory a fixture catalogue offline, or reconcile it read-only with --connection',
    access:
      'Live environment: not contacted without --connection; with it, reads only and changes nothing in Dataverse.',
  },
  'data-apply': {
    summary: 'create missing fixture rows and links; drift is refused, nothing is deleted',
    access: writesLive('creates rows and associations'),
  },
  'data-compare': {
    summary: 'compare controlled fields and exact association sets; exits 2 when they differ',
    access: readsLive,
  },
  'data-query': {
    summary: 'run the catalogue FetchXML queries under this application identity; exits 2 when a query fails',
    access: readsLive,
  },
};

/** Each option's description: by command, then `*`. */
const dataverseOptionHelp = {
  connection: {
    register: '  --connection <file>   connection file to create under an ignored .paqvilo directory',
    connect: '  --connection <file>   connection file to create under an ignored .paqvilo directory',
    plan: '  --connection <file>   reconcile against this connection (read-only)',
    'data-plan': '  --connection <file>   reconcile against this connection (read-only)',
    '*': '  --connection <file>   connection file written by register or connect',
  },
  name: { '*': '  --name <name>         application name' },
  role: {
    connect: '  --role <role>         security role to record (default: the registration role)',
    '*': '  --role <role>         security role of the application user (default: System Customizer)',
  },
  environment: {
    '*': '  --environment <url>   HTTPS organisation origin; must be the active PAC environment',
  },
  'allow-additional-application': {
    '*': '  --allow-additional-application  skip the existing-registration checks and create another application',
  },
  'update-labels': {
    '*': '  --update-labels       also change display labels/descriptions of declared tables and columns (plan: labelsOnly)',
  },
  registration: {
    '*': '  --registration <file> registration file register saved beside the connection (under .paqvilo)',
  },
  'secret-file': { '*': '  --secret-file <file>  file holding the client secret (under .paqvilo)' },
  'consume-secret-file': { '*': '  --consume-secret-file delete the secret file after the connection is saved' },
  manifest: { '*': '  --manifest <file>     Dataverse manifest JSON' },
  catalogue: { '*': '  --catalogue <file>    fixture catalogue JSON' },
  solution: { '*': '  --solution <name>     unique name of the Solution to export' },
  unpack: { '*': '  --unpack <directory>  unpack the exported ZIP into this folder with PAC' },
  out: {
    plan: '  --out <file>          save the plan and print only its summary (unless --json)',
    'data-plan': '  --out <file>          save the report and print only its summary (unless --json)',
    'data-compare': '  --out <file>          save the report and print only its summary (unless --json)',
    'data-query': '  --out <file>          save the report and print only its summary (unless --json)',
    export: '  --out <file>          ZIP file to create; it must not exist',
    '*': '  --out <file>          journal file to create; it must not exist (default: .paqvilo/dataverse/)',
  },
  json: {
    plan: '  --json                print the full result, also with --out; errors as JSON',
    'data-plan': '  --json                print the full result, also with --out; errors as JSON',
    'data-compare': '  --json                print the full result, also with --out; errors as JSON',
    'data-query': '  --json                print the full result, also with --out; errors as JSON',
    '*': '  --json                print errors as JSON',
  },
};

/** One `paqvilo dataverse` command's help, listing exactly the options DATAVERSE_COMMAND_OPTIONS accepts. */
export function dataverseCommandHelp(command) {
  const { summary, access, notes } = dataverseCommands[command];
  const { required, optional } = DATAVERSE_COMMAND_OPTIONS[command];
  const describe = (name) => {
    const text = dataverseOptionHelp[name];
    return text[Object.hasOwn(text, command) ? command : '*'];
  };
  const usage = required
    .map((name) => `--${name} <${['name', 'solution'].includes(name) ? 'name' : 'file'}>`)
    .join(' ');
  return [
    `paqvilo dataverse ${command} — ${summary}`,
    '',
    `Usage: paqvilo dataverse ${command} ${usage} [options]`,
    '',
    access,
    ...(notes ? [notes] : []),
    '',
    'Required',
    ...required.map(describe),
    '',
    'Options',
    ...optional.map(describe),
    '  --help, -h            show this command help',
    '',
    'Exit codes: 0 success; 1 failure, including an option this command does not accept' +
      (/exits 2/.test(summary) ? '; 2 the check did not pass' : '') +
      '.',
    '',
  ].join('\n');
}
