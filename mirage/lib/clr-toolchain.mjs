// The toolchain that compiles and starts the local plug-in host (plugin-clr-host.cs). On Windows it is the .NET
// Framework 4 compiler and the host executable runs on its own, as Dataverse runs plug-ins on the .NET Framework. On macOS
// and Linux it is a supported .NET SDK (10 or later): the original .NET Framework plug-in assemblies and the
// Microsoft.Xrm.Sdk they reference load on modern .NET, the host is compiled with the SDK's own C# compiler and the dotnet
// command starts it.
import fs from 'node:fs';
import path from 'node:path';

/** The oldest .NET SDK the host is built with: the current long-term support release. */
export const DOTNET_MIN_MAJOR = 10;

// Where installers put the dotnet command when PATH does not name it: the dotnet-install script, the macOS installer,
// Homebrew (Apple silicon, Intel), and Linux distribution and Microsoft packages.
const dotnetFolders = (env) => [
  ...(env.HOME && path.isAbsolute(env.HOME) ? [path.join(env.HOME, '.dotnet')] : []),
  '/usr/local/share/dotnet',
  '/opt/homebrew/opt/dotnet/libexec',
  '/usr/local/opt/dotnet/libexec',
  '/usr/share/dotnet',
  '/usr/lib/dotnet',
  '/usr/lib64/dotnet',
  '/opt/dotnet',
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

const versionParts = (name) => name.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
function compareVersions(a, b) {
  const left = versionParts(a),
    right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? -1,
      y = right[index] ?? -1;
    if (x === y) continue;
    // A prerelease label sorts before the release it precedes (10.0.100-rc.1 before 10.0.100).
    if (typeof x !== typeof y) return typeof x === 'number' ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The newest SDK under a dotnet root with its C# compiler, of major version DOTNET_MIN_MAJOR or later, or null. */
function newestSdk(root) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, 'sdk'));
  } catch {
    return null;
  }
  const usable = names
    .filter((name) => /^\d+\.\d+\.\d+/.test(name) && Number(name.split('.')[0]) >= DOTNET_MIN_MAJOR)
    .filter((name) => fs.existsSync(path.join(root, 'sdk', name, 'Roslyn', 'bincore', 'csc.dll')))
    .sort(compareVersions);
  const version = usable.at(-1);
  return version ? { version, directory: path.join(root, 'sdk', version) } : null;
}

/** The dotnet command (DOTNET_ROOT, PATH, then the standard install folders) whose root holds a usable SDK, or null. */
function findDotnet(env, folders) {
  const candidates = [
    ...(env.DOTNET_ROOT && path.isAbsolute(env.DOTNET_ROOT) ? [env.DOTNET_ROOT] : []),
    ...String(env.PATH ?? '')
      .split(path.delimiter)
      .filter((folder) => path.isAbsolute(folder)),
    ...folders,
  ];
  for (const folder of candidates) {
    const file = path.join(folder, 'dotnet');
    if (!executableFile(file)) continue;
    let command;
    try {
      // A dotnet on PATH is usually a link (/usr/bin/dotnet, /opt/homebrew/bin/dotnet) into its root.
      command = fs.realpathSync(file);
    } catch {
      continue;
    }
    const sdk = newestSdk(path.dirname(command));
    if (sdk) return { command, root: path.dirname(command), sdk };
  }
  return null;
}

/**
 * The toolchain, or null when none is installed:
 * - Windows: `{ kind: 'netfx', runtime, compiler, compilerArguments: [], launcher: null }`, the .NET Framework compiler.
 * - elsewhere: `{ kind: 'dotnet', runtime, dotnet, root, sdkVersion, sdkDirectory, compiler, launcher }`, a .NET SDK of
 *   major version DOTNET_MIN_MAJOR or later; `compiler` and `launcher` are the dotnet command.
 */
export function clrToolchain({ platform = process.platform, env = process.env, folders } = {}) {
  if (platform === 'win32')
    return {
      kind: 'netfx',
      runtime: '.NET Framework',
      compiler: path.join(env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      compilerArguments: [],
      launcher: null,
    };
  const found = findDotnet(env, folders ?? dotnetFolders(env));
  if (!found) return null;
  return {
    kind: 'dotnet',
    runtime: '.NET',
    dotnet: found.command,
    root: found.root,
    sdkVersion: found.sdk.version,
    sdkDirectory: found.sdk.directory,
    compiler: found.command,
    launcher: found.command,
  };
}

/**
 * Removes what an ended .NET host left in its temporary folder. At start the runtime creates two debugger pipes and a
 * diagnostics socket there, named after its process id, and removes them only when it exits by itself; a host that was
 * ended (after its result, on a timeout or cancel, when its pool closes) or that crashed leaves all three. The .NET
 * Framework host (`launcher` null) creates none.
 *
 * The socket's path is cut to the length a Unix socket address holds, so in a long temporary folder its name ends
 * early (`dotnet-diagnostic-<pid>-<number>-sock`, `dotnet-diagnostic-<pid>-`). A name cut before the dash that ends
 * the process id is the same for other processes too and is left alone.
 */
export function removeClrHostLeftovers(launcher, pid, env = process.env) {
  if (!launcher || !Number.isInteger(pid)) return;
  const folder = env.TMPDIR || '/tmp';
  const pipe = `clr-debug-pipe-${pid}-`,
    socket = `dotnet-diagnostic-${pid}-`;
  // What follows the process id in a socket name, whole or cut anywhere: digits, then the start of "-socket".
  const socketEnd = (rest) => {
    const digits = /^\d*/.exec(rest)[0].length;
    return digits === rest.length || (digits > 0 && '-socket'.startsWith(rest.slice(digits)));
  };
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const own = name.startsWith(pipe)
      ? /^\d+-(?:in|out)$/.test(name.slice(pipe.length))
      : name.startsWith(socket) && socketEnd(name.slice(socket.length));
    if (!own) continue;
    try {
      fs.rmSync(path.join(folder, name), { force: true });
    } catch {
      // A folder that became read-only: nothing this owner can remove.
    }
  }
}

/** The command and arguments that start the host `executable` with `args` under `launcher` (null: the executable itself). */
export function clrHostCommand(launcher, executable, args) {
  return launcher ? [launcher, [executable, ...args]] : [executable, args];
}

/**
 * The environment of a host process. Under modern .NET the sandbox's UTC clock is the process time zone (TZ=UTC): .NET
 * reads it for TimeZoneInfo.Local and DateTime.Now, also after a plug-in clears the cached zone; the host checks it.
 * The .NET Framework host pins UTC itself and gets the environment unchanged.
 */
export function clrHostEnvironment(launcher, env = process.env) {
  if (!launcher) return env;
  return { ...env, TZ: 'UTC', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
}
