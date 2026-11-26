// The `pcf` setting: code component sources besides the selected Solutions, and the catalogue's per-resource byte cap.
//
// A pcf-scripts project builds each control into `<outDir>/<Control>/` (pcfconfig.json `outDir`, `out/controls` by
// default; the .pcfproj `OutputPath`): ControlManifest.xml with its resources rewritten to the built files (bundle.js,
// css, strings, img). No ControlManifest.xml.data.xml is written, so the build output does not name its control. The
// customcontrol name that `pac solution` and `pac pcf push` import is the publisher prefix, an underscore and the
// manifest's namespace.constructor (Learn's Liquid example `abc_SampleNamespace.MapControl`). A source therefore declares
// its prefix: `publisherPrefix`, or `solution`, the solution project (a .cdsproj or its folder, or a Solution.xml) whose
// Publisher CustomizationPrefix the controls are packaged with. Build output sources follow the selected Solutions, so a
// local build supersedes the exported control of the same name.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSolutionXml, child, childText } from './solution-xml.mjs';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Learn, pac pcf push --publisher-prefix: 2 to 8 alphanumerics, starting with a letter, not starting with mscrm.
const PREFIX = /^[a-z][a-z\d]{1,7}$/i;
const validPrefix = (value) => typeof value === 'string' && PREFIX.test(value) && !/^mscrm/i.test(value);
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;
/** Default per-resource byte cap of the PCF catalogue (`pcf.maxResourceBytes` changes it). */
export const PCF_RESOURCE_LIMIT = 8 * 1024 * 1024;
// Declared images and the files a declared bundle or style refers to (code-components.mjs SIBLING), by extension.
const EXTENSION_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['ico', 'image/x-icon'],
  ['bmp', 'image/bmp'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['eot', 'application/vnd.ms-fontobject'],
  ['map', 'application/json; charset=utf-8'],
]);
/** The content type of a code component image, font or source map by its extension, or null. */
export const pcfFileType = (file) =>
  EXTENSION_TYPES.get(/\.([a-z\d]+)$/i.exec(String(file ?? ''))?.[1]?.toLowerCase()) ?? null;

function localPath(value, label) {
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value))
    throw new Error(`${label} must be a local path`);
}

/**
 * Validate `pcf`: `{ sources?: [{ path, publisherPrefix } | { path, solution }], maxResourceBytes?, platformLibraries? }`;
 * paths resolve from `base`. `platformLibraries` lists local `<Library>@<version>.js` files (React, ReactDOM,
 * FluentUIReact) the Power Pages host loads on every page with a code component.
 */
// The Liquid tag dataset binding: "none" (default, as Power Pages) or "view" (local-only explicit view binding).
function liquidDatasetBinding(value, label) {
  if (!['none', 'view'].includes(value)) throw new Error(`${label}.liquidDatasetBinding must be "none" or "view"`);
  return value;
}

export function pcfSettings(value, label = 'pcf', base = process.cwd()) {
  if (value == null) return { sources: [] };
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['sources', 'maxResourceBytes', 'platformLibraries', 'liquidDatasetBinding'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'`);
  const result = { sources: [] };
  if (value.liquidDatasetBinding !== undefined)
    result.liquidDatasetBinding = liquidDatasetBinding(value.liquidDatasetBinding, label);
  if (value.maxResourceBytes !== undefined) {
    if (
      !Number.isSafeInteger(value.maxResourceBytes) ||
      value.maxResourceBytes < 1 ||
      value.maxResourceBytes > MAX_RESOURCE_BYTES
    )
      throw new Error(`${label}.maxResourceBytes must be an integer from 1 to ${MAX_RESOURCE_BYTES}`);
    result.maxResourceBytes = value.maxResourceBytes;
  }
  if (value.platformLibraries !== undefined) {
    if (!Array.isArray(value.platformLibraries) || value.platformLibraries.length > 16)
      throw new Error(`${label}.platformLibraries must be an array of at most 16 local <Library>@<version>.js files`);
    result.platformLibraries = value.platformLibraries.map((entry, index) => {
      localPath(entry, `${label}.platformLibraries[${index}]`);
      if (!PLATFORM_LIBRARY.test(path.basename(entry)))
        throw new Error(`${label}.platformLibraries[${index}] must name a <Library>@<version>.js file`);
      return path.resolve(base, entry);
    });
  }
  if (value.sources === undefined) return result;
  if (!Array.isArray(value.sources) || value.sources.length > 64)
    throw new Error(`${label}.sources must be an ordered array of at most 64 PCF build outputs`);
  result.sources = value.sources.map((entry, index) => {
    const at = `${label}.sources[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${at} must be a mapping`);
    for (const key of Object.keys(entry))
      if (!['path', 'publisherPrefix', 'solution'].includes(key)) throw new Error(`Unknown setting ${at}.${key}`);
    localPath(entry.path, `${at}.path`);
    if ((entry.publisherPrefix === undefined) === (entry.solution === undefined))
      throw new Error(`${at} needs exactly one of publisherPrefix and solution to name its controls`);
    if (entry.publisherPrefix !== undefined && !validPrefix(entry.publisherPrefix))
      throw new Error(
        `${at}.publisherPrefix must be 2 to 8 letters or digits, start with a letter and not start with mscrm`,
      );
    if (entry.solution !== undefined) localPath(entry.solution, `${at}.solution`);
    return {
      path: path.resolve(base, entry.path),
      ...(entry.publisherPrefix !== undefined
        ? { publisherPrefix: entry.publisherPrefix }
        : { solution: path.resolve(base, entry.solution) }),
    };
  });
  return result;
}

