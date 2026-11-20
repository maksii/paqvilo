// Fixed native operations only: no eval, extension runtime or third-party scripts are executed
// by this module.

/** Passive API presence checks. Do not call getId/getValue or read form values here. */
export function modelDrivenActionAvailability({ origin, actions = [], localSimulation = false }) {
  // Inside the function: page.evaluate serializes this function alone.
  const REQUIREMENT_TEXT = {
    metadata:
      'This app does not report its Web API version (getGlobalContext().getVersion), so table metadata cannot be read.',
    environment: localSimulation
      ? 'Opens a page of a real Power Platform environment; local simulation has none.'
      : 'This app does not report its Power Platform environment ID.',
    organization: 'This app does not report its organization unique name.',
    privileges: 'This app does not expose the security role privileges of the signed-in user.',
    navigate: 'This app cannot open addresses (Xrm.Navigation.openUrl).',
    'open-form': 'This app cannot open forms from a script (Xrm.Navigation.openForm).',
    'side-panes': 'This app has no side panes (Xrm.App.sidePanes).',
    'form-selector': 'This form does not report which form is open (formSelector).',
    'save-events': 'This form does not expose save events.',
    refresh: 'This form cannot be refreshed from a script.',
    context: 'This app does not expose its global context.',
    subgrids: 'No subgrid on this form can be refreshed from a script (formContext.ui.controls).',
    prefill: 'Mirage cannot open a new form with prefilled values, so it cannot prepare a clone.',
  };
  const missingReason = (missing, onRecord) => {
    if (['form', 'saved-record'].includes(missing) && !onRecord)
      return 'Open a record form to use this; this page is not a form.';
    if (missing === 'saved-record') return 'Save the record first; this form has no saved record yet.';
    if (!missing) return undefined;
    return REQUIREMENT_TEXT[missing] ?? 'Not available on this page.';
  };
  // A bounded client API (or a native getter) may throw for an unsupported member;
  // that member is unavailable, never a failure of every other check.
  const safe = (callback) => {
    try {
      return callback();
    } catch {
      return undefined;
    }
  };
  const xrm = globalThis.Xrm,
    form = safe(() => xrm?.Page),
    context = safe(() => xrm?.Utility?.getGlobalContext()),
    type = safe(() => form?.ui?.getFormType());
  // The page decides what a form action can work on: the native page context, else the address (pagetype). A list,
  // dashboard or custom page has no form even when the app keeps an Xrm.Page object around.
  const pageType =
    safe(() => xrm?.Utility?.getPageContext?.()?.input?.pageType) ??
    new URLSearchParams(location.search).get('pagetype') ??
    undefined;
  const onRecord =
    pageType === undefined ? Boolean(safe(() => form?.data?.entity?.getEntityName?.())) : pageType === 'entityrecord';
  const checks = {
    context: () => context,
    form: () => onRecord && form?.data?.entity && form?.ui,
    'saved-record': () => onRecord && form?.data?.entity?.getId && type !== 1,
    metadata: () => context?.getClientUrl && context?.getVersion && globalThis.fetch,
    'open-form': () => typeof xrm?.Navigation?.openForm === 'function',
    navigate: () => context?.getClientUrl && xrm?.Navigation?.openUrl,
    refresh: () => typeof form?.data?.refresh === 'function',
    'save-events': () => form?.data?.entity?.addOnSave && form?.data?.entity?.removeOnSave,
    'side-panes': () => xrm?.App?.sidePanes?.createPane && xrm?.Utility?.getPageContext,
    'form-selector': () => form?.ui?.formSelector?.getCurrentItem,
    environment: () => context?.organizationSettings?.bapEnvironmentId,
    organization: () => context?.organizationSettings?.uniqueName,
    privileges: () => typeof context?.userSettings?.getSecurityRolePrivilegesInfo === 'function',
    // The control types only, never values: a subgrid control the client API exposes with refresh().
    subgrids: () => {
      const found = [];
      safe(() => form.ui.controls.forEach((control) => found.push(control)));
      return found.some(
        (control) => safe(() => control.getControlType()) === 'subgrid' && typeof control.refresh === 'function',
      );
    },
    // Mirage opens forms only in this tab and ignores form parameters.
    prefill: () => !localSimulation,
  };
  return actions.map((action) => {
    const missing = action.requirements?.find((requirement) => !checks[requirement] || !safe(checks[requirement]));
    const reason =
      location.origin !== origin ? 'The app left this Lense environment.' : missingReason(missing, onRecord);
    return {
      id: action.id,
      available: location.origin === origin && !missing,
      reason,
      needsRecord: ['form', 'saved-record'].includes(missing) && !onRecord,
    };
  });
}

/** page.evaluate-serializable. Private results go straight to the owned browser UI.
 * The returned acknowledgement never contains record identity, values or errors.
 */
