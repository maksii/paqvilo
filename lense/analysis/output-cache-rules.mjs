// Header and footer output caching (PAGE-06d1): with Header/OutputCache/Enabled or Footer/OutputCache/Enabled true, the
// portal caches the rendered Header or Footer web template, so Liquid that reads a request-dependent object outside a
// {% substitution %} block shows one request's output to later requests.
import { scanLiquidTokens } from '../../mirage/lib/liquid-source.mjs';
import { componentPayload } from '../portal-model.mjs';
import { booleanValue, isActive, isEnvironmentBacked, textValue } from './record-rules.mjs';

const cachingReference = 'https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching';
const substitutionReference = 'https://learn.microsoft.com/power-pages/configure/liquid/template-tags#substitution';
const objectsReference = 'https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects';

export const outputCacheRules = [
  {
    id: 'PP-CACHE-001',
    title: 'Request-dependent Liquid in a cached header or footer',
    severity: 'warning',
    category: 'reliability',
    confidence: 'medium',
    message:
      'Header or footer output caching is enabled, and this Liquid reads a request-dependent object outside a substitution block; the cached output is reused for other requests.',
    remediation:
      'Wrap the request-dependent part in {% substitution %}...{% endsubstitution %}, or use the documented substitution attributes such as website.sign_in_url_substitution and language.url_substitution.',
    references: [cachingReference, substitutionReference, objectsReference],
  },
];

const SECTIONS = [
  { field: 'headerwebtemplateid', setting: 'header/outputcache/enabled' },
  { field: 'footerwebtemplateid', setting: 'footer/outputcache/enabled' },
];
const MAX_INCLUDE_DEPTH = 16;
const NAME_CHARACTER = String.raw`\p{L}\p{Nd}_\-`;
// Objects the substitution tag documentation names (request, page, language and date, that is `now`), and `params`,
// documented as a shortcut for request.params. `user` is not listed: the documented cached header keeps its user branch.
// The first group is the root name, which a variable the template declares shadows.
const REQUEST_OBJECT = new RegExp(
  String.raw`(?<![${NAME_CHARACTER}.])(request|params|page|now)(?![${NAME_CHARACTER}])(?!\s*:)|(?<![${NAME_CHARACTER}.])([\p{L}_][${NAME_CHARACTER}]*)\.url(?![${NAME_CHARACTER}])`,
  'gu',
);
const VARIABLE = new RegExp(String.raw`^\s*([\p{L}_][${NAME_CHARACTER}]*)`, 'u');
const INCLUDE_PARAMETER = new RegExp(String.raw`([\p{L}_][${NAME_CHARACTER}]*)\s*:`, 'gu');
// Tags whose markup is a name, a block name or a template reference, never an expression.
const NON_EXPRESSION_TAGS = new Set(['capture', 'fetchxml', 'block', 'extends', 'substitution', 'endsubstitution']);
const LOOP_TAGS = new Set(['for', 'tablerow']);
// A loop over the site's languages: its variable is a language object.
const LANGUAGE_LOOP = /^\s*\S+\s+in\s+website\.languages(?![\w.-])/;
const blank = (text) => text.replace(/[^\r\n]/g, ' ');

const identity = (value) =>
  textValue(typeof value === 'object' && value !== null ? (value.id ?? value.Id) : value).toLowerCase();

function siteSettings(records) {
  const settings = new Map();
  for (const record of records) {
    if (record.kind !== 'sitesetting' || !isActive(record)) continue;
    const name = textValue(record.fields.name).toLowerCase();
    if (!SECTIONS.some((section) => section.setting === name)) continue;
    const key = `${record.rootId ?? 'source'}\0${identity(record.fields.websiteid)}\0${name}`;
    if (!settings.has(key)) settings.set(key, []);
    settings.get(key).push(record);
  }
  return settings;
}

// The effective value only when exactly one literal true record decides it; otherwise no finding.
function cachingEnabled(settings, rootId, siteId, name, siteCount) {
  const entries =
    settings.get(`${rootId}\0${siteId}\0${name}`) ??
    (siteCount === 1 ? settings.get(`${rootId}\0\0${name}`) : undefined);
  if (entries?.length !== 1 || isEnvironmentBacked(entries[0])) return false;
  return booleanValue(entries[0].fields.value) === true;
}

