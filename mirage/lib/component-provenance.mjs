// Render provenance of platform component markup (forms, lists, code components and other component tags).
//
// A platform renderer reports what it rendered (lib/platform.mjs onComponentRendered: the basic or advanced form,
// its step, the tabs, sections and cells in the order it wrote them; the list, its views and action settings) and,
// for single elements it knows exactly, their offsets (code component host and scripts, progress steps). This module
// parses the component's own markup once and gives every element start tag one `platform` interval naming the
// configuration that produced it (lib/render-provenance.mjs bindPlatformNode). The markup itself is never changed.
import { parseFragment } from 'parse5';
import { PCF_HOST_SCRIPT } from './code-components.mjs';
import { applyElementRenderEdits } from './render-provenance.mjs';

const norm = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .trim()
    .toLowerCase();
// Attributes recorded with a binding: identifying ones only, never state the host moves (data-pp-viewstate).
const IDENTITY_ATTRIBUTES = new Set([
  'id',
  'name',
  'type',
  'for',
  'data-name',
  'data-logical-name',
  'data-pcf-schema',
  'data-selected-view',
  'data-controlid',
]);
const attribute = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const classList = (node) =>
  new Set(
    String(attribute(node, 'class') ?? '')
      .split(/\s+/)
      .filter(Boolean),
  );
const elements = (node) => (node.childNodes ?? []).filter((child) => child.tagName);
const textOf = (node) =>
  (node.childNodes ?? []).map((child) => (child.nodeName === '#text' ? child.value : '')).join('');

// The list action types by their settings Type (lib/native-services.mjs ACTION_TYPES).
const ACTION_NAMES = {
  'CrmEntityFormView-DetailsAction': 'details',
  'CrmEntityFormView-EditAction': 'edit',
  'CrmEntityFormView-CreateAction': 'create',
  'CrmEntityFormView-DeleteAction': 'delete',
  'CrmEntityFormView-AssociateAction': 'associate',
  'CrmEntityFormView-DisassociateAction': 'disassociate',
  'CrmEntityFormView-WorkflowAction': 'workflow',
  'CrmEntityFormView-DownloadAction': 'download',
  DeactivateAction: 'deactivate',
  ActivateAction: 'activate',
  'CrmEntityFormView-CreateRelatedRecordAction': 'create-related',
};
const MODAL_CLASS_WORDS = new Set([
  'form',
  'fade',
  'dialog',
  'content',
  'header',
  'body',
  'footer',
  'title',
  'lg',
  'sm',
]);
/** The action a native dialog serves, from its classes (modal-form-insert, modal-delete, modal-run-workflow, …). */
function modalAction(classes) {
  for (const name of classes) {
    const form = /^modal-form-(.+)$/.exec(name);
    if (form) return form[1] === 'insert' ? 'create' : form[1];
  }
  for (const name of classes) {
    const match = /^modal-(.+)$/.exec(name);
    if (match && !MODAL_CLASS_WORDS.has(match[1])) return match[1] === 'run-workflow' ? 'workflow' : match[1];
  }
  return 'dialog';
}

function settingsObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
/** The basic form ids the configured actions open, by action name. */
function actionForms(settings) {
  const forms = new Map();
  const parsed = settingsObject(settings);
  for (const action of [...(parsed.ViewActions ?? []), ...(parsed.ItemActions ?? [])]) {
    const name = ACTION_NAMES[action?.Type];
    const target = action?.TargetType == null || action.TargetType === '' ? 0 : Number(action.TargetType);
    if (name && target === 0 && action.EntityFormId) forms.set(name, norm(action.EntityFormId));
  }
  return forms;
}

function sourceResolver(index) {
  const keys = new Map();
  const usable = (id) => Boolean(id) && Boolean(index?.sources?.has(id));
  return {
    key(key) {
      if (!key) return [];
      if (!keys.has(key))
        keys.set(
          key,
          (index?.metadataIndex?.sourceRefsFor?.([key]) ?? []).map((ref) => ref.id).filter((id) => usable(id)),
        );
      return keys.get(key);
    },
    record(id, field = '$record') {
      if (!id) return [];
      const source = index?.source?.({ id }, field);
      return source && !source.ambiguous ? [source.id] : [];
    },
    field(record, field) {
      const source = record && index?.source?.(record, field);
      return source && !source.ambiguous ? source : null;
    },
    // The FormXml placements of a form (portal-source-index.mjs formSources): its controls, tabs and sections.
    form(formId) {
      return (formId && index?.formSources?.(formId)) || null;
    },
  };
}