/* NOSONAR */ export async function runModelDrivenAction({
  origin,
  token,
  action,
  params = {},
  requestId,
  cloud = {},
  localSimulation = false,
}) {
  const ack = (accepted) => ({ accepted, requestId });
  const host = document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector');
  const receiver = () =>
    location.origin === origin &&
    host?.isConnected &&
    host.__paqModelActions?.token === token &&
    !globalThis.__paqviloRetiredModelInspectors?.includes(token)
      ? host.__paqModelActions
      : undefined;
  /* NOSONAR */ if (window.top !== globalThis || !receiver() || typeof requestId !== 'string' || requestId.length > 100)
    return ack(false);
  /* NOSONAR: identical bodies capture different state */ const safe = (callback) => {
    try {
      return callback();
    } catch {
      return undefined;
    }
  };
  const fail = (message, status = 'unsupported') => {
    throw Object.assign(new Error(message), { status });
  };
  const logical = (value) =>
    typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/i.test(value)
      ? value.toLowerCase()
      : fail('The table logical name is unavailable.');
  const guid = (value) =>
    typeof value === 'string' &&
    /* NOSONAR */ /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.test(
      value,
    )
      ? value.replace(/[{}]/g, '').toLowerCase()
      : fail('A saved record GUID is required.');
  const xrm = globalThis.Xrm,
    context = safe(() => xrm?.Utility?.getGlobalContext()),
    form = safe(() => xrm?.Page);
  const target = () => ({
    entity:
      safe(() => globalThis.Xrm?.Page?.data?.entity?.getEntityName()) ??
      new URLSearchParams(location.search).get('etn'),
    id: safe(() => globalThis.Xrm?.Page?.data?.entity?.getId()) ?? '',
    form: safe(() => globalThis.Xrm?.Page?.ui?.formSelector?.getCurrentItem()?.getId()) ?? '',
    actor: safe(() => globalThis.Xrm?.Utility?.getGlobalContext()?.userSettings?.userId) ?? '',
    route: location.pathname + location.search,
  });
  const captured = target(),
    key = JSON.stringify(captured);
  let state = host.__paqModelActionState;
  if (state?.token !== token || state?.retired) {
    state?.dispose();
    state = undefined;
  }
  if (!state) {
    state = {
      token,
      key,
      pending: new Map(),
      controllers: new Set(),
      restores: [],
      labels: [],
      panes: [],
      guard: undefined,
      retired: false,
    };
    state.restore = () => {
      let restored = 0,
        unavailable = 0;
      for (const callback of state.restores.splice(0).reverse()) {
        try {
          callback();
          restored++;
        } catch {
          unavailable++;
        }
      }
      return { restored, unavailable };
    };
    // The page changes of this session still in place, by the action that made them: its panel row offers Reset.
    state.active = () => ({
      'form:show-logical-names': state.labels.length > 0,
      'form:god-mode': state.restores.length > 0,
      'form:toggle-autosave': Boolean(state.guard),
      'navigation:pin-to-side-panel': state.panes.length > 0,
    });
    state.clearLabels = () => {
      const labels = state.labels.splice(0);
      for (const node of labels) node.remove();
      return labels.length;
    };
    state.cancelPending = () => {
      state.pending.clear();
      for (const controller of state.controllers) controller.abort();
      state.controllers.clear();
    };
    state.clearTarget = () => {
      state.cancelPending();
      state.restore();
      state.clearLabels();
      if (state.guard) {
        safe(() => state.guard.entity.removeOnSave(state.guard.handler));
        state.guard = undefined;
      }
    };
    state.dispose = () => {
      state.retired = true;
      clearInterval(state.timer);
      state.clearTarget();
      for (const pane of state.panes.splice(0)) {
        try {
          Promise.resolve(pane.close?.()).catch(() => {});
        } catch {
          /* A native pane may already be closed. */
        }
      }
    };
    // This starts only after an explicit action. Passive inspection never reads
    // record identity; the action lifetime revokes itself after a target change.
    state.timer = setInterval(() => {
      if (!receiver()) state.dispose();
      else {
        const next = JSON.stringify(target());
        if (next !== state.key) {
          state.clearTarget();
          state.key = next;
          safe(() => receiver()?.contextChanged?.());
        }
      }
    }, 250);
    Object.defineProperty(host, '__paqModelActionState', { value: state, writable: true, configurable: true });
  }
  if (state.key !== key) {
    state.clearTarget();
    state.key = key;
  }
  const marker = {},
    // Page changes this request records after this index are its own; a failure reverts them.
    firstRestore = state.restores.length,
    // Badges and side panes this request added; a failure removes them too.
    rollback = [];
  const drop = (items, item) => {
    const at = items.indexOf(item);
    if (at !== -1) items.splice(at, 1);
  };
  state.pending.set(requestId, marker);
  const live = () =>
    receiver() && !state.retired && state.pending.get(requestId) === marker && JSON.stringify(target()) === key;
  const deliver = (value) => {
    try {
      receiver()?.receive(requestId, value);
    } catch {
      /* Private UI errors must not become agent or Node result payloads. */
    }
  };
  const check = () => {
    if (!live()) fail('The app or record changed. Run the action again on the current page.', 'cancelled');
  };
  const text = (value) => {
    if (value == null) return value === null ? '[NULL]' : '';
    if (typeof value === 'object') return value instanceof Date ? value.toISOString() : JSON.stringify(value);
    return String(value);
  };
  const bounded = (value) => text(value).slice(0, 4000);
  const rowsResult = (title, columns, rows, message = '') => ({
    status: 'ok',
    title,
    columns,
    rows: rows.slice(0, 200).map((row) => row.map(bounded)),
    message: message + (rows.length > 200 ? ' Showing the first 200 rows.' : ''),
  });
  const result = (title, message, extra = {}) => ({ status: 'ok', title, message, ...extra });
  const list = (collection) => {
    if (!collection) return [];
    const all = safe(() => collection.get());
    if (Array.isArray(all)) return all;
    const entries = [];
    collection.forEach?.((entry) => entries.push(entry));
    return entries;
  };
  const requireForm = () => (form?.data?.entity && form?.ui ? form : fail('Open a record form first.'));
  const entity = () => logical(captured.entity);
  const recordId = () => guid(captured.id);
  const client = () => {
    if (!context?.getClientUrl) fail('This app does not report its address (getClientUrl).');
    const url = new URL(context.getClientUrl());
    if (url.origin !== origin || url.username || url.password || url.search || url.hash)
      fail('The app reports an address that does not match this Lense environment.');
    return url.href.replace(/\/$/, '');
  };
  const apiRoot = () => {
    const version = /^(\d+)\.(\d+)(?:\.|$)/.exec(context?.getVersion?.() ?? '');
    if (!version) fail('This app does not report its Web API version.');
    return `${client()}/api/data/v${version[1]}.${version[2]}/`;
  };
  const get = async (path) => {
    check();
    const controller = new AbortController();
    state.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);
    try {
      const response = await fetch(apiRoot() + path, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          prefer:
            'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname"',
        },
      });
      check();
      if (!response.ok)
        throw Object.assign(new Error(`The Web API request failed (HTTP ${response.status}).`), {
          status: 'error',
          http: response.status,
        });
      const limit = 2 * 1024 * 1024;
      if (!response.body?.getReader) fail('The Web API answer could not be read.', 'error');
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          check();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) {
            await reader.cancel().catch(() => {});
            fail('The Web API answer is larger than 2 MiB.', 'error');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const body = new TextDecoder().decode(bytes);
      check();
      try {
        return JSON.parse(body);
      } catch {
        fail('The Web API did not answer with JSON.', 'error');
      }
    } catch (error) {
      check();
      if (timedOut) fail('The Web API did not answer within 10 seconds.', 'error');
      throw error;
    } finally {
      clearTimeout(timer);
      state.controllers.delete(controller);
    }
  };
  const metadata = async (name) => {
    const definition = await get(
      `EntityDefinitions(LogicalName='${logical(name)}')?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`,
    ).catch((error) => {
      if (error.http === 404)
        fail(`This environment has no table named ${logical(name)}. Check the logical name.`, 'error');
      throw error;
    });
    if (!/^[a-z]\w*$/i.test(definition.EntitySetName ?? '')) fail('The table metadata has no entity set.');
    return definition;
  };
  const openUrl = async (value) => {
    check();
    if (!xrm?.Navigation?.openUrl) fail('This app cannot open addresses (Xrm.Navigation.openUrl).');
    await xrm.Navigation.openUrl(value);
  };
  const requestForm = (options, values) => {
    check();
    // Full main forms do not invoke openForm's success callback. Its promise
    // can remain pending even after the form opens; only quick-create Save has
    // a success result. Report dispatch and retain bounded private late errors.
    const operation = xrm.Navigation.openForm(options, values);
    Promise.resolve(operation).catch((error) => {
      if (receiver() && !state.retired && JSON.stringify(target()) === key)
        safe(() =>
          receiver()?.followup?.(requestId, {
            status: 'error',
            title: 'Form did not open',
            message: String(error?.message ?? 'The app could not open the form.').slice(0, 1000),
          }),
        );
    });
  };
  const pageUrl = (name, id, type = 'entitylist') => {
    const url = new URL(`${client()}/main.aspx`),
      current = new URLSearchParams(location.search);
    for (const parameter of ['appid', 'appname'])
      if (current.get(parameter)) url.searchParams.set(parameter, current.get(parameter));
    if (type) url.searchParams.set('pagetype', type);
    if (name) url.searchParams.set('etn', logical(name));
    if (id) url.searchParams.set('id', guid(id));
    return url;
  };
  const environment = () => {
    const id = context?.organizationSettings?.bapEnvironmentId;
    if (
      typeof id !== 'string' ||
      !/^(?:Default-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      fail('This app does not report its Power Platform environment ID.');
    return id;
  };
  const portal = (name) => {
    const defaults = {
      maker: 'https://make.powerapps.com',
      admin: 'https://admin.powerplatform.microsoft.com',
      automate: 'https://make.powerautomate.com',
    };
    const configured = cloud[name];
    if (!configured && !/^https:\/\/[^/]+\.crm\d*\.dynamics\.com$/i.test(client()))
      fail('Configure the maker/admin origins for this environment’s cloud.');
    const url = new URL(configured ?? defaults[name]);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      fail('The configured cloud portal origin is invalid.');
    return url.origin;
  };
  const solution = async () => {
    let id;
    try {
      const preferred = await get('GetPreferredSolution()');
      id = preferred.solutionid;
    } catch (error) {
      if (error.status === 'cancelled') throw error;
    }
    if (!id) {
      const defaults = await get("solutions?$select=solutionid&$filter=uniquename%20eq%20'Default'&$top=1");
      id = defaults.value?.[0]?.solutionid;
    }
    return guid(id);
  };
  try {
    let outcome;
    if (action === 'identity:users') {
      const query = params.query ?? '';
      // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
      if (typeof query !== 'string' || query.length > 100 || /[\x00-\x1f\x7f]/.test(query))
        fail('Enter a user search of at most 100 characters.', 'error');
      const filter =
        'isdisabled eq false and azureactivedirectoryobjectid ne null' +
        (query.trim()
          ? ` and (contains(fullname,'${query.trim().replaceAll("'", "''")}') or contains(domainname,'${query.trim().replaceAll("'", "''")}'))`
          : '');
      const users = await get(
        `systemusers?$select=systemuserid,fullname,domainname,azureactivedirectoryobjectid&$filter=${encodeURIComponent(filter)}&$orderby=fullname&$top=100`,
      );
      const choices = (users.value ?? [])
        .slice(0, 100)
        .filter(
          (user) =>
            /^[0-9a-f-]{36}$/i.test(user.systemuserid ?? '') &&
            /^[0-9a-f-]{36}$/i.test(user.azureactivedirectoryobjectid ?? ''),
        )
        .map((user) => ({
          id: guid(user.systemuserid),
          objectId: guid(user.azureactivedirectoryobjectid),
          label: bounded(user.fullname),
          name: bounded(user.fullname),
          domain: bounded(user.domainname),
        }));
      outcome = {
        ...rowsResult(
          'Users',
          ['Name', 'Domain', 'User ID', 'Directory object ID'],
          choices.map((user) => [user.name, user.domain, user.id, user.objectId]),
          'Enabled users with a Microsoft Entra ID, application users included (at most 100). Pick one below to act as that user.',
        ),
        users: choices,
      };
    } else if (action === 'identity:status') {
      const user = context?.userSettings;
      if (typeof user?.getSecurityRolePrivilegesInfo !== 'function')
        fail('This app does not expose the security role privileges of the signed-in user.');
      const privileges = await user.getSecurityRolePrivilegesInfo();
      check();
      const allowed = Object.values(privileges ?? {}).some(
        (privilege) => privilege.privilegeName === 'prvActOnBehalfOfAnotherUser',
      );
      outcome = result(
        'Signed-in user',
        allowed
          ? 'You may act as another user (Act on Behalf of Another User). Server permissions still apply to each request.'
          : 'You may not act as another user: your security roles lack Act on Behalf of Another User.',
        { identity: { canImpersonate: allowed, signedInUserId: guid(user.userId), name: bounded(user.userName) } },
      );
    } else if (action === 'admin:environment-context') {
      if (!context) fail('This app does not expose its global context.');
      // Each value is read on its own; one the app does not report (a local simulator has no Power Platform
      // environment) is left out of the list.
      const org = safe(() => context.organizationSettings) ?? {},
        user = safe(() => context.userSettings) ?? {},
        read = (owner, key) => safe(() => owner[key]);
      outcome = rowsResult(
        'Environment and signed-in user',
        ['Property', 'Value'],
        [
          ['Client URL', client()],
          ['Version', safe(() => context.getVersion?.())],
          ['Environment ID', read(org, 'bapEnvironmentId')],
          ['Organization ID', read(org, 'organizationId')],
          ['Unique name', read(org, 'uniqueName')],
          ['User ID', read(user, 'userId')],
          ['User name', read(user, 'userName')],
          ['Language', read(user, 'languageId')],
          [
            'Roles',
            list(user.roles)
              .map((role) => role.name)
              .join(', '),
          ],
        ].filter(([, value]) => value != null && value !== ''),
      );
    } else if (action === 'form:record-id' || action === 'form:record-url') {
      requireForm();
      const id = recordId(),
        value = action.endsWith('record-id')
          ? id
          : (() => {
              const url = pageUrl(entity(), id, 'entityrecord');
              const formId = safe(() => guid(captured.form));
              if (formId) url.searchParams.set('formid', formId);
              return url.href;
            })();
      outcome = result(action.endsWith('record-id') ? 'Record ID' : 'Record URL', value, { copyText: value });
    } else if (action === 'form:show-logical-names' || action === 'form:clear-logical-names') {
      requireForm();
      const removed = state.clearLabels();
      let count = 0;
      if (action.endsWith('show-logical-names')) {
        // Inline and !important: the app's own button and label rules cannot resize or move a badge, and an app whose
        // Content-Security-Policy refuses injected <style> elements (Mirage does) still applies it.
        const look =
          'position:absolute!important;z-index:2!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:flex-start!important;width:max-content!important;height:auto!important;margin:0!important;padding:0 4px!important;font:11px/15px Consolas,monospace!important;letter-spacing:0!important;text-transform:none!important;text-indent:0!important;color:#005a9e!important;background:#eff6fc!important;border:1px solid #c7e0f4!important;border-radius:2px!important;white-space:normal!important;overflow-wrap:anywhere!important;text-align:left!important;cursor:copy!important;';
        for (const attribute of list(form.data.entity.attributes).slice(0, 200)) {
          const name = safe(() => attribute.getName());
          if (!/^[a-z]\w*$/i.test(name ?? '')) continue;
          const nodes = [...document.querySelectorAll('[data-id],[id]')].filter(
            (node) =>
              node.id === `${name}_c` ||
              /* NOSONAR */ node.getAttribute('data-id') === name ||
              node.getAttribute('data-id')?.startsWith(name + '.fieldControl'), // NOSONAR: reads attributes of observed DOM, dataset would differ
          );
          const node =
            nodes.find((node) => !['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) ?? nodes[0]?.parentElement;
          if (node?.getRootNode() !== document) continue;
          const label = document.createElement('button');
          label.type = 'button';
          label.textContent = name;
          label.dataset.paqModelLogicalName = '';
          // The click answers on the label itself: it says the name was copied, or that the browser refused.
          const answer = (text) => {
            label.textContent = text;
            clearTimeout(label.paqAnswer);
            label.paqAnswer = setTimeout(() => {
              label.textContent = name;
            }, 1500);
          };
          label.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            Promise.resolve(navigator.clipboard?.writeText(name) ?? Promise.reject(new Error('no clipboard'))).then(
              () => answer(`${name} copied`),
              () => answer(`${name}: copy blocked`),
            );
          });
          // Out of flow, so the form's grid or flex layout keeps every cell where it was. The badge takes the place of
          // the label text: it starts at the label's content box and is at least as wide and tall, so it covers the
          // display name (kept in the tooltip) and never reaches the control and its value. A name longer than the
          // label grows the badge to at most 24 characters, then wraps. A field without a visible label gets the badge
          // just above its top-left corner.
          const found = node.tagName === 'LABEL' ? node : node.querySelector('label'),
            caption = found?.getClientRects().length ? found : null;
          if (caption) {
            const box = caption.getBoundingClientRect(),
              style = getComputedStyle(caption),
              inset = (...sides) => sides.reduce((sum, side) => sum + (Number.parseFloat(style[side]) || 0), 0);
            const width = Math.max(
                0,
                box.width - inset('paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'),
              ),
              height = Math.max(
                0,
                box.height - inset('paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'),
              );
            // The display name without the required marker the app appends to the caption (Name*).
            label.title = `${caption.textContent.trim().replace(/\s*\*+$/, '')} · click to copy ${name}`;
            label.style.cssText = `${look}min-width:${width}px!important;max-width:max(${width}px,24ch)!important;min-height:${height}px!important;`;
            caption.prepend(label);
          } else {
            label.title = `Click to copy ${name}`;
            label.style.cssText = `${look}margin-top:-17px!important;`;
            node.prepend(label);
          }
          state.labels.push(label);
          rollback.push(() => {
            drop(state.labels, label);
            label.remove();
          });
          count++;
        }
      }
      outcome = result(
        'Logical names',
        action.endsWith('clear-logical-names')
          ? `Reset: ${removed} logical-name ${removed === 1 ? 'label' : 'labels'} removed.`
          : `${count} field labels show their logical names. Point at one for the display name; click it to copy the logical name.`,
      );
    } else if (action === 'form:changed-fields') {
      requireForm();
      const rows = list(form.data.entity.attributes)
        .filter((attribute) => safe(() => attribute.getIsDirty()) === true)
        .map((attribute) => [
          safe(() => attribute.getName()),
          safe(() => attribute.getAttributeType()),
          safe(() => attribute.getValue()),
        ]);
      outcome = rowsResult(
        'Changed fields',
        ['Column', 'Type', 'Unsaved value'],
        rows,
        rows.length ? '' : 'No field has unsaved changes.',
      );
    } else if (action === 'form:show-optionset-values') {
      requireForm();
      const rows = [];
      for (const attribute of list(form.data.entity.attributes)) {
        const options = safe(() => attribute.getOptions());
        if (!Array.isArray(options)) continue;
        for (const option of options) rows.push([safe(() => attribute.getName()), option.text, option.value]);
      }
      outcome = rowsResult(
        'Choice values',
        ['Column', 'Label', 'Value'],
        rows,
        rows.length ? '' : 'This form has no choice fields.',
      );
    } else if (action === 'form:all-fields') {
      requireForm();
      const definition = await metadata(entity()),
        saved = await get(`${definition.EntitySetName}(${recordId()})`);
      outcome = rowsResult(
        'Saved record fields',
        ['Column', 'Saved value', 'Formatted value'],
        Object.keys(saved)
          .filter((name) => !name.includes('@'))
          .sort(/* NOSONAR: preserve default string coercion */)
          .map((name) => [name, saved[name], saved[name + '@OData.Community.Display.V1.FormattedValue']]),
        'Values saved on the server; unsaved changes on the form are not included.',
      );
      outcome.hideEmpty = true;
    } else if (action === 'form:open-web-api') {
      requireForm();
      const definition = await metadata(entity()),
        url = `${apiRoot()}${definition.EntitySetName}(${recordId()})`;
      await openUrl(url);
      // The address carries the record and environment IDs; the action's row already names what opened.
      outcome = result('Record Web API', 'Opened in a new tab.');
    } else if (action === 'form:refresh-subgrids') {
      requireForm();
      const grids = list(form.ui.controls).filter((control) => safe(() => control.getControlType()) === 'subgrid');
      let refreshed = 0;
      for (const grid of grids)
        if (typeof grid.refresh === 'function') {
          check();
          await grid.refresh();
          refreshed++;
        }
      if (!refreshed) fail('No subgrid on this form can be refreshed from a script (formContext.ui.controls).');
      outcome = result('Subgrids', `Refreshed ${refreshed} subgrid${refreshed === 1 ? '' : 's'}.`);
    } else if (action === 'form:god-mode') {
      requireForm();
      if (state.restores.length)
        fail('Restore this session’s existing form overrides before applying them again.', 'error');
      let changed = 0;
      // How many states of each kind changed; the result names only those kinds.
      const kinds = new Map();
      // A control the app refuses to change (Mirage does not render header and footer controls) is skipped and named
      // in the result; it does not undo the states that did change.
      const refused = new Map();
      const override = (object, getter, setter, value, kind) => {
        if (typeof object?.[getter] !== 'function' || typeof object?.[setter] !== 'function') return;
        try {
          const before = object[getter]();
          if (before === value) return;
          object[setter](value);
          state.restores.push(() => object[setter](before));
          changed++;
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        } catch {
          const name = safe(() => object.getName?.()) || 'unnamed';
          if (!refused.has(name)) refused.set(name, safe(() => object.getLabel?.()) || name);
        }
      };
      for (const attribute of list(form.data.entity.attributes))
        override(attribute, 'getRequiredLevel', 'setRequiredLevel', 'none', 'required');
      for (const control of list(form.ui.controls)) {
        override(control, 'getVisible', 'setVisible', true, 'control');
        override(control, 'getDisabled', 'setDisabled', false, 'locked');
      }
      for (const tab of list(form.ui.tabs)) {
        override(tab, 'getVisible', 'setVisible', true, 'tab');
        for (const section of list(tab.sections)) override(section, 'getVisible', 'setVisible', true, 'section');
      }
      // "3 header fields can't be changed here: Status, Budget, Remaining", by display name.
      const refusedText = (keys, labels) => {
        const where = ['header', 'footer'].find((region) => keys.every((key) => key.startsWith(`${region}_`)));
        const shown = labels.slice(0, 20).map(bounded).join(', ') + (labels.length > 20 ? ', and more' : '');
        return `${keys.length}${where ? ` ${where}` : ''} ${keys.length === 1 ? 'field' : 'fields'} can't be changed here: ${shown}.`;
      };
      const names = [...refused.keys()],
        counted = (kind, one, many, done) => {
          const n = kinds.get(kind);
          return n ? [`${n} ${n === 1 ? one : many} ${done}`] : [];
        },
        made = [
          ...counted('control', 'hidden control', 'hidden controls', 'shown'),
          ...counted('tab', 'hidden tab', 'hidden tabs', 'shown'),
          ...counted('section', 'hidden section', 'hidden sections', 'shown'),
          ...counted('locked', 'locked control', 'locked controls', 'enabled'),
          ...counted('required', 'required field', 'required fields', 'made optional'),
        ];
      outcome = result(
        'Form overrides',
        (changed
          ? `${changed} ${changed === 1 ? 'change' : 'changes'} on this form: ${made.join(', ')}. Server permissions still apply.`
          : 'Nothing to change on this form: nothing is hidden, locked or required.') +
          (names.length ? `\n${refusedText(names, [...refused.values()])}` : ''),
      );
    } else if (action === 'form:restore-overrides') {
      requireForm();
      const restored = state.restore();
      const n = restored.restored,
        unavailable = restored.unavailable
          ? ` ${restored.unavailable} ${restored.unavailable === 1 ? 'is' : 'are'} no longer on the form.`
          : '';
      outcome = result(
        'Form overrides restored',
        `Reset: ${n} form ${n === 1 ? 'setting' : 'settings'} restored to ${n === 1 ? 'its' : 'their'} state before the run.${unavailable}`,
      );
    } else if (action === 'form:toggle-autosave') {
      requireForm();
      const owner = form.data.entity;
      if (!owner.addOnSave || !owner.removeOnSave) fail('This form does not expose save events.');
      if (typeof params.enabled !== 'boolean') fail('Choose whether to block autosave.', 'error');
      if (state.guard) {
        state.guard.entity.removeOnSave(state.guard.handler);
        state.guard = undefined;
      }
      if (params.enabled) {
        const handler = (execution) => {
          const args = execution.getEventArgs();
          if (args.getSaveMode() === 70) args.preventDefault();
        };
        owner.addOnSave(handler);
        state.guard = { entity: owner, handler };
      }
      outcome = result(
        'Autosave guard',
        params.enabled ? 'Autosave is blocked. Save and Save & Close still work.' : 'Reset: autosave works again.',
      );
    } else if (action === 'form:refresh-autosave-off') {
      requireForm();
      if (!form.data.refresh) fail('This form cannot be refreshed from a script.');
      // On a dirty form the native app asks itself (Unsaved changes: Save and continue, Discard changes or close), so
      // Lense adds no second prompt. The refresh settles either way; the form state and the saved record's modifiedon
      // say which answer was given.
      const dirty = safe(() => form.data.entity.getIsDirty()) === true,
        id = safe(() => recordId()),
        savedAt = async () =>
          id ? (await get(`${(await metadata(entity())).EntitySetName}(${id})?$select=modifiedon`)).modifiedon : null;
      const before = dirty ? await savedAt() : null;
      await form.data.refresh(false);
      if (dirty && safe(() => form.data.entity.getIsDirty()) === true)
        fail('The draft was kept: the Unsaved changes prompt was closed.', 'cancelled');
      const saved = dirty && before !== null && (await savedAt()) !== before;
      let message = 'Refreshed without saving.';
      if (saved)
        message = 'The Unsaved changes prompt saved the draft (Save and continue), then the record was refreshed.';
      else if (dirty) message = 'Refreshed without saving; the draft was discarded.';
      outcome = result('Record refreshed', message);
    } else if (action === 'form:clone-record') {
      requireForm();
      if (!xrm?.Navigation?.openForm) fail('This app cannot open forms from a script (Xrm.Navigation.openForm).');
      const definition = await metadata(entity()),
        attributes = await get(
          `EntityDefinitions(LogicalName='${entity()}')/Attributes?$select=LogicalName,IsValidForCreate,AttributeType,IsPrimaryId`,
        ),
        allowed = new Map(
          (attributes.value ?? [])
            .filter((field) => field.IsValidForCreate === true && !field.IsPrimaryId)
            .map((field) => [field.LogicalName, field]),
        );
      const values = {};
      for (const attribute of list(form.data.entity.attributes)) {
        const name = logical(attribute.getName()),
          field = allowed.get(name),
          value = attribute.getValue();
        if (
          !field ||
          name === definition.PrimaryIdAttribute ||
          value === undefined ||
          value === null ||
          ['createdon', 'modifiedon', 'createdby', 'modifiedby', 'ownerid', 'statecode', 'statuscode'].includes(name)
        )
          continue;
        const type = String(field.AttributeType ?? attribute.getAttributeType?.() ?? '').toLowerCase();
        if (
          ['file', 'image', 'managedproperty', 'partylist'].includes(type) ||
          (type === 'virtual' && !(Array.isArray(value) && value.every((item) => Number.isInteger(item))))
        )
          continue;
        if (type === 'lookup' || type === 'customer' || type === 'owner') {
          if (!Array.isArray(value) || value.length !== 1) continue;
          values[name] = guid(value[0].id);
          values[name + 'name'] = String(value[0].name ?? '');
          values[name + 'type'] = logical(value[0].entityType);
        } else if (value instanceof Date) values[name] = value.toISOString();
        else if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) values[name] = value.join(',');
        else if (
          ['string', 'number', 'boolean'].includes(typeof value) &&
          (typeof value !== 'number' || Number.isFinite(value))
        )
          values[name] = value;
      }
      requestForm({ entityName: entity(), openInNewWindow: true }, values);
      outcome = result(
        'Clone requested',
        'The app opens a new form with this record’s values in a new window. No record is created until you save it there.',
      );
    } else if (action === 'form:open-editor') {
      requireForm();
      const id = guid(captured.form),
        solutionId = await solution();
      await openUrl(`${portal('maker')}/e/${environment()}/s/${solutionId}/entity/${entity()}/form/edit/${id}`);
      outcome = result('Form editor', 'Opened this form in the form designer.');
    } else if (action === 'form:table-processes') {
      requireForm();
      const name = entity(),
        workflows = await get(
          `workflows?$select=workflowid,name,category,type,mode&$filter=primaryentity%20eq%20'${name}'%20and%20statecode%20eq%201&$top=200`,
        ),
        apis = await get(
          `customapis?$select=customapiid,uniquename,displayname&$filter=bindingtype%20eq%201%20and%20boundentitylogicalname%20eq%20'${name}'&$top=200`,
        );
      const categories = { 2: 'Business rule', 3: 'Action', 4: 'Business process flow', 5: 'Flow' };
      outcome = rowsResult(
        'Table processes',
        ['Kind', 'Name', 'ID'],
        [
          ...(workflows.value ?? []).map((row) => [
            categories[row.category] ?? (row.mode === 1 ? 'Realtime workflow' : 'Background workflow'),
            row.name,
            row.workflowid,
          ]),
          ...(apis.value ?? []).map((row) => ['Custom API', row.displayname ?? row.uniquename, row.customapiid]),
        ],
        'Active processes and the custom APIs bound to this table, at most 200 of each.',
      );
      outcome.links = [
        ...(workflows.value ?? []).map((row) => ({ entity: 'workflow', id: row.workflowid, label: row.name })),
        ...(apis.value ?? []).map((row) => ({
          entity: 'customapi',
          id: row.customapiid,
          label: row.displayname ?? row.uniquename,
        })),
      ]
        .slice(0, 200)
        .filter((row) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id ?? ''))
        .map((row) => ({ label: bounded(row.label), url: pageUrl(row.entity, row.id, 'entityrecord').href }));
    } else if (action === 'navigation:open-record-by-id' || action === 'navigation:new-record') {
      if (!xrm?.Navigation?.openForm) fail('This app cannot open forms from a script (Xrm.Navigation.openForm).');
      const name = logical(params.entity);
      await metadata(name);
      const where = localSimulation ? 'this tab' : 'a new window';
      requestForm({
        entityName: name,
        ...(action.endsWith('open-record-by-id') ? { entityId: guid(params.id) } : {}),
        openInNewWindow: !localSimulation,
      });
      outcome = result(
        'Form requested',
        action.endsWith('new-record')
          ? `The app opens a new ${name} form in ${where}. No record is created until you save it.`
          : `The app opens the ${name} record in ${where}.`,
      );
    } else if (action === 'navigation:pin-to-side-panel') {
      if (!xrm?.App?.sidePanes?.createPane || !xrm?.Utility?.getPageContext)
        fail('This app has no side panes (Xrm.App.sidePanes).');
      const input = xrm.Utility.getPageContext().input;
      if (!['entityrecord', 'entitylist'].includes(input?.pageType))
        fail('Only a record or a table list can be pinned to a side pane.');
      const pane = await xrm.App.sidePanes.createPane({ canClose: true });
      if (!live()) {
        try {
          await pane.close?.();
        } catch {
          /* The new pane may already be closed. */
        }
        fail('The app changed before the side pane was ready.', 'cancelled');
      }
      state.panes.push(pane);
      rollback.push(() => {
        drop(state.panes, pane);
        Promise.resolve(pane.close?.()).catch(() => {});
      });
      await pane.navigate({
        pageType: input.pageType,
        entityName: logical(input.entityName),
        ...(input.pageType === 'entityrecord' ? { entityId: guid(input.entityId ?? captured.id) } : {}),
      });
      outcome = result('Side pane', 'Opened this page in a side pane.');
    } else if (action === 'navigation:close-side-panes') {
      const panes = state.panes.splice(0);
      for (const pane of panes)
        try {
          await pane.close?.();
        } catch {
          /* The user may have closed the pane already. */
        }
      outcome = result(
        'Side pane',
        panes.length
          ? `Reset: ${panes.length} side ${panes.length === 1 ? 'pane' : 'panes'} closed.`
          : 'This session has no open side pane.',
      );
    } else if (action.startsWith('navigation:')) {
      let url;
      if (action === 'navigation:open-list') {
        const name = logical(params.entity);
        await metadata(name);
        url = pageUrl(name);
      } else if (action === 'navigation:open-system-jobs') url = pageUrl('asyncoperation');
      else if (action === 'navigation:open-processes') url = pageUrl('workflow');
      else if (action === 'navigation:open-mailboxes') url = pageUrl('mailbox');
      else if (action === 'navigation:open-main') url = pageUrl(undefined, undefined, null);
      else if (action === 'navigation:open-advanced-find') url = pageUrl(undefined, undefined, 'advancedfind');
      else if (action === 'navigation:open-mobile-client') {
        const unique = context?.organizationSettings?.uniqueName;
        if (typeof unique !== 'string' || !unique) fail('This app does not report its organization unique name.');
        url = new URL(`${client()}/nga/main.htm`);
        url.searchParams.set('org', unique);
        url.searchParams.set('server', client());
      } else if (action === 'navigation:open-solutions')
        url = `${portal('maker')}/environments/${environment()}/solutions`;
      else if (action === 'navigation:open-solutions-history')
        url = `${portal('maker')}/environments/${environment()}/solutionsHistory`;
      else if (action === 'navigation:open-power-platform-admin')
        url = `${portal('admin')}/environments/environment/${environment()}/hub`;
      else if (action === 'navigation:open-security')
        url = `${portal('admin')}/environments/environment/${environment()}/hub`;
      else fail('This navigation operation is not supported.');
      await openUrl(String(url));
      outcome = result(
        'Opened',
        action === 'navigation:open-security'
          ? 'Opened this environment’s admin hub. Use its security settings to manage users and permissions.'
          : 'Opened in a new tab.',
      );
    } else if (action.startsWith('debugging:')) {
      const changes = {
          'debugging:forms-monitor': ['monitor', 'true'],
          'debugging:ribbon-debugger': ['ribbondebug', 'true'],
          'debugging:perf-center': ['perf', 'true'],
          'debugging:disable-form-handlers': ['flags', 'DisableFormHandlers=true'],
          'debugging:disable-business-rules': ['flags', 'DisableFormHandlers=businessrule'],
          'debugging:disable-form-libraries': ['flags', 'DisableFormLibraries=true'],
          'debugging:enable-dark-mode': ['flags', 'themeoption=darkmode'],
        },
        flags = new Set([
          'DisableFormHandlers=true',
          'DisableFormHandlers=businessrule',
          'DisableFormLibraries=true',
          'themeoption=darkmode',
        ]),
        url = new URL(location.href);
      if (action === 'debugging:clear-flags')
        url.search = new URLSearchParams(
          [...url.searchParams].filter(
            ([name, value]) =>
              !(name === 'flags' && flags.has(value)) &&
              !(['monitor', 'ribbondebug', 'perf'].includes(name) && value === 'true'),
          ),
        ).toString();
      else {
        const change = changes[action];
        if (!change) fail('Unknown diagnostic operation.');
        if (!url.searchParams.getAll(change[0]).includes(change[1])) url.searchParams.append(...change);
      }
      if (
        safe(() => form?.data?.entity?.getIsDirty()) &&
        !globalThis.confirm('Reload the app and discard your unsaved changes?')
      )
        fail('The draft was kept.', 'cancelled');
      check();
      if (url.href === location.href) outcome = result('Diagnostics', 'This option is already on.');
      else {
        deliver(
          result(
            'Diagnostics',
            action === 'debugging:clear-flags'
              ? 'Reloading without diagnostic options.'
              : 'Reloading with this option on.',
          ),
        );
        location.assign(url.href);
        return ack(true);
      }
    } else fail('Unknown action.');
    check();
    deliver(outcome);
  } catch (error) {
    // A failed action leaves the page as it found it: its partial changes are reverted, newest first.
    for (const callback of [...state.restores.splice(firstRestore), ...rollback].reverse()) safe(callback);
    if (receiver())
      deliver({
        // No title: the panel heads a failure with the action's own label.
        status: !live() ? 'cancelled' : (error.status ?? 'error'),
        message: !live()
          ? 'The app or record changed. Run the action again on the current page.'
          : String(error.message ?? 'The action failed.').slice(0, 1000),
      });
  } finally {
    if (state.pending.get(requestId) === marker) state.pending.delete(requestId);
  }
  return ack(true);
}

/** Retire only this inspector's browser-local action state. */
export function disposeModelDrivenActions({ origin, token }) {
  if (location.origin !== origin) return;
  const host = document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector'),
    state = host?.__paqModelActionState;
  if (state?.token === token) {
    state.dispose();
    delete host.__paqModelActionState;
  }
}