function enhancedSites(inputs) {
  const sites = [];
  for (const input of inputs) {
    if (!/(?:^|[\\/])powerpagesites\.xml$/i.test(input.file ?? '') || typeof input.text !== 'string') continue;
    const fields = componentPayload(input.text).value;
    if (!fields) continue;
    const normalized = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key.toLowerCase().replace(/^(?:adx_|mspp_)/, ''), value]),
    );
    const id = /\bpowerpagesiteid\s*=\s*["']([^"']+)["']/i.exec(input.text)?.[1];
    sites.push({ rootId: input.rootId ?? 'source', id: identity(id ?? normalized.id), fields: normalized });
  }
  return sites;
}

function websites(records, inputs) {
  const classic = records
    .filter((record) => record.kind === 'website' && isActive(record))
    .map((record) => ({
      rootId: record.rootId ?? 'source',
      id: identity(record.fields.websiteid ?? record.fields.id),
      fields: record.fields,
    }));
  return [...classic, ...enhancedSites(inputs)];
}

function templateIndex(records, units) {
  const byRoot = new Map();
  for (const record of records) {
    if (record.kind !== 'webtemplate' || !isActive(record)) continue;
    const sidecar = record.file.replace(/\.ya?ml$/i, '.source.html');
    const unit =
      units.find((item) => item.file === record.file && item.field === 'source') ??
      units.find((item) => item.file === sidecar);
    if (!unit) continue;
    const rootId = record.rootId ?? 'source';
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId).push({
      id: identity(record.fields.webtemplateid ?? record.fields.id),
      name: textValue(record.fields.name),
      unit,
    });
  }
  return byRoot;
}

// The include lookup of the runtime (mirage/lib/liquid-source.mjs findWebTemplate): exact name, else trimmed and
// case-insensitive.
function templateNamed(templates, name) {
  return (
    templates.find((template) => template.name === name) ??
    templates.find((template) => template.name.toLowerCase() === name.trim().toLowerCase())
  );
}