/** The source id of a FormXml placement (control, tab or section) by its component key, when located. */
const placementRef = (placements, key) => {
  const id = key && placements?.refs.get(key);
  return id ? [id] : [];
};

/**
 * The FormXml control a rendered cell is: the body control with the cell's control id, else the one bound to its
 * column. Several controls with one id (an invalid FormXml) are taken in document order.
 */
function cellControl(placements, cell, used) {
  if (!placements) return null;
  const body = placements.controls.filter((control) => (control.region ?? 'body') === 'body');
  let candidates = cell.id ? body.filter((control) => norm(control.id) === norm(cell.id)) : [];
  if (!candidates.length && cell.field) candidates = body.filter((control) => norm(control.name) === norm(cell.field));
  const next = candidates.find((control) => !used.has(control.key));
  if (next) used.add(next.key);
  return next ?? null;
}

/** The FormXml tab or section a rendered layout item is, by its name within the form (sections within their tab). */
function layoutPlacement(placements, kind, item, tab, ordinal) {
  if (!placements) return null;
  const items = placements.structure.filter(
    (entry) => entry.kind === kind && (kind === 'tab' || norm(entry.tab) === norm(tab)),
  );
  const named = item?.name ? items.filter((entry) => norm(entry.name) === norm(item.name)) : [];
  if (named.length === 1) return named[0];
  return item?.name ? null : (items[ordinal] ?? null);
}

const unique = (values) => [...new Set(values.filter(Boolean))];
const binding = (component, sourceRefIds = [], contextSourceRefId = null) => ({
  component,
  sourceRefIds: unique(sourceRefIds),
  ...(contextSourceRefId ? { contextSourceRefId } : {}),
});
// A part of a component: `<key>#<part>`, a part of a part `<key>#<part>:<part>`.
const withPart = (owner, part, extra = {}, refs = []) =>
  binding(
    {
      ...owner.component,
      key: owner.component.key.includes('#') ? `${owner.component.key}:${part}` : `${owner.component.key}#${part}`,
      name: owner.component.part ? `${owner.component.part}:${part}` : part,
      part: owner.component.part ? `${owner.component.part}:${part}` : part,
      ...extra,
    },
    [...owner.sourceRefIds, ...refs],
    owner.contextSourceRefId,
  );

// ---- Forms
function formOwners(form, refs) {
  const record = refs.record(form.id)[0] ?? null;
  const formRefs = form.formId ? refs.key('form:' + form.formId) : [];
  const placements = refs.form(form.formId);
  const shared = { formId: form.formId ?? undefined, entity: form.entity ?? undefined };
  if (form.reference) {
    // A reference (read-only) form view is the systemform the step names, not a basic form record.
    const owner = binding(
      { kind: 'form', key: `form:${form.formId ?? form.ids.view}`, name: form.name, ...shared },
      formRefs,
    );
    return { form: owner, step: owner, record: null, formRefs, placements };
  }
  const formOwner = binding(
    { kind: form.type, key: `${form.type}:${form.id}`, id: form.id, name: form.name, ...shared },
    record ? [record] : [],
  );
  if (form.type !== 'advanced-form' || !form.stepId)
    return { form: formOwner, step: formOwner, record, formRefs, placements };
  const stepRecord = refs.record(form.stepId)[0] ?? null;
  const step = binding(
    {
      kind: 'advanced-form-step',
      key: `advanced-form-step:${form.stepId}`,
      id: form.stepId,
      name: form.stepName ?? undefined,
      ...shared,
    },
    [stepRecord, record],
  );
  return { form: formOwner, step, record: stepRecord ?? record, formRefs, placements };
}

function metadataRow(form, predicate) {
  return (form.metadataRows ?? []).find(predicate) ?? null;
}

