// Child process of test/settings-contracts.test.mjs. Resolves a corpus of Mirage settings and prints the results as JSON.
//   node settings-contracts-resolver.mjs <light|full> <corpus.json>
// light: the modules a command loads to read a catalogue (lense/config.mjs, which registers the settings contracts).
// full: mirage/lib/provider-modules.mjs first, so every provider runtime has registered its own parser, as a runtime has.
import fs from 'node:fs';
import path from 'node:path';

const [mode, corpusFile] = process.argv.slice(2);
if (mode === 'full') await import('../../mirage/lib/provider-modules.mjs');
else if (mode !== 'light') throw new Error(`Unknown mode ${mode}`);
const { catalogueRoot, resolveMirageConfig } = await import('../../lense/config.mjs');
const { MIRAGE_SETTINGS, parseSetting, pendingSettingParsers } = await import('../../mirage/lib/config-keys.mjs');

const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
// One invented location for every case: resolution only joins paths, so both modes print the same absolute paths.
const configDir = path.resolve(corpus.base, 'catalogue');
const where = { configDir, sourceRoot: path.resolve(corpus.base, 'checkout'), sourceDir: path.resolve(corpus.base, 'checkout', 'portal') };

// The outcome of a call: its value (undefined kept apart from null) or the message and code of what it threw.
const UNSET = { $undefined: true };
function outcome(call) {
  try {
    const value = call();
    return { value: value === undefined ? UNSET : value };
  } catch (error) {
    return { error: { name: error?.name ?? null, message: String(error?.message ?? error), code: error?.code ?? null } };
  }
}
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const results = {};
for (const { id, settings, unset = [], catalogue } of corpus.cases) {
  const result = {};
  if (catalogue !== undefined) result.catalogue = outcome(() => catalogueRoot(catalogue));
  if (settings !== undefined) {
    // A key listed in `unset` is passed as undefined, which JSON cannot carry: the default of an unset key.
    const map = isMap(settings) ? { ...settings, ...Object.fromEntries(unset.map((key) => [key, undefined])) } : settings;
    result.keys = {};
    for (const key of Object.keys(MIRAGE_SETTINGS)) {
      if (!isMap(map) || !Object.hasOwn(map, key)) continue;
      const diagnostics = [];
      result.keys[key] = {
        ...outcome(() => parseSetting(key, map[key], { label: `mirage.${key}`, base: configDir, diagnostics })),
        diagnostics,
      };
    }
    result.resolved = outcome(() => resolveMirageConfig(map, where));
  }
  results[id] = result;
}

// undefined members inside a value are kept visible instead of being dropped by JSON.stringify.
process.stdout.write(
  JSON.stringify({ pending: pendingSettingParsers(), results }, (key, value) => (value === undefined ? UNSET : value)),
);
