// Building the plug-in host (and C# test fixtures) with a modern .NET SDK on macOS and Linux. A probe project, built once
// per SDK and cached, lets NuGet and MSBuild resolve the .NET reference assemblies, the WCF client that
// Microsoft.Xrm.Sdk's fault types bind to, and the SDK's own C# compiler. Every later compilation calls that compiler
// directly with the resolved lists, so it needs no network and no project file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileCached, compileCacheKey } from './compile-cache.mjs';

/** The framework the host and fixtures target: .NET 10, the current long-term support release. */
const DOTNET_TARGET = 'net10.0';
// The WCF client: System.ServiceModel.Primitives with its System.ServiceModel facade, which the .NET Framework
// Microsoft.Xrm.Sdk (FaultException<OrganizationServiceFault>) and plug-ins that catch its faults bind to. An exact
// version, so a build never floats to a newer package.
const WCF_VERSION = '10.1.0';
// hang guard only: a first restore downloads the packages
const RESTORE_GUARD_MS = 600_000;

const PROBE = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>${DOTNET_TARGET}</TargetFramework>
    <OutputType>Library</OutputType>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <ImplicitUsings>disable</ImplicitUsings>
    <GenerateDependencyFile>false</GenerateDependencyFile>
    <CopyLocalLockFileAssemblies>true</CopyLocalLockFileAssemblies>
    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="System.ServiceModel.Primitives" Version="[${WCF_VERSION}]" />
  </ItemGroup>
  <Target Name="PaqviloBuildInputs" AfterTargets="ResolveAssemblyReferences">
    <WriteLinesToFile File="$(PaqviloOut)/compile.txt" Lines="@(ReferencePath)" Overwrite="true" />
    <WriteLinesToFile File="$(PaqviloOut)/runtime.txt" Lines="@(ReferenceCopyLocalPaths->WithMetadataValue('Extension','.dll'))" Overwrite="true" />
    <WriteLinesToFile File="$(PaqviloOut)/roslyn.txt" Lines="$(RoslynTargetsPath)" Overwrite="true" />
  </Target>
</Project>
`;

/** The environment of a dotnet build: no telemetry, banner or first-run setup output. */
const buildEnvironment = (env = process.env) => ({
  ...env,
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
});

const lines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

function probe(toolchain, run, timeout) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-dotnet-'));
  try {
    const project = path.join(work, 'paqvilo-build-inputs.csproj');
    fs.writeFileSync(project, PROBE);
    // dotnet picks its SDK from the nearest global.json above the working folder: a project's own global.json (pinning
    // another SDK) must not apply, so the probe runs in its private folder pinned to the SDK the toolchain chose.
    fs.writeFileSync(
      path.join(work, 'global.json'),
      JSON.stringify({ sdk: { version: toolchain.sdkVersion, rollForward: 'disable' } }) + '\n',
    );
    // `dotnet build` leaves an MSBuild node and the compiler server running for minutes after it returns, with their
    // pipes and folders in the temporary folder, and a folder of its own there. MSBuild itself, with node reuse and the
    // shared compiler off, restores and builds the same and leaves no process.
    const build = run(
      toolchain.dotnet,
      [
        'msbuild',
        project,
        '-restore',
        '-nologo',
        '-v:q',
        '-nodeReuse:false',
        '-p:UseSharedCompilation=false',
        '-p:Configuration=Release',
        '-p:PaqviloOut=' + work,
        '-p:OutputPath=' + path.join(work, 'out') + path.sep,
      ],
      { shell: false, cwd: work, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout, env: buildEnvironment() },
    );
    if (build.error || build.status !== 0) {
      const detail = String(build.error?.message ?? build.stdout + build.stderr)
        .trim()
        .split(/\r?\n/)
        .slice(-12)
        .join('\n');
      throw new Error(
        `The .NET plug-in host needs the ${DOTNET_TARGET} reference pack and System.ServiceModel.Primitives ` +
          `${WCF_VERSION} from NuGet (restored once, then used offline); dotnet build failed:\n${detail}`,
      );
    }
    const roslyn = lines(path.join(work, 'roslyn.txt'))[0];
    return {
      csc: path.join(roslyn, 'bincore', 'csc.dll'),
      compile: lines(path.join(work, 'compile.txt')),
      // The host runs without a dependency manifest, so only the portable assembly of each package sits beside it: a
      // package's runtimes/<rid>/ variants (System.Security.Cryptography.Pkcs for Windows) are for other platforms.
      runtime: lines(path.join(work, 'runtime.txt')).filter((file) => !file.split(/[\\/]/).includes('runtimes')),
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `{ csc, compile, runtime }` for `toolchain` (a dotnet clrToolchain): the SDK's C# compiler (csc.dll), the reference
 * assemblies to compile against and the package assemblies a host or fixture needs beside it at run time. Cached per SDK
 * and package set; a cached list whose files were since removed (a cleared NuGet cache) is resolved again.
 */
export function dotnetBuildInputs(toolchain, { run = spawnSync, cacheRoot, timeout = RESTORE_GUARD_MS } = {}) {
  const usable = (inputs) =>
    inputs && [inputs.csc, ...inputs.compile, ...inputs.runtime].every((file) => fs.existsSync(file));
  const key = compileCacheKey([
    'clr-dotnet-inputs/2',
    toolchain.dotnet,
    toolchain.sdkVersion,
    DOTNET_TARGET,
    WCF_VERSION,
  ]);
  const cached = compileCached({
    ...(cacheRoot === undefined ? {} : { root: cacheRoot }),
    key,
    files: [],
    into: os.tmpdir(),
    build: () => probe(toolchain, run, timeout),
  }).meta;
  return usable(cached) ? cached : probe(toolchain, run, timeout);
}

/** The dotnet arguments that start the SDK's C# compiler against the .NET reference assemblies (csc options follow). */
const dotnetCompilerArguments = (inputs) => [
  'exec',
  inputs.csc,
  '/noconfig',
  '/nostdlib+',
  '/nologo',
  '/deterministic+',
  ...inputs.compile.map((reference) => '/reference:' + reference),
];

/**
 * Runs the SDK's C# compiler: `target` (exe or library) into `out` from `sources`, against the .NET reference assemblies
 * and `references` (paths), with `defines`.
 */
export function dotnetCompile(
  toolchain,
  inputs,
  { out, target, sources, references = [], defines = [], run, timeout },
) {
  return run(
    toolchain.dotnet,
    [
      ...dotnetCompilerArguments(inputs),
      '/target:' + target,
      ...defines.map((name) => '/define:' + name),
      '/out:' + out,
      ...references.map((reference) => '/reference:' + reference),
      ...sources,
    ],
    {
      shell: false,
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout,
      env: buildEnvironment(),
    },
  );
}

/** Writes the runtime configuration beside `executable` (name.runtimeconfig.json): .NET 10 or any later runtime. */
export function writeDotnetRuntimeConfig(executable) {
  const file = path.join(
    path.dirname(executable),
    path.basename(executable, path.extname(executable)) + '.runtimeconfig.json',
  );
  const config = {
    runtimeOptions: {
      tfm: DOTNET_TARGET,
      rollForward: 'Major',
      framework: { name: 'Microsoft.NETCore.App', version: DOTNET_TARGET.slice(3) + '.0' },
    },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return file;
}
