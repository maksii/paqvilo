// Detached runner of a /_setup/ preview operation (lense/setup/preview.mjs): runs `paqvilo mirage stop` and/or
// `paqvilo mirage start` for one configuration and site, and records progress in the operation file.
// Arguments: <operation file> <start|stop|restart> <--config|--project> <file> [site]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [target, action, flag, file, site] = process.argv.slice(2);
const bin = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
const record = value => fs.writeFileSync(target, JSON.stringify({ action, site: site || null, pid: process.pid, at: new Date().toISOString(), ...value }));
const report = text => { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return null; } };
const lastLine = text => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';

const steps = action === 'restart' ? ['stop', 'start'] : [action];
for (const step of steps) {
  record({ state: 'running', step });
  const result = spawnSync(process.execPath, [bin, 'mirage', step, flag, file, ...(site ? ['--site', site] : []), '--json'],
    { cwd: path.dirname(file), encoding: 'utf8', timeout: 180_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const json = report(result.stdout ?? '');
  if (result.status !== 0 || json?.ok === false) {
    record({ state: 'failed', step, message: json?.errors?.[0]?.message ?? (lastLine(result.stderr) || result.error?.message || `paqvilo mirage ${step} failed.`) });
    process.exit(1);
  }
  if (step === 'start') record({ state: 'running', step, url: json?.url ?? null });
}
record({ state: 'done', step: steps.at(-1) });