const stat = (file) => fs.stat(file).catch(() => null);

// The controls folder of a source path: the folder itself when it holds control folders, `<path>/out/controls` of a
// project folder, or the OutputPath of a .pcfproj (`$(MSBuildThisFileDirectory)` is the project folder).
async function controlsFolder(source) {
  const found = await stat(source);
  if (!found) return null;
  if (found.isFile()) {
    if (!/\.pcfproj$/i.test(source)) return null;
    const project = await fs.readFile(source, 'utf8');
    const output = /<OutputPath>([^<]+)<\/OutputPath>/i.exec(project)?.[1]?.trim();
    const dir = path.dirname(source);
    const relative = output
      ? output.replace(/^\$\(MSBuildThisFileDirectory\)[\\/]?/i, '').replaceAll('\\', '/')
      : 'out/controls';
    if (/\$\(/.test(relative)) return null;
    // The project file is source text: an OutputPath that leaves the project folder (absolute, a drive, a share or ..)
    // is refused before anything there is read; a build elsewhere is named by its own path in the setting.
    const resolved = path.resolve(dir, relative);
    const inside = path.relative(dir, resolved);
    if (
      /^(?:[a-z]:|[\\/])/i.test(relative) ||
      inside === '..' ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      throw Object.assign(
        new Error(`its .pcfproj OutputPath ${output} leaves the project folder; name that folder as the source path`),
        { code: 'PCF_BUILD_SOURCE_OUTSIDE' },
      );
    return resolved;
  }
  const built = path.join(source, 'out', 'controls');
  return (await stat(built))?.isDirectory() ? built : source;
}

// The publisher prefix of a solution project: <folder>/src/Other/Solution.xml or <folder>/Other/Solution.xml.
async function solutionPrefix(solution) {
  const found = await stat(solution);
  if (!found) throw new Error(`the solution ${solution} does not exist`);
  const dir = found.isFile() && !/solution\.xml$/i.test(solution) ? path.dirname(solution) : solution;
  const candidates =
    found.isFile() && /solution\.xml$/i.test(solution)
      ? [solution]
      : [path.join(dir, 'src', 'Other', 'Solution.xml'), path.join(dir, 'Other', 'Solution.xml')];
  for (const file of candidates) {
    if (!(await stat(file))?.isFile()) continue;
    const document = parseSolutionXml(await fs.readFile(file, 'utf8'));
    const manifest = document.name === 'SolutionManifest' ? document : child(document, 'SolutionManifest');
    const prefix = childText(child(manifest, 'Publisher'), 'CustomizationPrefix');
    if (!validPrefix(prefix)) throw new Error(`${file} has no valid Publisher CustomizationPrefix`);
    return prefix;
  }
  throw new Error(`the solution ${solution} has no Other/Solution.xml`);
}

/**
 * The code component layers of `pcf.sources` (`{ type: 'pcf-build', dir, publisherPrefix, source }`, in order) and a
 * diagnostic for every source that is not built yet or cannot name its controls. A missing build output is reported
 * and skipped, so a project starts before its first build.
 */
export async function pcfBuildLayers(settings, { diagnostic = () => {} } = {}) {
  const layers = [];
  for (const source of settings?.sources ?? []) {
    try {
      const publisherPrefix = source.publisherPrefix ?? (await solutionPrefix(source.solution));
      const dir = await controlsFolder(source.path);
      if (!dir || !(await stat(dir))?.isDirectory()) {
        diagnostic({
          code: 'PCF_BUILD_OUTPUT_MISSING',
          severity: 'warning',
          source: source.path,
          message: `PCF source ${source.path} has no build output yet: run the pcf-scripts build (npm run build).`,
        });
        continue;
      }
      layers.push({ type: 'pcf-build', dir, publisherPrefix, source: source.path });
    } catch (error) {
      const outside = error.code === 'PCF_BUILD_SOURCE_OUTSIDE';
      diagnostic({
        code: outside ? error.code : 'PCF_BUILD_SOURCE_INVALID',
        severity: 'error',
        source: source.path,
        message: `PCF source ${source.path} ${outside ? 'is refused' : 'cannot name its controls'}: ${error.message}.`,
      });
    }
  }
  return layers;
}

// A platform library project file: <Library>@<version>.js, as modelDriven.clientSources names them.
const PLATFORM_LIBRARY = /^([A-Z][\w.-]*)@(\d+(?:\.\d+){1,3})\.js$/i;
// The order the live page provides them in: React before ReactDOM before Fluent UI, then any other in listed order.
const LIBRARY_ORDER = ['react', 'reactdom', 'fluentuireact'];
// window.React.version and window.ReactDOM.version 16.14.0; window.FluentUIReact is @fluentui/react 8.122.8.
const LIVE_PLATFORM_LIBRARIES = Object.freeze([
  { name: 'React', version: '16.14.0' },
  { name: 'ReactDOM', version: '16.14.0' },
  { name: 'FluentUIReact', version: '8.122.8' },
]);

/**
 * The platform libraries of `pcf.platformLibraries` the Power Pages host loads on every page with a code component
 * (live: window.React 16.14.0, window.ReactDOM and window.FluentUIReact from the platform bundles): `{ libraries: [{ name, version, url }], assets }`, served from the project files
 * under `/__sim-static/pcf/platform-<token>/`. Nothing is downloaded; a missing or unreadable file is a diagnostic.
 */
export async function pcfPlatformLibraries(settings, { diagnostic = () => {} } = {}) {
  const libraries = [],
    assets = new Map();
  for (const file of settings?.platformLibraries ?? []) {
    const [, name, version] = PLATFORM_LIBRARY.exec(path.basename(file)) ?? [];
    // One file per library: the page has one window.React, as the live page does.
    const earlier = libraries.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (earlier) {
      diagnostic({
        code: 'PCF_PLATFORM_LIBRARY_DUPLICATE',
        severity: 'error',
        source: file,
        message: `pcf.platformLibraries names ${name} twice (${earlier.version} and ${version}); only the first is served.`,
      });
      continue;
    }
    try {
      const real = await fs.realpath(file);
      const found = await fs.stat(real);
      if (!found.isFile() || found.size > PCF_RESOURCE_LIMIT)
        throw new Error(`it is not a file of at most ${PCF_RESOURCE_LIMIT} bytes`);
      const token = createHash('sha256').update(real).digest('hex').slice(0, 24);
      const url = `/__sim-static/pcf/platform-${token}/${encodeURIComponent(name)}.js`;
      assets.set(url, { file: real, root: path.dirname(real), kind: 'code' });
      libraries.push({ name, version, url });
    } catch (error) {
      diagnostic({
        code: 'PCF_PLATFORM_LIBRARY_INVALID',
        severity: 'error',
        source: file,
        message: `pcf.platformLibraries entry ${path.basename(file)} cannot be served: ${error.message}.`,
      });
    }
  }
  // The set every live page with a code component has.
  if (settings?.platformLibraries?.length) {
    const differs = LIVE_PLATFORM_LIBRARIES.filter(
      (live) =>
        !libraries.some((item) => item.name.toLowerCase() === live.name.toLowerCase() && item.version === live.version),
    );
    if (differs.length) {
      const live = LIVE_PLATFORM_LIBRARIES.map((item) => `${item.name} ${item.version}`).join(', ');
      const lacking = differs.map((item) => `${item.name}@${item.version}.js`).join(', ');
      diagnostic({
        code: 'PCF_PLATFORM_LIBRARY_LIVE_SET',
        severity: 'info',
        message: `Power Pages provides ${live} on every page with a code component; pcf.platformLibraries lacks ${lacking}.`,
      });
    }
  }
  const rank = (library) => {
    const index = LIBRARY_ORDER.indexOf(library.name.toLowerCase());
    return index < 0 ? LIBRARY_ORDER.length : index;
  };
  libraries.sort((a, b) => rank(a) - rank(b));
  return { libraries, assets };
}

/** The catalogue import options of the `pcf` setting. */
export const pcfImportOptions = (settings) => ({ maxResourceBytes: settings?.maxResourceBytes ?? PCF_RESOURCE_LIMIT });
