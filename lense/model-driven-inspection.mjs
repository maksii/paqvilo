import { compileForm, parseRibbonCommands } from '../mirage/lib/model-driven/solution.mjs';
import { redactText } from './agent-server.mjs';

const MAX_ITEMS = 200;
const MAX_BYTES = 256 * 1024;
const clean = value => redactText(value, 500);
const norm = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();

/** Data-only provenance from the same selected Solution facts used by Mirage. */
export function modelDrivenInspectionCatalogue(imported) {
  const forms = new Map(), commands = new Map();
  let bytes = 0, remaining = 1000, inspectedForms = 0, inspectedRibbons = 0, inspectedCommands = 0, truncated = false;
  const consume = rows => {
    const count = Math.min(rows.length, MAX_ITEMS, remaining);
    remaining -= count; if (count < rows.length) truncated = true;
    return rows.slice(0, count);
  };
  const admit = (collection, key, value) => {
    const size = Buffer.byteLength(JSON.stringify(value)), previous = collection.get(key);
    const available = MAX_BYTES - bytes + (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0);
    if ((!collection.has(key) && collection.size >= MAX_ITEMS) || size > available) { truncated = true; return; }
    bytes += size - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0); collection.set(key, value);
  };
  for (const layer of imported.layers ?? []) for (const doc of layer.documents ?? []) {
    for (const form of doc.facts?.appComponents?.forms ?? []) {
      if (++inspectedForms > MAX_ITEMS) { truncated = true; continue; }
      if ((forms.size >= MAX_ITEMS && !forms.has(norm(form.id))) || !form.xml || form.xml.length > 2 * 1024 * 1024) { truncated = true; continue; }
      try {
        const compiled = compileForm(form, {});
        if (!compiled) continue;
        const controls = [];
        for (const tab of compiled.tabs) for (const section of tab.sections) for (const field of section.fields) {
          if (remaining < 1 || controls.length >= MAX_ITEMS) { truncated = true; break; }
          remaining--;
          controls.push({ name: clean(field.name), id: clean(field.sourceControl?.id), label: clean(field.label), pcf: field.pcf ? { name: clean(field.pcf.name) } : undefined });
        }
        admit(forms, norm(form.id), { id: norm(form.id), entity: clean(form.entity), name: clean(form.name), source: clean(form.file ?? doc.file),
          libraries: consume(compiled.libraries).map(clean),
          events: consume(compiled.clientEvents).map(event => ({ name: clean(event.name), attribute: clean(event.attribute), active: event.active,
            handlers: consume(event.handlers).map(handler => ({ library: clean(handler.library), functionName: clean(handler.functionName), enabled: handler.enabled })) })), controls,
        });
      } catch { /* Import diagnostics already identify malformed Solution components. */ }
    }
  }
  const command = entry => {
    if (++inspectedCommands > MAX_ITEMS) { truncated = true; return; }
    admit(commands, `${entry.entity}:${entry.id}`, { id: clean(entry.id), entity: clean(entry.entity), label: clean(entry.label), supported: entry.supported,
      source: clean(entry.source), locations: (entry.locations ?? []).slice(0, 4).map(clean), nativeControlIds: (entry.nativeControlIds ?? []).slice(0, 4).map(value => redactText(value, 1200)),
      actions: consume(entry.actions ?? []).map(action => ({ library: clean(action.library), functionName: clean(action.functionName) })) });
  };
  for (const document of imported.ribbonDocuments ?? []) {
    if (inspectedCommands >= MAX_ITEMS) { truncated = true; break; }
    if (++inspectedRibbons > MAX_ITEMS) { truncated = true; continue; }
    if (document.xml?.length > 2 * 1024 * 1024) { truncated = true; continue; }
    try { for (const entry of parseRibbonCommands(document.xml)) command({ ...entry, entity: document.entity, source: document.source }); }
    catch { /* Preserve the other declared sources if a ribbon cannot be inspected. */ }
  }
  for (const entry of imported.appActions ?? []) command(entry);
  return { forms: [...forms.values()], commands: [...commands.values()], solutionCount: imported.layers?.length ?? 0, limits: { maxItems: MAX_ITEMS, maxBytes: MAX_BYTES, maxDetails: 1000, truncated } };
}

/** Fixed, read-only metadata inspection. Never reads attributes' values or record IDs. */
export function inspectModelDrivenContext(origin) {
  if (location.origin !== origin) return null;
  const safe = operation => { try { return operation(); } catch { return undefined; } };
  const guid = value => typeof value === 'string' && /^[{]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[}]?$/i.test(value) ? value.replace(/[{}]/g, '').toLowerCase() : undefined;
  const logical = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/i.test(value) ? value : undefined;
  const globalContext = safe(() => window.Xrm?.Utility?.getGlobalContext());
  const form = safe(() => window.Xrm?.Page), item = safe(() => form?.ui?.formSelector?.getCurrentItem());
  const query = new URLSearchParams(location.search);
  const pageType = query.get('pagetype');
  const user = safe(() => globalContext?.userSettings);
  const roleCount = safe(() => user?.roles?.getLength()), formType = safe(() => form?.ui?.getFormType());
  return { appId: guid(query.get('appid')), pageType: ['entityrecord', 'entitylist'].includes(pageType) ? pageType : undefined,
    entity: logical(safe(() => form?.data?.entity?.getEntityName()) ?? query.get('etn')),
    formId: guid(safe(() => item?.getId())), formType: Number.isInteger(formType) && formType >= 0 && formType <= 20 ? formType : undefined,
    identity: { available: Boolean(user), userId: guid(safe(() => user?.userId)), roleCount: Number.isSafeInteger(roleCount) && roleCount >= 0 ? Math.min(roleCount, 10000) : undefined },
    frameBoundary: false };
}
