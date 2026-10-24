import { spawn } from 'node:child_process';

export async function runHook(command, { persona, cwd } = {}) {
  if (!command) return { skipped: true };
  const resolved = command.replace(/\{persona\}/g, persona ?? '');
  const words = resolved.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!words) throw new Error('Hook command is empty.');
  const [file, ...args] = words.map((item) => item.replace(/^"|"$/g, ''));
  return new Promise((resolve, reject) => {
    const options = { cwd: cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    // Windows hooks already run as command lines. Preserve the authored quoting
    // rather than stripping it and asking Node to concatenate literal argv again.
    const child =
      process.platform === 'win32'
        ? spawn(resolved, { ...options, shell: true })
        : spawn(file, args, { ...options, shell: false });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve({ code, output: out.slice(-2000) })
        : reject(new Error(`Hook failed (${code}): ${resolved}\n${out.slice(-2000)}`)),
    );
  });
}

export const MUTATING_HOOK_FAILURE = 'BASELINE_MUTATING_HOOK_UNCERTAIN';

/** Hook exit errors cannot prove whether an authored mutation committed or partially applied. */
export async function runMutatingHook(hook, command, options) {
  try {
    return await runHook(command, options);
  } catch (cause) {
    const error = new Error(
      `Mutating hook ${hook} failed; project reconciliation is required before continuing. ${cause.message}`,
      { cause },
    );
    error.code = MUTATING_HOOK_FAILURE;
    error.hook = hook;
    throw error;
  }
}