// The token text that can read objects: string literals and declared variable names are blanked, offsets kept.
function expressionText(token) {
  let text = token.text.replace(/(["'])[\s\S]*?\1/g, blank);
  if (token.name === 'assign') text = text.replace(/^([^=]*=)/, blank);
  if (token.name === 'for' || token.name === 'tablerow') text = text.replace(/^(.*?\sin\s)/s, blank);
  return text;
}

function includedName(token) {
  return /^\s*(["'])([^"']+)\1/.exec(token.markup)?.[2] ?? null;
}

// The named parameters of an include (`{% include 'Name' a: x, b: y %}`), which the included template sees as variables.
function includeParameters(token) {
  const markup = token.markup.replace(/(["'])[\s\S]*?\1/g, blank);
  return [...markup.matchAll(INCLUDE_PARAMETER)].map((match) => match[1]);
}

// The first request object the token reads that no variable in scope shadows.
// `url` of a language object: a variable that iterates website.languages (the documented Languages Dropdown loop), or
// `language` itself when nothing declares that name.
function requestObject(token, declared, languageVariable) {
  for (const match of expressionText(token).matchAll(REQUEST_OBJECT)) {
    if (match[1] && !declared(match[1])) return match;
    if (match[2] && (languageVariable(match[2]) || (match[2] === 'language' && !declared('language')))) return match;
  }
  return null;
}

// The variables visible at one point of a template: names inherited from the including template, inherited names
// that are language objects, the render-wide assign and capture names (shared with included templates) and the open
// loops.
function templateScope({ inherited, languages, globals }) {
  const loops = [];
  const declared = (name) => globals.has(name) || inherited.has(name) || loops.some((loop) => loop.name === name);
  const languageVariable = (name) => {
    const loop = loops.findLast((item) => item.name === name);
    return loop ? loop.language : languages.has(name) && !globals.has(name);
  };
  return { inherited, globals, loops, declared, languageVariable };
}

// The substitution nesting depth after `token`.
function substitutionDepth(token, depth) {
  if (token.type !== 'tag') return depth;
  if (token.name === 'substitution') return depth + 1;
  if (token.name === 'endsubstitution') return Math.max(0, depth - 1);
  return depth;
}

// Scans the template an include names, with its parameters and the loop variables in scope as its inherited names.
function scanInclude(token, scope, { templates, emit, chain }) {
  const name = includedName(token);
  const included = name ? templateNamed(templates, name) : undefined;
  if (!included) return;
  const parameters = includeParameters(token);
  const visible = new Set([...scope.inherited, ...scope.loops.map((loop) => loop.name), ...parameters]);
  const languageNames = new Set(
    [...visible].filter((item) => !parameters.includes(item) && scope.languageVariable(item)),
  );
  scanTemplate(included, templates, emit, chain, {
    inherited: visible,
    languages: languageNames,
    globals: scope.globals,
  });
}

// The declaration a tag makes (assign, for, tablerow) or the template it includes.
function scanTag(token, scope, context) {
  const variable = VARIABLE.exec(token.markup)?.[1];
  if (token.name === 'assign' && variable) scope.globals.add(variable);
  else if (LOOP_TAGS.has(token.name) && variable)
    scope.loops.push({ tag: token.name, name: variable, language: LANGUAGE_LOOP.test(token.markup) });
  else if (token.name === 'include') scanInclude(token, scope, context);
}

// One token outside a substitution block: a loop end closes its loop, a non-expression tag only declares (capture), and
// any other token is checked for a request object before its tag declares or includes.
function scanToken(token, scope, context) {
  if (token.type === 'tag' && token.name.startsWith('end') && LOOP_TAGS.has(token.name.slice(3))) {
    const index = scope.loops.findLastIndex((loop) => loop.tag === token.name.slice(3));
    if (index >= 0) scope.loops.length = index;
    return;
  }
  if (NON_EXPRESSION_TAGS.has(token.name)) {
    const name = token.name === 'capture' ? VARIABLE.exec(token.markup)?.[1] : undefined;
    if (name) scope.globals.add(name);
    return;
  }
  const match = requestObject(token, scope.declared, scope.languageVariable);
  if (match) context.emit('PP-CACHE-001', context.template.unit, undefined, token.start + match.index);
  if (token.type === 'tag') scanTag(token, scope, context);
}

/**
 * Scans one template and the templates it includes. Variable scopes follow Liquid: `assign` and `capture` declare a
 * name from that point on for the rest of the render, included templates too (`globals` is shared); a `for` or
 * `tablerow` variable lasts until its end tag; include parameters are variables of the included template. A
 * substitution block renders apart from the cached output, in a context of its own (mirage/lib/liquid.mjs
 * SubstitutionTag), so nothing in it is reported and its declarations do not shadow names outside it.
 */
function scanTemplate(
  template,
  templates,
  emit,
  chain,
  scope = { inherited: new Set(), languages: new Set(), globals: new Set() },
) {
  if (chain.has(template) || chain.size >= MAX_INCLUDE_DEPTH) return;
  chain.add(template);
  const state = templateScope(scope);
  const context = { template, templates, emit, chain };
  let substitution = 0;
  for (const token of scanLiquidTokens(template.unit.text)) {
    substitution = substitutionDepth(token, substitution);
    if (substitution === 0) scanToken(token, state, context);
  }
  chain.delete(template);
}

/** Reports request-dependent Liquid that an enabled header or footer output cache would share across requests. */
export function analyzeOutputCache(records, units, inputs, emit) {
  const sites = websites(records, inputs);
  if (!sites.length) return;
  const settings = siteSettings(records);
  const templates = templateIndex(records, units);
  for (const site of sites) {
    const rootTemplates = templates.get(site.rootId) ?? [];
    const siteCount = sites.filter((other) => other.rootId === site.rootId).length;
    for (const section of SECTIONS) {
      const templateId = identity(site.fields[section.field]);
      if (!templateId || !cachingEnabled(settings, site.rootId, site.id, section.setting, siteCount)) continue;
      const template = rootTemplates.find((item) => item.id === templateId);
      if (template) scanTemplate(template, rootTemplates, emit, new Set());
    }
  }
}
