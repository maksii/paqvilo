import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerExpressionOperators, registerShellConventions, validateEndpoints } from "./extensions.mjs";

/**
 * Project-agnostic preset registry.
 *
 * The runtime never imports a project's data module directly. Data packs live
 * outside the toolkit and are named explicitly by a project
 * (`dataPacks: [{ id, module }]`). A pack default-exports
 * `{ id, name, description, matches({ portal }), presets({ portal, metadata,
 * options }), generators, personas, plugins }`; see docs/data-packs.md.
 */
// No installed or adjacent project code is imported implicitly.
export const PACKS_ROOT = null;
/** Marks a lazily generated preset getter; carries the body-free descriptor. */
export const LAZY_PRESET = Symbol.for("paqvilo-mirage.lazy-preset");
const packIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const presetIdPattern = /^[\w.-]+$/;
const reserved = new Set(["__proto__", "constructor", "prototype"]);

/** Presets that are valid for every exported portal. */
export function genericPresets() {
  return {
    "empty-local": {
      id: "empty-local",
      name: "Empty local tables",
      description:
        "Empty imported tables with exported permissions. No business data is copied.",
      tables: {},
    },
    "open-sandbox": {
      id: "open-sandbox",
      name: "Open sandbox",
      description:
        "Sets permissionMode to permissive so every local identity can read and write all local tables. Records are unchanged.",
      settings: { permissionMode: "permissive" },
    },
    "strict-permissions": {
      id: "strict-permissions",
      name: "Strict table permissions",
      description:
        "Sets permissionMode to enforce so table permissions, web roles and scopes apply. Records are unchanged.",
      settings: { permissionMode: "enforce" },
    },
    "contact-demo": {
      id: "contact-demo",
      name: "Contact and account demo",
      description:
        "One invented contact and organisation with self/account permissions and a declarative full-name rule. Replaces the contact and account tables.",
      mappings: {
        contact: { entitySet: "contacts", idColumn: "contactid" },
        account: { entitySet: "accounts", idColumn: "accountid" },
      },
      tables: {
        contact: [
          {
            contactid: "11111111-1111-1111-1111-111111111111",
            fullname: "Local Portal User",
            parentcustomerid: "22222222-2222-2222-2222-222222222222",
          },
        ],
        account: [
          {
            accountid: "22222222-2222-2222-2222-222222222222",
            name: "Local organisation",
          },
        ],
      },
      permissions: [
        {
          entity: "contact",
          operations: ["read", "update"],
          roles: ["Authenticated Users"],
          scope: "self",
        },
        {
          entity: "account",
          operations: ["read"],
          roles: ["Authenticated Users"],
          scope: "account",
          field: "accountid",
        },
      ],
      plugins: [
        {
          id: "contact-name",
          entity: "contact",
          operations: ["create", "update"],
          set: {
            fullname: {
              op: "concat",
              args: ["$record.firstname", " ", "$record.lastname"],
            },
          },
          validate: [
            {
              field: "lastname",
              required: true,
              message: "Last name is required",
            },
          ],
        },
      ],
    },
  };
}

const dataProperty = (object, key) => {
  const property = Object.getOwnPropertyDescriptor(object, key);
  return property && "value" in property ? property : null;
};

/** Validate a pack object without evaluating lazy personas/plugins getters. */
export function validatePack(pack, source = "data pack") {
  const fail = (message) => {
    throw new Error(`Data pack ${source}: ${message}`);
  };
  if (!pack || typeof pack !== "object" || Array.isArray(pack))
    fail("must default-export an object");
  if (typeof pack.id !== "string" || !packIdPattern.test(pack.id))
    fail("id must match /^[a-z0-9][a-z0-9._-]*$/");
  for (const key of ["name", "description"])
    if (typeof pack[key] !== "string" || !pack[key].trim())
      fail(`${key} must be a nonempty string`);
  if (typeof pack.matches !== "function")
    fail("matches({ portal }) must be a function");
  if (typeof pack.presets !== "function")
    fail("presets({ portal, metadata, options }) must be a function");
  const generators = dataProperty(pack, "generators")?.value;
  if (generators !== undefined) {
    if (!generators || typeof generators !== "object" || Array.isArray(generators))
      fail("generators must be an object of functions");
    for (const [name, generator] of Object.entries(generators))
      if (typeof generator !== "function")
        fail(`generators.${name} must be a function`);
  }
  for (const key of ["personas", "plugins"]) {
    const property = dataProperty(pack, key);
    if (property && property.value !== undefined && !Array.isArray(property.value))
      fail(`${key} must be an array`);
  }
  // Extension points (lib/extensions.mjs): plugin expression operators and
  // HTTP endpoints under /__sim/ served while the pack matches the portal.
  const operators = dataProperty(pack, "expressionOperators")?.value;
  if (operators !== undefined && (!operators || typeof operators !== "object" || Array.isArray(operators) || Object.values(operators).some((value) => typeof value !== "function")))
    fail("expressionOperators must be an object of functions");
  try {
    validateEndpoints(pack.id, dataProperty(pack, "endpoints")?.value);
  } catch (error) {
    fail(error.message);
  }
  return pack;
}

