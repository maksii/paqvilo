#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { parseOptions } from '../lense/cli-options.mjs';
import { MIRAGE_TOOLS, MIRAGE_LIFECYCLE, mirageToolHelp } from '../mirage/tool-registry.mjs';
import { parseToolHelp } from '../mirage/tool-options.mjs';
import { forwardTerminationSignals } from '../lense/signal-forwarding.mjs';

const HELP = `paqvilo — Power Platform source development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]
       paqvilo init [dir] [options]
       paqvilo setup [--config FILE | --project FILE] [--open]
       paqvilo dataverse <command> [options]
       paqvilo analyze --source DIR | --project FILE | --config FILE [options]
       paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, analyze, map, status, audit, resources, verify, agent, model-driven
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          demo, init, dev, start, status, stop, serve, inspect, data
          ${Object.keys(MIRAGE_TOOLS).join(', ')}
  doctor  Check installed dependencies and browser readiness.
  analyze Review declared Power Platform sources offline, including standalone projects.
  init    Scaffold a consumer project; --check, --ready and --refresh-editor maintain it.
  setup   Local configuration workspace at /_setup/, including incomplete projects.
  dataverse  Register a provisioning app, plan/apply metadata, publish and export.

Run paqvilo lense --help, paqvilo mirage --help or paqvilo dataverse --help for options.
`;
const DOCTOR_HELP =
  'Usage: paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]\n\n  --setup    Check installed dependencies and browser readiness.\n  --json     Print the readiness report as JSON.\n  --config   Resolve the catalogue browser without importing portal sources.\n  --browser  Explicit browser channel, overriding the catalogue.';
const ANALYZE_HELP = `Usage: paqvilo analyze [--source PATH | --project FILE | --config FILE] [options]

Review declared Power Platform sources locally, including standalone Dataverse projects.
  --source PATH    Review a source folder or supported package without a catalogue.
                   With --config or --site, --source overrides the selected site's portal source; with --all the same folder is applied to every site. Without a catalogue it is a standalone folder.
  --project FILE   Review a Mirage project's declared sources without a portal.
  --config FILE    Select a catalogue and its declared source roots.
  --site NAME      Select a catalogue site, including a standalone runtime.
  --all            Review every catalogue site's declared sources separately.
  --repo DIR       Override the catalogue source checkout root; cannot be combined with --source or --project alone.
  --env NAME       Select the catalogue environment context; no request is made; cannot be combined with --source or --project alone.
  --fail-on LEVEL  none, error (default), warning or hint; incomplete inspection fails.
  --json           Include rule, domain, inventory and separate-evidence capability details.

Analysis does not run builds, project modules, native tools, flows or live requests.
See docs/static-analysis.md for supported source formats and evidence boundaries.`;
const argv = process.argv.slice(2);
const [product, ...args] = argv;
// A flag after the option terminator is a positional value, never a request for help/JSON.
const hasFlag = (items, ...flags) =>
  items.slice(0, !items.includes('--') ? items.length : items.indexOf('--')).some((arg) => flags.includes(arg));