// A cell's sources, most specific first: the FormXml control (its own ref, with the control's region in the FormXml),
// then what the cell renders (column, view, quick view form), the FormXml, and the form metadata row that configures it.
function cellBinding(form, owners, cell, refs, control = []) {
  const context = owners.record;
  const common = { formId: form.formId ?? undefined, controlName: cell.id ?? undefined };
  const formRefs = owners.formRefs;
  if (cell.field) {
    const row = metadataRow(form, (item) => item.type === 100000000 && norm(item.attribute) === norm(cell.field));
    return binding(
      {
        kind: 'field',
        key: `column:${norm(form.entity)}:${norm(cell.field)}`,
        entity: form.entity,
        field: cell.field,
        name: cell.field,
        ...common,
      },
      [
        ...control,
        ...refs.key(`column:${norm(form.entity)}:${norm(cell.field)}`),
        ...formRefs,
        ...refs.record(row?.id),
      ],
      context,
    );
  }
  if (cell.type === 'subgrid' && cell.viewId) {
    const row = metadataRow(form, (item) => item.type === 100000003 && item.subgrid === cell.id);
    return binding(
      { kind: 'subgrid', key: `view:${norm(cell.viewId)}`, viewId: norm(cell.viewId), entity: cell.entity, ...common },
      [...control, ...refs.key('view:' + norm(cell.viewId)), ...formRefs, ...refs.record(row?.id)],
      context,
    );
  }
  if (cell.type === 'notes') {
    const row = metadataRow(form, (item) => item.type === 100000005);
    return withPart(owners.step, 'notes', common, [...control, ...formRefs, ...refs.record(row?.id)]);
  }
  if (cell.type === 'quickform' && cell.quickFormId) return quickViewBinding(form, cell, refs, control, context);
  if (cell.id && form.formId)
    return binding(
      { kind: 'form-control', key: `form:${form.formId}:control:${cell.id}`, ...common },
      [...control, ...formRefs],
      context,
    );
  return null;
}

/** A quick view: the quick view form, hosted by a control of the host form (its FormXml control first). */
function quickViewBinding(host, cell, refs, control, context) {
  return binding(
    {
      kind: 'quick-view',
      key: `form:${norm(cell.quickFormId)}`,
      formId: norm(cell.quickFormId),
      hostFormId: host.formId ?? undefined,
      controlName: cell.id ?? undefined,
      field: cell.lookup ?? undefined,
      entity: host.entity,
    },
    [
      ...control,
      ...refs.key('form:' + norm(cell.quickFormId)),
      ...(host.formId ? refs.key('form:' + host.formId) : []),
    ],
    context,
  );
}

function layoutBinding(form, owners, kind, item, refs, placement = null) {
  if (!item) return null;
  const name = item.name ?? '';
  const key = form.formId ? `form:${form.formId}:${kind}:${name}` : `${owners.step.component.key}#${kind}:${name}`;
  return binding(
    { kind: `form-${kind}`, key, name: item.label || name, formId: form.formId ?? undefined },
    [...placementRef(owners.placements, placement?.key), ...owners.formRefs, ...refs.record(item.metadataId)],
    owners.record,
  );
}

// ---- Lists
function listOwner(list, refs) {
  return binding(
    { kind: 'list', key: `list:${list.id}`, id: list.id, name: list.name, entity: list.entity },
    refs.record(list.id),
  );
}
function viewBinding(viewId, owner, extra, refs) {
  const id = norm(viewId);
  return binding(
    { kind: 'list-view', key: `view:${id}`, viewId: id, entity: owner.component.entity, ...extra },
    [...refs.key('view:' + id), ...owner.sourceRefIds],
    owner.sourceRefIds[0],
  );
}
/**
 * Redacts every query/fragment value (`?a=1&b=2#c=3` becomes `?a=…&b=…#c=…`) in one linear pass. A candidate that
 * reaches `&`, `#` or the end before `=` fails every start inside the same run, so the scan resumes at that stop.
 */
function redactQueryValues(text) {
  let out = '';
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    if (!'?&#'.includes(text[at])) {
      at++;
      continue;
    }
    let stop = at + 1;
    while (stop < text.length && !'=&#'.includes(text[stop])) stop++;
    if (text[stop] !== '=') {
      at = stop;
      continue;
    }
    let end = stop + 1;
    while (end < text.length && !'&#'.includes(text[end])) end++;
    out += text.slice(copied, stop + 1) + '…';
    copied = end;
    at = end;
  }
  return out + text.slice(copied);
}
// The attribute flags a modern list's parts carry, in the order they are matched.
const LIST_FLAG_PARTS = [
  ['data-pp-modern-list-view', 'view-selector'],
  ['data-pp-modern-list-search', 'search'],
  ['data-pp-modern-list-actions', 'actions'],
  ['data-pp-modern-list-more', 'pagination'],
  ['data-pp-modern-list-dialog', 'action:form'],
];
const LIST_MESSAGES = [
  ['view-empty-maker', 'empty-maker'],
  ['view-empty', 'empty'],
  ['view-access-denied', 'access-denied'],
  ['view-error', 'error'],
  ['view-loading', 'loading'],
  ['view-pagination', 'pagination'],
];

