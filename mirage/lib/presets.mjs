import { isDeepStrictEqual } from "node:util";
import {
  LAZY_PRESET,
  defineLazyPreset,
  discoverPacks,
  genericPresets,
  packMatches,
  packPresetEntries,
  presetDescriptor,
  presetLibrary,
} from "./preset-registry.mjs";

const clone = (value) => structuredClone(value);
const hasOwn = (object, key) =>
  object != null && typeof object === "object" && Object.hasOwn(object, key);

/**
 * The public library contains generic presets only. Project packs are supplied
 * explicitly to the portal library; never import adjacent project code at startup.
 */
export const defaultPacks = Object.freeze(await discoverPacks());

/**
 * Compatibility library: generic presets plus every discovered pack, without
 * portal filtering, so stored builtin descriptors remain resolvable. Bodies are
 * memoized lazy getters; use `presetDescriptor` to read names cheaply.
 */
export const builtinPresets = presetLibrary({ packs: defaultPacks });

const lazyMeta = (library, id) =>
  hasOwn(library, id)
    ? Object.getOwnPropertyDescriptor(library, id).get?.[LAZY_PRESET] ?? null
    : null;
const compactDescriptor = (name, description) => ({
  builtin: true,
  builtinVersion: 1,
  name,
  description,
});
const bodyKeys = [
  "tables",
  "mappings",
  "permissions",
  "plugins",
  "settings",
  "identity",
  "endpoints",
  "personaRoles",
  "contactRoles",
];
const isCompactDescriptor = (preset) =>
  preset?.builtin === true && !bodyKeys.some((key) => hasOwn(preset, key));

/** Refresh generated library entries; explicitly edited presets and mappings remain authoritative. */
export function resolvePreset(state, name, generatedPresets = builtinPresets) {
  const saved = state.presets?.[name];
  const generatedHas = hasOwn(generatedPresets, name);
  // Explicit project packs are absent from the compatibility library; their
  // stored descriptors resolve from the supplied portal library instead.
  const library = hasOwn(builtinPresets, name)
    ? builtinPresets
    : generatedHas && saved?.builtin === true && saved.userConfigured !== true
      ? generatedPresets
      : null;
  if (
    saved?.userConfigured === true ||
    !library ||
    (saved &&
      saved.builtin !== true &&
      !isDeepStrictEqual(saved, library[name]))
  )
    return saved
      ? !library && isCompactDescriptor(saved)
        ? null
        : clone(saved)
      : generatedHas
        ? clone(generatedPresets[name])
        : null;
  const generated = generatedHas ? generatedPresets[name] : library[name];
  if (!generated) return saved ? clone(saved) : null;
  const result = clone(generated);
  for (const [entity, mapping] of Object.entries(result.mappings ?? {})) {
    const existing = state.mappings?.[entity];
    if (existing?.userConfigured === true)
      result.mappings[entity] = clone(existing);
    else if (
      existing?.metadataSources?.length &&
      !mapping.metadataSources?.length
    )
      result.mappings[entity] = {
        ...mapping,
        ...clone(existing),
        relationships: {
          ...mapping.relationships,
          ...clone(existing.relationships),
        },
      };
  }
  return result;
}

/** Builtin bodies are generated on demand; explicit custom presets remain complete. */
export function compactBuiltinPresets(presets, library = builtinPresets) {
  if (!presets || Array.isArray(presets) || typeof presets !== "object")
    return presets;
  return Object.fromEntries(
    Object.keys(presets).map((id) => {
      // Lazy library entries (bootstrap/pack presets) compact without
      // generating their bodies.
      const lazy = lazyMeta(presets, id);
      if (lazy) return [id, compactDescriptor(lazy.name, lazy.description)];
      const preset = presets[id];
      if (
        hasOwn(library, id) &&
        preset?.userConfigured !== true &&
        (preset?.builtin === true ||
          isDeepStrictEqual(preset, library[id]))
      ) {
        const meta = presetDescriptor(library, id);
        return [
          id,
          compactDescriptor(
            preset?.name ?? meta.name,
            preset?.description ?? meta.description,
          ),
        ];
      }
      return [id, preset];
    }),
  );
}

/** Apply a resolved preset's state sections in place (DataStore transaction body). */
export function applyPresetSections(state, preset) {
  if (preset.tables)
    for (const [entity, rows] of Object.entries(preset.tables))
      state.tables[entity] = clone(rows);
  if (preset.mappings) Object.assign(state.mappings, clone(preset.mappings));
  for (const key of ["plugins", "permissions"])
    if (preset[key]) state[key] = clone(preset[key]);
  if (preset.settings) Object.assign(state.settings, preset.settings);
  if (preset.identity) {
    state.simulator ??= {};
    state.simulator.identity = clone(preset.identity);
  }
  if (preset.endpoints) {
    state.simulator ??= {};
    state.simulator.endpoints = clone(preset.endpoints);
  }
  return state;
}

/**
 * Presets stored in a newly bootstrapped state: `empty-local` with the
 * imported tables, plus every matching pack preset as a lazy builtin whose
 * mappings/tables are layered over the imported mappings and empty tables.
 */
export function bootstrapPresetLibrary({
  portal,
  metadata,
  mappings = {},
  tables = {},
  packs = defaultPacks,
  options,
} = {}) {
  const importedMappings = clone(mappings);
  const importedTables = clone(tables);
  const library = {
    "empty-local": {
      ...genericPresets()["empty-local"],
      tables: clone(importedTables),
    },
  };
  for (const pack of packs) {
    if (!packMatches(pack, portal ?? {})) continue;
    for (const [id, entry] of packPresetEntries(pack, { portal, metadata, options })) {
      if (Object.hasOwn(library, id))
        throw new Error(`Preset '${id}' from data pack ${pack.id} duplicates an existing preset`);
      defineLazyPreset(library, id, entry, {
        pack: pack.id,
        finish: (body) => ({
          ...clone(body),
          id,
          builtin: true,
          ...(body.mappings
            ? { mappings: { ...clone(importedMappings), ...clone(body.mappings) } }
            : {}),
          ...(body.tables
            ? { tables: { ...clone(importedTables), ...clone(body.tables) } }
            : {}),
        }),
      });
    }
  }
  return library;
}

/**
 * Body-free preset listing for admin/CLI: generic presets, the portal library
 * (`library`, normally the bootstrap presets) and stored state presets.
 */
export function listPresets({ state = {}, library = {} } = {}) {
  const stored = state.presets ?? {};
  const ids = [
    ...new Set([
      ...Object.keys(genericPresets()),
      ...Object.keys(library ?? {}),
      ...Object.keys(stored),
    ]),
  ];
  return ids.map((id) => {
    const saved = hasOwn(stored, id) ? stored[id] : undefined;
    const meta =
      presetDescriptor(library, id) ?? presetDescriptor(builtinPresets, id);
    const custom =
      saved !== undefined &&
      (saved?.userConfigured === true || !meta || saved?.builtin !== true);
    const unavailable = !meta && isCompactDescriptor(saved);
    return {
      id,
      name: (custom ? saved?.name : meta?.name) ?? meta?.name ?? id,
      description:
        (custom ? saved?.description : meta?.description) ??
        meta?.description ??
        "",
      source: saved?.userConfigured ? "stored" : meta ? "builtin" : "stored",
      ...(meta?.pack ? { pack: meta.pack } : {}),
      ...(unavailable ? { unavailable: true } : {}),
    };
  });
}

export { genericPresets, presetDescriptor };
