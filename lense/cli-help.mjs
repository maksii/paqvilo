import { LENSE_COMMAND_OPTIONS } from './cli-options.mjs';

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
  },
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

/** The selected command's existing option contract, without loading or executing it. */
export function lenseCommandHelp(command, action, overview, mirageInitHelp) {
  if (command === 'mirage' && action === 'init') return mirageInitHelp;
  const definition = commands[command];
  const executable = command === 'mirage' ? 'paqvilo mirage' : `paqvilo lense ${command}`;
  let syntax = definition.syntax ?? '';
  if (definition.actions) {
    const actions = definition.actions.includes(action) ? action : definition.actions.join('|');
    syntax = ` ${actions}`;
  }
  const documentation = optionDocumentation(overview);
  const options = LENSE_COMMAND_OPTIONS[command].map((name) => {
    if (definition.optionHelp?.[name]) return definition.optionHelp[name];
    const lines = documentation.get(name);
    if (!lines) throw new Error(`Missing help for --${name}`);
    return lines.join('\n');
  });
  if (!LENSE_COMMAND_OPTIONS[command].includes('json'))
    options.push('  --json            print this help as JSON (with --help)');
  options.push('  --help, -h        show this command help');
  return `${executable} — ${definition.summary}\n\nUsage: ${executable}${syntax} [options]\n\nOptions\n${options.join('\n')}\n`;
}
