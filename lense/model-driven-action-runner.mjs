// Fixed native operations only: no eval, extension runtime or third-party scripts are executed
// by this module.

/** Passive API presence checks. Do not call getId/getValue or read form values here. */
export function modelDrivenActionAvailability({ origin, actions = [] }) {
  // Inside the function: page.evaluate serializes this function alone.
  const REQUIREMENT_TEXT = { metadata: 'This app does not report its Web API version (getGlobalContext().getVersion), so table metadata cannot be read.',
    environment: 'This app does not report a Power Platform environment ID; a local simulator has none.', privileges: 'This app does not expose the security role privileges of the signed-in user.',
    navigate: 'This app cannot open addresses (Xrm.Navigation.openUrl).', 'open-form': 'This app cannot open forms from a script (Xrm.Navigation.openForm).',
    'side-panes': 'This app has no side panes (Xrm.App.sidePanes).', 'form-selector': 'This form does not report which form is open (formSelector).',
    'save-events': 'This form does not expose save events.', refresh: 'This form cannot be refreshed from a script.', context: 'This app does not expose its global context.' };
  // A bounded client API (or a native getter) may throw for an unsupported member;
  // that member is unavailable, never a failure of every other check.
  const safe = callback => { try { return callback(); } catch { return undefined; } };
  const xrm = window.Xrm, form = safe(() => xrm?.Page), context = safe(() => xrm?.Utility?.getGlobalContext()), type = safe(() => form?.ui?.getFormType());
  // The page decides what a form action can work on: the native page context, else the address (pagetype). A list,
  // dashboard or custom page has no form even when the app keeps an Xrm.Page object around.
  const pageType = safe(() => xrm?.Utility?.getPageContext?.()?.input?.pageType) ?? new URLSearchParams(location.search).get('pagetype') ?? undefined;
  const onRecord = pageType === undefined ? Boolean(safe(() => form?.data?.entity?.getEntityName?.())) : pageType === 'entityrecord';
  const checks = {
    context: () => context, form: () => onRecord && form?.data?.entity && form?.ui,
    'saved-record': () => onRecord && form?.data?.entity?.getId && type !== 1,
    metadata: () => context?.getClientUrl && context?.getVersion && window.fetch,
    'open-form': () => typeof xrm?.Navigation?.openForm === 'function', navigate: () => context?.getClientUrl && xrm?.Navigation?.openUrl,
    refresh: () => typeof form?.data?.refresh === 'function',
    'save-events': () => form?.data?.entity?.addOnSave && form?.data?.entity?.removeOnSave,
    'side-panes': () => xrm?.App?.sidePanes?.createPane && xrm?.Utility?.getPageContext,
    'form-selector': () => form?.ui?.formSelector?.getCurrentItem,
    environment: () => context?.organizationSettings?.bapEnvironmentId,
    privileges: () => typeof context?.userSettings?.getSecurityRolePrivilegesInfo === 'function',
  };
  return actions.map(action => {
    const missing = action.requirements?.find(requirement => !checks[requirement] || !safe(checks[requirement]));
    const reason = location.origin !== origin ? 'The app left this Lense environment.'
      : ['form', 'saved-record'].includes(missing) && !onRecord ? 'Open a record form to use this; this page is not a form.'
      : missing === 'saved-record' ? 'Save the record first; this form has no saved record yet.'
      : missing ? REQUIREMENT_TEXT[missing] ?? `The current native page does not provide ${missing.replaceAll('-', ' ')} support.` : undefined;
    return { id: action.id, available: location.origin === origin && !missing, reason, needsRecord: ['form', 'saved-record'].includes(missing) && !onRecord };
  });
}

/** page.evaluate-serializable. Private results go straight to the owned browser UI.
 * The returned acknowledgement never contains record identity, values or errors.
 */
