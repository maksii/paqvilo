import { DataError } from './data-error.mjs';
import { createHash } from 'node:crypto';
import { validatePlatformOverrides } from './platform-settings.mjs';
import { validatePortalOverrides } from './portal-overrides.mjs';
import { cloneStateData } from './state-clone.mjs';
const fail = (message) => {
  throw new DataError(message, 400, 'InvalidExperimentPreset');
};
const builtinIds = new Set(['source-defaults', 'expanded-query-budget', 'webapi-disabled']);
export const experimentId = (id) => {
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) ||
    ['constructor', 'prototype', '__proto__'].includes(id)
  )
    fail('Use a preset ID of up to 80 letters, digits, hyphens or underscores.');
  return id;
};
export function validateExperiment(p) {
  if (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !['id', 'name', 'description', 'platformOverrides', 'portalOverrides'].includes(k))
  )
    fail('An experiment contains id, name, description, platformOverrides and portalOverrides only.');
  experimentId(p.id);
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160) fail('A preset requires a short name.');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 2000))
    fail('A preset description must be a string of at most 2000 characters.');
  validatePlatformOverrides(p.platformOverrides ?? {});
  validatePortalOverrides(p.portalOverrides ?? {});
  if (Object.keys(p.portalOverrides ?? {}).some((k) => !['settings', 'snippets'].includes(k)))
    fail('Experiments affect site settings/snippets, not roles or access rules.');
  return p;
}
export function validateExperimentPresets(value = {}, reservedIds = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100)
    fail('Experiment presets must be an object with at most 100 entries.');
  for (const [id, p] of Object.entries(value)) {
    validateExperiment(p);
    if (experimentId(id) !== p.id) fail('Preset identity mismatch.');
    if (builtinIds.has(id)) fail('Built-in experiment IDs cannot be replaced.');
    if (reservedIds.includes(id)) fail(`Configuration preset ${id} belongs to a data pack and cannot be replaced.`);
  }
  return value;
}
export function experimentPresets(state, portal, packPresets = []) {
  const disabled = Object.fromEntries(
    Object.keys(portal.settings ?? {})
      .filter((k) => /^Webapi\/[^/]+\/enabled$/i.test(k))
      .map((k) => [k, 'False']),
  );
  return [
    {
      id: 'source-defaults',
      name: 'Source defaults',
      platformOverrides: {},
      portalOverrides: { settings: {}, snippets: {} },
      builtin: true,
    },
    {
      id: 'expanded-query-budget',
      name: 'Simulated support increase (30)',
      platformOverrides: { QueryLinkEntityLimit: 30 },
      portalOverrides: { settings: {}, snippets: {} },
      builtin: true,
    },
    {
      id: 'webapi-disabled',
      name: 'Disable exported Web API tables',
      platformOverrides: {},
      portalOverrides: { settings: disabled, snippets: {} },
      builtin: true,
    },
    ...packPresets,
    ...Object.values(validateExperimentPresets(state.simulator?.experimentPresets)).map((p) => ({
      ...p,
      builtin: false,
      source: 'user',
      ...(packPresets.some((pack) => pack.id === p.id)
        ? {
            shadowed: true,
            diagnostics: [
              {
                code: 'CONFIGURATION_PRESET_COLLISION',
                severity: 'warning',
                message: `Saved configuration preset ${p.id} is shadowed by a data pack. Delete the saved entry to resolve the collision.`,
              },
            ],
          }
        : {}),
    })),
  ];
}
export function applyExperiment(state, p) {
  const next = cloneStateData(state);
  next.simulator ??= {};
  next.simulator.platformOverrides = structuredClone(p.platformOverrides ?? {});
  next.simulator.portalOverrides = {
    ...next.simulator.portalOverrides,
    settings: structuredClone(p.portalOverrides?.settings ?? {}),
    snippets: structuredClone(p.portalOverrides?.snippets ?? {}),
  };
  next.simulator.activeExperiment = {
    id: p.id,
    name: p.name,
    source: p.source ?? (p.builtin ? 'builtin' : 'user'),
    digest: createHash('sha256')
      .update(JSON.stringify([p.platformOverrides ?? {}, p.portalOverrides ?? {}]))
      .digest('hex'),
  };
  return next;
}

const packReports = new WeakMap();
/** Invalid entries remain visible as diagnostics; no partial/unsafe override is applied. */
export function configurationPresetReport(packs = []) {
  const presets = [],
    diagnostics = [],
    ids = new Set(builtinIds);
  for (const pack of packs) {
    let report = packReports.get(pack);
    if (!report) {
      report = { presets: [], diagnostics: [] };
      const property = Object.getOwnPropertyDescriptor(pack, 'configurationPresets');
      const bad = (index, cause) =>
        report.diagnostics.push({
          code: 'PACK_CONFIGURATION_PRESET_INVALID',
          severity: 'error',
          pack: pack.id,
          index,
          message: `Data pack ${pack.id} configurationPresets${index === null ? '' : `[${index}]`}: ${cause.message}`,
        });
      if (property) {
        if (!('value' in property) || !Array.isArray(property.value) || property.value.length > 100)
          bad(null, new Error('must be a data array of at most 100 presets'));
        else
          Array.from(property.value).forEach((value, index) => {
            try {
              validateExperiment(value);
              report.presets.push({ ...structuredClone(value), builtin: false, readOnly: true, source: pack.id });
            } catch (cause) {
              bad(index, cause);
            }
          });
      }
      packReports.set(pack, report);
    }
    diagnostics.push(...report.diagnostics);
    for (const preset of report.presets) {
      if (ids.has(preset.id)) {
        diagnostics.push({
          code: 'PACK_CONFIGURATION_PRESET_DUPLICATE',
          severity: 'error',
          pack: pack.id,
          message: `Configuration preset ${preset.id} is already declared; use a unique pack-prefixed ID.`,
        });
        continue;
      }
      ids.add(preset.id);
      presets.push(preset);
    }
  }
  return { presets, diagnostics };
}

/** Saved collisions never prevent reading state or removing the saved entry. */
export function configurationPresetCollisions(state, packPresets = []) {
  return Object.keys(state.simulator?.experimentPresets ?? {})
    .filter((id) => packPresets.some((p) => p.id === id))
    .map((id) => ({
      code: 'CONFIGURATION_PRESET_COLLISION',
      severity: 'warning',
      id,
      message: `Saved configuration preset ${id} is shadowed by a data pack. Delete the saved entry to resolve the collision.`,
    }));
}