/** The view a grid shows: its selected view, else the first of its layouts. */
function gridView(node) {
  const selected = attribute(node, 'data-selected-view');
  if (selected) return selected;
  try {
    return (
      JSON.parse(Buffer.from(attribute(node, 'data-view-layouts') ?? '', 'base64').toString('utf8'))?.[0]?.Id ?? null
    );
  } catch {
    return null;
  }
}
function descendantGridView(node) {
  const pending = [...elements(node)];
  while (pending.length) {
    const next = pending.shift();
    if (classList(next).has('entity-grid')) return gridView(next);
    pending.push(...elements(next));
  }
  return null;
}

/** Recognises the custom JavaScript a platform component writes for its record, with its literal body. */
function customScript(node, record, refs, html) {
  if (node.tagName !== 'script' || attribute(node, 'src')) return null;
  const source = refs.field(record, 'customjavascript');
  if (!source) return { refs: [] };
  const start = node.sourceCodeLocation?.startTag?.endOffset,
    end = node.sourceCodeLocation?.endTag?.startOffset;
  const text = source.text ?? '';
  const literal =
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && text && html.slice(start, end).startsWith(text)
      ? {
          start,
          end: start + text.length,
          mapping: 'literal',
          sourceRefId: source.id,
          sourceSpan: { start: 0, end: text.length },
        }
      : null;
  return { refs: [source.id], literal };
}

