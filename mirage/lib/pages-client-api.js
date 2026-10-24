// The local Power Pages client API ($pages) and the modern list adapter.
// It runs inside the page runtime script (platform.mjs injectRuntime, PAGES_CLIENT_API_SOURCE), before authored
// scripts. Learn: power-pages/configure/client-api.
//
// Levels:
// - readiness: Microsoft.PowerPages.onPagesClientApiReady calls back and resolves once the document is
//   parsed (next tick when it already is); the deprecated Microsoft.Dynamic365.Portal alias warns once.
// - currentPage.lists: behaviour. Modern lists (platform.mjs renderModernList) load through the list's own
//   secured grid query with page continuation on scroll and raise loaded/rowclick/cellclick; traditional
//   lists answer isModern false, empty rows/columns and no-op on/off, as Learn documents.
// - ajax.request, webAPI record and file-column methods: behaviour over the local /_api and server endpoints.
// - user.signIn/signOut, languages: behaviour over the local sign-in routes, page languages and language-prefixed paths.
// - currentPage.forms: behaviour over the rendered basic and multistep forms (formOf below).
// - Members the rendered form cannot serve (getValue/setValue of a control whose type is not available) and
//   agents throw a PagesClientApiUnsupported error naming the member and log PAGES_CLIENT_API_MEMBER_UNSUPPORTED once.
// It also hydrates the local SharePoint document grid ([data-pp-documents], platform.mjs) over /_apps/portal-documents/.
(function () {
  'use strict';
  if (window.__paqviloPages) return;
  const warned = new Set();
  class PagesClientApiUnsupported extends Error {
    constructor(member) {
      super(`PagesClientApiUnsupported: $pages.${member} is not available in the local runtime.`);
      this.name = 'PagesClientApiUnsupported';
      this.member = member;
      this.code = 'PAGES_CLIENT_API_MEMBER_UNSUPPORTED';
    }
  }
  const unsupported = member => function () {
    if (!warned.has(member)) { warned.add(member); console.error(`PAGES_CLIENT_API_MEMBER_UNSUPPORTED: $pages.${member} is not supported by the local runtime.`); }
    throw new PagesClientApiUnsupported(member);
  };
  // Undocumented member names (the agents area) are unsupported by name; `then` stays undefined so awaiting the area works.
  const unsupportedAny = area => new Proxy({}, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' || key === 'toJSON' ? undefined : unsupported(`${area}.${String(key)}`)) });

  // DOM attributes are data, including when they describe a local navigation target.
  // Keep the parsed scheme and origin: a non-HTTP URL's pathname can itself begin with javascript:.
  function portalNavigationUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (url.origin !== location.origin) return null;
      return url.href;
    } catch { return null; }
  }

  // ---- Ajax: CSRF token, credentials and x-requested-with on every request (Learn, client-api/ajax).
  let tokenRequest = null;
  const token = () => (tokenRequest ??= fetch('/_layout/tokenhtml', { credentials: 'same-origin', headers: { 'x-requested-with': 'XMLHttpRequest' } })
    .then(response => response.text()).then(html => /value="([^"]+)"/.exec(html)?.[1] ?? '')
    .catch(error => { tokenRequest = null; throw error; }));
  const parse = async response => {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  };
  const headerObject = headers => { const result = {}; headers.forEach((value, name) => { result[name] = value; }); return result; };
  const ajaxError = (message, status, body, requestId) => Object.assign(new Error(message), { name: 'AjaxError', status, body, requestId });
  const canceled = (error, signal) => Object.assign(new Error('The request was canceled.'), { name: 'CanceledError', cause: signal?.reason ?? error });
  async function request(options) {
    if (!options || typeof options.url !== 'string' || !options.url) throw new TypeError('$pages.ajax.request needs options.url.');
    const hasBody = options.body !== undefined;
    const method = String(options.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError(`$pages.ajax.request does not support ${method}.`);
    const url = new URL(options.url, location.href);
    for (const [name, value] of Object.entries(options.params ?? {})) url.searchParams.append(name, String(value));
    const headers = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) if (!/^(?:__requestverificationtoken|x-requested-with)$/i.test(name)) headers[name] = value;
    // ponytail: browsers refuse a GET body (fetch and XMLHttpRequest drop or reject it), so a GET sends its body only as documented intermediaries do: not at all.
    const sendBody = hasBody && method !== 'GET';
    if (sendBody && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    if (url.origin === location.origin) headers.__RequestVerificationToken = await token();
    headers['x-requested-with'] = 'XMLHttpRequest';
    let response;
    try {
      response = await fetch(url.href, { method, headers, credentials: 'same-origin', body: sendBody ? JSON.stringify(options.body) : undefined, signal: options.signal });
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw canceled(error, options.signal);
      throw ajaxError(`Network request to ${url.pathname} failed.`, 0, null, undefined);
    }
    const data = await parse(response);
    const requestId = response.headers.get('x-ms-request-id') ?? undefined;
    if (!response.ok) throw ajaxError(`Request failed with status ${response.status}.`, response.status, data, requestId);
    return { data, status: response.status, ok: true, headers: headerObject(response.headers) };
  }

  // ---- webAPI over the local portal Web API (/_api); errors are the AjaxError of the request.
  const query = options => (options ? '?' + String(options).replace(/^\?/, '') : '');
  const key = id => String(id ?? '').replace(/[{}]/g, '');
  const api = (method, path, body) => request({ method, url: '/_api/' + path, ...(body === undefined ? {} : { body }) });
  const webAPI = {
    async createRecord(entitySetName, data) {
      const response = await api('POST', entitySetName, data ?? {});
      const entityId = response.headers['odata-entityid'] ?? response.headers.location ?? '';
      return /\(([0-9a-f-]{36})\)/i.exec(entityId)?.[1] ?? response.data?.[Object.keys(response.data ?? {}).find(name => /id$/i.test(name))] ?? null;
    },
    async retrieveRecord(entitySetName, id, options) { return (await api('GET', `${entitySetName}(${key(id)})${query(options)}`)).data; },
    async retrieveMultipleRecords(entitySetName, options) { return (await api('GET', `${entitySetName}${query(options)}`)).data; },
    async updateRecord(entitySetName, id, data) { await api('PATCH', `${entitySetName}(${key(id)})`, data ?? {}); },
    async deleteRecord(entitySetName, id) { await api('DELETE', `${entitySetName}(${key(id)})`); },
    async updateSingleProperty(entitySetName, id, property, value) { await api('PUT', `${entitySetName}(${key(id)})/${property}`, { value }); },
    async deleteSingleProperty(entitySetName, id, property) { await api('DELETE', `${entitySetName}(${key(id)})/${property}`); },
    async associateRecord(entitySetName, id, navigationProperty, relatedEntitySetName, relatedId) {
      await api('POST', `${entitySetName}(${key(id)})/${navigationProperty}/$ref`, { '@odata.id': `${location.origin}/_api/${relatedEntitySetName}(${key(relatedId)})` });
    },
    async disassociateRecord(entitySetName, id, navigationProperty, _relatedEntitySetName, relatedId) {
      await api('DELETE', `${entitySetName}(${key(id)})/${navigationProperty}(${key(relatedId)})/$ref`);
    },
    async getRecordCount(entitySetName) { return Number((await api('GET', `${entitySetName}/$count`)).data); },
    // File and image columns (Learn, client-api/dataverse) over the portal Web API's file-column routes
    // (webapi-handler.mjs fileColumnRequest). The name goes in the x-ms-file-name query parameter, which carries
    // names outside ASCII (Learn, file-column-data). ponytail: one request per file, no 4-MB chunks.
    async uploadFileToColumn(entitySetName, id, columnName, file) {
      if (!(file instanceof Blob)) throw new TypeError('$pages.webAPI.uploadFileToColumn needs a File.');
      const name = encodeURIComponent(file.name || columnName);
      await binary('PATCH', `${entitySetName}(${key(id)})/${columnName}?x-ms-file-name=${name}`, { body: file, headers: { 'content-type': 'application/octet-stream' } });
    },
    async downloadFileFromColumn(entitySetName, id, columnName, options) {
      const size = options?.size === 'thumbnail' ? 'thumbnail' : 'full';
      // The route answers application/octet-stream; the stored type comes in the mimetype header and types the Blob.
      const response = await binary('GET', `${entitySetName}(${key(id)})/${columnName}/$value?size=${size}`);
      return new Blob([await response.arrayBuffer()], { type: response.headers.get('mimetype') ?? response.headers.get('content-type') ?? '' });
    },
  };
  async function binary(method, path, init = {}) {
    const headers = { 'x-requested-with': 'XMLHttpRequest', ...(init.headers ?? {}) };
    if (method !== 'GET') headers.__RequestVerificationToken = await token();
    let response;
    try { response = await fetch('/_api/' + path, { method, credentials: 'same-origin', ...init, headers }); }
    catch { throw ajaxError(`Network request to /_api/${path.split('?')[0]} failed.`, 0, null, undefined); }
    if (!response.ok) throw ajaxError(`Request failed with status ${response.status}.`, response.status, await parse(response), response.headers.get('x-ms-request-id') ?? undefined);
    return response;
  }

  // ---- Lists (Learn, client-api/lists).
  const lists = new WeakMap();
  const base64Json = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value || 'W10='), char => char.charCodeAt(0))));
  const rawValue = attribute => {
    const value = attribute?.Value;
    if (value == null) return null;
    if (Array.isArray(value)) return null;
    if (typeof value === 'object') return typeof value.Value === 'number' ? value.Value : null;
    return value;
  };
  const styleOnto = (element, style) => { for (const [name, value] of Object.entries(style ?? {})) element.style[name] = value; };
  const classes = value => String(value ?? '').split(/\s+/).filter(Boolean);
  function traditionalList(element) {
    return {
      id: element.id || element.closest('[id]')?.id || '',
      isModern: false,
      get rows() { return []; },
      get columns() { return []; },
      getVisible: () => !element.hidden && element.style.display !== 'none',
      setVisible: visible => { element.style.display = visible ? '' : 'none'; },
      getHtmlElement: () => element,
      getColumn: () => undefined,
      on() {},
      off() {},
    };
  }
  function modernList(element) {
    // Views, search, metadata filter, sorting and actions reuse the classic grid engine: the same layouts (with the
    // list's action links), request body and grid, delete, download and modal form routes (platform.mjs renderModernList).
    const layouts = base64Json(element.getAttribute('data-view-layouts'));
    let layout = layouts.find(item => item.Id === element.getAttribute('data-selected-view')) ?? layouts[0] ?? { Columns: [] };
    const pageSize = Number(element.getAttribute('data-page-size')) || layout.Configuration?.PageSize || 10;
    const website = encodeURIComponent(element.getAttribute('data-website-id') ?? '');
    const table = element.querySelector('table');
    const head = table.querySelector('thead tr');
    const body = table.querySelector('tbody');
    const sentinel = element.querySelector('[data-pp-modern-list-more]');
    const dialog = element.querySelector('[data-pp-modern-list-dialog]');
    let definitions = [];
    const handlers = { loaded: new Set(), rowclick: new Set(), cellclick: new Set() };
    const rows = [], byElement = new WeakMap();
    let page = 0, more = true, loading = null, observer = null, generation = 0, search = '', metaFilter = '', sortExpression = layout.SortExpression ?? '', disabled = [];
    const headerCell = name => head.querySelector(`th[data-logical-name="${CSS.escape(name)}"]`);
    const text = html => { const template = document.createElement('template'); template.innerHTML = String(html ?? ''); return template.content.textContent.trim(); };
    const configuration = () => layout.Configuration ?? {};
    const itemActions = () => {
      const links = [...(configuration().ItemActionLinks ?? [])];
      const details = configuration().DetailsActionLink;
      if (details?.Enabled && !links.some(link => link.Type === 1)) links.unshift(details);
      return links.filter(link => link.Enabled !== false && [1, 2, 4].includes(link.Type));
    };
    const formUrl = (link, id) => {
      if (link.URL?.PathWithQueryString) { const target = portalNavigationUrl(link.URL.PathWithQueryString); if (!target) return null; const url = new URL(target); if (id) url.searchParams.set(link.QueryStringIdParameterName || 'id', id); return url.href; }
      if (!link.EntityForm?.Id) return null;
      const url = new URL(`/_portal/modal-form-template-path/${website}`, location.href);
      url.searchParams.set('entityformid', link.EntityForm.Id);
      if (id) url.searchParams.set('id', id);
      return portalNavigationUrl(url.href);
    };
    // A form action opens its page (URL target) or the basic form in the list's dialog (modal form route); closing it reloads.
    const openForm = (link, id) => {
      const target = formUrl(link, id);
      if (!target) return;
      if (link.URL?.PathWithQueryString) { location.assign(target); return; }
      dialog.querySelector('iframe').src = target;
      dialog.showModal();
    };
    dialog?.querySelector('[data-pp-modern-list-close]').addEventListener('click', () => dialog.close());
    dialog?.addEventListener('close', () => { dialog.querySelector('iframe').src = 'about:blank'; restart(); });
    const post = async (service, payload) => fetch(`/_services/${service}/${website}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-requested-with': 'XMLHttpRequest', __RequestVerificationToken: await token() }, body: JSON.stringify(payload) });
    async function runAction(link, id) {
      if (link.Type === 4) {
        if (!confirm(text(link.Confirmation) || 'Are you sure you want to delete this record?')) return;
        const response = await post('entity-grid-delete', { LogicalName: configuration().EntityName ?? layout.EntityName, Id: id });
        if (!response.ok) { show('.view-error'); return; }
        restart();
      } else if (link.Type === 8) {
        const response = await post('download-as-csv', { base64SecureConfiguration: layout.Base64SecureConfiguration, sortExpression, search: search || null, filter: null, metaFilter: metaFilter || null });
        const data = response.ok ? await response.json() : null;
        if (!data?.sessionKey) { show('.view-error'); return; }
        location.assign(`/_services/download-as-csv/${website}?key=${encodeURIComponent(data.sessionKey)}`);
      } else openForm(link, id);
    }
    const actionControl = (link, id) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'btn btn-default btn-sm';
      control.textContent = text(link.Label) || text(link.Tooltip);
      control.setAttribute('data-action-type', String(link.Type));
      control.addEventListener('click', event => { event.stopPropagation(); runAction(link, id); });
      return control;
    };
    function renderToolbar() {
      const host = element.querySelector('[data-pp-modern-list-actions]');
      if (!host) return;
      const links = [...(configuration().ViewActionLinks ?? []), ...(configuration().InsertActionLink?.Enabled ? [configuration().InsertActionLink] : [])];
      host.replaceChildren(...links.filter(link => [3, 8].includes(link.Type)).map(link => { const control = actionControl(link, null); control.disabled = link.Enabled === false; return control; }));
    }
    function renderHead() {
      definitions = (layout.Columns ?? []).filter(column => column.Type === 0);
      head.replaceChildren(...definitions.map(definition => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.setAttribute('data-logical-name', definition.LogicalName);
        if (definition.SortDisabled) { th.textContent = text(definition.Name) || definition.LogicalName; return th; }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-link';
        button.textContent = text(definition.Name) || definition.LogicalName;
        const [attribute, direction] = sortExpression.split(',')[0].trim().split(/\s+/);
        if (attribute === definition.LogicalName) th.setAttribute('aria-sort', /desc/i.test(direction ?? '') ? 'descending' : 'ascending');
        button.addEventListener('click', () => {
          const descending = th.getAttribute('aria-sort') === 'ascending';
          sortExpression = `${definition.LogicalName} ${descending ? 'DESC' : 'ASC'}`;
          renderHead();
          restart();
        });
        th.append(button);
        return th;
      }));
      if (itemActions().length) { const th = document.createElement('th'); th.scope = 'col'; th.innerHTML = '<span class="sr-only visually-hidden">Actions</span>'; head.append(th); }
    }
    const columnOf = definition => ({
      getLogicalName: () => definition.LogicalName,
      getDisplayName: () => definition.Name,
      setHeader: text => { const cell = headerCell(definition.LogicalName); const target = cell?.querySelector('button') ?? cell; if (target) target.textContent = String(text); },
      setVisible: visible => { for (const cell of element.querySelectorAll(`[data-logical-name="${CSS.escape(definition.LogicalName)}"]`)) cell.style.display = visible ? '' : 'none'; },
      setTooltip: tooltip => { const cell = headerCell(definition.LogicalName); if (cell) { cell.title = String(tooltip); cell.setAttribute('aria-label', String(tooltip)); } },
    });
    let columns = [];
    const show = selector => { for (const message of element.querySelectorAll('.message')) message.hidden = !message.matches(selector); };
    function rowOf(record) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-id', record.Id);
      const attribute = name => (record.Attributes ?? []).find(item => item.Name === name);
      for (const definition of definitions) {
        const td = document.createElement('td');
        td.setAttribute('data-logical-name', definition.LogicalName);
        td.setAttribute('data-th', definition.Name);
        td.textContent = attribute(definition.LogicalName)?.DisplayValue ?? '';
        if (headerCell(definition.LogicalName)?.style.display === 'none') td.style.display = 'none';
        tr.append(td);
      }
      const links = itemActions();
      if (links.length) {
        const td = document.createElement('td');
        td.className = 'pp-modern-list-row-actions';
        // The grid service names the actions whose filter criteria exclude this row (DisabledItemActionLinks).
        for (const link of links) {
          const control = actionControl(link, record.Id);
          control.disabled = disabled.some(item => item.EntityId === record.Id && item.LinkUniqueId === link.FilterCriteriaId);
          td.append(control);
        }
        tr.append(td);
      }
      const privileges = 'CanRead' in record ? { canRead: record.CanRead, canWrite: record.CanWrite, canDelete: record.CanDelete, canAppend: record.CanAppend, canAppendTo: record.CanAppendTo } : undefined;
      const row = {
        getId: () => record.Id,
        getValue: name => rawValue(attribute(name)),
        getDisplayValue: name => attribute(name)?.DisplayValue ?? '',
        getPrivileges: () => privileges && { ...privileges },
        getState: () => ('StateCode' in record ? { stateCode: record.StateCode, statusCode: record.StatusCode } : undefined),
        setStyle: style => styleOnto(tr, style),
        setClassName: value => { tr.className = classes(value).join(' '); },
        addClassName: value => tr.classList.add(...classes(value)),
        removeClassName: value => tr.classList.remove(...classes(value)),
        setVisible: visible => { tr.hidden = !visible; },
        getCell: name => {
          const td = tr.querySelector(`td[data-logical-name="${CSS.escape(name)}"]`);
          return { setDisplayText: text => { if (td) td.textContent = String(text); }, setStyle: style => { if (td) styleOnto(td, style); } };
        },
      };
      byElement.set(tr, row);
      return { tr, row };
    }
    const emit = (event, payload) => { for (const handler of [...handlers[event]]) handler(payload); };
    async function load() {
      if (loading || !more) return loading;
      element.setAttribute('aria-busy', 'true');
      const current = generation;
      loading = (async () => {
        const response = await fetch(element.getAttribute('data-get-url'), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-requested-with': 'XMLHttpRequest', __RequestVerificationToken: await token() },
          // The classic grid client's request body: one secured query, continued page by page.
          body: JSON.stringify({ base64SecureConfiguration: layout.Base64SecureConfiguration, sortExpression, search: search || null, page: page + 1, pageSize, pagingCookie: '', filter: null, metaFilter: metaFilter || null, nlSearchFilter: null, timezoneOffset: new Date().getTimezoneOffset(), customParameters: [] }),
        });
        // A view, search, filter or sort change restarted the list while this page was in flight: drop it.
        if (current !== generation) return;
        if (response.status === 403) { more = false; show('.view-access-denied'); return; }
        if (!response.ok) { more = false; show('.view-error'); return; }
        const data = await response.json();
        if (current !== generation) return;
        // The grid service answers a denied read as 200 { AccessDenied: true } (native-services.mjs sendAccessDenied).
        if (data.AccessDenied) { more = false; show('.view-access-denied'); return; }
        page += 1;
        more = Boolean(data.MoreRecords);
        disabled = [...disabled, ...(data.DisabledItemActionLinks ?? [])];
        for (const record of data.Records ?? []) { const { tr, row } = rowOf(record); body.append(tr); rows.push(row); }
        show(rows.length ? '.none' : '.view-empty');
        if (sentinel) sentinel.hidden = !more;
        emit('loaded', { rows: [...rows] });
      })().catch(() => { if (current === generation) { more = false; show('.view-error'); } }).finally(() => {
        if (current !== generation) return;
        loading = null;
        element.removeAttribute('aria-busy');
        // Re-observing reports the sentinel again, so a page that still shows it continues.
        if (more && observer && sentinel) { observer.unobserve(sentinel); observer.observe(sentinel); }
      });
      return loading;
    }
    // A view, search, filter or sort change starts the secured query again from its first page.
    function restart() {
      generation += 1;
      page = 0; more = true; loading = null; disabled = [];
      rows.length = 0;
      body.replaceChildren();
      element.removeAttribute('aria-busy');
      return load();
    }
    element.querySelector('[data-pp-modern-list-view]')?.addEventListener('change', event => {
      layout = layouts.find(item => item.Id === event.target.value) ?? layout;
      sortExpression = layout.SortExpression ?? '';
      renderHead(); renderToolbar(); columns = definitions.map(columnOf);
      restart();
    });
    const searchBox = element.querySelector('[data-pp-modern-list-search]');
    searchBox?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search = searchBox.value.trim(); restart(); } });
    searchBox?.addEventListener('search', () => { search = searchBox.value.trim(); restart(); });
    // The metadata filter panel is the classic one (renderListFilter); its inputs serialize as the grid's metaFilter query.
    const filterPanel = element.querySelector('[data-pp-modern-list-filter]');
    filterPanel?.querySelector('.btn-entitylist-filter-submit')?.addEventListener('click', event => {
      event.preventDefault();
      const query = new URLSearchParams();
      for (const input of filterPanel.querySelectorAll('input[name], select[name]'))
        if ((input.type === 'checkbox' || input.type === 'radio') ? input.checked : input.value.trim()) query.append(input.name, input.type === 'checkbox' || input.type === 'radio' ? input.value : input.value.trim());
      metaFilter = query.toString();
      restart();
    });
    body.addEventListener('click', event => {
      const tr = event.target.closest('tr');
      const row = tr && byElement.get(tr);
      if (!row) return;
      const td = event.target.closest('td');
      if (handlers.cellclick.size && td) emit('cellclick', { row, columnName: td.getAttribute('data-logical-name'), event });
      else emit('rowclick', { row, event });
    });
    const list = {
      id: element.id,
      isModern: true,
      get rows() { return [...rows]; },
      get columns() { return [...columns]; },
      getVisible: () => !element.hidden && element.style.display !== 'none',
      setVisible: visible => { element.style.display = visible ? '' : 'none'; },
      getHtmlElement: () => element,
      getColumn: name => columns.find(column => column.getLogicalName() === name),
      on: (event, handler) => { if (handlers[event] && typeof handler === 'function') handlers[event].add(handler); },
      off: (event, handler) => { handlers[event]?.delete(handler); },
    };
    renderHead(); renderToolbar(); columns = definitions.map(columnOf);
    Object.defineProperty(list, '__start', { value() {
      if (sentinel && typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load(); });
        observer.observe(sentinel);
      }
      return load();
    } });
    Object.defineProperty(list, '__loadMore', { value: load });
    return list;
  }
  const listFor = element => {
    if (!lists.has(element)) lists.set(element, element.hasAttribute('data-pp-modern-list') ? modernList(element) : traditionalList(element));
    return lists.get(element);
  };
  const LIST_SELECTOR = '[data-pp-modern-list], .entity-grid.entitylist';
  const pageLists = () => [...document.querySelectorAll(LIST_SELECTOR)].map(listFor);

  // ---- Forms, tabs, sections and controls over the rendered basic and multistep forms (Learn, client-api/forms-tabs-sections,
  // control-methods, controls): the panels .crmEntityFormView[data-form-name] (platform.mjs), their wrapper
  // (EntityFormControl_*/WebFormControl_*, the form id), tabs div.tab, sections table.section and the cells
  // .control[data-logical-name]. Required state and validators are ASP.NET validators in Page_Validators, so they run on
  // submit and report in the form's validation summary (webforms-compat.js). Learn documents no form events.
  // Guessed native behaviour: the getType names other than MultiSelectPicklist; Boolean values are the option labels.
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const shown = element => Boolean(element) && element.style.display !== 'none' && !element.hidden;
  const show = (element, visible) => { if (element) element.style.display = visible ? '' : 'none'; };
  const fire = element => element.dispatchEvent(new Event('change', { bubbles: true }));
  const byId = (root, id) => root.querySelector(`[id="${CSS.escape(id)}"]`);
  const requiredBy = new WeakMap();
  function pageValidator(form, holder, controlId, message, valid) {
    const span = document.createElement('span');
    span.style.display = 'none';
    Object.assign(span, { controltovalidate: controlId, errormessage: escapeHtml(message), display: 'None', isvalid: true,
      evaluationfunction: () => { try { return valid() === true; } catch (error) { console.error(error); return false; } } });
    const group = form.querySelector('[id^="ValidationSummary"]')?.validationGroup;
    if (typeof group === 'string') span.validationGroup = group;
    (holder.querySelector('.validators') ?? holder).append(span);
    window.Page_Validators = [...(window.Page_Validators ?? []), span];
    return span;
  }
  const dropValidator = span => { span?.remove(); window.Page_Validators = (window.Page_Validators ?? []).filter(item => item !== span); };
  const empty = value => value == null || value === '' || (Array.isArray(value) && !value.length);
  function typeOf(cell, element, id) {
    // The rich text editor's stored HTML (platform.mjs richTextInput: a hidden JSON-encoded value beside the editor).
    if (cell.querySelector('input[data-sim-richtext-value]')) return 'RichText';
    const pcf = cell.querySelector('[pcf-controlcontext]');
    if (pcf) return /MultiSelectPicklist/.test(pcf.getAttribute('pcf-controlcontext')) ? 'MultiSelectPicklist' : undefined;
    if (cell.querySelector('.file-control-container')) return 'File';
    if (cell.querySelector('input[type="file"][accept^="image"]')) return 'Image';
    if (!element) return undefined;
    const has = name => element.classList.contains(name);
    if (byId(cell, `${id}_name`)?.classList.contains('lookup') || (element.tagName === 'SELECT' && has('lookup'))) return 'Lookup';
    if (has('boolean-radio') || (element.tagName === 'SELECT' && /boolean/.test(element.className))) return 'Boolean';
    if (element.type === 'checkbox') return 'MultipleChoice';
    if (has('picklist')) return 'Picklist';
    if (has('state')) return 'Status';
    if (has('status')) return 'StatusReason';
    if (element.tagName === 'SELECT' && has('integer')) return 'FormattedInteger';
    if (has('addressCompositeControl')) return 'AddressComposite';
    if (has('fullNameCompositeControl')) return 'FullName';
    if (element.tagName === 'TEXTAREA') return 'Memo';
    if (has('datetime')) return 'DateTime';
    if (element.type === 'email') return 'Email';
    if (has('tickersymbol')) return 'TickerSymbol';
    if (element.type === 'url') return 'URL';
    for (const [name, type] of [['integer', 'Integer'], ['decimal', 'Decimal'], ['double', 'Double'], ['money', 'Money']]) if (has(name)) return type;
    return element.tagName === 'INPUT' && element.type === 'text' ? 'String' : undefined;
  }
  const ADDRESS = { line1: 'line1', line2: 'line2', line3: 'line3', city: 'city', state: 'stateorprovince', postalCode: 'postalcode', country: 'country' };
  const radioLabel = radio => { const label = radio.parentElement.querySelector(`label[for="${CSS.escape(radio.id)}"]`); const copy = label?.cloneNode(true); copy?.querySelector('.sr-only, .visually-hidden')?.remove(); return copy?.textContent.trim() ?? radio.value; };
  // One control object per rendered cell, so validators added through one lookup are removed or replaced through a
  // fresh lookup (Learn control-methods: addValidator/removeValidator/clearValidators act on "this control instance").
  const controlsByCell = new WeakMap();
  function controlOf(cell, form) {
    if (!controlsByCell.has(cell)) controlsByCell.set(cell, createControl(cell, form));
    return controlsByCell.get(cell);
  }
  // Learn controls "Full name": getValue/setValue use { firstName, middleName, lastName }. The parts are the composite's
  // own part boxes when the form renders them (<id><part> or <id>_<part>), else the form's firstname/middlename/lastname
  // cells, which carry the parts on submit. The native composite part box ids are not known.
  const NAME_PARTS = { firstName: 'firstname', middleName: 'middlename', lastName: 'lastname' };
  function createControl(cell, form) {
    const name = cell.getAttribute('data-logical-name');
    const holder = cell.closest('td.cell, .form-group') ?? cell;
    const info = holder.querySelector('.info');
    const id = info?.querySelector('label[id$="_label"]')?.id.replace(/_label$/, '') || name;
    const element = byId(cell, id) ?? cell.querySelector('input:not([type="hidden"]), select, textarea');
    const type = typeOf(cell, element, id);
    const member = method => `Control.${method}`;
    const fileInput = cell.querySelector('input[type="file"]');
    const modal = type === 'Lookup' && element?.tagName !== 'SELECT';
    const isReadOnly = box => Boolean(box && (box.disabled || box.readOnly || box.classList.contains('readonly') || box.closest('[readonly]')));
    const readOnly = () => isReadOnly(element);
    const maxFileSize = () => Number(/(?:fileLoad\(this, '[^']*'|imageLoad\(this, '\d+'), '(\d+)'/.exec(fileInput?.getAttribute('onchange') ?? '')?.[1] ?? 0) * 1024;
    const setFile = files => { fileInput.files = files; fire(fileInput); };
    const namePart = part => byId(cell, `${id}${part}`) ?? byId(cell, `${id}_${part}`) ?? form.querySelector(`.control[data-logical-name="${part}"] input:not([type="hidden"])`);
    const nameParts = () => {
      const boxes = Object.fromEntries(Object.entries(NAME_PARTS).map(([key, part]) => [key, namePart(part)]));
      if (!Object.values(boxes).some(Boolean)) throw new Error(`The ${name} control has no first, middle or last name boxes on this form.`);
      return boxes;
    };
    // The rich text editor instance (platform.mjs: CKEditor or the local compatibility editor, both named <id>_editor).
    const richEditor = () => window.CKEDITOR?.instances?.[`${id}_editor`];
    const getValue = () => {
      switch (type) {
        case 'Lookup': {
          if (!modal) return element.value ? { id: element.value, name: element.selectedOptions[0]?.textContent ?? '' } : undefined;
          return element.value ? { id: element.value, name: byId(cell, `${id}_name`)?.value ?? '', entityType: byId(cell, `${id}_entityname`)?.value ?? '' } : undefined;
        }
        case 'Boolean': { if (element.tagName === 'SELECT') return element.selectedOptions[0]?.textContent ?? ''; const checked = element.querySelector('input:checked'); return checked ? radioLabel(checked) : ''; }
        case 'MultipleChoice': return element.checked;
        case 'Picklist': return element.tagName === 'SELECT' ? element.value : element.querySelector('input:checked')?.value ?? '';
        case 'MultiSelectPicklist': { const hidden = byId(cell, id); try { return hidden?.value ? JSON.parse(hidden.value).map(item => Number(item?.Value ?? item)) : []; } catch { return []; } }
        case 'Status': case 'StatusReason': return element.textContent.trim();
        case 'File': case 'Image': return fileInput?.files?.[0] ?? null;
        case 'AddressComposite': return Object.fromEntries(Object.entries(ADDRESS).map(([key, part]) => [key, byId(cell, `${id}_${part}`)?.value ?? '']));
        case 'FullName': return Object.fromEntries(Object.entries(nameParts()).map(([key, box]) => [key, box?.value ?? '']));
        case 'RichText': {
          // The editor's current HTML, else the stored value (JSON-encoded HTML in the hidden input).
          const editor = richEditor();
          if (typeof editor?.getData === 'function') return editor.getData();
          try { return element.value ? String(JSON.parse(element.value) ?? '') : ''; } catch { return element.value; }
        }
        case undefined: return unsupported(member('getValue'))();
        default: return element.value;
      }
    };
    const setValue = value => {
      if (type === 'Status' || type === 'StatusReason') throw new Error(`The ${name} control is read-only.`);
      if (type === undefined) return unsupported(member('setValue'))();
      // Guess: a read-only control refuses setValue (Learn documents isReadOnly, not the setValue outcome).
      // The full name composite box shows the computed fullname column (platform.mjs renders it read-only); the control
      // writes its parts, so it is read-only only when every part box is.
      if (type === 'FullName' ? Object.values(nameParts()).filter(Boolean).every(isReadOnly) : readOnly()) throw new Error(`The ${name} control is read-only.`);
      switch (type) {
        case 'FullName': {
          if (!value || typeof value !== 'object') throw new Error(`${name} needs an object with firstName, middleName and lastName.`);
          const boxes = nameParts(), given = Object.keys(NAME_PARTS).filter(key => key in value);
          const missing = given.find(key => !boxes[key] && value[key] != null && value[key] !== '');
          if (missing) throw new Error(`The ${name} control has no ${NAME_PARTS[missing]} box on this form.`);
          for (const key of given) if (boxes[key]) { boxes[key].value = String(value[key] ?? ''); fire(boxes[key]); }
          // The composite box shows the parts through its content template ({<id>firstname} {<id>lastname}).
          const template = element.getAttribute('data-content-template') ?? '{firstname} {lastname}';
          element.value = template.replace(/\{([^}]+)\}/g, (_, key) => namePart(Object.values(NAME_PARTS).find(part => key.toLowerCase().endsWith(part)) ?? '')?.value ?? '').replace(/\s+/g, ' ').trim();
          fire(element); return;
        }
        case 'RichText': {
          const html = String(value ?? '');
          const editor = richEditor();
          if (typeof editor?.setData === 'function') editor.setData(html);
          else { const area = byId(cell, `${id}_editor`); if (area) area.value = html; }
          // Assumed: a captured managed rich text control (data-sim-managed-control) reads the hidden value on save; its
          // own view is Microsoft's PCF proxy and is not refreshed here.
          const encoded = JSON.stringify(html);
          element.value = encoded; element.setAttribute('value', encoded); fire(element); return;
        }
        case 'Lookup':
          if (!modal) { element.value = String(value ?? ''); if (element.value !== String(value ?? '')) throw new Error(`${value} is not an option of ${name}.`); fire(element); return; }
          element.value = value?.id ?? '';
          for (const [suffix, part] of [['_name', value?.name], ['_entityname', value?.entityType]]) { const box = byId(cell, id + suffix); if (box) box.value = part ?? ''; }
          fire(element); return;
        case 'Boolean': {
          if (element.tagName === 'SELECT') { const option = [...element.options].find(item => item.value === String(value) || item.textContent.trim() === String(value)); if (!option) throw new Error(`${value} is not an option of ${name}.`); element.value = option.value; fire(element); return; }
          const radio = [...element.querySelectorAll('input[type="radio"]')].find(item => item.value === String(value) || radioLabel(item) === String(value));
          if (!radio) throw new Error(`${value} is not an option of ${name}.`);
          radio.checked = true; fire(radio); return;
        }
        case 'MultipleChoice': element.checked = Boolean(value); fire(element); return;
        case 'Picklist': {
          if (element.tagName === 'SELECT') { element.value = String(value); if (element.value !== String(value)) throw new Error(`${value} is not an option of ${name}.`); fire(element); return; }
          const radio = element.querySelector(`input[value="${CSS.escape(String(value))}"]`);
          if (!radio) throw new Error(`${value} is not an option of ${name}.`);
          radio.checked = true; fire(radio); return;
        }
        case 'MultiSelectPicklist': {
          const context = JSON.parse(cell.querySelector('[pcf-controlcontext]').getAttribute('pcf-controlcontext'));
          const options = context.ControlProperties?.value_Options ?? [];
          const values = Array.isArray(value) ? value.map(Number) : [];
          const missing = values.find(item => !options.some(option => Number(option.Value) === item));
          if (!Array.isArray(value) || missing !== undefined) throw new Error(`${missing ?? value} is not an option of ${name}.`);
          const hidden = byId(cell, id);
          hidden.value = values.length ? JSON.stringify(options.filter(option => values.includes(Number(option.Value)))) : '';
          // The local multiselect host (multiselect-compat.js) renders an empty view from the hidden value.
          byId(cell, context.UniqueId)?.replaceChildren();
          window.__ppMultiSelectHost?.mount?.();
          fire(hidden); return;
        }
        case 'File': case 'Image': {
          if (!(value instanceof File) || !value.size) throw new Error(`${name} needs a file that is not empty.`);
          if (maxFileSize() && value.size > maxFileSize()) throw new Error(`The file exceeds ${maxFileSize()} bytes.`);
          if (type === 'Image' && !/^image\//.test(value.type)) throw new Error(`${name} needs an image file.`);
          const transfer = new DataTransfer(); transfer.items.add(value); setFile(transfer.files); return;
        }
        case 'AddressComposite':
          for (const [key, part] of Object.entries(ADDRESS)) { const box = byId(cell, `${id}_${part}`); if (box && value && key in value) { box.value = String(value[key] ?? ''); fire(box); } }
          return;
        default: {
          const text = String(value ?? '');
          if ((type === 'String' || type === 'Memo') && element.maxLength > 0 && text.length > element.maxLength) throw new Error(`The value exceeds the maximum length ${element.maxLength} of ${name}.`);
          // Assumed: a date picker built over the bound box (date-controls.mjs) shows the new value after its change event.
          element.value = text; fire(element);
        }
      }
    };
    const custom = new Map();
    const label = () => info?.querySelector('label')?.textContent.trim() || name;
    const control = {
      getDisabled: () => Boolean(element?.disabled),
      getRequired: () => Boolean(info?.classList.contains('required') || requiredBy.has(cell)),
      getVisible: () => shown(holder),
      getName: () => name,
      // Learn's control type list has no rich text type, so the rich text control answers undefined (a guess).
      getType: () => (type === 'RichText' ? undefined : type),
      getLogicalName: () => name,
      getValue,
      setValue,
      setDisabled: disabled => { for (const item of cell.querySelectorAll('input, select, textarea, button')) { item.disabled = Boolean(disabled); item.toggleAttribute('aria-disabled', Boolean(disabled)); } },
      setVisible: visible => show(holder, visible),
      // A column required on the server stays required (Learn); otherwise a required validator runs on submit.
      setRequired: (isRequired, errorMessage) => {
        dropValidator(requiredBy.get(cell)); requiredBy.delete(cell);
        const server = Boolean(document.getElementById(`RequiredFieldValidator${id}`));
        if (isRequired && !server) requiredBy.set(cell, pageValidator(form, holder, id, errorMessage || `${label()} is a required field.`, () => !empty(getValue())));
        info?.classList.toggle('required', Boolean(isRequired) || server);
      },
      addValidator: (validatorId, evaluationFn, errorMessage) => {
        dropValidator(custom.get(validatorId));
        custom.set(validatorId, pageValidator(form, holder, id, errorMessage, () => evaluationFn(getValue())));
      },
      removeValidator: validatorId => { dropValidator(custom.get(validatorId)); custom.delete(validatorId); },
      clearValidators: () => { for (const span of custom.values()) dropValidator(span); custom.clear(); },
    };
    Object.defineProperty(control, 'isReadOnly', { get: readOnly, enumerable: true });
    if (type === 'Money') Object.defineProperty(control, 'readOnly', { get: readOnly, enumerable: true });
    if (type === 'DateTime') Object.defineProperties(control, { isDisabled: { get: () => Boolean(element.disabled || element.readOnly), enumerable: true }, dataType: { value: element.getAttribute('data-type'), enumerable: true } });
    if (type === 'Lookup') Object.assign(control, modal ? { isModal: true, clearValue: () => { setValue({ id: '', name: '', entityType: '' }); } } : { isDropdown: true });
    if (type === 'Picklist') control.subType = element.tagName === 'SELECT' ? 'Dropdown' : element.classList.contains('vertical') ? 'VerticalRadioButton' : 'HorizontalRadioButton';
    if (type === 'File' || type === 'Image') Object.assign(control, { maxFileSizeInByte: maxFileSize(), removeFile: () => setFile(new DataTransfer().files) });
    return control;
  }
  const visibleArea = (element, title) => ({ getVisible: () => shown(element), setVisible: visible => { show(element, visible); show(title, visible); } });
  function formOf(panel) {
    const wrapper = panel.closest('[id^="EntityFormControl"], [id^="WebFormControl"]') ?? panel;
    let config = {};
    try { config = JSON.parse(wrapper.querySelector('script[data-paqvilo-mirage-form-config]')?.textContent || '{}'); } catch { config = {}; }
    const controlsIn = root => [...root.querySelectorAll('.control[data-logical-name]')].map(cell => controlOf(cell, panel));
    const sectionOf = table => ({ get controls() { return controlsIn(table); }, getName: () => table.getAttribute('data-name') ?? table.closest('fieldset')?.querySelector('legend')?.textContent.trim() ?? '', ...visibleArea(table.closest('fieldset') ?? table) });
    const tabOf = tab => {
      const title = tab.previousElementSibling?.classList.contains('tab-title') ? tab.previousElementSibling : null;
      return { get sections() { return [...tab.querySelectorAll('table.section')].map(sectionOf); }, getName: () => tab.getAttribute('data-name') ?? title?.textContent.trim() ?? '', ...visibleArea(tab, title) };
    };
    const multiStep = config.kind === 'webform' || wrapper.id.startsWith('WebFormControl');
    const button = buttonId => wrapper.querySelector(`#${buttonId}`);
    const jq = element => (typeof window.jQuery === 'function' ? window.jQuery(element ?? []) : element ?? {});
    const form = {
      id: wrapper.id,
      name: panel.getAttribute('data-form-name'),
      get controls() { return controlsIn(panel); },
      get tabs() { return [...panel.querySelectorAll('div.tab')].map(tabOf); },
      isMultiStep: multiStep,
      getVisible: () => shown(wrapper),
      setVisible: visible => show(wrapper, visible),
      getHtmlElement: () => wrapper,
      getControlByLogicalName: logicalName => { const cell = panel.querySelector(`.control[data-logical-name="${CSS.escape(String(logicalName))}"]`); return cell ? controlOf(cell, panel) : undefined; },
    };
    if (!multiStep) return form;
    // The step's own facts (platform.mjs submitConfig.clientStep): a next step after this one, a previous step before it.
    const step = config.clientStep ?? {};
    return Object.assign(form, {
      get nextButton() { return jq(button('NextButton')); },
      get previousButton() { return jq(button('PreviousButton')); },
      hasNextStep: () => step.hasNextStep === true,
      hasPreviousStep: () => step.hasPreviousStep === true,
      goToNextStep: () => { const next = button('NextButton'); if (!next) throw new Error('This step has no Next or Submit button.'); next.click(); },
      goToPreviousStep: () => { const previous = button('PreviousButton'); if (!previous) throw new Error('This step has no previous step.'); previous.click(); },
    });
  }
  const pageForms = () => [...document.querySelectorAll('.crmEntityFormView[data-form-name]')].map(formOf);

  const portal = () => window.Microsoft?.Dynamic365?.Portal ?? {};
  // The language picker's links: /<code> before the path without the active language's segment (liquid.mjs languageDrop).
  function setActive(language) {
    const CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
    const code = String(language ?? '').trim();
    if (!CODE.test(code)) throw new TypeError('$pages.languages.setActive needs a language code such as fr-FR.');
    // The picker offers only the site's languages (getAll); any other code is refused without navigating.
    if (!$pages.languages.getAll().some(item => String(item).toLowerCase() === code.toLowerCase())) throw new TypeError(`${code} is not a language of this site.`);
    const active = $pages.languages.getActive();
    const [, first = '', rest = ''] = /^\/([^/]*)(.*)$/.exec(location.pathname) ?? [];
    const path = CODE.test(active) && first.toLowerCase() === active.toLowerCase() ? rest : location.pathname;
    location.assign(`/${code}${path || '/'}${location.search}`);
  }
  const $pages = {
    currentPage: {
      forms: {
        getAll: pageForms,
        getFormById: id => pageForms().find(form => form.id === id || form.getHtmlElement().querySelector('.crmEntityFormView')?.id === id),
        getFormByName: name => pageForms().find(form => form.name === name),
      },
      lists: { getAll: pageLists, getListById: id => pageLists().find(list => list.id === id) },
    },
    user: {
      signIn() { location.assign('/SignIn?returnUrl=' + encodeURIComponent(location.pathname + location.search)); },
      signOut() { location.assign('/Account/Login/LogOff?returnUrl=' + encodeURIComponent('/')); },
    },
    webAPI,
    languages: {
      getAll: () => [...(portal().activeLanguages ?? [])],
      getActive: () => document.documentElement.lang || portal().activeLanguages?.[0] || '',
      setActive,
    },
    ajax: { request },
    // Copilot Studio agents are out of scope for the local runtime.
    agents: unsupportedAny('agents'),
  };
  // A local, non-native marker: the contract version of this object.
  Object.defineProperty($pages, '__paqvilo', { value: Object.freeze({ version: 1, PagesClientApiUnsupported }) });

  const whenParsed = callback => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', callback, { once: true }) : setTimeout(callback, 0));
  const onPagesClientApiReady = function (callback) {
    return new Promise(resolve => whenParsed(() => { resolve($pages); if (typeof callback === 'function') callback($pages); }));
  };
  let aliasWarned = false;
  const deprecatedAlias = function (callback) {
    if (!aliasWarned) { aliasWarned = true; console.warn('Microsoft.Dynamic365.Portal.onPagesClientApiReady is deprecated. Use Microsoft.PowerPages.onPagesClientApiReady instead.'); }
    return onPagesClientApiReady(callback);
  };
  window.Microsoft ||= {};
  Microsoft.Dynamic365 ||= {};
  const legacy = Microsoft.Dynamic365.Portal ||= {};
  Microsoft.PowerPages ||= {};
  // An authored or captured definition of the readiness functions is kept; the local fallback is replaced.
  const local = fn => typeof fn !== 'function' || fn.__paqviloLocal === true;
  if (local(Microsoft.PowerPages.onPagesClientApiReady)) Microsoft.PowerPages.onPagesClientApiReady = onPagesClientApiReady;
  if (local(legacy.onPagesClientApiReady)) legacy.onPagesClientApiReady = deprecatedAlias;
  if (legacy.isClientApiEnabled === undefined || legacy.isClientApiEnabled === 'False') legacy.isClientApiEnabled = 'True';
  window.__paqviloPages = $pages;

  // ---- The local SharePoint document grid (platform.mjs, sharepoint-documents.mjs createPortalDocumentService).
  function documentGrid(element) {
    const body = element.querySelector('tbody'), status = element.querySelector('.message');
    const say = text => { status.hidden = !text; status.textContent = text || ''; };
    const url = portalNavigationUrl(element.getAttribute('data-documents-url'));
    if (!url) { element.removeAttribute('aria-busy'); say('The document service URL must stay within this portal.'); return; }
    const failureText = async response => { try { return (await response.json())?.error?.message ?? `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; } };
    const write = async (method, target, init = {}) => fetch(target, { method, credentials: 'same-origin', ...init, headers: { 'x-requested-with': 'XMLHttpRequest', __RequestVerificationToken: await token(), ...(init.headers ?? {}) } });
    // The open subfolder (names from the record folder down) and the route for it: ?folder=a/b.
    let path = [];
    const at = (suffix = '', params = {}, folder = path) => {
      const query = new URLSearchParams(params);
      if (folder.length) query.set('folder', folder.join('/'));
      return `${url}${suffix}${query.size ? '?' + query : ''}`;
    };
    const button = (text, onClick) => { const control = document.createElement('button'); control.type = 'button'; control.className = 'btn btn-default btn-sm'; control.textContent = text; control.addEventListener('click', onClick); return control; };
    const act = async (method, target, init) => { const answer = await write(method, target, init); if (!answer.ok) say(await failureText(answer)); else load(); };
    const open = next => { path = next; load(); };
    function row(first, size, modified, actions) {
      const tr = document.createElement('tr');
      for (const value of [first, size, modified]) { const td = document.createElement('td'); td.append(value); tr.append(td); }
      const td = document.createElement('td'); td.append(...actions); tr.append(td);
      body.append(tr);
    }
    async function load() {
      element.setAttribute('aria-busy', 'true');
      const response = await fetch(at(), { credentials: 'same-origin', headers: { 'x-requested-with': 'XMLHttpRequest' } });
      element.removeAttribute('aria-busy');
      body.replaceChildren();
      for (const control of element.querySelectorAll('[data-pp-documents-upload], [data-pp-documents-new-folder], [data-pp-documents-path]')) control.remove();
      if (!response.ok) { say(await failureText(response)); return; }
      const data = await response.json();
      // Breadcrumb navigation: the record folder, then each open subfolder.
      const crumbs = document.createElement('nav');
      crumbs.setAttribute('data-pp-documents-path', ''); crumbs.setAttribute('aria-label', 'Folder');
      for (const [index, name] of ['Documents', ...path].entries()) {
        if (index) crumbs.append(' / ');
        if (index === path.length) { const current = document.createElement('span'); current.setAttribute('aria-current', 'location'); current.textContent = name; crumbs.append(current); }
        else { const link = button(name, () => open(path.slice(0, index))); link.className = 'btn btn-link btn-sm'; crumbs.append(link); }
      }
      element.prepend(crumbs);
      for (const folder of data.folders ?? []) {
        const link = button(folder.name, () => open([...path, folder.name]));
        link.className = 'btn btn-link'; link.setAttribute('data-pp-documents-folder', folder.name);
        const actions = data.canDelete ? [button('Delete', () => act('DELETE', at('', {}, [...path, folder.name])))] : [];
        row(link, 'Folder', folder.lastModified ? new Date(folder.lastModified).toLocaleString() : '', actions);
      }
      for (const file of data.documents) {
        const link = document.createElement('a');
        link.href = at(`/${encodeURIComponent(file.name)}`);
        link.textContent = file.name;
        row(link, `${Math.max(1, Math.round(file.size / 1024))} KB`, file.lastModified ? new Date(file.lastModified).toLocaleString() : '', data.canDelete ? [button('Delete', () => act('DELETE', link.href))] : []);
      }
      say(data.documents.length || data.folders?.length ? '' : 'There are no documents.');
      if (data.canCreateFolder) {
        const create = button('New folder', () => { const name = prompt('Folder name'); if (name) act('POST', at('', { newFolder: name })); });
        create.setAttribute('data-pp-documents-new-folder', '');
        element.append(create);
      }
      if (data.canUpload) {
        const input = document.createElement('input');
        input.type = 'file'; input.setAttribute('data-pp-documents-upload', ''); input.setAttribute('aria-label', 'Add files');
        input.addEventListener('change', async () => {
          for (const file of input.files) {
            const answer = await write('POST', at('', { name: file.name }), { body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
            if (!answer.ok) { say(await failureText(answer)); return; }
          }
          load();
        });
        element.append(input);
      }
    }
    return load().catch(() => say('Error completing request.'));
  }
  whenParsed(() => {
    for (const element of document.querySelectorAll('[data-pp-modern-list]')) listFor(element).__start();
    for (const element of document.querySelectorAll('[data-pp-documents]')) documentGrid(element);
  });
})();