/** Directories under `root` that contain a `pack.mjs`, sorted for determinism. */
export async function builtinPackModules(root = PACKS_ROOT) {
  if (root == null) return [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const modules = [];
  for (const entry of entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, "pack.mjs");
    try {
      if ((await fs.stat(file)).isFile()) modules.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return modules;
}

/** Import and validate one pack module (absolute path or file URL). */
export async function loadPack(module) {
  const url = module instanceof URL || /^file:/i.test(String(module))
    ? String(module)
    : pathToFileURL(path.resolve(String(module))).href;
  const imported = await import(url);
  const pack = validatePack(imported.default, fileURLToPath(url));
  registerExpressionOperators(pack.id, pack.expressionOperators);
  registerShellConventions(pack.id, pack.shell);
  return pack;
}

/** True when a pack declares that it serves the supplied imported portal. */
export function packMatches(pack, portal) {
  if (portal == null) return true;
  try {
    return pack.matches({ portal }) === true;
  } catch (error) {
    throw new Error(`Data pack ${pack.id} matches() failed: ${error.message}`, {
      cause: error,
    });
  }
}

const explicitEntries = (entries, base, label) => {
  if (entries == null) return [];
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array`);
  return entries.map((entry, index) => {
    if (typeof entry === "string") entry = { module: entry };
    if (!entry || typeof entry !== "object" || typeof entry.module !== "string" || !entry.module.trim())
      throw new Error(`${label}[${index}].module is required`);
    if (entry.id !== undefined && (typeof entry.id !== "string" || !packIdPattern.test(entry.id)))
      throw new Error(`${label}[${index}].id is invalid`);
    const module = /^file:/i.test(entry.module)
      ? fileURLToPath(entry.module)
      : path.resolve(base, entry.module);
    return { id: entry.id, module };
  });
};

/**
 * Discover data packs: every `packs/<id>/pack.mjs` plus explicit project
 * entries. With a portal, only packs whose `matches({ portal })` returns true
 * are returned; without one, every valid pack is returned.
 */
export async function packModules({ project, explicit = [], root = PACKS_ROOT } = {}) {
  const base = project?.configFile ? path.dirname(path.resolve(project.configFile)) : process.cwd();
  return [
    ...(await builtinPackModules(root)).map((module) => ({ module })),
    ...explicitEntries(project?.dataPacks, base, "project.dataPacks"),
    ...explicitEntries(explicit, base, "explicit"),
  ];
}

export async function discoverPacks({
  project,
  portal,
  explicit = [],
  root = PACKS_ROOT,
} = {}) {
  const entries = await packModules({ project, explicit, root });
  const loaded = new Map();
  const packs = [];
  for (const entry of entries) {
    const pack = await loadPack(entry.module);
    if (entry.id && entry.id !== pack.id)
      throw new Error(
        `Data pack ${entry.module} declares id '${pack.id}', expected '${entry.id}'`,
      );
    const previous = loaded.get(pack.id);
    if (previous) {
      if (path.resolve(previous) === path.resolve(entry.module)) continue;
      throw new Error(
        `Duplicate data pack id '${pack.id}' in ${previous} and ${entry.module}`,
      );
    }
    loaded.set(pack.id, entry.module);
    if (packMatches(pack, portal)) packs.push(pack);
  }
  return packs;
}

/** Body-free descriptor of one library entry, or null when it is absent. */
export function presetDescriptor(library, id) {
  if (!library || typeof library !== "object" || !Object.hasOwn(library, id))
    return null;
  const property = Object.getOwnPropertyDescriptor(library, id);
  const lazy = property.get?.[LAZY_PRESET];
  if (lazy) return { ...lazy };
  const value = property.value;
  return {
    id,
    name: value?.name ?? id,
    description: value?.description ?? "",
    ...(value?.pack ? { pack: value.pack } : {}),
    lazy: false,
  };
}

/**
 * Define a memoized lazy preset. `entry` is either a complete preset body or
 * `{ name, description, load() }`; `finish(body)` adapts a loaded body once.
 */
export function defineLazyPreset(library, id, entry, { pack, finish } = {}) {
  if (!presetIdPattern.test(id) || reserved.has(id))
    throw new Error(`Invalid preset id '${id}'${pack ? ` in data pack ${pack}` : ""}`);
  if (!entry || typeof entry !== "object")
    throw new Error(`Preset ${id}${pack ? ` in data pack ${pack}` : ""} must be an object`);
  const load = typeof entry.load === "function" ? entry.load : () => entry;
  let body;
  let loaded = false;
  const get = () => {
    if (!loaded) {
      const value = load();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Preset ${id}${pack ? ` in data pack ${pack}` : ""} did not load an object`);
      body = finish ? finish(value) : value;
      loaded = true;
    }
    return body;
  };
  get[LAZY_PRESET] = Object.freeze({
    id,
    name: entry.name ?? id,
    description: entry.description ?? "",
    ...(pack ? { pack } : {}),
    lazy: true,
  });
  Object.defineProperty(library, id, {
    enumerable: true,
    configurable: true,
    get,
    set(value) {
      Object.defineProperty(library, id, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    },
  });
  return library;
}

/** Call a pack's preset factory and check ids before they enter a library. */
export function packPresetEntries(pack, { portal, metadata, options } = {}) {
  const entries = pack.presets({ portal, metadata, options: options ?? {} }) ?? {};
  if (typeof entries !== "object" || Array.isArray(entries))
    throw new Error(`Data pack ${pack.id} presets() must return an object`);
  return Object.entries(entries);
}

/**
 * Merged `{ id: preset }` library: generic presets plus every supplied pack
 * that matches the portal (all supplied packs without a portal). Pack bodies
 * remain lazy getters until first read; `presetDescriptor` lists them without
 * generating records.
 */
export function presetLibrary({ portal, metadata, packs = [], options } = {}) {
  const library = genericPresets();
  for (const pack of packs) {
    if (!packMatches(pack, portal)) continue;
    for (const [id, entry] of packPresetEntries(pack, { portal, metadata, options })) {
      if (Object.hasOwn(library, id))
        throw new Error(`Preset '${id}' from data pack ${pack.id} duplicates an existing preset`);
      defineLazyPreset(library, id, entry, { pack: pack.id });
    }
  }
  return library;
}