// ---- The classifier
class Classifier {
  constructor({ html, components, refs, tag, args }) {
    this.html = html;
    this.refs = refs;
    this.forms = components.filter((item) => item?.type === 'basic-form' || item?.type === 'advanced-form');
    this.lists = components.filter((item) => item?.type === 'list');
    this.quickViews = components.filter((item) => item?.type === 'quick-view');
    this.tag = tag;
    this.args = args;
    this.spans = [];
    this.literals = [];
    this.formStates = new Map();
  }
  formState(form) {
    if (!this.formStates.has(form))
      this.formStates.set(form, {
        owners: formOwners(form, this.refs),
        tabs: 0,
        sections: 0,
        cells: 0,
        // The FormXml controls already given to a cell, the current tab and its section count.
        controls: new Set(),
        tab: null,
        tabSections: 0,
      });
    return this.formStates.get(form);
  }
  rootScope() {
    // A quick view document (lib/platform.mjs renderQuickForm): the quick view and, inside it, its read-only form.
    const quick = this.quickViews[0];
    const quickForm = quick && (this.forms.find((item) => item.ids?.view === quick.id) ?? this.forms[0]);
    if (quickForm) {
      const state = this.formState(quickForm);
      const placements = this.refs.form(quick.host?.formId);
      const control = placementRef(placements, cellControl(placements, { id: quick.id }, new Set())?.key);
      const context = this.refs.record(quick.host?.stepId)[0] ?? this.refs.record(quick.host?.id)[0] ?? null;
      const owner = quickViewBinding(
        { formId: quick.host?.formId ?? undefined, entity: quick.entity },
        { quickFormId: quickForm.formId ?? quick.formId, id: quick.id, lookup: quick.lookup },
        this.refs,
        control,
        context,
      );
      return { type: 'form', form: quickForm, state, binding: owner };
    }
    const form = this.forms.find((item) => !item.reference);
    if (form) {
      const state = this.formState(form);
      return { type: 'form', form, state, binding: state.owners.form };
    }
    const list = this.lists[0];
    if (list) {
      const owner = listOwner(list, this.refs);
      return { type: 'list', list, owner, binding: owner, root: true };
    }
    return { type: 'tag', binding: this.tagBinding() };
  }
  tagBinding() {
    const name = String(this.tag ?? 'component');
    const args = Object.fromEntries(
      Object.entries(this.args && typeof this.args === 'object' ? this.args : {})
        .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
        // Query and fragment values are redacted; argument names and paths stay.
        .map(([key, value]) => [key, redactQueryValues(String(value))]),
    );
    // A chart (its placeholder, lib/liquid-service-observations.mjs) is the chart the tag names, over the view it names.
    if (name === 'chart' && args.id)
      return binding(
        {
          kind: 'chart',
          key: 'chart:' + norm(args.id),
          name: args.id,
          ...(args.viewid ? { viewId: norm(args.viewid) } : {}),
          arguments: args,
        },
        args.viewid ? this.refs.key('view:' + norm(args.viewid)) : [],
      );
    return binding({ kind: 'liquid-tag', key: 'liquid-tag:' + name, name, arguments: args });
  }
  emit(node, assigned) {
    const location = node.sourceCodeLocation?.startTag;
    if (!location || !assigned?.component?.key) return;
    this.spans.push({
      start: location.startOffset,
      end: location.endOffset,
      tag: node.tagName,
      attributes: (node.attrs ?? [])
        .filter((item) => IDENTITY_ATTRIBUTES.has(item.name))
        .map((item) => ({ name: item.name, value: item.value })),
      ...assigned,
    });
  }
  walk(node, scope) {
    const children = elements(node);
    // A code component's host element owns the host script before it and the mount script after it.
    const hosted = new Map();
    children.forEach((child, index) => {
      const schema = attribute(child, 'data-pcf-schema');
      if (!schema || scope.type === 'tag') return;
      const pcf = this.pcfBinding(schema, scope);
      hosted.set(child, pcf);
      const before = children[index - 1],
        after = children[index + 1];
      if (before?.tagName === 'script' && attribute(before, 'src') === PCF_HOST_SCRIPT) hosted.set(before, pcf);
      if (after?.tagName === 'script' && !attribute(after, 'src')) hosted.set(after, pcf);
    });
    for (const child of children) {
      const next = hosted.has(child) ? { ...scope, binding: hosted.get(child) } : this.classify(child, scope);
      this.emit(child, next.binding);
      this.walk(child, next);
      if (child.content) this.walk(child.content, next);
    }
  }
  pcfBinding(schema, scope) {
    const lower = schema.toLowerCase();
    const cell = scope.cell;
    const fieldExtra = cell?.field
      ? { field: cell.field, entity: scope.form.entity, controlName: cell.id, formId: scope.form.formId ?? undefined }
      : {};
    const column = cell?.field ? this.refs.key(`column:${norm(scope.form.entity)}:${norm(cell.field)}`) : [];
    return binding(
      { kind: 'pcf', key: 'pcf:' + lower, name: schema, ...fieldExtra },
      [
        ...this.refs.key('pcf:' + lower),
        ...(scope.controlRefs ?? []),
        ...column,
        ...(scope.state?.owners.formRefs ?? []),
      ],
      scope.binding.contextSourceRefId ?? scope.state?.owners.record,
    );
  }
  classify(node, scope) {
    if (scope.type === 'form') return this.classifyForm(node, scope);
    if (scope.type === 'list') return this.classifyList(node, scope);
    if (scope.type === 'grid') return this.classifyGrid(node, scope);
    return scope;
  }
  // A native dialog under an owner (a list, a subgrid view, a lookup field): <owner>#action:<type>.
  modalScope(node, scope, owner, forms = new Map()) {
    const classes = classList(node);
    if (!classes.has('modal') && !(attribute(node, 'id') ?? '').startsWith('ModalToShowError')) return null;
    if (classes.has('modal-lookup')) {
      const viewId = descendantGridView(node);
      if (viewId) {
        const view = binding(
          { ...owner.component, kind: 'lookup-view', key: `view:${norm(viewId)}`, viewId: norm(viewId) },
          [...this.refs.key('view:' + norm(viewId)), ...owner.sourceRefIds],
          owner.contextSourceRefId,
        );
        return { ...scope, type: 'grid', owner: view, binding: view };
      }
    }
    const action = modalAction(classes);
    const target = forms.get(action) ?? (action === 'create' ? forms.get('create-lookup') : null);
    const assigned = withPart(owner, 'action:' + action, {}, this.refs.record(target));
    return { ...scope, type: 'grid', owner: assigned, binding: assigned, modal: true };
  }
  classifyGrid(node, scope) {
    if (!scope.modal) {
      const modal = this.modalScope(node, scope, scope.owner, scope.actionForms);
      if (modal) return modal;
    }
    return scope;
  }
  classifyList(node, scope) {
    const { owner } = scope;
    const classes = classList(node);
    const id = attribute(node, 'id') ?? '';
    if (scope.root && (classes.has('entitylist') || id.startsWith('EntityListControl')) && !classes.has('entity-grid'))
      return { ...scope, binding: owner, root: true };
    if (attribute(node, 'data-mirage-component') === 'codecomponent')
      return { ...scope, binding: withPart(owner, 'notice') };
    if (classes.has('entitylist-filter') || node.attrs?.some((item) => item.name === 'data-pp-modern-list-filter'))
      return { ...scope, root: false, binding: withPart(owner, 'filter') };
    for (const [className, part] of LIST_MESSAGES)
      if (classes.has(className)) return { ...scope, root: false, binding: withPart(owner, part) };
    return this.classifyListPart(node, scope);
  }
  // The rest of the list rules, tried in order after classifyList's.
  classifyListPart(node, scope) {
    const { list, owner } = scope;
    const classes = classList(node);
    const modal = this.modalScope(node, scope, owner, actionForms(list.settings));
    if (modal) return modal;
    if (classes.has('entity-grid') || node.attrs?.some((item) => item.name === 'data-pp-modern-list')) {
      const view = viewBinding(gridView(node) ?? list.views?.[0], owner, {}, this.refs);
      return { ...scope, root: false, binding: view, view };
    }
    if (node.tagName === 'script') {
      const script = customScript(node, list.scriptRecord, this.refs, this.html);
      if (script?.literal) this.literals.push(script.literal);
      if (script) return { ...scope, root: false, binding: withPart(owner, 'custom-javascript', {}, script.refs) };
    }
    const flags = new Set((node.attrs ?? []).map((item) => item.name));
    for (const [flag, part] of LIST_FLAG_PARTS)
      if (flags.has(flag)) return { ...scope, root: false, binding: withPart(owner, part) };
    if (classes.has('pp-modern-list-toolbar')) return { ...scope, root: false, binding: withPart(owner, 'toolbar') };
    if (node.tagName === 'th' && attribute(node, 'data-logical-name') && scope.view) {
      const field = norm(attribute(node, 'data-logical-name'));
      const column = binding(
        {
          kind: 'field',
          key: `column:${norm(list.entity)}:${field}`,
          entity: list.entity,
          field,
          viewId: scope.view.component.viewId,
        },
        [...this.refs.key(`column:${norm(list.entity)}:${field}`), ...scope.view.sourceRefIds],
        scope.view.contextSourceRefId,
      );
      return { ...scope, binding: column };
    }
    if (scope.root && (list.layout === 'map' || list.layout === 'calendar'))
      return { ...scope, root: false, binding: withPart(owner, list.layout) };
    return { ...scope, root: false };
  }
  classifyForm(node, scope) {
    const { form, state } = scope;
    const id = attribute(node, 'id') ?? '';
    // A reference read-only form inside a step is its own form view.
    const nested = this.forms.find((item) => item !== form && item.reference && item.ids.view === id);
    if (nested) {
      const nestedState = this.formState(nested);
      return { type: 'form', form: nested, state: nestedState, binding: nestedState.owners.form };
    }
    const { owners } = state;
    const classes = classList(node);
    if (scope.cell) return this.classifyCell(node, scope);
    // The returned scope is the scope of the node's children: `wrapper` marks the wrapper's direct children.
    const next = { ...scope, wrapper: false, scriptSpan: false };
    if (id === form.ids.wrapper) return { ...next, binding: owners.form, wrapper: true };
    if (id === form.ids.panel || id === form.ids.view) return { ...next, binding: owners.step, inStep: true };
    const owner = scope.inStep ? owners.step : owners.form;
    const part = (name, extra = {}, refs = []) => ({ ...next, binding: withPart(owner, name, extra, refs) });
    const rule = { node, scope, id, classes, form, state, owners, next, owner, part };
    return (
      this.classifyFormScript(rule) ??
      this.classifyFormScriptTag(rule) ??
      this.classifyFormPart(rule) ??
      this.classifyFormMarker(rule) ??
      this.classifyFormLayout(rule) ??
      next
    );
  }
  // The form rules below return a scope for the first rule that matches and undefined otherwise, in source order.
  classifyFormScript({ node, scope, form, owners, owner, next }) {
    // The form's custom JavaScript: <span><script>…</script></span> first inside the wrapper.
    const first = elements(node)[0];
    if (scope.wrapper && node.tagName === 'span' && first?.tagName === 'script' && !attribute(first, 'src')) {
      const script = customScript(first, form.scriptRecord, this.refs, this.html);
      if (script?.literal) this.literals.push(script.literal);
      // A multistep form writes the rendered step's JavaScript.
      const scriptOwner = form.stepId && norm(form.scriptRecord?.id) === form.stepId ? owners.step : owner;
      return {
        ...next,
        binding: withPart(scriptOwner, 'custom-javascript', {}, script?.refs ?? []),
        scriptSpan: true,
      };
    }
  }
  classifyFormScriptTag({ node, scope, next, part }) {
    if (node.tagName === 'script') {
      if (scope.scriptSpan) return next;
      if (node.attrs?.some((item) => item.name === 'data-paqvilo-mirage-form-config')) return part('configuration');
      const text = textOf(node);
      if (/Page_Validators|Page_ValidationSummaries/.test(text)) return part('validators');
      if (/function entityFormClientValidate|function webFormClientValidate/.test(text))
        return part('client-validation');
      return next;
    }
  }
  classifyFormPart({ id, classes, owners, owner, next }) {
    if (id.endsWith('_ProgressIndicator')) return { ...next, binding: withPart(owners.form, 'progress') };
    if (classes.has('instructions')) return { ...next, binding: withPart(owner, 'instructions') };
    if (id === 'MessagePanel')
      return {
        ...next,
        binding: withPart(
          owner,
          classes.has('alert-success') || classes.has('success') ? 'success-message' : 'message',
        ),
      };
    if (classes.has('actions') || classes.has('form-custom-actions') || /^(?:Previous|Next)Button$/.test(id))
      return { ...next, binding: withPart(owner, 'actions') };
    if (classes.has('validation-summary') || id.startsWith('ValidationSummary'))
      return { ...next, binding: withPart(owner, 'validation-summary') };
    if (
      /_(?:EntityName|EntityID|EntityState|EntityStatus|EntityLayoutConfig)$/.test(id) ||
      id.startsWith('confirmOnExit')
    )
      return { ...next, binding: withPart(owner, 'state') };
  }
  classifyFormMarker({ node, id, classes, owner, next }) {
    if ([...classes].some((name) => name.startsWith('frm-g-')))
      return { ...next, binding: withPart(owner, 'honeypot') };
    if (
      /AttachFile|^ModalToShowErrorForFile/.test(id) ||
      (classes.has('tr') && elements(node).some((child) => classList(child).has('file-cell')))
    )
      return { ...next, binding: withPart(owner, 'attach-file') };
    if (classes.has('tr') && elements(node).some((child) => classList(child).has('captcha-cell')))
      return { ...next, binding: withPart(owner, 'captcha') };
  }
  classifyFormLayout({ node, scope, classes, form, state, owners, owner, next }) {
    if (node.tagName === 'h2' && classes.has('tab-title')) {
      const item = form.layout?.tabs?.[state.tabs];
      const placement = layoutPlacement(owners.placements, 'tab', item, null, state.tabs);
      return { ...next, binding: layoutBinding(form, owners, 'tab', item, this.refs, placement) ?? owner };
    }
    if (node.tagName === 'div' && classes.has('tab')) {
      const item = form.layout?.tabs?.[state.tabs];
      const placement = layoutPlacement(owners.placements, 'tab', item, null, state.tabs++);
      state.tab = placement?.name ?? item?.name ?? null;
      state.tabSections = 0;
      const tab = layoutBinding(form, owners, 'tab', item, this.refs, placement);
      return { ...next, binding: tab ?? owner, tab };
    }
    if (node.tagName === 'fieldset' && scope.tab) {
      const item = form.layout?.sections?.[state.sections++];
      const placement = layoutPlacement(owners.placements, 'section', item, state.tab, state.tabSections++);
      const section = layoutBinding(form, owners, 'section', item, this.refs, placement);
      return { ...next, binding: section ?? scope.binding, section };
    }
    if (node.tagName === 'td' && classes.has('cell') && !classes.has('zero-cell') && scope.section) {
      const cell = form.layout?.cells?.[state.cells++];
      const control = cell
        ? placementRef(owners.placements, cellControl(owners.placements, cell, state.controls)?.key)
        : [];
      const assigned = (cell && cellBinding(form, owners, cell, this.refs, control)) ?? scope.binding;
      return { ...next, binding: assigned, cell: cell ?? {}, cellBinding: assigned, controlRefs: control };
    }
  }
  // Inside a cell: the cell's binding, a subgrid's messages and dialogs, a lookup's dialogs.
  classifyCell(node, scope) {
    const { cell } = scope;
    if (scope.modal) return scope;
    const classes = classList(node);
    if (!scope.grid && classes.has('entity-grid') && cell.type === 'subgrid') {
      const row = (scope.form.metadataRows ?? []).find((item) => item.type === 100000003 && item.subgrid === cell.id);
      return { ...scope, grid: true, gridOwner: scope.cellBinding, actionForms: actionForms(row?.subgridSettings) };
    }
    const owner = scope.gridOwner ?? scope.cellBinding;
    if (scope.grid)
      for (const [className, part] of LIST_MESSAGES)
        if (classes.has(className)) return { ...scope, binding: withPart(owner, part) };
    const forms = scope.actionForms ?? new Map(cell.createFormId ? [['create', norm(cell.createFormId)]] : []);
    const modal = this.modalScope(node, scope, owner, forms);
    if (modal) return { ...scope, binding: modal.binding, modal: true };
    return scope;
  }
}

