// Canvas PCF admission uses exact exported identities and explicit local code trust.
// Canvas has no Dataverse WebAPI or dataset PCF contract (Microsoft PCF limitations).
import { prepareCanvasSource } from './canvas-components.mjs';
import { pcfAdmission } from './model-driven/pcf-runtime.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { CANVAS_ASSETS } from './canvas-assets.mjs';
import { readLocalFile } from '../../lense/local-file.mjs';

const prepared = new WeakMap();
// The portal key of every declared PCF resource; a Canvas page names the same resource under its own apps prefix.
export const PORTAL_PCF = '/__sim-static/pcf/';
export const CANVAS_PCF = '/_apps/canvas/pcf/';
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const RESOURCE_TYPES = new Map([
  ['code', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['resx', 'application/xml; charset=utf-8'],
]);

const SCALAR =
  /^(?:SingleLine\.(?:Text(?:Area)?|Email|Phone|URL|Ticker)|Multiple|Whole\.(?:None|Duration|TimeZone|Language)|Decimal|FP|Currency|Enum|OptionSet|TwoOptions|DateAndTime\.Date(?:AndTime|Only))$/i; // NOSONAR: regex kept: a rewrite would change matches or captures
const identity = (name) =>
  String(name ?? '')
    .replace(/\([0-9a-f-]{36}\)$/i, '')
    .toLowerCase();
const safeProperty = (name) =>
  /^[A-Za-z_]\w*$/.test(name ?? '') && !['__proto__', 'prototype', 'constructor'].includes(name);

function propertyDefault(property, ofType) {
  const formula = property['pfx-default-value'];
  if (formula !== undefined) return { defaultFormula: String(formula) };
  if (property['default-value'] === undefined) return {};
  const value = property['default-value'];
  if (/^(Whole|Decimal|FP|Currency|Enum|OptionSet)/i.test(ofType)) {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('Invalid numeric default.');
    return { defaultValue: Number(value) };
  }
  if (/^TwoOptions$/i.test(ofType)) {
    if (!['true', 'false', '0', '1'].includes(String(value))) throw new Error('Invalid Boolean default.');
    return { defaultValue: value === true || value === 'true' || value === '1' || value === 1 };
  }
  return { defaultValue: value };
}

function canvasCodeComponent(control, catalog, { enabled = false, platformLibraries = [] } = {}) {
  const matches = [...(catalog?.controls?.values() ?? [])].filter(
    (entry) => identity(entry.schemaName) === identity(control.componentName),
  );
  const component = matches.length === 1 ? matches[0] : null;
  const refuse = (code, reason) => ({ name: control.componentName, admitted: false, code, reason, properties: [] });
  if (!enabled)
    return refuse('CANVAS_PCF_TRUST_REQUIRED', 'Enable canvas.codeComponents to run exported local component code.');
  if (!component) return refuse('CANVAS_PCF_MANIFEST_UNAVAILABLE', 'An exact exported component manifest is required.');
  const admission = pcfAdmission(component, { platformLibraries });
  if (!admission.admitted) return refuse(admission.code, admission.reason);
  if (admission.dataset)
    return refuse('CANVAS_PCF_DATASET_UNSUPPORTED', 'Dataset PCF controls are not supported by the Canvas host.');
  const required = (component.features ?? []).filter((feature) =>
    ['true', '1'].includes(String(feature.required).toLowerCase()),
  );
  if (required.length)
    return refuse(
      'CANVAS_PCF_FEATURE_UNSUPPORTED',
      'The component requires APIs unavailable in the local Canvas host.',
    );
  const properties = [];
  for (const property of component.properties ?? []) {
    const types = property.types ?? [];
    const ofType = property['of-type'] ?? property.ofType ?? (types.length === 1 ? types[0] : null);
    if (
      !safeProperty(property.name) ||
      !SCALAR.test(ofType ?? '') ||
      !['input', 'bound', 'output'].includes(property.usage)
    )
      return refuse(
        'CANVAS_PCF_PROPERTY_UNSUPPORTED',
        'The manifest contains an unsupported or ambiguous property contract.',
      );
    try {
      properties.push({
        name: property.name,
        usage: property.usage,
        ofType,
        required: ['true', '1'].includes(String(property.required)),
        ...propertyDefault(property, ofType),
      });
    } catch {
      return refuse('CANVAS_PCF_DEFAULT_UNSUPPORTED', 'The manifest contains an invalid scalar default.');
    }
  }
  const resources = component.resources ?? [];
  const versioned = (resource) =>
    resource.url + (component.fingerprint ? `?v=${encodeURIComponent(component.fingerprint)}` : '');
  const code = resources.filter((resource) => resource.kind === 'code').map(versioned);
  const css = resources.filter((resource) => resource.kind === 'css').map(versioned);
  if (!code.length || [...code, ...css].some((url) => !String(url).startsWith(PORTAL_PCF)))
    return refuse('CANVAS_PCF_RESOURCE_UNAVAILABLE', 'Only declared, local exported resources can run.');
  // The page loads its own resources: a same-origin apps path, so the page's script-src 'self' admits them.
  const canvasUrl = (url) => CANVAS_PCF + url.slice(PORTAL_PCF.length);
  const events = (component.events ?? []).map((event) => event.name);
  if (events.some((name) => !safeProperty(name)) || new Set(events).size !== events.length)
    return refuse('CANVAS_PCF_EVENT_UNSUPPORTED', 'The manifest contains invalid or duplicate event names.');
  return {
    name: component.schemaName,
    constructor: component.constructor,
    controlType: component.type ?? 'standard',
    admitted: true,
    properties,
    libraries: component.libraries ?? [],
    platformLibraries: admission.libraries,
    resources: {
      code: code.map(canvasUrl),
      css: css.map(canvasUrl),
      exports: resources.filter((resource) => resource.exportGlobal).map((resource) => resource.exportGlobal),
      resx: {},
    },
    events,
  };
}

/**
 * Serves one declared PCF resource for GET or HEAD. `assets` maps portal keys to admitted files; `fail(status, message)`
 * builds the refusal of the calling route.
 */
export async function servePcfResource(req, res, { assets, key, fail }) {
  if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'PCF resources require GET or HEAD.');
  const asset = assets.get(key);
  if (!asset) throw fail(404, 'This PCF resource is not declared in a selected manifest.');
  const real = await fs.realpath(asset.file);
  if (real !== asset.file || (await fs.stat(real)).size > MAX_RESOURCE_BYTES)
    throw fail(404, 'The declared PCF resource changed outside its source boundary.');
  res.writeHead(200, {
    'content-type': RESOURCE_TYPES.get(asset.kind) ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  return res.end(
    req.method === 'HEAD' ? undefined : await readLocalFile(real, { root: asset.root, maxBytes: MAX_RESOURCE_BYTES }),
  );
}

/** Prepare scopes once before mapping the expanded instance names to manifest descriptors. */
export function canvasPcfApps(apps, catalog, options = {}) {
  return apps.map((app) => {
    const raw = app.source,
      key = raw.tree ?? raw.screens ?? raw;
    const display = options.display?.[app.uniqueName];
    const signature = JSON.stringify([
      app.uniqueName,
      raw.app,
      raw.diagnostics,
      raw.assetDiagnostics,
      display,
      options.displayEvidence,
      options.enabled,
      options.watch,
    ]);
    const prior = prepared.get(key);
    if (
      prior?.signature === signature &&
      prior.formulas === raw.formulas &&
      prior.enums === raw.enums &&
      prior.assets === raw[CANVAS_ASSETS] &&
      prior.catalog === catalog &&
      prior.libraries === options.platformLibraries
    )
      return prior.app;
    const source = prepareCanvasSource(app.source);
    const codeComponents = Object.create(null);
    for (const screen of source.tree?.screens ?? source.screens ?? [])
      for (const control of screen.controls ?? [])
        if (/^CodeComponent(?:@|$)/i.test(control.control ?? ''))
          codeComponents[control.name] = canvasCodeComponent(control, catalog, options);
    const facts = {
      ...source,
      app: { ...source.app, ...(display ? { display, displayEvidence: options.displayEvidence ?? null } : {}) },
      codeComponents,
    };
    const digest = createHash('sha256').update(
      JSON.stringify([
        facts.app,
        facts.tree ?? facts.screens,
        facts.formulas,
        facts.enums,
        facts.diagnostics,
        facts.assetDiagnostics,
        codeComponents,
      ]),
    );
    for (const [name, asset] of facts[CANVAS_ASSETS] ?? []) digest.update(name).update(asset.type).update(asset.data);
    const result = { ...app, source: { ...facts, revision: digest.digest('hex'), watch: options.watch === true } };
    prepared.set(key, {
      signature,
      formulas: raw.formulas,
      enums: raw.enums,
      assets: raw[CANVAS_ASSETS],
      catalog,
      libraries: options.platformLibraries,
      app: result,
    });
    return result;
  });
}
