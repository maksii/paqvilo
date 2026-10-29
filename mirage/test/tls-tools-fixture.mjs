import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Resolve optional local TLS clients without changing the process-wide command search path. */
export function tlsTools({
  platform = process.platform,
  required = process.env.PAQ_TEST_REQUIRE_TLS_TOOLS === '1',
  run = spawnSync,
} = {}) {
  const probe = (command, args) => run(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const python = ['python3', 'python', 'py'].find((name) => probe(name, ['--version']).status === 0) ?? null;
  let openssl = probe('openssl', ['version']).status === 0 ? 'openssl' : null;
  if (!openssl && platform === 'win32') {
    const git = probe('git', ['--exec-path']);
    if (git.status === 0 && git.stdout?.trim()) {
      const bundled = path.win32.resolve(git.stdout.trim(), '../../..', 'usr/bin/openssl.exe');
      if (probe(bundled, ['version']).status === 0) openssl = bundled;
    }
  }
  const missing = [!python && 'Python', !openssl && 'OpenSSL'].filter(Boolean);
  if (required && missing.length)
    throw new Error(`Required TLS verification tools are unavailable: ${missing.join(', ')}.`);
  return { python, openssl };
}