export async function runModelDrivenAction({ origin, token, action, params = {}, requestId, cloud = {} }) {
  const ack = accepted => ({ accepted, requestId });
  const host = (document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector'));
  const receiver = () => location.origin === origin && host?.isConnected && host.__paqModelActions?.token === token && !window.__paqviloRetiredModelInspectors?.includes(token) ? host.__paqModelActions : undefined;
  if (window.top !== window || !receiver() || typeof requestId !== 'string' || requestId.length > 100) return ack(false);
  const safe = callback => { try { return callback(); } catch { return undefined; } };
  const fail = (message, status = 'unsupported') => { throw Object.assign(new Error(message), { status }); };
  const logical = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/i.test(value) ? value.toLowerCase() : fail('The table logical name is unavailable.');
  const guid = value => typeof value === 'string' && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.test(value) ? value.replace(/[{}]/g, '').toLowerCase() : fail('A saved record GUID is required.');
  const xrm = window.Xrm, context = safe(() => xrm?.Utility?.getGlobalContext()), form = safe(() => xrm?.Page);
  const target = () => ({ entity: safe(() => window.Xrm?.Page?.data?.entity?.getEntityName()) ?? new URLSearchParams(location.search).get('etn'), id: safe(() => window.Xrm?.Page?.data?.entity?.getId()) ?? '', form: safe(() => window.Xrm?.Page?.ui?.formSelector?.getCurrentItem()?.getId()) ?? '', actor: safe(() => window.Xrm?.Utility?.getGlobalContext()?.userSettings?.userId) ?? '', route: location.pathname + location.search });
  const captured = target(), key = JSON.stringify(captured);
  let state = host.__paqModelActionState;
  if (state?.token !== token || state?.retired) { state?.dispose(); state = undefined; }
  if (!state) {
    state = { token, key, pending: new Map(), controllers: new Set(), restores: [], labels: [], panes: [], guard: undefined, retired: false };
    state.restore = () => { let restored = 0, unavailable = 0; for (const callback of state.restores.splice(0).reverse()) { try { callback(); restored++; } catch { unavailable++; } } return { restored, unavailable }; };
    state.clearLabels = () => { for (const node of state.labels.splice(0)) node.remove(); };
    state.cancelPending = () => { state.pending.clear(); for (const controller of state.controllers) controller.abort(); state.controllers.clear(); };
    state.clearTarget = () => { state.cancelPending(); state.restore(); state.clearLabels(); if (state.guard) { safe(() => state.guard.entity.removeOnSave(state.guard.handler)); state.guard = undefined; } };
    state.dispose = () => { state.retired = true; clearInterval(state.timer); state.clearTarget(); for (const pane of state.panes.splice(0)) { try { Promise.resolve(pane.close?.()).catch(() => {}); } catch { /* A native pane may already be closed. */ } } };
    // This starts only after an explicit action. Passive inspection never reads
    // record identity; the action lifetime revokes itself after a target change.
    state.timer = setInterval(() => { if (!receiver()) state.dispose(); else { const next = JSON.stringify(target()); if (next !== state.key) { state.clearTarget(); state.key = next; safe(() => receiver()?.contextChanged?.()); } } }, 250);
    Object.defineProperty(host, '__paqModelActionState', { value: state, writable: true, configurable: true });
  }
  if (state.key !== key) { state.clearTarget(); state.key = key; }
  const marker = {}; state.pending.set(requestId, marker);
  const live = () => receiver() && !state.retired && state.pending.get(requestId) === marker && JSON.stringify(target()) === key;
  const deliver = value => { try { receiver()?.receive(requestId, value); } catch { /* Private UI errors must not become agent or Node result payloads. */ } };
  const check = () => { if (!live()) fail('The app or record changed. Run the action again on the current page.', 'cancelled'); };
  const text = value => value == null ? value === null ? '[NULL]' : '' : typeof value === 'object' ? value instanceof Date ? value.toISOString() : JSON.stringify(value) : String(value);
  const bounded = value => text(value).slice(0, 4000);
  const rowsResult = (title, columns, rows, message = '') => ({ status: 'ok', title, columns, rows: rows.slice(0, 200).map(row => row.map(bounded)), message: message + (rows.length > 200 ? ' Showing the first 200 rows.' : '') });
  const result = (title, message, extra = {}) => ({ status: 'ok', title, message, ...extra });
  const list = collection => { if (!collection) return []; const all = safe(() => collection.get()); if (Array.isArray(all)) return all; const entries = []; collection.forEach?.(entry => entries.push(entry)); return entries; };
  const requireForm = () => form?.data?.entity && form?.ui ? form : fail('A native record form is required.');
  const entity = () => logical(captured.entity);
  const recordId = () => guid(captured.id);
  const client = () => {
    if (!context?.getClientUrl) fail('The native client URL is unavailable.');
    const url = new URL(context.getClientUrl());
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) fail('The native client URL does not match this Lense environment.');
    return url.href.replace(/\/$/, '');
  };
  const apiRoot = () => {
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(context?.getVersion?.() ?? '');
    if (!version) fail('The native Web API version is unavailable.');
    return `${client()}/api/data/v${version[1]}.${version[2]}/`;
  };
  const get = async path => {
    check(); const controller = new AbortController(); state.controllers.add(controller); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
    try {
      const response = await fetch(apiRoot() + path, { credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json', prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname"' } }); check();
      if (!response.ok) fail(`The native read failed (HTTP ${response.status}).`, 'error');
      const limit = 2 * 1024 * 1024;
      if (!response.body?.getReader) fail('The native read does not provide a bounded response stream.', 'error');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read(); check();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) { await reader.cancel().catch(() => {}); fail('The native result exceeds the action’s 2 MiB read limit.', 'error'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body = new TextDecoder().decode(bytes); check();
      try { return JSON.parse(body); } catch { fail('The native read did not return JSON.', 'error'); }
    } catch (error) { check(); if (timedOut) fail('The native read timed out.', 'error'); throw error; }
    finally { clearTimeout(timer); state.controllers.delete(controller); }
  };
  const metadata = async name => {
    const definition = await get(`EntityDefinitions(LogicalName='${logical(name)}')?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`);
    if (!/^[a-z][\w]*$/i.test(definition.EntitySetName ?? '')) fail('The actual entity-set metadata is unavailable.');
    return definition;
  };
  const openUrl = async value => { check(); if (!xrm?.Navigation?.openUrl) fail('Native URL navigation is unavailable.'); await xrm.Navigation.openUrl(value); };
  const requestForm = (options, values) => {
    check();
    // Full main forms do not invoke openForm's success callback. Its promise
    // can remain pending even after the form opens; only quick-create Save has
    // a success result. Report dispatch and retain bounded private late errors.
    const operation = xrm.Navigation.openForm(options, values);
    Promise.resolve(operation).catch(error => {
      if (receiver() && !state.retired && JSON.stringify(target()) === key) safe(() => receiver()?.followup?.(requestId, { status: 'error', title: 'Native form request failed', message: String(error?.message ?? 'The native form request failed.').slice(0, 1000) }));
    });
  };
  const pageUrl = (name, id, type = 'entitylist') => { const url = new URL(`${client()}/main.aspx`), current = new URLSearchParams(location.search); for (const parameter of ['appid', 'appname']) if (current.get(parameter)) url.searchParams.set(parameter, current.get(parameter)); if (type) url.searchParams.set('pagetype', type); if (name) url.searchParams.set('etn', logical(name)); if (id) url.searchParams.set('id', guid(id)); return url; };
  const environment = () => { const id = context?.organizationSettings?.bapEnvironmentId; if (typeof id !== 'string' || !/^(?:Default-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail('The native environment ID is unavailable.'); return id; };
  const portal = name => {
    const defaults = { maker: 'https://make.powerapps.com', admin: 'https://admin.powerplatform.microsoft.com', automate: 'https://make.powerautomate.com' };
    const configured = cloud[name];
    if (!configured && !/^https:\/\/[^/]+\.crm\d*\.dynamics\.com$/i.test(client())) fail('Configure the maker/admin origins for this environment’s cloud.');
    const url = new URL(configured ?? defaults[name]); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('The configured cloud portal origin is invalid.'); return url.origin;
  };
  const solution = async () => {
    let id;
    try { const preferred = await get('GetPreferredSolution()'); id = preferred.solutionid; }
    catch (error) { if (error.status === 'cancelled') throw error; }
    if (!id) { const defaults = await get("solutions?$select=solutionid&$filter=uniquename%20eq%20'Default'&$top=1"); id = defaults.value?.[0]?.solutionid; }
    return guid(id);
  };
  try {
    let outcome;
    if (action === 'identity:users') {
      const query = params.query ?? ''; if (typeof query !== 'string' || query.length > 100 || /[\x00-\x1f\x7f]/.test(query)) fail('Enter a user search of at most 100 characters.', 'error');
      const filter = 'isdisabled eq false and applicationid eq null' + (query.trim() ? ` and (contains(fullname,'${query.trim().replaceAll("'", "''")}') or contains(domainname,'${query.trim().replaceAll("'", "''")}'))` : '');
      const users = await get(`systemusers?$select=systemuserid,fullname,domainname,azureactivedirectoryobjectid&$filter=${encodeURIComponent(filter)}&$orderby=fullname&$top=100`);
      const choices = (users.value ?? []).slice(0, 100).filter(user => /^[0-9a-f-]{36}$/i.test(user.systemuserid ?? '') && /^[0-9a-f-]{36}$/i.test(user.azureactivedirectoryobjectid ?? '')).map(user => ({ id: guid(user.systemuserid), objectId: guid(user.azureactivedirectoryobjectid), label: bounded(user.fullname), name: bounded(user.fullname), domain: bounded(user.domainname) }));
      outcome = { ...rowsResult('Active native users', ['Name', 'Domain', 'User ID', 'Directory object ID'], choices.map(user => [user.name, user.domain, user.id, user.objectId]), 'Only enabled non-application users with directory identities are selectable. Showing at most 100 results.'), users: choices };
    } else if (action === 'identity:status') {
      const user = context?.userSettings; if (typeof user?.getSecurityRolePrivilegesInfo !== 'function') fail('The native privilege-detail API is unavailable.');
      const privileges = await user.getSecurityRolePrivilegesInfo(); check();
      const allowed = Object.values(privileges ?? {}).some(privilege => privilege.privilegeName === 'prvActOnBehalfOfAnotherUser');
      outcome = result('Native identity', allowed ? 'The signed-in user has the native acting-as privilege. Server authorization still applies to each request.' : 'The exact native acting-as privilege was not found.', { identity: { canImpersonate: allowed, signedInUserId: guid(user.userId), name: bounded(user.userName) } });
    } else if (action === 'admin:environment-context') {
      if (!context) fail('The native global context is unavailable.');
      // Each value is read on its own: one the app does not report (a local simulator has no Power Platform environment) shows as not reported.
      const org = safe(() => context.organizationSettings) ?? {}, user = safe(() => context.userSettings) ?? {}, read = (owner, key) => safe(() => owner[key]) ?? 'not reported';
      outcome = rowsResult('Environment and signed-in user', ['Property', 'Value'], [['Client URL', client()], ['Version', safe(() => context.getVersion?.()) ?? 'not reported'], ['Environment ID', read(org, 'bapEnvironmentId')], ['Organization ID', read(org, 'organizationId')], ['Unique name', read(org, 'uniqueName')], ['User ID', read(user, 'userId')], ['User name', read(user, 'userName')], ['Language', read(user, 'languageId')], ['Roles', list(user.roles).map(role => role.name).join(', ')]]);
    } else if (action === 'form:record-id' || action === 'form:record-url') {
      requireForm(); const id = recordId(), value = action.endsWith('record-id') ? id : (() => { const url = pageUrl(entity(), id, 'entityrecord'); const formId = safe(() => guid(captured.form)); if (formId) url.searchParams.set('formid', formId); return url.href; })();
      outcome = result(action.endsWith('record-id') ? 'Record ID' : 'Record URL', value, { copyText: value });
    } else if (action === 'form:show-logical-names' || action === 'form:clear-logical-names') {
      requireForm(); state.clearLabels(); let count = 0;
      if (action.endsWith('show-logical-names')) for (const attribute of list(form.data.entity.attributes).slice(0, 200)) {
        const name = safe(() => attribute.getName()); if (!/^[a-z][\w]*$/i.test(name ?? '')) continue;
        const nodes = [...document.querySelectorAll('[data-id],[id]')].filter(node => node.id === `${name}_c` || node.getAttribute('data-id') === name || node.getAttribute('data-id')?.startsWith(name + '.fieldControl'));
        const node = nodes.find(node => !['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) ?? nodes[0]?.parentElement;
        if (!node || node.getRootNode() !== document) continue;
        const label = document.createElement('button'); label.type = 'button'; label.textContent = name; label.dataset.paqModelLogicalName = ''; label.style.cssText = 'font:11px Consolas,monospace;color:#005a9e;background:#eff6fc;border:1px solid #c7e0f4;padding:2px 4px;'; label.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); navigator.clipboard?.writeText(name).catch(() => {}); }); node.prepend(label); state.labels.push(label); count++;
      }
      outcome = result('Logical names', action.endsWith('clear-logical-names') ? 'Labels added by this session were removed.' : `${count} matched field labels added.`);
    } else if (action === 'form:changed-fields') {
      requireForm(); const rows = list(form.data.entity.attributes).filter(attribute => safe(() => attribute.getIsDirty()) === true).map(attribute => [safe(() => attribute.getName()), safe(() => attribute.getAttributeType()), safe(() => attribute.getValue())]);
      outcome = rowsResult('Changed fields — form draft', ['Column', 'Type', 'Draft value'], rows, rows.length ? '' : 'The current form draft has no changed attributes.');
    } else if (action === 'form:show-optionset-values') {
      requireForm(); const rows = [];
      for (const attribute of list(form.data.entity.attributes)) { const options = safe(() => attribute.getOptions()); if (!Array.isArray(options)) continue; for (const option of options) rows.push([safe(() => attribute.getName()), option.text, option.value]); }
      outcome = rowsResult('Choice values', ['Column', 'Label', 'Value'], rows, rows.length ? '' : 'No native choice options are available on this form.');
    } else if (action === 'form:all-fields') {
      requireForm(); const definition = await metadata(entity()), saved = await get(`${definition.EntitySetName}(${recordId()})`);
      outcome = rowsResult('Saved record fields', ['Column', 'Saved value', 'Formatted value'], Object.keys(saved).filter(name => !name.includes('@')).sort().map(name => [name, saved[name], saved[name + '@OData.Community.Display.V1.FormattedValue']]), 'Saved server state; unsaved form changes are not included.');
    } else if (action === 'form:open-web-api') {
      requireForm(); const definition = await metadata(entity()), url = `${apiRoot()}${definition.EntitySetName}(${recordId()})`; await openUrl(url); outcome = result('Record Web API', 'Opened the native record endpoint.');
    } else if (action === 'form:refresh-subgrids') {
      requireForm(); const grids = list(form.ui.controls).filter(control => safe(() => control.getControlType()) === 'subgrid'); let refreshed = 0;
      for (const grid of grids) if (typeof grid.refresh === 'function') { check(); await grid.refresh(); refreshed++; }
      if (!refreshed) fail('No refreshable native subgrids are available on this form.'); outcome = result('Subgrids', `${refreshed} native subgrids refreshed.`);
    } else if (action === 'form:god-mode') {
      requireForm(); if (state.restores.length) fail('Restore this session’s existing form overrides before applying them again.', 'error'); let changed = 0;
      const override = (object, getter, setter, value) => { if (typeof object?.[getter] !== 'function' || typeof object?.[setter] !== 'function') return; const before = object[getter](); if (before === value) return; object[setter](value); state.restores.push(() => object[setter](before)); changed++; };
      for (const attribute of list(form.data.entity.attributes)) override(attribute, 'getRequiredLevel', 'setRequiredLevel', 'none');
      for (const control of list(form.ui.controls)) { override(control, 'getVisible', 'setVisible', true); override(control, 'getDisabled', 'setDisabled', false); }
      for (const tab of list(form.ui.tabs)) { override(tab, 'getVisible', 'setVisible', true); for (const section of list(tab.sections)) override(section, 'getVisible', 'setVisible', true); }
      outcome = result('Form overrides', `${changed} client states changed. Server permissions still apply. Use Restore form overrides to revert them.`);
    } else if (action === 'form:restore-overrides') {
      requireForm(); const restored = state.restore(); outcome = result('Form overrides restored', `${restored.restored} states restored.${restored.unavailable ? ` ${restored.unavailable} controls are no longer available.` : ''}`);
    } else if (action === 'form:toggle-autosave') {
      requireForm(); const owner = form.data.entity; if (!owner.addOnSave || !owner.removeOnSave) fail('Native save-handler registration and removal are required.');
      if (typeof params.enabled !== 'boolean') fail('Choose whether to block autosave.', 'error');
      if (state.guard) { state.guard.entity.removeOnSave(state.guard.handler); state.guard = undefined; }
      if (params.enabled) { const handler = execution => { const args = execution.getEventArgs(); if (args.getSaveMode() === 70) args.preventDefault(); }; owner.addOnSave(handler); state.guard = { entity: owner, handler }; }
      outcome = result('Autosave guard', params.enabled ? 'Autosave mode 70 is blocked. Save and Save & Close are unchanged.' : 'This session’s autosave guard was removed.');
    } else if (action === 'form:refresh-autosave-off') {
      requireForm(); if (!form.data.refresh) fail('Native form refresh is unavailable.');
      if (safe(() => form.data.entity.getIsDirty()) && !window.confirm('Discard unsaved changes and refresh this native record?')) fail('The draft was kept.', 'cancelled');
      await form.data.refresh(false); outcome = result('Record refreshed', 'Refreshed without saving. Autosave behavior was not changed.');
    } else if (action === 'form:clone-record') {
      requireForm(); if (!xrm?.Navigation?.openForm) fail('Native create-form navigation is unavailable.');
      const definition = await metadata(entity()), attributes = await get(`EntityDefinitions(LogicalName='${entity()}')/Attributes?$select=LogicalName,IsValidForCreate,AttributeType,IsPrimaryId`), allowed = new Map((attributes.value ?? []).filter(field => field.IsValidForCreate === true && !field.IsPrimaryId).map(field => [field.LogicalName, field]));
      const values = {};
      for (const attribute of list(form.data.entity.attributes)) {
        const name = logical(attribute.getName()), field = allowed.get(name), value = attribute.getValue(); if (!field || name === definition.PrimaryIdAttribute || value === undefined || value === null || ['createdon', 'modifiedon', 'createdby', 'modifiedby', 'ownerid', 'statecode', 'statuscode'].includes(name)) continue;
        const type = String(field.AttributeType ?? attribute.getAttributeType?.() ?? '').toLowerCase();
        if (['file', 'image', 'managedproperty', 'partylist'].includes(type) || type === 'virtual' && !(Array.isArray(value) && value.every(item => Number.isInteger(item)))) continue;
        if (type === 'lookup' || type === 'customer' || type === 'owner') { if (!Array.isArray(value) || value.length !== 1) continue; values[name] = guid(value[0].id); values[name + 'name'] = String(value[0].name ?? ''); values[name + 'type'] = logical(value[0].entityType); }
        else if (value instanceof Date) values[name] = value.toISOString();
        else if (Array.isArray(value) && value.every(item => Number.isInteger(item))) values[name] = value.join(',');
        else if (['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))) values[name] = value;
      }
      requestForm({ entityName: entity(), openInNewWindow: true }, values); outcome = result('Clone draft requested', 'Requested an unsaved create form with the eligible draft values. No record was created by this action. Native main forms do not report opening completion.');
    } else if (action === 'form:open-editor') {
      requireForm(); const id = guid(captured.form), solutionId = await solution(); await openUrl(`${portal('maker')}/e/${environment()}/s/${solutionId}/entity/${entity()}/form/edit/${id}`); outcome = result('Form editor', 'Opened the current native form editor.');
    } else if (action === 'form:table-processes') {
      requireForm(); const name = entity(), workflows = await get(`workflows?$select=workflowid,name,category,type,mode&$filter=primaryentity%20eq%20'${name}'%20and%20statecode%20eq%201&$top=200`), apis = await get(`customapis?$select=customapiid,uniquename,displayname&$filter=bindingtype%20eq%201%20and%20boundentitylogicalname%20eq%20'${name}'&$top=200`);
      const categories = { 2: 'Business rule', 3: 'Action', 4: 'Business process flow', 5: 'Flow' };
      outcome = rowsResult('Table processes', ['Kind', 'Name', 'ID'], [...(workflows.value ?? []).map(row => [categories[row.category] ?? (row.mode === 1 ? 'Realtime workflow' : 'Background workflow'), row.name, row.workflowid]), ...(apis.value ?? []).map(row => ['Custom API', row.displayname ?? row.uniquename, row.customapiid])], 'Active workflows and table-bound custom APIs. Native paging may contain additional results.');
      outcome.links = [...(workflows.value ?? []).map(row => ({ entity: 'workflow', id: row.workflowid, label: row.name })), ...(apis.value ?? []).map(row => ({ entity: 'customapi', id: row.customapiid, label: row.displayname ?? row.uniquename }))].slice(0, 200).filter(row => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id ?? '')).map(row => ({ label: bounded(row.label), url: pageUrl(row.entity, row.id, 'entityrecord').href }));
    } else if (action === 'navigation:open-record-by-id' || action === 'navigation:new-record') {
      if (!xrm?.Navigation?.openForm) fail('Native form navigation is unavailable.'); const name = logical(params.entity); await metadata(name); requestForm({ entityName: name, ...(action.endsWith('open-record-by-id') ? { entityId: guid(params.id) } : {}), openInNewWindow: true }); outcome = result('Native form requested', action.endsWith('new-record') ? 'Requested an unsaved create form. Native main forms do not report opening completion.' : 'Requested the native record form. Native main forms do not report opening completion.');
    } else if (action === 'navigation:pin-to-side-panel') {
      if (!xrm?.App?.sidePanes?.createPane || !xrm?.Utility?.getPageContext) fail('Native app side panes are unavailable.');
      const input = xrm.Utility.getPageContext().input; if (!['entityrecord', 'entitylist'].includes(input?.pageType)) fail('This page cannot be pinned as a native table or record pane.');
      const pane = await xrm.App.sidePanes.createPane({ canClose: true });
      if (!live()) { try { await pane.close?.(); } catch { /* The new pane may already be closed. */ } fail('The app changed before the native pane was ready.', 'cancelled'); }
      state.panes.push(pane); await pane.navigate({ pageType: input.pageType, entityName: logical(input.entityName), ...(input.pageType === 'entityrecord' ? { entityId: guid(input.entityId ?? captured.id) } : {}) }); outcome = result('Native side pane', 'Opened the current page in a native side pane.');
    } else if (action.startsWith('navigation:')) {
      let url;
      if (action === 'navigation:open-list') { const name = logical(params.entity); await metadata(name); url = pageUrl(name); }
      else if (action === 'navigation:open-system-jobs') url = pageUrl('asyncoperation');
      else if (action === 'navigation:open-processes') url = pageUrl('workflow');
      else if (action === 'navigation:open-mailboxes') url = pageUrl('mailbox');
      else if (action === 'navigation:open-main') url = pageUrl(undefined, undefined, null);
      else if (action === 'navigation:open-advanced-find') url = pageUrl(undefined, undefined, 'advancedfind');
      else if (action === 'navigation:open-mobile-client') { const unique = context?.organizationSettings?.uniqueName; if (typeof unique !== 'string' || !unique) fail('The native organization name is unavailable.'); url = new URL(`${client()}/nga/main.htm`); url.searchParams.set('org', unique); url.searchParams.set('server', client()); }
      else if (action === 'navigation:open-solutions') url = `${portal('maker')}/environments/${environment()}/solutions`;
      else if (action === 'navigation:open-solutions-history') url = `${portal('maker')}/environments/${environment()}/solutionsHistory`;
      else if (action === 'navigation:open-power-platform-admin') url = `${portal('admin')}/environments/environment/${environment()}/hub`;
      else if (action === 'navigation:open-security') url = `${portal('admin')}/environments/environment/${environment()}/hub`;
      else fail('This navigation operation is not supported.');
      await openUrl(String(url)); outcome = result('Native navigation', action === 'navigation:open-security' ? 'Opened this environment’s admin hub. Use its security settings to manage users and permissions.' : 'Opened the selected native destination.');
    } else if (action.startsWith('debugging:')) {
      const changes = { 'debugging:forms-monitor': ['monitor', 'true'], 'debugging:ribbon-debugger': ['ribbondebug', 'true'], 'debugging:perf-center': ['perf', 'true'], 'debugging:disable-form-handlers': ['flags', 'DisableFormHandlers=true'], 'debugging:disable-business-rules': ['flags', 'DisableFormHandlers=businessrule'], 'debugging:disable-form-libraries': ['flags', 'DisableFormLibraries=true'], 'debugging:enable-dark-mode': ['flags', 'themeoption=darkmode'] }, flags = new Set(['DisableFormHandlers=true', 'DisableFormHandlers=businessrule', 'DisableFormLibraries=true', 'themeoption=darkmode']), url = new URL(location.href);
      if (action === 'debugging:clear-flags') url.search = new URLSearchParams([...url.searchParams].filter(([name, value]) => !(name === 'flags' && flags.has(value)) && !(['monitor', 'ribbondebug', 'perf'].includes(name) && value === 'true'))).toString();
      else { const change = changes[action]; if (!change) fail('Unknown diagnostic operation.'); if (!url.searchParams.getAll(change[0]).includes(change[1])) url.searchParams.append(...change); }
      if (safe(() => form?.data?.entity?.getIsDirty()) && !window.confirm('Reload this native app and discard the unsaved draft?')) fail('The draft was kept.', 'cancelled');
      check(); if (url.href === location.href) outcome = result('Native diagnostics', 'The selected diagnostic option is already applied.');
      else { deliver(result('Native diagnostics', 'Reloading with the selected native diagnostic options.')); location.assign(url.href); return ack(true); }
    } else fail('This action is not part of the fixed native operation contract.');
    check(); deliver(outcome);
  } catch (error) {
    if (receiver()) deliver({ status: !live() ? 'cancelled' : error.status ?? 'error', title: 'Model-driven action', message: !live() ? 'The app or record changed. Run the action again on the current page.' : String(error.message ?? 'The action failed.').slice(0, 1000) });
  } finally { if (state.pending.get(requestId) === marker) state.pending.delete(requestId); }
  return ack(true);
}

/** Retire only this inspector's browser-local action state. */
export function disposeModelDrivenActions({ origin, token }) {
  if (location.origin !== origin) return;
  const host = (document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector')), state = host?.__paqModelActionState;
  if (state?.token === token) { state.dispose(); delete host.__paqModelActionState; }
}