/**
 * The render intervals of one component's markup: a `platform` interval for every element start tag, the explicit
 * element bindings a renderer reported taking precedence, and `literal` intervals for custom JavaScript bodies that are
 * the exported source text. `components` are the onComponentRendered reports, `explicit` the offset bindings
 * (code component onRendered, onProgressRendered with sourceSelectors).
 */
export function platformComponentIntervals({
  html,
  components = [],
  explicit = [],
  index = null,
  tag = null,
  args = null,
}) {
  if (typeof html !== 'string' || !html) return [];
  const refs = sourceResolver(index);
  const classifier = new Classifier({ html, components, refs, tag, args });
  const tree = parseFragment(html, { sourceCodeLocationInfo: true });
  classifier.walk(tree, classifier.rootScope());
  const exact = new Map();
  for (const item of explicit) {
    const sourceRefIds = item.sourceSelectors
      ? item.sourceSelectors.flatMap((selector) => {
          const source = index?.source?.({ id: selector.recordId }, selector.field, selector);
          return source && !source.ambiguous ? [source.id] : [];
        })
      : (item.sourceRefIds ?? refs.key(item.component?.key));
    const rest = { ...item };
    delete rest.sourceSelectors;
    exact.set(item.start, { ...rest, sourceRefIds });
  }
  // An element a renderer bound exactly keeps that binding; its descendants keep the classified ones.
  const spans = classifier.spans.map((span) => {
    const known = exact.get(span.start);
    if (!known || known.end !== span.end || known.tag !== span.tag) return span;
    exact.delete(span.start);
    return { ...span, ...known, attributes: known.attributes ?? span.attributes };
  });
  return [...spans, ...exact.values(), ...classifier.literals];
}

