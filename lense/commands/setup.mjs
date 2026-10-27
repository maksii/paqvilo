import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { startSetupServer } from '../setup/server.mjs';

export const SETUP_HELP = `Usage: paqvilo setup [--config FILE | --project FILE] [--port N] [--open] [--json]

Serve the local /_setup/ configuration workspace, including incomplete projects.
  --config   Shared catalogue (default: ./paqvilo.config.yml; no bundled fallback)
  --project  Standalone Mirage project (YAML or JSON)
  --port     Loopback port; 0 chooses a free port (default)
  --open     Open the workspace in your system browser
  --json     Print the setup URL and project scope as JSON
Ctrl+C stops only this setup server. Saves apply on the next preview start.
`;

export async function runSetup(args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      project: { type: 'string' },
      port: { type: 'string' },
      open: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(SETUP_HELP);
    return 0;
  }
  for (const [key, value] of Object.entries(values)) {
    const entries = Array.isArray(value) ? value : [value];
    if (entries.some((item) => typeof item === 'string' && !item.trim()))
      throw new Error(`--${key} must not be empty or whitespace`);
  }
  if (values.config && values.project) throw new Error('Select --config or --project.');
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535))
    throw new Error('--port must be an integer between 0 and 65535');
  const server = await startSetupServer({
    config: values.config,
    project: values.project,
    port: Number(values.port ?? 0),
  });
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.log(
      values.json
        ? JSON.stringify({
            schemaVersion: 1,
            url: server.url,
            config: values.config ?? values.project ?? './paqvilo.config.yml',
          })
        : `setup       ${server.url}\nLocal project configuration. Ctrl+C to stop.`,
    );
    if (values.open) {
      const command =
        process.platform === 'win32'
          ? [
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${server.url}' -WindowStyle Hidden`],
            ]
          : process.platform === 'darwin'
            ? ['open', [server.url]]
            : ['xdg-open', [server.url]];
      const child = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
      child.on('error', (error) => console.error(`Open ${server.url} in your browser (${error.message}).`));
    }
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await server.close();
  }
  return 0;
}