function failure(error, code, label = 'paqvilo', items = args) {
  if (hasFlag(items, '--json'))
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message: error.message } }));
  else console.error(`${label}: ${error.message.replace(/[\r\n]+/g, ' ')}`);
  process.exitCode = 1;
}
// A repeated single-value option is an invalid_argument whatever the command's fallback code is.
const argumentFailureCode = (error, fallback) => (error.code === 'invalid_argument' ? error.code : fallback);
const exitStatus = (code, signal) => {
  if (code != null) return code;
  if (signal === 'SIGINT') return 130;
  return signal === 'SIGTERM' ? 143 : 1;
};
if (['--version', '-v', '--help', '-h'].includes(product)) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } },
    });
    console.log(values.help ? HELP : JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  } catch (error) {
    failure(error, 'INVALID_ARGUMENT', 'paqvilo', argv);
  }
} else if (product === undefined) {
  console.log(HELP);
} else if (product === 'setup' || (['lense', 'mirage'].includes(product) && args[0] === 'setup')) {
  const setupArgs = product === 'setup' ? args : args.slice(1);
  try {
    process.exitCode = await (await import('../lense/commands/setup.mjs')).runSetup(setupArgs);
  } catch (error) {
    failure(error, argumentFailureCode(error, 'SETUP_FAILED'), 'paqvilo setup', setupArgs);
  }
} else if (product === 'init') {
  try {
    process.exitCode = await (await import('../lense/commands/init.mjs')).runInit(args);
  } catch (error) {
    failure(error, error.code ?? 'INIT_FAILED', 'paqvilo init');
  }
} else if (product === 'doctor') {
  try {
    const { values } = parseOptions({
      args,
      options: {
        setup: { type: 'boolean' },
        json: { type: 'boolean' },
        config: { type: 'string' },
        browser: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) console.log(DOCTOR_HELP);
    else {
      if (!values.setup) throw new Error('doctor requires --setup. Run paqvilo doctor --help for options.');
      if (values.config !== undefined && !values.config.trim()) throw new Error('--config requires a non-empty value');
      let browser = values.browser;
      if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
        throw new Error('--browser must be msedge, chrome or chromium');
      if (values.config) {
        const { loadCatalogue } = await import('../lense/config.mjs');
        const catalogue = loadCatalogue({ config: values.config });
        browser ??= catalogue.settings.values.PAQVILO_BROWSER ?? catalogue.root.browser.channel;
      }
      if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
        throw new Error('--browser must be msedge, chrome or chromium');
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url)),
          '--check',
          ...(values.json ? ['--json'] : []),
          ...(browser ? ['--browser', browser] : []),
        ],
        { stdio: 'inherit', windowsHide: true },
      );
      child.on('exit', (code, signal) => {
        process.exitCode = exitStatus(code, signal);
      });
      child.on('error', (error) => {
        failure(error, 'SETUP_CHECK_FAILED', 'paqvilo doctor');
      });
    }
  } catch (error) {
    failure(error, argumentFailureCode(error, 'SETUP_CHECK_FAILED'), 'paqvilo doctor');
  }
} else if (product === 'analyze' && hasFlag(args, '--help', '-h')) {
  try {
    parseOptions({
      args,
      options: {
        source: { type: 'string' },
        project: { type: 'string' },
        config: { type: 'string' },
        site: { type: 'string' },
        env: { type: 'string' },
        repo: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        'fail-on': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    console.log(ANALYZE_HELP);
  } catch (error) {
    failure(error, argumentFailureCode(error, 'INVALID_ARGUMENT'), 'paqvilo analyze');
  }
} else if (product === 'mirage' && Object.hasOwn(MIRAGE_TOOLS, args[0]) && hasFlag(args, '--help', '-h')) {
  try {
    // Validate the operational schema without importing or executing the operation.
    parseToolHelp(args[0], args.slice(1));
    console.log(mirageToolHelp(args[0]));
  } catch (error) {
    failure(error, 'INVALID_ARGUMENT', `paqvilo mirage ${args[0]}`);
  }
} else if (!['lense', 'mirage', 'dataverse', 'analyze'].includes(product)) {
  const message = `Unknown command ${JSON.stringify(product)}. Choose lense, mirage, dataverse, analyze, init, setup or doctor. Run paqvilo --help for options.`;
  failure(new Error(message), 'UNKNOWN_PRODUCT', 'paqvilo', argv);
} else {
  const lifecycle = new Set(MIRAGE_LIFECYCLE);
  const tools = new Set(Object.keys(MIRAGE_TOOLS));
  let program, forwarded, helpSupplement;
  if (product === 'dataverse') {
    program = '../lense/dataverse/cli.mjs';
    forwarded = args;
  } else if (product === 'analyze') {
    program = '../lense/cli.mjs';
    forwarded = ['analyze', ...args];
  } else if (product === 'lense') {
    program = '../lense/cli.mjs';
    forwarded = args;
  } else if (args[0] === 'demo') {
    program = '../lense/commands/demo.mjs';
    forwarded = args.slice(1);
  } else if (lifecycle.has(args[0])) {
    program = '../lense/cli.mjs';
    forwarded = ['mirage', ...args];
  } else if (tools.has(args[0])) {
    program = `../mirage/${args[0]}.mjs`;
    forwarded = args.slice(1);
  } else {
    program = '../mirage/cli.mjs';
    forwarded = args.length ? args : ['--help'];
    const overview = !args.length || ['--help', '-h', 'help'].includes(args[0]);
    if (overview) helpSupplement = `Public Mirage tools:\n${Object.keys(MIRAGE_TOOLS).map(mirageToolHelp).join('')}`; // NOSONAR: preserve callback identity and iteration arguments
    if (overview && hasFlag(args, '--help', '-h'))
      helpSupplement +=
        '\nMirage demo: paqvilo mirage demo (editable sample and development browser).\nMirage lifecycle: init, dev, start, status, stop (catalogue and browser options: paqvilo lense --help).';
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL(program, import.meta.url)), ...forwarded], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    failure(error, 'SPAWN_FAILED');
  });
  // A terminal interrupt is also sent to the child; allow its browser/runtime cleanup to finish.
  const stopForwarding = forwardTerminationSignals(child);
  child.on('exit', (code, signal) => {
    stopForwarding();
    process.exitCode = exitStatus(code, signal);
    // A failed help parse must not prefix a JSON error with human-readable help.
    if (code === 0 && helpSupplement) console.log(helpSupplement);
  });
}