/** A component renderer's result with its render intervals (renderProvenance), for the Liquid component tags. */
export function componentRenderResult(result, options = {}) {
  const html = typeof result === 'string' ? result : result?.html;
  if (typeof html !== 'string' || !html) return result;
  const renderProvenance = platformComponentIntervals({ ...options, html });
  const base = typeof result === 'string' ? { html } : result;
  return renderProvenance.length ? { ...base, renderProvenance } : base;
}

/**
 * The render fragment of an ASP.NET server form (lib/platform-manifest.mjs webFormsForm) around component markup: the
 * component's intervals (componentRenderResult renderProvenance) re-based on the removals the server form made from
 * its content (onContent: offset, length, edits) and moved to where the content sits in the form. The form's own
 * elements are left to the document's platform pass. Without intervals, or when the content is not where the form
 * reported it, the form text is returned as it is.
 */
export function serverFormFragment(form, content, range) {
  if (typeof form !== 'string' || !content?.renderProvenance?.length || !range) return form;
  // As the Liquid component tags host them (lib/liquid.mjs): every interval but exported text is a platform one.
  const intervals = content.renderProvenance.map((span) =>
    span.mapping === 'literal' ? span : { ...span, mapping: 'platform', sourceRefIds: span.sourceRefIds ?? [] },
  );
  const edited = applyElementRenderEdits({ text: content.html, intervals }, range.edits ?? []);
  if (form.slice(range.offset, range.offset + range.length) !== edited.text) return form;
  return {
    text: form,
    intervals: edited.intervals
      .filter((span) => span.end <= range.length)
      .map((span) => ({ ...span, start: span.start + range.offset, end: span.end + range.offset })),
  };
}
