// The command a message tells the user to run, in the form that works where they run it (docs/index.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realpath = (file) => {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
};

/**
 * The package.json nearest to `directory` (that folder, else the closest folder above it that has one), with the
 * folder that holds it; null when there is none or it cannot be read. The nearest one decides even when it does not
 * depend on paqvilo: the lookup never climbs past it to a project further up.
 */
function nearestPackage(directory) {
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file))
      try {
        return { dir, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        return null;
      }
    if (path.dirname(dir) === dir) return null;
  }
}

const quoted = (value) => (/^[\w./:\\<>@=-]+$/.test(value) ? value : JSON.stringify(value));

/**
 * The command line that runs `paqvilo <command...> <extra...>` from `cwd`: the npm script `script` when the nearest
 * package.json defines it as that same paqvilo command, else the paqviloPrefix form.
 * A `config` file other than the working directory's paqvilo.config.yml is passed explicitly, so it never runs
 * through a script that names its own catalogue; and a script that names another catalogue never stands for the
 * working directory's one.
 */
export function paqviloCommand(command, { script, extra = [], config, cwd = process.cwd() } = {}) {
  const pkg = nearestPackage(cwd);
  // The catalogue every command reads by default needs no option.
  if (config && realpath(path.resolve(cwd, config)) === realpath(path.join(cwd, 'paqvilo.config.yml')))
    config = undefined;
  const options = [...(config ? ['--config', path.resolve(cwd, config)] : []), ...extra].map(quoted);
  const defined = !config && script ? pkg?.manifest?.scripts?.[script] : undefined;
  const words = command.map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join(' ');
  if (
    typeof defined === 'string' &&
    new RegExp(String.raw`^(?:npx (?:--no-install )?paqvilo|paqvilo|node \S*paqvilo\.mjs) ${words}(?: |$)`).test(
      defined.trim(),
    ) &&
    readsDefaultCatalogue(defined, pkg.dir, cwd)
  )
    return ['npm run', script, ...(options.length ? ['--', ...options] : [])].join(' ');
  return [...paqviloPrefix(cwd, pkg), ...command, ...options].join(' ');
}

/** Whether an npm script, run in `scriptDir`, reads the working directory's catalogue: it names no other --config. */
function readsDefaultCatalogue(script, scriptDir, cwd) {
  const match = /(?:^|\s)--config(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(script);
  if (!match) return true;
  const named = match[1] ?? match[2] ?? match[3];
  return realpath(path.resolve(scriptDir, named)) === realpath(path.join(cwd, 'paqvilo.config.yml'));
}

/**
 * The words that start the paqvilo command line from `cwd`: `node bin/paqvilo.mjs` in the toolkit checkout,
 * `npx --no-install paqvilo` in a project that depends on paqvilo and `npx paqvilo` elsewhere.
 */
export function paqviloPrefix(cwd = process.cwd(), pkg = nearestPackage(cwd)) {
  if (pkg && realpath(pkg.dir) === realpath(TOOL_ROOT))
    return ['node', path.relative(cwd, path.join(TOOL_ROOT, 'bin', 'paqvilo.mjs')).replaceAll('\\', '/')];
  if (pkg?.manifest?.dependencies?.paqvilo || pkg?.manifest?.devDependencies?.paqvilo)
    return ['npx', '--no-install', 'paqvilo'];
  // Outside a project the toolkit was run as an installed or fetched package; npx finds either.
  return ['npx', 'paqvilo'];
}
