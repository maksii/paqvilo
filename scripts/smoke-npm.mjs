import { spawnSync } from 'node:child_process';

/** Run the configured npm CLI and report its output or failure. */
export function runSmokeNpm(npm, args, cwd, timeout = 120_000) {
  const env = { ...process.env };
  if (args.includes('--offline')) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_update_notifier') delete env[key];
    env.npm_config_update_notifier = 'false';
  }
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(result.error?.message ?? `${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
