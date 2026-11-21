#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parseOptions } from '../lense/cli-options.mjs';
import {
  MIRAGE_TOOLS,
  MIRAGE_TOOL_USAGE_EXIT,
  MIRAGE_LIFECYCLE,
  MIRAGE_CORE_COMMANDS,
  mirageToolHelp,
} from '../mirage/tool-registry.mjs';
import { parseToolHelp } from '../mirage/tool-options.mjs';
import { exitOnUnhandledTermination, exitStatus, forwardTerminationSignals } from '../lense/signal-forwarding.mjs';

const HELP = `paqvilo — Power Platform source development

Usage: paqvilo lense <command> [options]
       paqvilo mirage <command> [options]
       paqvilo init [dir] [options]
       paqvilo setup [--config FILE | --project FILE] [--open]
       paqvilo dataverse <command> [options]
       paqvilo analyze --source DIR | --project FILE | --config FILE [options]
       paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]
       paqvilo --version | -v   Print the toolkit version (also paqvilo lense --version, paqvilo mirage --version).

  lense   Overlay local sources, inspect resources and browser sessions.
          dev, list, use, doctor, analyze, map, status, audit, resources, verify, agent, model-driven
  mirage  Render exported portals with Liquid and simulated Dataverse on loopback.
          ${[...new Set(['demo', ...MIRAGE_LIFECYCLE, ...MIRAGE_CORE_COMMANDS])].join(', ')}
          ${Object.keys(MIRAGE_TOOLS).join(', ')}
  lense setup and mirage setup are aliases of paqvilo setup.
  doctor  Check installed dependencies and browser readiness.
  analyze Review declared Power Platform sources offline, including standalone projects.
  init    Scaffold a consumer project; --check, --ready and --refresh-editor maintain it.
  setup   Local configuration workspace at /_setup/, including incomplete projects.
  dataverse  Register a provisioning app, plan/apply metadata, publish and export.

Run paqvilo lense --help, paqvilo mirage --help or paqvilo dataverse --help for options.
`;
const DOCTOR_HELP =
  'Usage: paqvilo doctor --setup [--json] [--config FILE] [--browser CHANNEL]\n\n  --setup    Check installed dependencies and browser readiness.\n  --json     Print the readiness report as JSON.\n  --config   Catalogue whose browser is checked (default: ./paqvilo.config.yml when present), read without importing portal sources.\n  --browser  Explicit browser channel, overriding the catalogue.\nWithout a catalogue or --browser the browser is not checked, and the report says so.';
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
const LENSE_CLI = '../lense/cli.mjs';
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
// An unknown option (unsupported_option), a repeated or malformed one (invalid_argument) and a catalogue that does not
// exist (CONFIG_NOT_FOUND, lense/config.mjs) keep their code whatever the command's fallback code is.
const argumentFailureCode = (error, fallback) =>
  ['invalid_argument', 'unsupported_option', 'CONFIG_NOT_FOUND'].includes(error.code) ? error.code : fallback;
