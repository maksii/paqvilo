import { spawnSync } from 'node:child_process';

/** Force the offline smoke settings without inherited npm configuration aliases. */
export function offlineSmokeEnv(source = process.env) {
  const env = { ...source };
  const settings = {
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  for (const key of Object.keys(env)) if (Object.hasOwn(settings, key.toLowerCase())) delete env[key];
  return Object.assign(env, settings);
}

/** Run the configured npm CLI and report its output or failure. */
export function runSmokeNpm(npm, args, cwd, timeout = 120_000) {
  const env = args.includes('--offline') ? offlineSmokeEnv() : { ...process.env };
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
