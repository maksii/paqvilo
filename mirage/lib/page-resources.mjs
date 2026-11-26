import path from 'node:path';
import fs from 'node:fs';
import { recordedStamp } from '../../lense/file-cache.mjs';
import { normalizePortalPath, portalField, pageTemplateKind, effectiveSnippetRecords } from './importer.mjs';
import { stripLiquidLiteralBlocks, scanLiquidTokens, findWebTemplate } from './liquid-source.mjs';
import { pageRuleMatcher } from './page-access.mjs';
import { localizedPortalPage } from './portal-languages.mjs';
import { tagAttributes } from './liquid-engine.mjs';
import { runtimeTemplateFallback } from './liquid.mjs';
import { rewritePageLayout } from './platform-manifest.mjs';
import { advancedFormGraph } from './advanced-form-graph.mjs';
import { authRoute } from './auth-session.mjs';
import {
  deniedPageRoute,
  languageRoute,
  loginPath,
  requestTargetUrl,
  resolveUnmatchedRoute,
  servicePages,
  siteMarkerRoute,
} from './redirects.mjs';

const id = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const asArray = (value) => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};
const unique = (items, key = (item) => JSON.stringify(item)) => {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};
const recordDescriptor = (record, kind, name, fieldPath) => ({
  kind,
  name: String(name ?? ''),
  sourceFile: record?._file ?? null,
  file: record?._file ?? null,
  relativePath: record?._file ? path.basename(record._file) : null,
  recordId: record?.id ?? null,
  fieldPath: fieldPath ?? null,
});
const sourceFile = (record, suffix) => {
  if (!record?._file) return null;
  if (record._file.toLowerCase().endsWith('powerpagecomponent.xml')) return record._file;
  const body = record._file.replace(/\.ya?ml$/i, `.${suffix}`);
  return fs.existsSync(body) ? body : record._file;
};
const field = (record, name, fallback = null) => portalField(record ?? {}, name, fallback);
const active = (record) => Number(field(record, 'statecode', 0)) !== 1;
const lookup = (rows, value) => {
  const key = id(value);
  if (!key) return null;
  return rows.find((row) => id(row.id) === key) ?? null;
};
const expression = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Certainty of a usage row (usages[].certainty; unresolved[].certainty and component
 * descriptors carry it too when they are not 'declared'):
 *   'declared'     the reference sits in a source the route renders, outside if/unless/case/for/tablerow;
 *   'conditional'  it renders only on one branch or loop iteration (usages[].conditional is true);
 *   'not-rendered' the row is listed although the runtime does not render it: page copy that no
 *                  rendered template outputs, a page-record form/list lookup that no rendered source
 *                  uses, an entityform/webform tag after the page's first one or under a rewrite page
 *                  template (liquid.mjs claimFormTag), a form tag that names no form.
 */
const CERTAINTY_RANK = { 'not-rendered': 0, conditional: 1, declared: 2 };
const strongest = (a, b) => ((CERTAINTY_RANK[a] ?? 2) >= (CERTAINTY_RANK[b] ?? 2) ? a : b);
const certaintyOf = (frame, token) => {
  if (frame.notRendered) return 'not-rendered';
  return frame.conditional || token?.conditional ? 'conditional' : 'declared';
};
const MAX_INCLUDE_DEPTH = 64;
// Shell snippets the runtime renders when they exist and skips otherwise (liquid.mjs renderPage:
// Head/Bottom and Browser Title Suffix with `?? ''`, Head/Bootstrap when present).
const SHELL_SNIPPETS = ['Head/Bottom', 'Head/Bootstrap', 'Browser Title Suffix'];
/** Parameters that the runtime's built-in templates read (liquid-builtins.mjs bodies), by template name. */
const BUILTIN_PARAMETERS = {
  snippet: [{ names: ['snippet_name'], kind: 'snippet' }],
  entity_list: [{ names: ['key'], kind: 'list' }],
  weblink_list_group: [{ names: ['weblink_set_name'], kind: 'web-link-set' }],
  poll: [
    { names: ['poll_name'], kind: 'poll' },
    { names: ['poll_placement_name'], kind: 'pollplacement' },
  ],
  ad: [
    { names: ['ad_name'], kind: 'ad' },
    { names: ['ad_placement_name'], kind: 'adplacement' },
  ],
  random_poll: [{ names: ['id', 'name'], kind: 'pollplacement' }],
  random_ad: [{ names: ['id', 'name'], kind: 'adplacement' }],
};
const UNRESOLVED_KIND = {
  snippet: 'content-snippet',
  list: 'entitylist',
  'web-link-set': 'web-link-set',
  poll: 'poll',
  pollplacement: 'poll-placement',
  ad: 'ad',
  adplacement: 'ad-placement',
};
const PAGE_LOOKUP = /^page\s*\.\s*(?:adx_|mspp_)?(entityform|entitylist|webform|navigation)(?:\s*\.\s*(?:id|name))?$/i;
const PAGE_LOOKUP_USE =
  /(?<![\p{L}\p{Nd}_.])page\s*\.\s*(?:adx_|mspp_)?(entityform|entitylist|webform|navigation)\b/giu;