const toolkitVersion = () => JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
if (['lense', 'mirage'].includes(product) && args.length === 1 && ['--version', '-v'].includes(args[0])) {
  // Both products are part of the toolkit and share its version.
  console.log(toolkitVersion());
} else if (['--version', '-v', '--help', '-h'].includes(product)) {
  try {
    const { values } = parseOptions({
      args: argv,
      options: { version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } },
    });
    console.log(values.help ? HELP : toolkitVersion());
  } catch (error) {
    failure(error, argumentFailureCode(error, 'INVALID_ARGUMENT'), 'paqvilo', argv);
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
      if (!values.setup) {
        const { paqviloCommand } = await import('../lense/command-hint.mjs');
        throw new Error(`doctor requires --setup. Run ${paqviloCommand(['doctor', '--help'])} for options.`);
      }
      if (values.config !== undefined && !values.config.trim()) throw new Error('--config requires a non-empty value');
      let browser = values.browser;
      let unreadable;
      if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
        throw new Error('--browser must be msedge, chrome or chromium');
      if (browser === undefined) {
        // --config, else the working directory's catalogue as the other commands find it.
        const local = 'paqvilo.config.yml';
        const config = values.config ?? (fs.existsSync(local) ? local : undefined);
        if (config) {
          const { loadCatalogue } = await import('../lense/config.mjs');
          try {
            const catalogue = loadCatalogue({ config });
            browser = catalogue.settings.values.PAQVILO_BROWSER ?? catalogue.root.browser.channel;
          } catch (error) {
            // An explicit --config must load. The working directory's catalogue may be an unfinished project, which
            // the setup page sends here: the other checks still run and the browser is reported as not checked.
            if (values.config !== undefined) throw error;
            unreadable = String(error.message)
              .replace(/[\r\n]+/g, ' ')
              .trim()
              .replace(/:$/, '');
          }
        }
      }
      if (browser !== undefined && !['msedge', 'chrome', 'chromium'].includes(browser))
        throw new Error('--browser must be msedge, chrome or chromium');
      let browserNotChecked;
      if (!browser) {
        const { paqviloCommand } = await import('../lense/command-hint.mjs');
        const check = paqviloCommand(['doctor', '--setup'], { extra: ['--browser', '<channel>'] });
        const reason = unreadable
          ? `paqvilo.config.yml in this folder could not be read: ${unreadable}`
          : 'no --browser, and no paqvilo.config.yml in this folder names one';
        browserNotChecked = `Browser: not checked (${reason}). Check it with: ${check} (msedge, chrome or chromium), or with --config FILE.`;
      }
      // Without a browser to check, the report says so: a JSON report gains prerequisites.browserNotChecked.
      const capture = Boolean(browserNotChecked && values.json);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../scripts/ensure-dependencies.mjs', import.meta.url)),
          '--check',
          ...(values.json ? ['--json'] : []),
          ...(browser ? ['--browser', browser] : []),
        ],
        { stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], windowsHide: true },
      );
      let output = '';
      if (capture) child.stdout.on('data', (chunk) => (output += chunk));
      child.on('close', (code, signal) => {
        process.exitCode = exitStatus(code, signal);
        if (capture) {
          let report;
          try {
            report = JSON.parse(output);
          } catch {
            process.stdout.write(output);
            return;
          }
          if (report.prerequisites) report.prerequisites.browserNotChecked = browserNotChecked;
          console.log(JSON.stringify(report, null, 2));
        } else if (browserNotChecked && !values.json) console.log(browserNotChecked);
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
    // An unknown option is unsupported_option everywhere; the tools' other help-time refusals keep INVALID_ARGUMENT.
    failure(error, error.code === 'unsupported_option' ? error.code : 'INVALID_ARGUMENT', `paqvilo mirage ${args[0]}`);
    // With --help as without it, a refused argument exits with the tool's own argument-error code.
    process.exitCode = MIRAGE_TOOL_USAGE_EXIT[args[0]] ?? 1;
  }
} else if (!['lense', 'mirage', 'dataverse', 'analyze'].includes(product)) {
  const message = `Unknown command ${JSON.stringify(product)}. Choose lense, mirage, dataverse, analyze, init, setup or doctor. Run paqvilo --help for options.`;
  failure(new Error(message), 'unknown_command', 'paqvilo', argv);
} else {
  const lifecycle = new Set(MIRAGE_LIFECYCLE);
  const tools = new Set(Object.keys(MIRAGE_TOOLS));
  let program, forwarded, helpSupplement;
  if (product === 'dataverse') {
    program = '../lense/dataverse/cli.mjs';
    forwarded = args;
  } else if (product === 'analyze') {
    program = LENSE_CLI;
    forwarded = ['analyze', ...args];
  } else if (product === 'lense') {
    program = LENSE_CLI;
    forwarded = args;
  } else if (args[0] === 'demo') {
    program = '../lense/commands/demo.mjs';
    forwarded = args.slice(1);
  } else if (lifecycle.has(args[0])) {
    program = LENSE_CLI;
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
        '\nMirage demo: paqvilo mirage demo (editable sample and development browser).\nMirage lifecycle: init, dev, start, status, stop (catalogue and browser options: paqvilo lense --help).\nMirage setup: paqvilo mirage setup is an alias of paqvilo setup (local configuration workspace at /_setup/).';
  }
  if (program === LENSE_CLI) {
    // The lense command line (lense, analyze and the Mirage lifecycle) runs in this process: a second Node process
    // only to relay its arguments, output and exit code cost every command a process start.
    process.argv.splice(1, Infinity, fileURLToPath(new URL(program, import.meta.url)), ...forwarded);
    // A signal that ends the command when nothing handles it ends it with the exit code of that signal, as the
    // relaying process reported it. Windows reports a console interrupt by its own exit code, in one process as in two.
    exitOnUnhandledTermination();
    await import(program);
  } else {
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
}
