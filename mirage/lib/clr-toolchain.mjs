// The .NET Framework toolchain that compiles and starts the local plug-in host (plugin-clr-host.cs). On Windows it is the
// .NET Framework 4 compiler, and the host executable runs on its own. Elsewhere (macOS, Linux) it is Mono: the host and
// the original plug-in assemblies are .NET Framework images, which Mono runs; Mono's csc.exe compiles the host and the
// mono command starts it.
import fs from 'node:fs';
import path from 'node:path';

// Where Mono installs its mono command when PATH does not name it: Homebrew (Apple silicon, Intel), the mono-project.com
// macOS package, and Linux distribution packages.
const MONO_FOLDERS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Library/Frameworks/Mono.framework/Versions/Current/Commands',
  '/usr/bin',
];

function executableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The mono command on PATH or in a standard install folder, or null. */
function findMono(env, standardFolders) {
  const folders = [
    ...String(env.PATH ?? '')
      .split(path.delimiter)
      .filter((folder) => path.isAbsolute(folder)),
    ...standardFolders,
  ];
  for (const folder of folders) {
    const file = path.join(folder, 'mono');
    if (executableFile(file)) return file;
  }
  return null;
}

/**
 * `{ runtime, compiler, compilerArguments, launcher }`: run `compiler` with `compilerArguments` before the csc options
 * to build the host, and start the host with `launcher` (null: the executable itself). Null when no toolchain is
 * installed. Mono's compiler is the csc.exe of the same Mono installation, so a `csc` of another tool on PATH is never
 * used.
 */
export function clrToolchain({ platform = process.platform, env = process.env, folders = MONO_FOLDERS } = {}) {
  if (platform === 'win32')
    return {
      runtime: '.NET Framework',
      compiler: path.join(env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      compilerArguments: [],
      launcher: null,
    };
  const mono = findMono(env, folders);
  if (!mono) return null;
  let real;
  try {
    real = fs.realpathSync(mono);
  } catch {
    return null;
  }
  const csc = path.resolve(path.dirname(real), '..', 'lib', 'mono', '4.5', 'csc.exe');
  if (!fs.existsSync(csc)) return null;
  return { runtime: 'Mono', compiler: real, compilerArguments: [csc], launcher: real };
}

/** The command and arguments that start the host `executable` with `args` under `toolchain`. */
export function clrHostCommand(launcher, executable, args) {
  return launcher ? [launcher, [executable, ...args]] : [executable, args];
}