// `page.copy` and `page['copy']` (either attribute prefix), as two expressions so each stays simple.
const PAGE_COPY_MEMBER = /(?<![\p{L}\p{Nd}_.])page\s*\.\s*(?:adx_|mspp_)?copy\b/iu;
const PAGE_COPY_INDEX = /(?<![\p{L}\p{Nd}_.])page\s*\[\s*(['"])(?:adx_|mspp_)?copy\1\s*\]/iu;
const usesPageCopy = (markup) => PAGE_COPY_MEMBER.test(markup) || PAGE_COPY_INDEX.test(markup);
const OBJECT_ROOT = /(?<![\p{L}\p{Mn}\p{Nd}\p{Pc}.\-\]])(snippets|settings|weblinks|sitemarkers|entities|sitemap)\b/giu;
const MEMBER = /[\p{L}\p{Mn}\p{Nd}\p{Pc}-]+/uy;
const QUOTED = /^\s*(['"])([\s\S]*)\1\s*$/;

/** A tag attribute as a literal (quoted, or an unquoted GUID) or as a dynamic Liquid expression. */
function attributeValue(attributes, names) {
  for (const name of names) {
    const attribute = attributes.get(name);
    if (!attribute) continue;
    const value = String(attribute.value).trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) return { literal: quoted[2], raw: value };
    if (guid.test(value.replace(/[{}]/g, ''))) return { literal: value.replace(/[{}]/g, ''), raw: value };
    return { dynamic: value, raw: value };
  }
  return null;
}

const maskQuotes = (text) => text.replace(/'[^']*'|"[^"]*"/g, (quoted) => ' '.repeat(quoted.length));

/** The first index at or after `from` that is not a space or a tab. */
function skipBlanks(text, from) {
  let position = from;
  while (text[position] === ' ' || text[position] === '\t') position++;
  return position;
}

/** Global object lookups (snippets, settings, weblinks, sitemarkers, entities, sitemap) in one Liquid markup. */
function* objectReferences(markup) {
  const masked = maskQuotes(markup);
  let found = -2;
  const closeAt = (from) => {
    if (found === -2 || (found !== -1 && found < from)) found = markup.indexOf(']', from);
    return found;
  };
  OBJECT_ROOT.lastIndex = 0;
  for (const match of masked.matchAll(OBJECT_ROOT)) {
    const position = skipBlanks(markup, match.index + match[0].length);
    const object = match[1].toLowerCase();
    if (markup[position] === '.') {
      MEMBER.lastIndex = position + 1;
      const member = MEMBER.exec(markup);
      if (!member) continue;
      yield { object, literal: member[0], member: true, text: markup.slice(match.index, MEMBER.lastIndex) };
    } else if (markup[position] === '[') {
      const close = closeAt(position + 1);
      if (close < 0) continue;
      const content = markup.slice(position + 1, close);
      const quoted = QUOTED.exec(content);
      const text = markup.slice(match.index, close + 1);
      if (quoted) yield { object, literal: quoted[2], text };
      else if (content.trim()) yield { object, dynamic: content.trim(), text };
    }
  }
}

function pageLookupId(page, expressionText) {
  const kind = PAGE_LOOKUP.exec(String(expressionText ?? '').trim())?.[1]?.toLowerCase();
  if (!kind) return null;
  if (kind === 'entityform') return { kind, id: page?.formId || null };
  if (kind === 'entitylist') return { kind, id: page?.listId || null };
  if (kind === 'webform') return { kind, id: page?.advancedFormId || null };
  return { kind, id: id(field(page?.metadata, 'navigation')) || null };
}

// ---- Graph walk: every rendered source is scanned where the runtime renders it (depth first).

function usage(context, frame, token, row) {
  const certainty = row.certainty ?? certaintyOf(frame, token);
  const entry = {
    ...row,
    expression: expression(row.expression ?? token?.text),
    owner: frame.owner,
    conditional: certainty === 'conditional',
    certainty,
  };
  context.usages.push(entry);
  return entry;
}

function unresolvedRow(context, frame, token, row) {
  if (frame.builtin && row.dynamic) return;
  const { dynamic: _dynamic, ...rest } = row; // NOSONAR: binding is excluded from the rest object
  const certainty = certaintyOf(frame, token);
  context.unresolved.push({
    ...rest,
    expression: rest.expression ?? token?.text,
    owner: frame.owner,
    ...(certainty === 'declared' ? {} : { certainty }),
  });
}

function childFrame(frame, token, owner, extra = {}) {
  return {
    owner,
    conditional: Boolean(frame.conditional || token?.conditional),
    notRendered: Boolean(frame.notRendered),
    builtin: false,
    depth: frame.depth + 1,
    ...extra,
  };
}

function walkSource(text, frame, context) {
  if (frame.depth > MAX_INCLUDE_DEPTH || !text) return;
  const key = `${frame.owner}\u0000${frame.builtin ? 'b' : ''}\u0000${text}`;
  const rank = CERTAINTY_RANK[certaintyOf(frame)];
  if ((context.seen.get(key) ?? -1) >= rank) return;
  context.seen.set(key, rank);
  const source = stripLiquidLiteralBlocks(text);
  const lists = [];
  for (const token of scanLiquidTokens(source)) {
    if (token.name === 'endentitylist') lists.pop();
    visitToken(token, frame, context, lists);
  }
  collectFetchReferences(source, frame, context);
}

function visitToken(token, frame, context, lists) {
  const { name, markup } = token;
  if (token.type === 'tag') {
    if (['include', 'render', 'extends', 'layout'].includes(name)) visitInclude(token, frame, context);
    else if (name === 'editable') visitEditable(token, frame, context);
    else if (['entityform', 'webform', 'entitylist', 'entityview'].includes(name))
      visitComponent(token, frame, context, lists);
    else if (['chart', 'powerbi', 'searchindex', 'redirect', 'rating'].includes(name))
      visitPlatformTag(token, frame, context);
  }
  if (token.type === 'output' || (name && !name.startsWith('end')))
    for (const reference of objectReferences(markup)) visitObjectReference(reference, token, frame, context);
  visitPageMarkers(markup, token, frame, context);
}

function visitPageMarkers(markup, token, frame, context) {
  const masked = maskQuotes(markup);
  PAGE_LOOKUP_USE.lastIndex = 0;
  for (const match of masked.matchAll(PAGE_LOOKUP_USE)) {
    const kind = match[1].toLowerCase();
    const certainty = certaintyOf(frame, token);
    context.pageLookupsUsed.set(kind, strongest(context.pageLookupsUsed.get(kind) ?? 'not-rendered', certainty));
  }
  if (usesPageCopy(markup)) renderPageCopy(token, frame, context);
}

function renderPageCopy(token, frame, context) {
  if (!context.page || frame.owner === 'page') return;
  context.pageCopyRendered = true;
  walkSource(context.page.html ?? '', childFrame(frame, token, 'page', { field: 'copy' }), context);
}

function visitInclude(token, frame, context) {
  const literal = /^\s*(?:'([^']*)'|"([^"]*)")/.exec(token.markup);
  if (!literal) {
    unresolvedRow(context, frame, token, {
      kind: 'web-template',
      expression: token.text,
      reason: 'Template reference is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
    if (!frame.builtin) usage(context, frame, token, { kind: 'include', reference: null });
    return;
  }
  const name = literal[1] ?? literal[2];
  usage(context, frame, token, { kind: 'include', reference: name });
  const args = token.markup.slice(literal[0].length);
  const record = findWebTemplate(context.portal, name);
  const fallback = runtimeTemplateFallback(name, record ?? null);
  if (record) addWebTemplate(record, 'Liquid include/layout', token, frame, context, fallback);
  if (fallback) {
    addBuiltinTemplate(fallback, name, token, frame, context);
    applyBuiltinParameters(fallback.name, args, token, frame, context);
  }
  if (!record && !fallback)
    unresolvedRow(context, frame, token, {
      kind: 'web-template',
      expression: name,
      via: 'Liquid include/layout',
      reason: 'No imported web template matches this static reference.',
    });
}

function addWebTemplate(found, via, token, frame, context, fallback = null) {
  const owner = frame.owner;
  let descriptor = context.webTemplates.find((item) => id(item.id) === id(found.id));
  if (descriptor) {
    if (owner && !descriptor.includedBy.includes(owner)) descriptor.includedBy.push(owner);
  } else {
    const file = sourceFile(found.metadata, 'source.html') ?? found.metadata?._file ?? null;
    descriptor = {
      ...recordDescriptor(found.metadata, 'web-template', found.name, 'source'),
      id: found.id,
      via,
      includedBy: owner ? [owner] : [],
      sourceFile: file,
      file,
      ...(fallback ? { runtimeSource: `built-in ${fallback.name}` } : {}),
    };
    context.webTemplates.push(descriptor);
    context.dependencies.push(descriptor);
  }
  if (!fallback) walkSource(found.source ?? '', childFrame(frame, token, `web-template:${id(found.id)}`), context);
}

function addBuiltinTemplate(fallback, reference, token, frame, context) {
  let descriptor = context.builtinTemplates.find((item) => item.name === fallback.name);
  if (!descriptor) {
    descriptor = {
      kind: 'builtin-template',
      name: fallback.name,
      reference: String(reference),
      origin: fallback.origin,
      includedBy: [],
      sourceFile: null,
    };
    context.builtinTemplates.push(descriptor);
  }
  if (!descriptor.includedBy.includes(frame.owner)) descriptor.includedBy.push(frame.owner);
  walkSource(
    fallback.source,
    childFrame(frame, token, `builtin-template:${fallback.name}`, { builtin: true, optional: true }),
    context,
  );
}

function applyBuiltinParameters(managed, args, token, frame, context) {
  const groups = BUILTIN_PARAMETERS[managed];
  if (!groups) return;
  const attributes = tagAttributes(args);
  let passed = false;
  for (const group of groups) {
    const value = attributeValue(attributes, group.names);
    if (!value) continue;
    passed = true;
    resolveNamedReference(group.kind, value, token, frame, context, `built-in ${managed}`);
  }
  if (!passed)
    unresolvedRow(context, frame, token, {
      kind: UNRESOLVED_KIND[groups[0].kind],
      expression: token.text,
      reason: `The built-in ${managed} template reads ${groups.flatMap((group) => group.names).join(' or ')} from the calling scope; no literal value is passed.`,
    });
}

function resolveNamedReference(kind, value, token, frame, context, via) {
  if (kind === 'snippet') return resolveSnippetReference(value, token, frame, context, via);
  if (kind === 'list') return resolveNamedListReference(value, token, frame, context, via);
  if (kind === 'web-link-set') return resolveWebLinkSetReference(value, token, frame, context, via);
  if (value.literal !== undefined) addCommunityRecord(kind, value.literal, via, token, frame, context);
  else
    unresolvedRow(context, frame, token, {
      kind: UNRESOLVED_KIND[kind],
      expression: token.text,
      reason: `The ${UNRESOLVED_KIND[kind]} name is dynamic and cannot be resolved statically.`,
    });
}

function resolveSnippetReference(value, token, frame, context, via) {
  if (value.literal !== undefined) {
    usage(context, frame, token, { kind: 'snippet', reference: value.literal, via });
    addSnippet(value.literal, via, token, frame, context);
  } else {
    unresolvedRow(context, frame, token, {
      kind: 'content-snippet',
      expression: token.text,
      reason: 'Snippet key is dynamic and cannot be resolved statically.',
    });
    usage(context, frame, token, { kind: 'snippet', reference: null, via });
  }
}

function resolveNamedListReference(value, token, frame, context, via) {
  const page = value.dynamic === undefined ? null : pageLookupId(context.page, value.dynamic);
  const reference = value.literal ?? page?.id ?? null;
  if (value.dynamic !== undefined && !page)
    unresolvedRow(context, frame, token, {
      kind: 'entitylist',
      expression: token.text,
      reason: 'Built-in list key uses a Liquid variable and cannot be resolved statically.',
    });
  const row = usage(context, frame, token, {
    kind: 'entitylist',
    reference,
    via,
    ...(page ? { pageLookup: 'entitylist' } : {}),
  });
  if (reference) context.references.lists.push({ ref: reference, usage: row });
}

function resolveWebLinkSetReference(value, token, frame, context, via) {
  if (value.literal !== undefined) addWebLinkSet(value.literal, via, token, frame, context);
  else
    unresolvedRow(context, frame, token, {
      kind: 'web-link-set',
      expression: token.text,
      reason: 'Web link set name is dynamic and cannot be resolved statically.',
    });
}

function visitEditable(token, frame, context) {
  const markup = token.markup;
  const target = /^\s*([\w.]+)/.exec(markup)?.[1];
  if (!target) return;
  const rest = markup.slice(markup.indexOf(target) + target.length);
  const literal = /^\s*(?:'([^']*)'|"([^"]*)")/.exec(rest);
  const reference = literal ? (literal[1] ?? literal[2]) : null;
  if (target.toLowerCase() === 'snippets') {
    if (reference !== null) addSnippet(reference, 'Liquid snippet', token, frame, context);
    else
      unresolvedRow(context, frame, token, {
        kind: 'content-snippet',
        expression: token.text,
        reason: 'Editable snippet name is dynamic and cannot be resolved statically.',
        dynamic: true,
      });
    usage(context, frame, token, { kind: 'editable', reference, target: 'snippet' });
    return;
  }
  usage(context, frame, token, { kind: 'editable', reference, target });
  if (target.toLowerCase() === 'page' && /^(?:adx_|mspp_)?copy$/i.test(reference ?? ''))
    renderPageCopy(token, frame, context);
}

/** What an entitylist/entityform/webform tag references: the reference, its page lookup, and why nothing renders. */
function componentReference(kind, value, token, frame, context) {
  let reference = value?.literal ?? null,
    pageLookup = null,
    reason = null,
    certainty;
  if (!value) {
    certainty = 'not-rendered';
    reason = `The ${kind} tag names no ${kind === 'entitylist' ? 'list' : 'form'}; the runtime renders nothing.`;
  } else if (value.dynamic !== undefined) {
    const page = pageLookupId(context.page, value.dynamic);
    if (page) {
      pageLookup = page.kind;
      reference = page.id;
      if (!reference) {
        certainty = 'not-rendered';
        reason = `The page record has no ${page.kind} lookup; the runtime renders nothing.`;
      }
    } else
      unresolvedRow(context, frame, token, {
        kind,
        expression: token.text,
        reason: 'Component reference uses a Liquid variable and cannot be resolved statically.',
        dynamic: true,
      });
  }
  return { reference, pageLookup, reason, certainty };
}

function visitComponent(token, frame, context, lists) {
  const kind = token.name;
  const attributes = tagAttributes(token.markup);
  if (kind === 'entityview') {
    visitEntityView(token, frame, context, lists, attributes);
    return;
  }
  const value = attributeValue(attributes, ['name', 'id', 'key']);
  const pageControl = /^(['"]?)true\1$/i.test(String(attributes.get('pp_page_control')?.value ?? ''));
  const { reference, pageLookup, reason, certainty } = componentReference(kind, value, token, frame, context);
  const row = usage(context, frame, token, {
    kind,
    reference,
    ...(pageLookup ? { pageLookup } : {}),
    ...(reason ? { reason } : {}),
    ...(certainty ? { certainty } : {}),
  });
  if (kind === 'entitylist') {
    lists.push(reference);
    if (reference) context.references.lists.push({ ref: reference, usage: row });
    return;
  }
  if (value) context.formTags.push({ usage: row, pageControl });
  if (reference) context.references.forms.push({ kind, ref: reference, usage: row });
}

function visitEntityView(token, frame, context, lists, attributes) {
  if (token.blocks.includes('entitylist')) {
    // Inside an entitylist block the runtime renders the enclosing list's view model and ignores the arguments.
    usage(context, frame, token, { kind: 'entityview', reference: lists.at(-1) ?? null, via: 'enclosing entitylist' });
    return;
  }
  const viewId = attributeValue(attributes, ['id']);
  const table = attributeValue(attributes, ['logical_name', 'logicalname']);
  const name = attributeValue(attributes, ['name']);
  if (viewId?.literal !== undefined) {
    usage(context, frame, token, { kind: 'entityview', reference: viewId.literal });
    context.references.views.push({ ref: viewId.literal });
  } else if (!viewId && table?.literal !== undefined && name?.literal !== undefined) {
    usage(context, frame, token, { kind: 'entityview', reference: name.literal, entity: table.literal.toLowerCase() });
    context.references.views.push({ ref: name.literal, entity: table.literal.toLowerCase() });
  } else if (viewId || table?.dynamic !== undefined || name?.dynamic !== undefined) {
    unresolvedRow(context, frame, token, {
      kind: 'entityview',
      expression: token.text,
      reason: 'Component reference uses a Liquid variable and cannot be resolved statically.',
      dynamic: true,
    });
    usage(context, frame, token, { kind: 'entityview', reference: null });
  } else {
    unresolvedRow(context, frame, token, {
      kind: 'entityview',
      expression: token.text,
      reason: 'Outside an entitylist block the runtime selects a view by id, or by logical_name and name.',
    });
    usage(context, frame, token, { kind: 'entityview', reference: null, certainty: 'not-rendered' });
  }
}

function visitChartTag(token, frame, context, attributes) {
  const kind = token.name;
  const chart = attributeValue(attributes, ['id']);
  const view = attributeValue(attributes, ['viewid']);
  usage(context, frame, token, {
    kind,
    reference: chart?.literal ?? null,
    view: view?.literal ?? null,
  });
  if (view?.literal) context.references.views.push({ ref: view.literal });
  if (chart?.dynamic !== undefined || view?.dynamic !== undefined)
    unresolvedRow(context, frame, token, {
      kind: 'chart',
      expression: token.text,
      reason: 'Chart or view id is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

function visitRedirectTag(token, frame, context, attributes) {
  const kind = token.name;
  // RedirectTag (liquid.mjs) strips quotes and a ['...'] wrapper from the sitemarker attribute.
  const marker = attributes.get('sitemarker')?.value;
  const quoted = marker == null ? null : /^\[?\s*(['"])([\s\S]*)\1\s*\]?$/.exec(String(marker).trim());
  usage(context, frame, token, { kind, reference: quoted ? quoted[2] : null });
  if (quoted) addSiteMarker(quoted[2], 'redirect tag', token, frame, context);
  else if (marker != null)
    unresolvedRow(context, frame, token, {
      kind: 'site-marker',
      expression: token.text,
      reason: 'Site marker name is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

function visitPlatformTag(token, frame, context) {
  const kind = token.name;
  const attributes = tagAttributes(token.markup);
  if (kind === 'chart') return visitChartTag(token, frame, context, attributes);
  if (kind === 'redirect') return visitRedirectTag(token, frame, context, attributes);
  if (kind === 'searchindex') {
    const names = attributeValue(attributes, ['logical_names']);
    const tables = String(names?.literal ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    usage(context, frame, token, { kind, reference: null, tables });
    for (const table of tables) addTable(context, table);
    return;
  }
  const reference = attributeValue(attributes, kind === 'powerbi' ? ['path'] : ['id', 'name']);
  usage(context, frame, token, { kind, reference: reference?.literal ?? null });
}

function visitSnippetsObject({ literal, text }, token, frame, context) {
  if (literal !== undefined) {
    usage(context, frame, token, { kind: 'snippet', reference: literal, expression: text });
    addSnippet(literal, 'Liquid snippet', token, frame, context);
  } else {
    unresolvedRow(context, frame, token, {
      kind: 'content-snippet',
      expression: text,
      reason: 'Snippet key is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
    if (!frame.builtin) usage(context, frame, token, { kind: 'snippet', reference: null, expression: text });
  }
}

function visitSettingsObject({ literal, text }, token, frame, context) {
  if (literal !== undefined) {
    usage(context, frame, token, { kind: 'setting', reference: literal, expression: text });
    context.references.settings.push({ name: literal, optional: Boolean(frame.optional) });
  } else
    unresolvedRow(context, frame, token, {
      kind: 'site-setting',
      expression: text,
      reason: 'Site setting key is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

function visitWeblinksObject({ literal, dynamic, text }, token, frame, context) {
  const page = dynamic === undefined ? null : pageLookupId(context.page, dynamic);
  if (literal !== undefined) addWebLinkSet(literal, 'Liquid weblinks', token, frame, context, text);
  else if (page?.kind === 'navigation' && page.id)
    addWebLinkSet(page.id, 'page navigation', token, frame, context, text);
  else
    unresolvedRow(context, frame, token, {
      kind: 'web-link-set',
      expression: text,
      reason: 'Web link set key is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

function visitSitemarkersObject({ literal, text }, token, frame, context) {
  if (literal !== undefined) addSiteMarker(literal, 'Liquid sitemarkers', token, frame, context, text);
  else
    unresolvedRow(context, frame, token, {
      kind: 'site-marker',
      expression: text,
      reason: 'Site marker name is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

function visitEntitiesObject({ literal, text }, token, frame, context) {
  if (literal !== undefined) {
    usage(context, frame, token, { kind: 'table', reference: literal.toLowerCase(), expression: text });
    addTable(context, literal.toLowerCase());
  } else
    unresolvedRow(context, frame, token, {
      kind: 'table',
      expression: text,
      reason: 'Table name is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
}

const OBJECT_VISITORS = {
  snippets: visitSnippetsObject,
  settings: visitSettingsObject,
  weblinks: visitWeblinksObject,
  sitemarkers: visitSitemarkersObject,
  entities: visitEntitiesObject,
  sitemap: visitSitemap,
};

function visitObjectReference(reference, token, frame, context) {
  OBJECT_VISITORS[reference.object]?.(reference, token, frame, context);
}

function visitSitemap({ literal, dynamic, member, text }, token, frame, context) {
  if (member) {
    usage(context, frame, token, { kind: 'sitemap', reference: literal, expression: text });
    return;
  }
  if (dynamic !== undefined) {
    unresolvedRow(context, frame, token, {
      kind: 'sitemap',
      expression: text,
      reason: 'Site map path is dynamic and cannot be resolved statically.',
      dynamic: true,
    });
    return;
  }
  const key = normalizePortalPath(literal);
  const page = (context.portal.pages ?? []).find((candidate) => normalizePortalPath(candidate.url) === key);
  usage(context, frame, token, {
    kind: 'sitemap',
    reference: literal,
    expression: text,
    page: page ? { id: page.id, name: page.name ?? null, url: page.url } : null,
  });
  if (!page)
    unresolvedRow(context, frame, token, {
      kind: 'page',
      expression: literal,
      reason: 'No imported page has this site map path.',
    });
}

function addTable(context, table) {
  if (!table) return;
  if (!context.references.tables.has(table)) context.references.tables.set(table, new Set());
}

function addSnippet(reference, via, token, frame, context) {
  const key = String(reference ?? '');
  const record = context.snippetRecords.resolve(key);
  if (!record) {
    if (frame.optional || token?.optional)
      context.optionalAbsent.push({ kind: 'content-snippet', name: key, via, owner: frame.owner });
    else
      unresolvedRow(context, frame, token, {
        kind: 'content-snippet',
        expression: key,
        via,
        reason: 'No imported content snippet matches this static reference.',
      });
    return;
  }
  let descriptor = context.snippets.find((item) => item.name === record.name);
  if (descriptor) {
    if (frame.owner && !descriptor.usedBy.includes(frame.owner)) descriptor.usedBy.push(frame.owner);
  } else {
    descriptor = {
      ...recordDescriptor(record, 'content-snippet', record.name, 'value'),
      usedBy: frame.owner ? [frame.owner] : [],
    };
    descriptor.sourceFile = sourceFile(record, 'value.html') ?? record._file;
    descriptor.file = descriptor.sourceFile;
    context.snippets.push(descriptor);
    context.dependencies.push(descriptor);
  }
  walkSource(
    localizedSnippet(context.portal, record.name, context.languageId) ?? '',
    childFrame(frame, token, `content-snippet:${record.name}`),
    context,
  );
}

/** The web link set a Liquid key selects (liquid.mjs buildWeblinks): a GUID by id, else the first active set of that exact name. */
function findWebLinkSet(portal, key, languageId, byId = false) {
  const languages = new Map(
    (portal.records ?? [])
      .filter((record) => record.kind === 'weblinkset')
      .map((record) => [id(record.id), id(field(record, 'websitelanguageid'))]),
  );
  const inLanguage = (set) => !languageId || !languages.get(id(set.id)) || languages.get(id(set.id)) === id(languageId);
  const sets = [...(portal.weblinkSets ?? []), ...Object.values(portal.weblinks ?? {})].filter(
    (set) => set && inLanguage(set),
  );
  const text = String(key ?? '').trim();
  if (byId || guid.test(text.replace(/[{}]/g, ''))) return sets.find((set) => id(set.id) === id(text)) ?? null;
  return sets.find((set) => set.name === String(key)) ?? null;
}

function addWebLinkSet(key, via, token, frame, context, text = null) {
  const set = findWebLinkSet(
    context.portal,
    key,
    context.languageId ?? context.siteLanguageId,
    via === 'page navigation',
  );
  usage(context, frame, token, {
    kind: 'web-link-set',
    reference: String(key),
    via,
    ...(text ? { expression: text } : {}),
  });
  if (!set) {
    if (frame.optional)
      context.optionalAbsent.push({ kind: 'web-link-set', name: String(key), via, owner: frame.owner });
    else
      unresolvedRow(context, frame, token, {
        kind: 'web-link-set',
        expression: String(key),
        via,
        reason: 'No imported web link set matches this static reference.',
      });
    return;
  }
  let descriptor = context.webLinkSets.find((item) => id(item.id) === id(set.id));
  if (descriptor) {
    if (!descriptor.usedBy.includes(frame.owner)) descriptor.usedBy.push(frame.owner);
    return;
  }
  const links = [];
  const flatten = (items, parentId = null) => {
    for (const link of items ?? []) {
      links.push({
        id: link.id,
        name: link.name,
        parentId,
        pageId: link.pageId || null,
        url: link.url ?? null,
        sourceFile: link.metadata?._file ?? null,
      });
      flatten(link.weblinks, link.id);
    }
  };
  flatten(set.weblinks);
  descriptor = {
    ...recordDescriptor(set.metadata, 'web-link-set', set.name, 'name'),
    id: set.id,
    usedBy: [frame.owner],
    links,
  };
  context.webLinkSets.push(descriptor);
  context.dependencies.push(descriptor);
  for (const link of links)
    context.dependencies.push({
      kind: 'web-link',
      name: String(link.name ?? ''),
      sourceFile: link.sourceFile,
      file: link.sourceFile,
      relativePath: link.sourceFile ? path.basename(link.sourceFile) : null,
      recordId: link.id,
      fieldPath: 'name',
      setId: set.id,
    });
}

function addSiteMarker(name, via, token, frame, context, text = null) {
  const marker = (context.portal.siteMarkers ?? []).find((item) => item.name === name);
  usage(context, frame, token, { kind: 'site-marker', reference: name, via, ...(text ? { expression: text } : {}) });
  if (!marker) {
    if (frame.optional) context.optionalAbsent.push({ kind: 'site-marker', name, via, owner: frame.owner });
    else
      unresolvedRow(context, frame, token, {
        kind: 'site-marker',
        expression: name,
        via,
        reason: 'No imported site marker matches this static reference.',
      });
    return;
  }
  const existing = context.siteMarkers.find((item) => id(item.id) === id(marker.id));
  if (existing) {
    if (!existing.usedBy.includes(frame.owner)) existing.usedBy.push(frame.owner);
    return;
  }
  const record = (context.portal.records ?? []).find(
    (item) => item.kind === 'sitemarker' && id(item.id) === id(marker.id),
  );
  const page = (context.portal.pages ?? []).find((item) => id(item.id) === id(marker.pageId));
  const descriptor = {
    ...recordDescriptor(record, 'site-marker', marker.name, 'pageid'),
    id: marker.id,
    usedBy: [frame.owner],
    page: page ? { id: page.id, name: page.name ?? null, url: page.url } : null,
  };
  context.siteMarkers.push(descriptor);
  context.dependencies.push(descriptor);
  if (!page)
    unresolvedRow(context, frame, token, {
      kind: 'page',
      expression: marker.pageId ?? name,
      via: `site marker ${name}`,
      reason: 'The site marker points at no imported page.',
    });
}

function addCommunityRecord(kind, name, via, token, frame, context) {
  const record = (context.portal.records ?? []).find(
    (item) => item.kind === kind && active(item) && (item.name === name || id(item.id) === id(name)),
  );
  const label = UNRESOLVED_KIND[kind];
  usage(context, frame, token, { kind: label, reference: name, via });
  if (!record) {
    unresolvedRow(context, frame, token, {
      kind: label,
      expression: name,
      via,
      reason: `No imported ${label.replace('-', ' ')} matches this static reference.`,
    });
    return;
  }
  if (context.components.some((item) => item.kind === label && id(item.recordId) === id(record.id))) return;
  const descriptor = recordDescriptor(record, label, record.name, 'name');
  context.components.push(descriptor);
  context.dependencies.push(descriptor);
}

/** The attribute `name` of a FetchXML tag's attribute text (its quoted value), if present. */
const fetchAttribute = (attrs, name) => new RegExp(String.raw`\b${name}\s*=\s*(['"])(.*?)\1`, 'i').exec(attrs)?.[2];
/** A FetchXML attribute value that is a literal: non-empty and free of Liquid. */
const fetchLiteral = (value) => (value && !/\{\{|\{%/.test(value) ? value : null);

/** An entity or link-entity tag: the table it names (or a dynamic name), its join columns, the entity nesting. */
function scanFetchEntity(tagName, attrs, state, context) {
  const name = fetchAttribute(attrs, 'name');
  const current = fetchLiteral(name)?.toLowerCase() ?? null;
  if (name && !current) state.dynamic = true;
  if (current) {
    addTable(context, current);
    state.queryTables.push(current);
    if (tagName === 'link-entity') {
      const parent = state.entityStack.at(-1);
      const from = fetchLiteral(fetchAttribute(attrs, 'from'));
      const to = fetchLiteral(fetchAttribute(attrs, 'to'));
      if (from) context.references.tables.get(current).add(from);
      if (to && parent) context.references.tables.get(parent).add(to);
    }
  }
  if (!/\/\s*$/.test(attrs)) state.entityStack.push(current);
}

/** An attribute, condition or order tag: the column it names on its entity (a condition's own, else the enclosing). */
function scanFetchColumn(tagName, attrs, state, context) {
  const column = fetchLiteral(fetchAttribute(attrs, tagName === 'attribute' ? 'name' : 'attribute'));
  const owner =
    tagName === 'condition' ? (fetchLiteral(fetchAttribute(attrs, 'entityname'))?.toLowerCase() ?? null) : null;
  const table = owner && context.references.tables.has(owner) ? owner : state.entityStack.at(-1);
  if (table && column) context.references.tables.get(table).add(column);
}

/** The tables of one FetchXML query, adding the tables and columns it reads to the references. */
function scanFetchQuery(query, context) {
  const state = { entityStack: [], queryTables: [], dynamic: false };
  const token = /<(\/?)(entity|link-entity|attribute|condition|order)\b([^>]*)>/gi;
  for (const item of query.matchAll(token)) {
    const [, closing, tag, attrs] = item;
    const tagName = tag.toLowerCase();
    if (closing) {
      if (tagName === 'entity' || tagName === 'link-entity') state.entityStack.pop();
    } else if (tagName === 'entity' || tagName === 'link-entity') scanFetchEntity(tagName, attrs, state, context);
    else scanFetchColumn(tagName, attrs, state, context);
  }
  return state;
}

function collectFetchReferences(source, frame, context) {
  for (const match of source.matchAll(/<fetch\b[\s\S]*?<\/fetch>/gi)) {
    const query = match[0];
    const { queryTables, dynamic } = scanFetchQuery(query, context);
    if (!queryTables.length || dynamic)
      unresolvedRow(context, frame, null, {
        kind: 'fetchxml-table',
        expression: query.slice(0, 120),
        reason: dynamic
          ? 'FetchXML entity name is a Liquid expression and cannot be resolved statically.'
          : 'FetchXML entity name could not be resolved statically.',
      });
    usage(context, frame, null, {
      kind: 'fetchxml',
      reference: queryTables[0] ?? null,
      tables: [...new Set(queryTables)],
      expression: query,
    });
  }
}

// ---- Components (forms, lists, views), tables and settings

function appendSchemaColumns(component, schema, solutionMetadata, entityNames, columns) {
  for (const item of schema?.fields ?? [])
    if (component.entityName && item.name)
      columns.push({
        entity: component.entityName.toLowerCase(),
        name: item.name,
        sourceFile:
          item.source ?? solutionMetadata.entities?.[component.entityName.toLowerCase()]?.sources?.[0] ?? null,
        fieldPath: item.name,
      });
  for (const step of schema?.steps ?? []) {
    if (step.entity) entityNames.add(step.entity.toLowerCase());
    for (const item of step.fields ?? [])
      if (step.entity && item.name)
        columns.push({
          entity: step.entity.toLowerCase(),
          name: item.name,
          sourceFile: solutionMetadata.entities?.[step.entity.toLowerCase()]?.sources?.[0] ?? null,
          fieldPath: item.name,
        });
  }
}

/** Active steps of an advanced form, including steps of other forms that its step references select (advanced-form-graph.mjs). */
const advancedFormSteps = (portal, component) => advancedFormGraph(component, portal.records ?? []).steps;

const componentFrame = (owner, certainty) => ({
  owner,
  conditional: certainty === 'conditional',
  notRendered: certainty === 'not-rendered',
  builtin: false,
  depth: 1,
});

/** The active steps of an advanced form: their tables, custom JavaScript and component descriptors. */
function appendAdvancedFormSteps(portal, component, certainty, context) {
  const { components, entityNames, dependencies } = context;
  for (const step of advancedFormSteps(portal, component)) {
    const entity = field(step, 'targetentitylogicalname', field(step, 'entityname'));
    if (entity) entityNames.add(String(entity).toLowerCase());
    const stepFile = sourceFile(step, 'custom_javascript.js') ?? step._file ?? null;
    if (step.customJavascript)
      walkSource(step.customJavascript, componentFrame(`advanced-form-step:${id(step.id)}`, certainty), context);
    const stepDescriptor = {
      ...recordDescriptor(step, 'advanced-form-step', step.name, 'customjavascript'),
      sourceFile: stepFile,
      file: stepFile,
    };
    components.push(stepDescriptor);
    dependencies.push(stepDescriptor);
  }
}

function resolveFormReference(entry, context) {
  const { portal, solutionMetadata, unresolved, forms, components, columns, entityNames, dependencies } = context;
  const advancedTag = entry.kind === 'webform' || entry.kind === 'page-webform';
  // The runtime looks an entityform up among basic forms and a webform among advanced forms, by exact name or id.
  const component = (advancedTag ? portal.advancedForms : portal.forms)?.find(
    (item) => id(item.id) === id(entry.ref) || item.name === String(entry.ref),
  );
  const certainty = entry.usage?.certainty ?? 'declared';
  if (!component) {
    unresolved.push({
      kind: 'form',
      expression: entry.ref,
      reason: advancedTag
        ? 'No imported advanced form matches this static reference.'
        : 'No imported form matches this static reference.',
      ...(entry.usage?.owner ? { owner: entry.usage.owner } : {}),
      ...(certainty === 'declared' ? {} : { certainty }),
    });
    return;
  }
  const advanced = component.metadata?.kind === 'advancedform' || advancedTag;
  const kind = advanced ? 'advanced-form' : 'basic-form';
  const existing = components.find((item) => item.kind === kind && id(item.recordId) === id(component.id));
  if (existing) {
    existing.certainty = strongest(existing.certainty, certainty);
    return;
  }
  forms.push(component);
  const owner = `${kind}:${id(component.id)}`;
  if (component.entityName) entityNames.add(component.entityName.toLowerCase());
  const schema = solutionMetadata.componentSchemas?.[component.id];
  appendSchemaColumns(component, schema, solutionMetadata, entityNames, columns);
  const descriptor = recordDescriptor(component.metadata, kind, component.name, 'customjavascript');
  descriptor.sourceFile = sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null;
  descriptor.file = descriptor.sourceFile;
  descriptor.certainty = certainty;
  components.push(descriptor);
  dependencies.push(descriptor);
  if (component.js) walkSource(component.js, componentFrame(owner, certainty), context);
  if (advanced) appendAdvancedFormSteps(portal, component, certainty, context);
}

/* NOSONAR */ function resolveListReference(entry, context) {
  const { portal, unresolved, components, entityNames, references, dependencies } = context;
  const ref = String(entry.ref);
  const certainty = entry.usage?.certainty ?? 'declared';
  // findList (platform.mjs): by id, exact name or the list's key.
  const component = (portal.lists ?? []).find(
    (item) => id(item.id) === id(ref) || item.name === ref || field(item.metadata, 'key') === ref,
  );
  if (!component) {
    unresolved.push({
      kind: 'list',
      expression: ref,
      reason: 'No imported list matches this static reference.',
      ...(entry.usage?.owner ? { owner: entry.usage.owner } : {}),
      ...(certainty === 'declared' ? {} : { certainty }),
    });
    return;
  }
  const existing = components.find((item) => item.kind === 'list' && id(item.recordId) === id(component.id));
  if (existing) {
    existing.certainty = strongest(existing.certainty, certainty);
    return;
  }
  if (component.entityName) entityNames.add(component.entityName.toLowerCase());
  const descriptor = {
    ...recordDescriptor(component.metadata, 'list', component.name, 'customjavascript'),
    entity: component.entityName ?? null,
    sourceFile: sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null,
    file: sourceFile(component.metadata, 'custom_javascript.js') ?? component.metadata?._file ?? null,
    certainty,
  };
  components.push(descriptor);
  dependencies.push(descriptor);
  if (component.js) walkSource(component.js, componentFrame(`list:${id(component.id)}`, certainty), context);
  const viewValues = [];
  for (let value of [field(component.metadata, 'view'), field(component.metadata, 'views')]) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
      }
    }
    viewValues.push(...asArray(value?.Views ?? value?.views ?? value));
  }
  for (const viewId of viewValues) {
    const value =
      viewId && typeof viewId === 'object' ? (viewId.ViewId ?? viewId.viewId ?? viewId.id ?? viewId.value) : viewId;
    if (value) references.views.push({ ref: String(value) });
  }
}

function resolveViewReference(entry, context) {
  const { solutionMetadata, unresolved, views, components, entityNames, columns, dependencies } = context;
  const reference = entry.ref;
  const view = (solutionMetadata.views ?? []).find((item) =>
    entry.entity
      ? item.entity?.toLowerCase() === entry.entity && item.name === reference
      : id(item.id) === id(reference) || item.name === reference,
  );
  if (!view) {
    unresolved.push({
      kind: 'view',
      expression: entry.entity ? `${entry.entity}/${reference}` : reference,
      reason: 'View source is absent from imported solution metadata.',
    });
    return;
  }
  if (views.some((item) => id(item.id) === id(view.id))) return;
  views.push(view);
  entityNames.add(view.entity.toLowerCase());
  const descriptor = {
    kind: 'view',
    name: view.name,
    id: view.id,
    entity: view.entity,
    sourceFile: view.file,
    file: view.file,
    relativePath: view.file ? path.basename(view.file) : null,
    recordId: view.id,
    fieldPath: 'fetchXml',
  };
  components.push(descriptor);
  dependencies.push(descriptor);
  (view.fields ?? []).forEach((item) => {
    const column = solutionMetadata.entities?.[view.entity]?.fields?.[item.name];
    columns.push({
      entity: view.entity,
      name: item.name,
      width: item.width,
      source: column?.source,
      sourceFile: column?.source,
      recordId: view.id,
      fieldPath: 'layoutxml',
    });
  });
}

function appendTableColumns(references, columns, entityNames, solutionMetadata) {
  for (const [entity, selected] of references.tables) {
    entityNames.add(entity);
    selected.forEach((name) =>
      columns.push({
        entity,
        name,
        sourceFile: solutionMetadata.entities?.[entity]?.sources?.[0] ?? null,
        fieldPath: name,
      }),
    );
  }
}

function addTableDescriptors(entityNames, solutionMetadata, tables, columns, unresolved, dependencies) {
  for (const entity of entityNames) {
    const metadata = solutionMetadata.entities?.[entity];
    const descriptor = {
      kind: 'table',
      name: entity,
      logicalName: entity,
      sourceFile: metadata?.sources?.[0] ?? null,
      file: metadata?.sources?.[0] ?? null,
      sourceFiles: metadata?.sources ?? [],
      columns: Object.keys(metadata?.fields ?? {}).filter((name) =>
        columns.some((column) => column.entity === entity && column.name === name),
      ),
    };
    tables.push(descriptor);
    dependencies.push(descriptor);
    if (!metadata)
      unresolved.push({
        kind: 'table',
        expression: entity,
        reason: 'No imported solution table metadata matches this dependency.',
      });
  }
}

/** The active site setting record a reference resolves to (exact name, else the first case-insensitive match). */
function settingRecord(name, lower, portal, settings, records) {
  const key = Object.hasOwn(portal.settings ?? {}, name)
    ? name
    : (settings.find((item) => item.toLowerCase() === lower) ??
      records.find((item) => String(item.name).toLowerCase() === lower)?.name);
  return key === undefined ? undefined : records.findLast((item) => item.name === key);
}

/**
 * Site settings by the name the runtime resolves (redirects.mjs siteSetting: exact name, else the first
 * case-insensitive match) and the active record whose value the importer keeps (the last of that name).
 */
function resolveSettingReferences(settingEntries, tableNames, portal, context) {
  const { unresolved, siteSettings, dependencies, optionalAbsent } = context;
  const entries = [
    ...settingEntries,
    ...Object.keys(portal.settings ?? {})
      .filter((name) => /^webapi\//i.test(name) && tableNames.has(name.split('/')[1].toLowerCase()))
      .map((name) => ({ name, optional: false })),
  ];
  const records = (portal.records ?? []).filter((item) => item.kind === 'sitesetting' && active(item));
  const settings = Object.keys(portal.settings ?? {});
  const seen = new Set();
  for (const { name, optional } of entries) {
    const lower = String(name).toLowerCase();
    const record = settingRecord(name, lower, portal, settings, records);
    if (!record) {
      if (seen.has(`missing:${lower}`)) continue;
      seen.add(`missing:${lower}`);
      if (optional) optionalAbsent.push({ kind: 'site-setting', name });
      else
        unresolved.push({
          kind: 'site-setting',
          expression: name,
          reason: 'No imported site setting matches this static reference.',
        });
      continue;
    }
    if (seen.has(`record:${id(record.id)}:${record.name}`)) continue;
    seen.add(`record:${id(record.id)}:${record.name}`);
    const descriptor = recordDescriptor(record, 'site-setting', record.name, 'value');
    siteSettings.push(descriptor);
    dependencies.push(descriptor);
  }
}

/**
 * Settle form-tag certainty as the runtime claims forms (liquid.mjs claimFormTag): under a rewrite page
 * template no Liquid form tag renders; otherwise the first rendered entityform/webform tag claims the page
 * and later tags render nothing. Tags before the first unconditional one may or may not be that tag.
 */
function settleFormTags(context) {
  const tags = context.formTags.filter((tag) => tag.usage.certainty !== 'not-rendered' && !tag.pageControl);
  if (context.rewrite) {
    for (const tag of tags) {
      tag.usage.certainty = 'not-rendered';
      tag.usage.conditional = false;
      tag.usage.reason = 'A rewrite-based page template renders no Liquid entityform or webform tag.';
    }
    return;
  }
  const first = tags.findIndex((tag) => tag.usage.certainty === 'declared');
  if (first < 0) return;
  if (first > 0) {
    tags[first].usage.certainty = 'conditional';
    tags[first].usage.reason = 'An earlier conditional form tag may claim the page first.';
  }
  for (const tag of tags.slice(first + 1)) {
    tag.usage.certainty = 'not-rendered';
    tag.usage.conditional = false;
    tag.usage.reason = 'The page renders only its first entityform or webform tag.';
  }
}

function addPageLookups(page, context) {
  for (const [kind, value, target] of [
    ['entityform', page.formId, 'forms'],
    ['webform', page.advancedFormId, 'forms'],
    ['entitylist', page.listId, 'lists'],
  ]) {
    if (!value) continue;
    const pageAttribute = kind === 'webform' ? 'adx_webform' : `adx_${kind}`;
    const row = {
      kind,
      reference: value,
      expression: `page.${pageAttribute}`,
      via: 'page record',
      owner: 'page',
      conditional: false,
      certainty: 'not-rendered',
      pageLookup: kind,
    };
    context.pageLookupRows.push(row);
    context.usages.push(row);
    if (target === 'forms')
      context.references.forms.push({
        kind: kind === 'webform' ? 'page-webform' : 'page-entityform',
        ref: value,
        usage: row,
      });
    else context.references.lists.push({ ref: value, usage: row });
  }
}

/** A page-record lookup renders when a rendered source reads it (page.adx_*) or a rendered tag names the same record. */
function settlePageLookups(context) {
  for (const row of context.pageLookupRows) {
    const read = context.pageLookupsUsed.get(row.kind) ?? 'not-rendered';
    const named = context.usages
      .filter((item) => item !== row && item.kind === row.kind && id(item.reference) === id(row.reference))
      .reduce((best, item) => strongest(best, item.certainty), 'not-rendered');
    row.certainty = strongest(read, named);
    row.conditional = row.certainty === 'conditional';
    if (row.certainty === 'not-rendered')
      row.reason = 'No rendered source reads this page-record lookup, so the runtime does not render it.';
  }
}

// ---- Routes

/** The platform sign-in page renders the Login (or Sign In) site-marker page's copy in the site shell. */
function signInMarkerPage(portal, pages) {
  const marker = ['Login', 'Sign In']
    .map((name) => (portal.siteMarkers ?? []).find((item) => item.name === name))
    .find(Boolean);
  return marker ? (pages.find((item) => item.id === marker.pageId) ?? null) : null;
}

/** Language code, sign-in, modal form, web file, page and unmatched-route resolution for a raw request path. */
function resolveInspectionRoute(portal, rawRoute) {
  let url;
  try {
    url = requestTargetUrl(String(rawRoute || '/'), 'http://localhost/');
  } catch {
    url = new URL('http://localhost/');
  }
  if (url.pathname.includes('//')) url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  // The requested path is reported without its query, so query values never reach the report.
  const route = { requested: url.pathname };
  applyLanguageRoute(portal, url, route);
  const pathname = url.pathname;
  const key = normalizePortalPath(pathname);
  const pages = portal.pages ?? [];
  const signIn = authRoute(pathname, 'GET', { loginPath: loginPath(portal) });
  const exported = pages.find((page) => normalizePortalPath(page.url) === key);
  if (signIn?.kind === 'sign-out') return { ...route, kind: 'sign-out', path: key, page: null };
  if (signIn || (/^\/register\/?$/i.test(pathname) && !exported)) {
    return { ...route, kind: 'sign-in', path: key, page: signInMarkerPage(portal, pages), signInPage: true };
  }
  if (/^\/_portal\/modal-form-template-path(?:\/[^/]+)?\/?$/i.test(pathname))
    return {
      ...route,
      kind: 'modal-form',
      path: key,
      page: null,
      formId: url.searchParams.get('entityformid') ?? url.searchParams.get('entityform'),
    };
  const pageFirst = pathname.endsWith('/') && Boolean(exported);
  const webFile = pageFirst ? null : (portal.webFiles ?? []).find((file) => normalizePortalPath(file.url) === key);
  if (webFile) return { ...route, kind: 'web-file', path: key, page: null, webFile };
  if (exported && (pathname.endsWith('/') || key === '/')) return { ...route, kind: 'page', path: key, page: exported };
  if (key === '/' && servicePages(portal).home)
    return { ...route, kind: 'page', path: key, page: servicePages(portal).home };
  const marker = siteMarkerRoute(portal, url);
  if (marker) return { ...route, kind: 'page', path: key, page: marker.page, source: 'site-marker' };
  return unmatchedRoute(route, key, resolveUnmatchedRoute(portal, url, {}), pages, exported);
}

/** The route of a path no exported page, file or marker serves: a canonical or other redirect, not found or unmapped. */
function unmatchedRoute(route, key, unmatched, pages, exported) {
  if (unmatched.kind === 'redirect' && unmatched.source === 'canonical') {
    const page = pages.find((item) => item.id === unmatched.pageId) ?? exported;
    return {
      ...route,
      kind: 'page',
      path: key,
      page,
      redirect: { status: unmatched.status, location: unmatched.location, source: 'canonical' },
    };
  }
  if (unmatched.kind === 'redirect')
    return {
      ...route,
      kind: 'redirect',
      path: key,
      page: null,
      redirect: {
        status: unmatched.status,
        location: unmatched.location,
        source: unmatched.source,
        id: unmatched.id ?? null,
      },
    };
  if (unmatched.kind === 'render')
    return { ...route, kind: 'not-found', path: key, page: unmatched.page, status: unmatched.status };
  return { ...route, kind: 'unmapped', path: key, page: null, status: unmatched.status };
}

/** Moves `url` to the path inside its language prefix and records the language on `route`. */
function applyLanguageRoute(portal, url, route) {
  const language = languageRoute(portal, url, 'GET');
  if (!language) return;
  const pathname =
    language.kind === 'redirect'
      ? language.location.slice(0, language.location.length - url.search.length)
      : language.pathname;
  const record = (portal.websiteLanguages ?? []).find(
    (item) => String(item.code).toLowerCase() === String(language.code).toLowerCase(),
  );
  route.language = { code: language.code, id: record?.id ?? null, redirected: language.kind === 'redirect' };
  url.pathname = pathname || '/';
}

function routeSummary(route) {
  const summary = { kind: route.kind, requested: route.requested };
  if (route.language) summary.language = route.language;
  if (route.status) summary.status = route.status;
  if (route.redirect) summary.redirect = route.redirect;
  if (route.source) summary.source = route.source;
  if (route.page) summary.page = { id: route.page.id, name: route.page.name ?? null, url: route.page.url };
  if (route.webFile) summary.webFile = { id: route.webFile.id, name: route.webFile.name, url: route.webFile.url };
  if (route.formId !== undefined) summary.formId = route.formId ?? null;
  return summary;
}

// ---- Report

function describeFormResource(item, portal, solutionMetadata) {
  const relative = (file) => makeRelativeSource(portal, file);
  const schema = solutionMetadata.componentSchemas?.[item.id];
  const advanced = item.metadata?.kind === 'advancedform';
  const sourceSteps = advanced ? advancedFormSteps(portal, item) : [];
  const steps = unique(
    [
      ...sourceSteps.map((step) => ({
        id: step.id,
        name: step.name,
        entity: field(step, 'targetentitylogicalname', field(step, 'entityname')) ?? null,
        formName: field(step, 'formname') ?? null,
        mode: field(step, 'mode', null),
        sourceFile: sourceFile(step, 'custom_javascript.js') ?? step._file ?? null,
      })),
      ...(schema?.steps ?? []).map((step) => ({
        id: step.stepId,
        name: step.title ?? null,
        entity: step.entity ?? null,
        formName: step.formName ?? null,
        mode: step.mode ?? null,
        sourceFile: step.metadata?._file ?? null,
      })),
    ],
    (step) => id(step.id),
  );
  const source = item.metadata?._file ?? null;
  return {
    id: item.id,
    name: item.name,
    kind: advanced ? 'advanced-form' : 'basic-form',
    entity: item.entityName ?? steps.find((step) => step.entity)?.entity ?? null,
    formName: item.formName ?? schema?.formName ?? null,
    mode: item.mode ?? schema?.mode ?? null,
    steps: steps.map((step) => {
      const stepSchema = solutionMetadata.componentSchemas?.[step.id];
      return {
        ...step,
        formXml: stepSchema?.sourceFile
          ? { id: stepSchema.formId ?? null, name: stepSchema.formName ?? null, sourceFile: stepSchema.sourceFile }
          : null,
        relativePath: relative(step.sourceFile),
      };
    }),
    formXml:
      schema?.sourceFile && !advanced
        ? { id: schema.formId ?? null, name: schema.formName ?? null, sourceFile: schema.sourceFile }
        : null,
    sourceFile: source,
    relativePath: relative(source),
    recordId: item.id,
  };
}

function makeRelativeSource(portal, file) {
  return file && portal.sourceDir ? path.relative(portal.sourceDir, file) : null;
}

function applyResourceRelativePaths(descriptors, portal) {
  for (const descriptor of descriptors)
    if (descriptor.sourceFile && portal.sourceDir)
      descriptor.relativePath = path.relative(portal.sourceDir, descriptor.sourceFile);
}

function describeViewResource(item, portal) {
  return {
    id: item.id,
    name: item.name,
    entity: item.entity,
    sourceFile: item.file,
    relativePath: makeRelativeSource(portal, item.file),
    fields: item.fields ?? [],
  };
}

/** The page body the runtime renders (liquid.mjs renderPage): the page template's web template, a rewrite layout or the page copy. */
function walkPageBody(page, pageTemplate, context) {
  const root = { owner: 'page-layout', conditional: false, notRendered: false, builtin: false, depth: 0 };
  if (pageTemplate && pageTemplateKind(pageTemplate) === 'rewrite') {
    const layout = rewritePageLayout(page, pageTemplate);
    walkSource(
      layout?.source ?? "{% include 'Page Copy' %}",
      { ...root, owner: `page-template:${id(pageTemplate.id)}` },
      context,
    );
    return;
  }
  const template = pageTemplate?.webTemplateId ? lookup(context.templateRows, pageTemplate.webTemplateId) : null;
  if (template) {
    addWebTemplate(
      template,
      'page-template',
      null,
      { ...root, owner: `page-template:${id(pageTemplate.id)}` },
      context,
    );
    return;
  }
  if (pageTemplate?.webTemplateId)
    context.unresolved.push({
      kind: 'web-template',
      expression: pageTemplate.webTemplateId,
      via: 'page-template',
      owner: `page-template:${id(pageTemplate.id)}`,
      reason: 'No imported web template matches this static reference.',
    });
  else if (pageTemplate)
    context.unresolved.push({
      kind: 'web-template',
      expression: pageTemplate.name,
      via: 'page-template',
      reason: 'Page template has no resolved web-template ID.',
    });
  // Without a web template the runtime renders the page copy layout ({% include 'Page Copy' %}).
  walkSource("{% include 'Page Copy' %}", root, context);
}

function walkPageShell(pageTemplate, context) {
  const { portal } = context;
  if (pageTemplateKind(pageTemplate) !== 'rewrite' && pageTemplate?.useHeaderFooter === false) return;
  const root = { conditional: false, notRendered: false, builtin: false, depth: 0 };
  for (const [fieldName, via, owner] of [
    ['headerwebtemplateid', 'website header', 'website-header'],
    ['footerwebtemplateid', 'website footer', 'website-footer'],
  ]) {
    const value = field(portal.website, fieldName);
    if (!value) continue;
    const template = lookup(context.templateRows, value) ?? findWebTemplate(portal, value);
    if (template) addWebTemplate(template, via, null, { ...root, owner }, context);
    else
      context.unresolved.push({
        kind: 'web-template',
        expression: value,
        via,
        owner,
        reason: 'No imported web template matches this static reference.',
      });
  }
  for (const name of SHELL_SNIPPETS) {
    context.references.snippets.push(name);
    addSnippet(name, 'rendered page shell', null, { ...root, owner: 'page-shell', optional: true }, context);
  }
}

/** Resolve the static imported runtime graph for a portal route without rendering or writing. */
export function resolvePageResources(portal, route, options = {}) {
  return resolveRouteResources(portal, route, options).report;
}

/** Walks a page route: the page, its template, body, style, script, shell and lookups; returns the page template. */
function walkPageRoute(route, page, pageDescriptor, context) {
  const { portal, components, dependencies, unresolved } = context;
  components.push(pageDescriptor);
  dependencies.push(pageDescriptor);
  // The sign-in page renders the marker page's copy without its page template.
  const pageTemplate = route.signInPage ? null : lookup(portal.pageTemplates ?? [], page.pageTemplateId);
  if (!route.signInPage && page.pageTemplateId && !pageTemplate)
    unresolved.push({
      kind: 'page-template',
      expression: page.pageTemplateId,
      reason: 'The page template ID is absent from the imported portal.',
    });
  if (pageTemplate) {
    const descriptor = {
      ...recordDescriptor(pageTemplate.metadata, 'page-template', pageTemplate.name, 'pagetemplate'),
      id: pageTemplate.id,
      webTemplateId: pageTemplate.webTemplateId,
    };
    components.push(descriptor);
    dependencies.push(descriptor);
  }
  context.rewrite = pageTemplateKind(pageTemplate) === 'rewrite';
  walkPageBody(page, pageTemplate, context);
  const pageFrame = { owner: 'page', conditional: false, notRendered: false, builtin: false, depth: 0 };
  walkSource(page.css ?? '', pageFrame, context);
  walkSource(page.js ?? '', pageFrame, context);
  walkPageShell(pageTemplate, context);
  // Page copy that no rendered template outputs is still listed, as not rendered.
  if (!context.pageCopyRendered)
    walkSource(page.html ?? '', { ...pageFrame, notRendered: true, field: 'copy' }, context);
  if (!route.signInPage) addPageLookups(page, context);
  return pageTemplate;
}

/** Walks the route kinds that are not a page: the sign-in shell, a modal form, a web file, a redirect, an unmapped path. */
function walkOtherRoute(route, pageRoute, context) {
  const { portal, components, dependencies, unresolved } = context;
  if (pageRoute && route.kind === 'sign-in') {
    walkPageShell(null, context);
  } else if (route.kind === 'modal-form') {
    if (route.formId) context.references.forms.push({ kind: 'entityform', ref: route.formId });
    else
      unresolved.push({
        kind: 'form',
        expression: route.requested,
        reason: 'A modal form document needs an entityformid query parameter.',
      });
  } else if (route.kind === 'web-file') {
    const file = route.webFile;
    const descriptor = {
      ...recordDescriptor(file.metadata, 'web-file', file.name, 'filecontent'),
      id: file.id,
      url: file.url,
      sourceFile: file.file ?? file.metadata?._file ?? null,
      file: file.file ?? file.metadata?._file ?? null,
    };
    components.push(descriptor);
    dependencies.push(descriptor);
  } else if (route.kind === 'redirect') {
    const redirect = (portal.redirects ?? []).find((item) => id(item.id) === id(route.redirect.id));
    if (redirect) {
      const descriptor = {
        kind: 'redirect',
        name: String(redirect.name ?? redirect.inboundUrl ?? ''),
        sourceFile: redirect.file ?? null,
        file: redirect.file ?? null,
        relativePath: redirect.file ? path.basename(redirect.file) : null,
        recordId: redirect.id,
        fieldPath: 'inboundurl',
        location: route.redirect.location,
        statusCode: route.redirect.status,
      };
      components.push(descriptor);
      dependencies.push(descriptor);
    }
  } else if (route.kind === 'unmapped')
    unresolved.push({ kind: 'page', expression: route.path, reason: 'No imported page matches this route.' });
}

/** Resolves the forms and lists the walked sources name, including those their own JavaScript names, until none is new. */
function resolveQueuedReferences(context) {
  for (let formIndex = 0, listIndex = 0; ;) {
    if (formIndex < context.references.forms.length)
      resolveFormReference(context.references.forms[formIndex++], context);
    else if (listIndex < context.references.lists.length)
      resolveListReference(context.references.lists[listIndex++], context);
    else break;
  }
}

/** The report entry of the page's template, with its source path relative to the source directory. */
function describePageTemplate(pageTemplate, portal) {
  if (!pageTemplate) return null;
  const described = {
    ...recordDescriptor(pageTemplate.metadata, 'page-template', pageTemplate.name, 'pagetemplate'),
    id: pageTemplate.id,
    webTemplateId: pageTemplate.webTemplateId,
    useHeaderFooter: pageTemplate.useHeaderFooter !== false,
  };
  if (described.sourceFile && portal.sourceDir)
    described.relativePath = path.relative(portal.sourceDir, described.sourceFile);
  return described;
}

function resolveRouteResources(portal, rawRoute, { solutionMetadata = {}, languageId: requestLanguageId } = {}) {
  const route = resolveInspectionRoute(portal, rawRoute);
  const languageId = route.language?.id ?? requestLanguageId ?? null;
  const page = localizedPortalPage(route.page ?? null, languageId);
  const pageRoute = ['page', 'not-found', 'sign-in'].includes(route.kind);
  const dependencies = [],
    unresolved = [],
    webTemplates = [],
    builtinTemplates = [],
    snippets = [],
    siteSettings = [],
    forms = [],
    views = [],
    tables = [],
    columns = [],
    components = [],
    usages = [],
    webLinkSets = [],
    siteMarkers = [],
    optionalAbsent = [];
  const siteLanguageId = languageId ?? portal.selectedLanguageId ?? id(field(portal.website ?? {}, 'defaultlanguage'));
  const context = {
    portal,
    page,
    solutionMetadata,
    dependencies,
    unresolved,
    webTemplates,
    builtinTemplates,
    snippets,
    views,
    forms,
    components,
    columns,
    usages,
    webLinkSets,
    siteMarkers,
    optionalAbsent,
    siteSettings,
    languageId,
    siteLanguageId: siteLanguageId || null,
    templateRows: unique(
      Object.values(portal.templates ?? {}).filter((item) => item && typeof item === 'object'),
      (item) => id(item.id),
    ),
    snippetRecords: effectiveSnippetRecords(
      portal.records ?? [],
      siteLanguageId,
      field(portal.website ?? {}, 'defaultlanguage'),
    ),
    references: { snippets: [], settings: [], forms: [], lists: [], views: [], tables: new Map() },
    seen: new Map(),
    formTags: [],
    pageLookupRows: [],
    pageLookupsUsed: new Map(),
    pageCopyRendered: false,
    rewrite: false,
  };
  const entityNames = new Set();
  context.entityNames = entityNames;
  const pageRecord = page?.metadata;
  const pageDescriptor = page
    ? {
        ...recordDescriptor(pageRecord, 'page', page.title || page.name, 'copy'),
        id: page.id,
        url: page.url,
        sourceFile: sourceFile(pageRecord, 'copy.html') ?? pageRecord?._file ?? null,
        file: sourceFile(pageRecord, 'copy.html') ?? pageRecord?._file ?? null,
      }
    : null;
  let pageTemplate = null;
  if (pageRoute && page) pageTemplate = walkPageRoute(route, page, pageDescriptor, context);
  else walkOtherRoute(route, pageRoute, context);

  settleFormTags(context);
  settlePageLookups(context);
  // Form and list JavaScript can name further forms and lists; resolve until no new reference appears.
  resolveQueuedReferences(context);
  for (const entity of context.references.tables.keys()) entityNames.add(entity);
  for (const entry of unique(context.references.views, (item) => `${item.entity ?? ''}/${item.ref}`))
    resolveViewReference(entry, context);
  appendTableColumns(context.references, columns, entityNames, solutionMetadata);
  addTableDescriptors(entityNames, solutionMetadata, tables, columns, unresolved, dependencies);
  resolveSettingReferences(context.references.settings, new Set(entityNames), portal, context);
  const allColumns = unique(columns, (item) => `${item.entity}/${item.name}`);
  applyResourceRelativePaths(
    [...dependencies, ...forms, ...views, ...columns, ...tables, ...(pageDescriptor ? [pageDescriptor] : [])],
    portal,
  );
  const resolvedPageTemplate = describePageTemplate(pageTemplate, portal);
  const report = {
    path: route.path,
    route: routeSummary(route),
    sourceRoots: [...new Set([portal.sourceDir, ...(solutionMetadata.roots ?? [])].filter(Boolean))],
    page: pageRoute && page ? pageDescriptor : null,
    pageTemplate: resolvedPageTemplate,
    webTemplates,
    builtinTemplates,
    snippets,
    siteSettings,
    forms: unique(forms, (item) => id(item.id)).map((item) => describeFormResource(item, portal, solutionMetadata)),
    views: unique(views, (item) => id(item.id)).map((item) => describeViewResource(item, portal)),
    tables,
    columns: allColumns,
    components,
    webLinkSets,
    siteMarkers,
    usages: strongestRows(usages, (item) => `${item.owner}/${item.kind}/${item.expression}`),
    dependencies: unique(dependencies, (item) => `${item.kind}/${item.recordId ?? item.sourceFile}/${item.fieldPath}`),
    unresolved: strongestRows(unresolved, ({ certainty: _certainty, ...rest }) => JSON.stringify(rest)), // NOSONAR: binding is excluded from the key
    optionalAbsent: unique(optionalAbsent, (item) => `${item.kind}/${item.name}`),
  };
  return { report, page: pageRoute ? page : null, route };
}

/** First row per key, upgraded to the strongest certainty any duplicate carries. */
function strongestRows(rows, key) {
  const byKey = new Map();
  for (const row of rows) {
    const value = key(row);
    const existing = byKey.get(value);
    if (!existing || CERTAINTY_RANK[row.certainty ?? 'declared'] > CERTAINTY_RANK[existing.certainty ?? 'declared'])
      byKey.set(value, row);
  }
  return [...byKey.values()];
}

const displayNameCache = new Map();
/** Entity display name from its Solution XML: entity-level LocalizedNames, else the Name label. */
function tableDisplayName(files = []) {
  let name = null;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = displayNameCache.get(file);
    let value = cached?.stamp === stamp ? cached.value : undefined;
    if (value === undefined) {
      try {
        const xml = fs.readFileSync(file, 'utf8');
        const block = /<LocalizedNames>([\s\S]*?)<\/LocalizedNames>/.exec(xml)?.[1] ?? '';
        value =
          /<LocalizedName\b[^>]*\bdescription="([^"]*)"[^>]*\blanguagecode="1033"/i.exec(block)?.[1] ??
          /<LocalizedName\b[^>]*\bdescription="([^"]*)"/i.exec(block)?.[1] ??
          /<Name\b[^>]*\bLocalizedName="([^"]*)"/.exec(xml.slice(0, 4096))?.[1] ??
          null;
      } catch {
        value = null;
      }
      displayNameCache.set(file, { stamp: recordedStamp(stat, stamp), value });
    }
    if (value) name = value;
  }
  return name;
}

const rightLabel = (right) => ({ 1: 'Grant change', 2: 'Restrict read' })[right] ?? 'Unresolved right';
const scopeLabel = (scope) => ({ 1: 'All content', 2: 'Exclude direct child web files' })[scope] ?? 'Unresolved scope';
const truth = (value) => value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
const preview = (value, limit = 280) => {
  if (value == null) return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

function ancestorPages(portal, page) {
  const chain = [];
  const seen = new Set();
  let current = page;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = current.parentId;
    current = (portal.pages ?? []).find((candidate) => candidate.id === parentId);
  }
  return chain;
}

/** Page access rules on the page branch with role names and the current persona's match. */
export function pageAccessRules(portal, page, identity = {}, overrides = {}) {
  const ancestors = ancestorPages(portal, page);
  const roles = new Map(
    (portal.records ?? [])
      .filter((record) => record.kind === 'webrole' && Number(field(record, 'statecode', 0)) !== 1)
      .map((record) => [id(record.id), record.name]),
  );
  const matchesRoles = pageRuleMatcher(portal, identity);
  return (portal.records ?? [])
    .filter((record) => record.kind === 'webpageaccesscontrolrule' && Number(field(record, 'statecode', 0)) !== 1)
    .map((record) => {
      const root = id(field(record, 'webpageid'));
      const owner = ancestors.find((candidate) => id(candidate.id) === root);
      if (!owner) return null;
      const associated = field(record, 'webpageaccesscontrolrule_webrole', []);
      const roleIds = asArray(associated)
        .map((value) =>
          id(typeof value === 'object' ? (value.id ?? value.adx_webroleid ?? value.mspp_webroleid) : value),
        )
        .filter(Boolean);
      const right = Number(field(record, 'right'));
      const scope = Number(field(record, 'scope', 1));
      return {
        id: record.id,
        name: record.name || record.id,
        right,
        rightLabel: rightLabel(right),
        scope,
        scopeLabel: scopeLabel(scope),
        roles: roleIds.map((roleId) => ({ id: roleId, name: roles.get(roleId) ?? null, resolved: roles.has(roleId) })),
        page: { id: owner.id, name: owner.name, url: owner.url },
        inherited: id(owner.id) !== id(page.id),
        matches: matchesRoles(roleIds),
        overridden: Object.hasOwn(overrides.accessRules ?? {}, record.id),
        sourceFile: record._file ?? null,
      };
    })
    .filter(Boolean);
}

/** Records that point at a page: web links, site markers, redirects and shortcuts. */
function relatedMetadata(portal, page) {
  const pageId = id(page.id);
  const records = portal.records ?? [];
  const active = (record) => Number(field(record, 'statecode', 0)) !== 1;
  const sets = new Map(
    records.filter((record) => record.kind === 'weblinkset').map((record) => [id(record.id), record]),
  );
  const weblinks = records
    .filter((record) => record.kind === 'weblink' && active(record) && id(field(record, 'pageid')) === pageId)
    .map((record) => {
      const set = sets.get(id(field(record, 'weblinksetid')));
      return {
        id: record.id,
        name: record.name,
        set: set?.name ?? null,
        setId: set?.id ?? null,
        displayOrder: Number(field(record, 'displayorder', 0)),
        sourceFile: record._file ?? null,
      };
    })
    .sort((a, b) => String(a.set).localeCompare(String(b.set)) || a.displayOrder - b.displayOrder);
  const sitemarkers = records
    .filter((record) => record.kind === 'sitemarker' && active(record) && id(field(record, 'pageid')) === pageId)
    .map((record) => ({ id: record.id, name: record.name, sourceFile: record._file ?? null }));
  const pagePath = normalizePortalPath(page.url);
  const redirects = [
    ...records.filter(
      (record) =>
        record.kind === 'redirect' &&
        active(record) &&
        (id(field(record, 'webpageid')) === pageId ||
          (field(record, 'redirecturl') && normalizePortalPath(String(field(record, 'redirecturl'))) === pagePath)),
    ),
    ...(Array.isArray(portal.redirects)
      ? portal.redirects.filter(
          (item) =>
            id(item.pageId ?? item.webPageId) === pageId ||
            (item.redirectUrl && normalizePortalPath(item.redirectUrl) === pagePath),
        )
      : []),
  ].map((item) => ({
    id: item.id,
    name: item.name ?? null,
    inboundUrl: item.inboundUrl ?? field(item, 'inboundurl'),
    statusCode: Number(item.statusCode ?? field(item, 'statuscode', 302)) || null,
    sourceFile: item._file ?? item.file ?? item.sourceFile ?? null,
  }));
  const shortcuts = (portal.shortcuts ?? [])
    .filter((shortcut) => id(shortcut.targetPageId) === pageId)
    .map((shortcut) => ({
      id: shortcut.id,
      name: shortcut.name,
      title: shortcut.title,
      sourceFile: shortcut.metadata?._file ?? null,
    }));
  return { weblinks, sitemarkers, redirects: unique(redirects, (item) => id(item.id)), shortcuts };
}

/** Ordered include chain from page-template, header/footer, shell and page-copy roots. */
function templateChain(report) {
  const rows = [];
  const byOwner = (items, key) => {
    const map = new Map();
    for (const item of items)
      for (const owner of item[key] ?? []) {
        if (!map.has(owner)) map.set(owner, []);
        map.get(owner).push(item);
      }
    return map;
  };
  const templatesByOwner = byOwner(
    [...report.webTemplates, ...(report.builtinTemplates ?? []).map((item) => ({ ...item, builtin: true }))],
    'includedBy',
  );
  const snippetsByOwner = byOwner(report.snippets, 'usedBy');
  const visited = new Set();
  const descend = (owner, depth) => {
    for (const template of templatesByOwner.get(owner) ?? []) {
      const key = template.builtin ? `builtin-template:${template.name}` : `web-template:${id(template.id)}`;
      const repeated = visited.has(key);
      rows.push(
        template.builtin
          ? { depth, kind: 'builtin-template', name: template.name, origin: template.origin, repeated }
          : {
              depth,
              kind: 'web-template',
              name: template.name,
              id: template.id,
              via: template.via,
              sourceFile: template.sourceFile,
              relativePath: template.relativePath,
              fieldPath: template.fieldPath ?? null,
              repeated,
            },
      );
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
    for (const snippet of snippetsByOwner.get(owner) ?? []) {
      const key = `content-snippet:${snippet.name}`;
      const repeated = visited.has(key);
      rows.push({
        depth,
        kind: 'content-snippet',
        name: snippet.name,
        sourceFile: snippet.sourceFile,
        relativePath: snippet.relativePath,
        fieldPath: snippet.fieldPath ?? null,
        repeated,
      });
      if (repeated) continue;
      visited.add(key);
      descend(key, depth + 1);
    }
  };
  if (report.pageTemplate) {
    rows.push({
      depth: 0,
      kind: 'page-template',
      name: report.pageTemplate.name,
      id: report.pageTemplate.id,
      sourceFile: report.pageTemplate.sourceFile,
      relativePath: report.pageTemplate.relativePath,
    });
    descend(`page-template:${id(report.pageTemplate.id)}`, 1);
  }
  for (const [owner, label] of [
    ['website-header', 'Website header'],
    ['website-footer', 'Website footer'],
    ['page-shell', 'Rendered page shell'],
    ['page-layout', 'Page copy layout'],
    ['page', 'Page copy, JavaScript and CSS'],
  ]) {
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({ depth: 0, kind: 'root', name: label, owner });
    descend(owner, 1);
  }
  for (const component of report.components.filter((item) =>
    ['basic-form', 'advanced-form', 'advanced-form-step', 'list'].includes(item.kind),
  )) {
    const owner = `${component.kind}:${id(component.recordId)}`;
    if (!templatesByOwner.has(owner) && !snippetsByOwner.has(owner)) continue;
    rows.push({
      depth: 0,
      kind: 'root',
      name: `${component.name} (${component.kind.replaceAll('-', ' ')} JavaScript)`,
      owner,
      sourceFile: component.sourceFile,
      relativePath: component.relativePath,
    });
    descend(owner, 1);
  }
  return rows;
}

function applyTableInspection(report, solutionMetadata, mapping, tablePermissions) {
  for (const table of report.tables) {
    const metadata = solutionMetadata.entities?.[table.logicalName];
    const mapped = mapping(table.logicalName);
    table.displayName = tableDisplayName(metadata?.sources ?? []);
    table.entitySet = mapped?.entitySet ?? null;
    table.entitySetInferred = mapped ? Boolean(mapped.entitySetInferred) : null;
    table.idColumn = mapped?.idColumn ?? null;
    table.nameColumn = mapped?.nameColumn ?? null;
    table.mapped = Boolean(mapped);
    table.fieldCount = Object.keys(metadata?.fields ?? {}).length;
    table.permissions = tablePermissions(table.logicalName);
  }
}

function applyColumnInspection(report, solutionMetadata) {
  for (const column of report.columns) {
    const metadata = solutionMetadata.entities?.[column.entity]?.fields?.[column.name];
    if (!metadata) {
      column.resolved = false;
      continue;
    }
    Object.assign(column, {
      resolved: true,
      label: metadata.label ?? null,
      type: metadata.dataverseType ?? metadata.type ?? null,
      required: Boolean(metadata.required),
      maxLength: metadata.maxLength ?? null,
      optionSetName: metadata.optionSetName ?? null,
      optionCount: Array.isArray(metadata.options) ? metadata.options.length : 0,
      options: Array.isArray(metadata.options)
        ? metadata.options.slice(0, 12).map((option) => ({ value: option.value, label: option.label }))
        : [],
    });
  }
}

function localizedSnippet(portal, name, languageId) {
  const translations = languageId ? portal.snippetTranslations?.[languageId] : null;
  if (Object.hasOwn(translations ?? {}, name)) return translations[name];
  return Object.hasOwn(portal.snippets ?? {}, name) ? portal.snippets[name] : undefined;
}

function applySnippetInspection(report, portal, sourcePortal, overrides, languageId) {
  for (const snippet of report.snippets) {
    const name = snippet.name;
    const value = localizedSnippet(portal, name, languageId);
    snippet.value = preview(value);
    snippet.sourceValue = preview(localizedSnippet(sourcePortal, name, languageId));
    snippet.overridden = Object.hasOwn(overrides.snippets ?? {}, name);
    snippet.deleted = value === undefined;
  }
}

function applySettingInspection(report, portal, sourcePortal, overrides) {
  // A setting bound to a Secret environment variable is classified by name: inspection never prints the bound value.
  const secretNames = new Set(portal.secretSettingNames ?? []);
  for (const setting of report.siteSettings) {
    const name = setting.name;
    const secret = secretNames.has(name);
    setting.value = secret ? '[secret]' : preview(portal.settings?.[name], 400);
    setting.sourceValue = secret ? '[secret]' : preview(sourcePortal.settings?.[name], 400);
    if (secret) setting.secret = true;
    setting.overridden = Object.hasOwn(overrides.settings ?? {}, name);
    setting.deleted = !Object.hasOwn(portal.settings ?? {}, name);
  }
}

/** The response a persona the page denies receives (the sign-in redirect or the Access Denied page), as reported. */
function deniedOutcome(portal, resolvedRoute, identity, denial) {
  const outcome = deniedPageRoute(
    portal,
    new URL(`http://localhost${resolvedRoute.requested}`),
    identity ?? {},
    denial,
  );
  return {
    kind: outcome.kind,
    status: outcome.status,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.source ? { source: outcome.source } : {}),
    ...(outcome.page ? { page: { id: outcome.page.id, name: outcome.page.name ?? null, url: outcome.page.url } } : {}),
  };
}

/** The publishing state a page names (null when it names none) and whether the export contains it. */
function publishingStateSummary(portal, page) {
  const publishingStateId = id(field(page.metadata, 'publishingstateid'));
  if (!publishingStateId) return null;
  const publishingState = (portal.records ?? []).find(
    (record) => record.kind === 'publishingstate' && id(record.id) === publishingStateId,
  );
  return {
    id: publishingStateId,
    name: publishingState?.name ?? null,
    visible: publishingState ? truth(field(publishingState, 'isvisible', true)) : null,
    resolved: Boolean(publishingState),
  };
}

/** The persona's access result to the page as reported; empty when access was not evaluated. */
function accessSummary(accessResult) {
  if (!accessResult) return {};
  return {
    allowed: accessResult.allowed,
    status: accessResult.status,
    code: accessResult.code ?? null,
    reason: accessResult.reason ?? null,
    ruleIds: accessResult.ruleIds ?? [],
    diagnostics: accessResult.diagnostics ?? [],
  };
}

/**
 * Inspect a route for development tools: the static dependency graph plus the current
 * persona's runtime view (page access, table permissions), effective local values and
 * metadata that points at the page. Reads local files only; renders and writes nothing.
 */
export function inspectPage(
  portal,
  route,
  {
    solutionMetadata = {},
    languageId,
    sourcePortal = portal,
    overrides = {},
    identity = null,
    access = null,
    mapping = () => null,
    tablePermissions = () => null,
  } = {},
) {
  const { report, page, route: resolvedRoute } = resolveRouteResources(portal, route, { solutionMetadata, languageId });
  if (!page)
    return {
      ...report,
      templateChain: templateChain(report),
      related: { weblinks: [], sitemarkers: [], redirects: [], shortcuts: [] },
    };
  const parent = (portal.pages ?? []).find((candidate) => candidate.id === page.parentId);
  const accessResult = access ? access(page) : null;
  // A page the persona may not read is answered with the sign-in redirect or the Access Denied page;
  // the Profile site-marker page requires a signed-in visitor (as mirage/server.mjs routes it).
  const profile = servicePages(portal).profile;
  const signInRequired = accessResult?.allowed && profile && id(profile.id) === id(page.id) && !identity?.contactId;
  if ((accessResult && !accessResult.allowed) || signInRequired) {
    report.route.outcome = deniedOutcome(
      portal,
      resolvedRoute,
      identity,
      signInRequired ? { code: 'PROFILE_SIGN_IN_REQUIRED' } : accessResult,
    );
  }
  report.page = {
    ...report.page,
    title: page.title ?? null,
    pageName: page.name ?? null,
    parent: parent ? { id: parent.id, name: parent.name, url: parent.url } : null,
    pageTemplateName: report.pageTemplate?.name ?? null,
    publishingState: publishingStateSummary(portal, page),
    access: {
      ...accessSummary(accessResult),
      rules: pageAccessRules(portal, page, identity ?? {}, overrides),
    },
  };
  applyTableInspection(report, solutionMetadata, mapping, tablePermissions);
  applyColumnInspection(report, solutionMetadata);
  applySnippetInspection(report, portal, sourcePortal, overrides, resolvedRoute.language?.id ?? languageId);
  applySettingInspection(report, portal, sourcePortal, overrides);
  return { ...report, templateChain: templateChain(report), related: relatedMetadata(portal, page) };
}
