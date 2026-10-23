// Browser-only developer tools. Results and transient inputs never enter inspector snapshots.
export function modelDrivenActionsUi(data) {
  const host = (document.getElementById('paqvilo-panel') ?? document.getElementById('paqvilo-model-inspector'));
  if (location.origin !== data.origin || !host?.shadowRoot || host.__paqModelInspector?.token !== data.token) return;
  if (host.__paqModelActions?.token === data.token) { host.__paqModelActions.update(data); return; }
  host.__paqModelActions?.dispose();
  const canonical=host.id==='paqvilo-panel';
  const root = host.shadowRoot, lifetime = new AbortController(), signal = lifetime.signal;
  const sheet = new CSSStyleSheet(); sheet.replaceSync(`
    .actions-panel{position:fixed;left:12px;bottom:68px;width:650px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 92px);overflow:auto;padding:14px;pointer-events:auto;background:white;border:1px solid #c8c8c8;border-radius:6px;box-shadow:0 4px 18px #0003}
    .actions-panel[hidden],[data-actions-hidden]{display:none!important}.actions-bar-identity{position:fixed;left:12px;bottom:64px;max-width:calc(100vw - 24px);padding:8px;background:#fff4ce;color:#6b4d00;border-radius:4px;pointer-events:auto;display:flex;align-items:center;gap:8px}.actions-bar-identity[hidden]{display:none}.actions-head,.actions-toolbar,.actions-item,.actions-buttons{display:flex;align-items:center;gap:8px}.actions-head h2{font-size:16px;margin:0;flex:1}.actions-tabs{display:flex;gap:6px;margin:12px 0}.actions-tabs button[aria-pressed=true]{background:#deecf9;border-color:#0078d4}.actions-panel input,.actions-panel textarea,.actions-panel select{font:inherit;color:inherit;box-sizing:border-box;padding:7px;border:1px solid #a19f9d;border-radius:3px;min-width:0}.actions-search{width:100%}.actions-toolbar{margin:8px 0}.actions-toolbar label{display:flex;gap:5px;align-items:center}.actions-list{max-height:34dvh;overflow:auto;border-block:1px solid #eee;margin:10px 0}.actions-group h3{position:sticky;top:0;background:white;margin:0;padding:7px 0;font-size:13px}.actions-item{border-top:1px solid #eee;padding:7px 0;align-items:flex-start}.actions-item>button:first-child{flex:1;text-align:left;border:0;background:transparent;padding:3px}.actions-item small{display:block;color:#616161;font-size:12px}.actions-star{flex:none;min-width:32px}.actions-detail{padding:10px;background:#f7f9fb;border-radius:4px}.actions-detail h3{margin:0 0 5px}.actions-input{display:flex;flex-direction:column;gap:4px;margin:9px 0}.actions-input:has(input[type=checkbox]){flex-direction:row;align-items:center}.actions-reason{color:#8a4d00;font-size:12px}.actions-result{margin-top:12px;padding-top:10px;border-top:1px solid #c8c8c8}.actions-result h3{margin:0;font-size:14px}.actions-result p{white-space:pre-wrap;overflow-wrap:anywhere}.actions-table-wrap{max-height:32dvh;overflow:auto}.actions-result table{border-collapse:collapse;width:100%;font-size:12px}.actions-result th,.actions-result td{border-bottom:1px solid #eee;padding:6px;text-align:left;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;max-width:360px}.actions-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:28dvh;overflow:auto;font:12px/1.5 Consolas,monospace}.actions-identity{padding:9px;background:#fff4ce;color:#6b4d00;margin-top:8px;border-radius:4px}.actions-identity button{margin-left:8px}.actions-identity:empty{display:none}.actions-users{max-height:28dvh;overflow:auto}.actions-users button{display:block;width:100%;text-align:left;margin:5px 0}.actions-code{width:100%;min-height:180px;font:12px/1.5 Consolas,monospace!important;tab-size:2;resize:vertical}.actions-panel :focus-visible{outline:2px solid #0078d4;outline-offset:2px}.actions-status{min-height:20px;color:#005a9e;font-size:12px}.actions-muted{color:#616161;font-size:12px}@media(max-width:650px){.actions-panel{left:6px;bottom:70px;max-width:calc(100vw - 12px);padding:11px}.actions-toolbar,.actions-buttons{flex-wrap:wrap}.actions-list{max-height:29dvh}.actions-panel input:not([type=checkbox]){width:100%}}
  `); root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  const identitySheet = new CSSStyleSheet(); identitySheet.replaceSync('.actions-bar-identity>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions-bar-identity>button{flex:none}.ui:has(.actions-bar-identity:not([hidden]))>.panel{bottom:120px;max-height:calc(100dvh - 144px)}'); root.adoptedStyleSheets = [...root.adoptedStyleSheets, identitySheet];
  let shared;
  if(canonical){shared=new CSSStyleSheet();shared.replaceSync(`
    .actions-panel{position:static;inset:auto;width:100%;max-width:none;max-height:none;overflow:visible;padding:0;border:0;border-radius:0;box-shadow:none;background:var(--bg);color:var(--fg)}
    .actions-group h3{background:var(--bg)}.actions-detail{background:var(--tint)}.actions-panel .f[aria-pressed=true]{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}
    .actions-item>.actions-select{color:var(--fg)}.actions-item>.actions-select:hover{color:var(--link);background:var(--tint)}.actions-star{color:var(--fg)}
    .actions-panel input,.actions-panel textarea,.actions-panel select{background:var(--bg);color:var(--fg);border-color:var(--input-line);border-radius:var(--radius)}.actions-panel :focus-visible{outline-color:var(--primary)}
    .actions-item,.actions-list,.actions-result,.actions-result th,.actions-result td{border-color:var(--line)}.actions-item small,.actions-muted{color:var(--muted)}.actions-status{color:var(--link)}.actions-reason{color:var(--warn)}
    .actions-identity,.actions-bar-identity{background:var(--warn-bg);color:var(--fg);border-radius:var(--radius)}.actions-bar-identity{position:static;inset:auto;max-width:none;margin:6px 10px;padding:8px;border:1px solid var(--warn)}
    .actions-list{max-height:30vh}.actions-panel .actions-table-wrap{max-height:25vh}.actions-head h2{font-size:14px}.actions-tabs{flex-wrap:wrap}.actions-toolbar,.actions-buttons{flex-wrap:wrap}
  `);root.adoptedStyleSheets=[...root.adoptedStyleSheets,shared];}
  const make = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (label, callback, cls) => { const node = make('button', label, cls??(canonical?'btn':undefined)); node.type = 'button'; node.addEventListener('click', callback, { signal }); return node; };
  // Shared-panel chips for toggles; filled .btn only for commands. List rows keep the panel text color.
  const chip = canonical ? 'f' : undefined;
  const bar = root.querySelector('.bar'), launch = button('Actions', () => { panel.hidden ? open() : close(true); });
  launch.setAttribute('aria-expanded', 'false'); launch.setAttribute('aria-controls', 'paqvilo-actions-panel'); if(!canonical)bar.insertBefore(launch, bar.querySelector('.bar-status'));
  const panel = make('section', null, 'actions-panel'); panel.id = 'paqvilo-actions-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Model-driven actions');
  const head = make('div', null, 'actions-head'); head.append(make('h2', 'Model-driven actions'), button('×', () => close(true))); head.lastChild.setAttribute('aria-label', 'Close actions');if(canonical)head.lastChild.remove();
  const acting = make('div', null, 'actions-identity'); acting.setAttribute('role', 'status');
  const actingBar = make('div', null, 'actions-bar-identity'); actingBar.hidden = true; actingBar.setAttribute('role', 'status'); (canonical?root.querySelector('.wrap'):root.querySelector('.ui')).prepend(actingBar);
  const tabs = make('div', null, 'actions-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Developer tools');
  const content = make('div'), status = make('div', '', 'actions-status'), waiting = make('div', null, 'actions-buttons'), results = make('section', null, 'actions-result'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); results.hidden = true; results.setAttribute('aria-label', 'Action results');
  panel.append(head, acting, tabs, content, status, waiting, results); if(!canonical)root.querySelector('.ui').append(panel);
  let current = data, view = 'Actions', selectedAction, selectedUser, identity = { active:false }, identityRequest, disposed = false, selectedCommand, actionSearch = '', actionFilter = 'all', lastResultRequest;
  const requests = new Map(), params = new Map(), drafts = new Map(), commandKey = 'paqvilo.modelActions.commands.v1', preferenceKey = 'paqvilo.modelActions.labels.v1';
  const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { status.textContent = 'Browser storage is unavailable. Changes remain in this panel.'; return false; } };
  const preferences = readStore(preferenceKey, {}), favorites = new Set(Array.isArray(preferences.favorites) ? preferences.favorites.filter(value => typeof value === 'string').slice(0, 100) : []);
  let recent = Array.isArray(preferences.recent) ? preferences.recent.filter(value => typeof value === 'string').slice(0, 12) : [];
  const persistLabels = () => writeStore(preferenceKey, { version:1, favorites:[...favorites], recent });
  const validateCommands = value => {
    if (value?.version !== 1 || !Array.isArray(value.commands) || value.commands.length > 50) throw Error('Use version 1 JSON with at most 50 commands.');
    const ids = new Set();
    return value.commands.map(item => {
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120 || typeof item.code !== 'string' || item.code.length > 65536 || item.description != null && (typeof item.description !== 'string' || item.description.length > 500)) throw Error('Each command needs a unique ID, a label, and code up to 64 KiB.');
      ids.add(item.id); return { id:item.id, label:item.label.trim(), description:item.description ?? '', code:item.code };
    });
  };
  let commands; try { commands = validateCommands(readStore(commandKey, { version:1, commands:[] })); } catch { commands = []; }
  const availability = action => current.availability?.find(entry => entry.id === action.id) ?? { available:false, reason:'Reconnect Lense to read this action’s current context.' };
  const requestId = () => globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const busy = () => requests.size > 0;
  const remember = label => { recent = [label, ...recent.filter(value => value !== label)].slice(0, 12); persistLabels(); };
  function renderIdentity() {
    acting.replaceChildren();
    actingBar.replaceChildren(); actingBar.hidden = !identity.active;
    if (!canonical) { panel.style.bottom = identity.active ? '120px' : ''; panel.style.maxHeight = identity.active ? 'calc(100dvh - 144px)' : ''; }
    if (identity.active) { acting.append(make('span', `Acting as ${identity.label || 'the selected user'} for this tab’s Dataverse requests.`), button('Stop', () => startIdentity(null))); }
    if (identity.active) { const label = make('span', `Acting as ${identity.label || 'selected user'}`); label.title = label.textContent; actingBar.append(label, button('Stop', () => startIdentity(null))); }
  }
  function renderResult(value) {
    results.replaceChildren(); results.hidden = !value;
    if (!value) { lastResultRequest = undefined; return; }
    const heading = make('div', null, 'actions-head'), title = make('h3', value.title || 'Action result'); title.tabIndex = -1; heading.append(title, button('Clear', () => renderResult(null))); results.append(heading);
    if (value.message) results.append(make('p', String(value.message)));
    if (Array.isArray(value.columns) && Array.isArray(value.rows)) {
      const wrap = make('div', null, 'actions-table-wrap'), table = make('table'), header = make('tr');
      for (const label of value.columns.slice(0, 30)) { const th = make('th', String(label)); th.scope = 'col'; header.append(th); } const thead = make('thead'); thead.append(header); table.append(thead);
      const body = make('tbody'); for (const row of value.rows.slice(0, 200)) { const tr = make('tr'); for (const item of (Array.isArray(row) ? row : [row]).slice(0, 30)) tr.append(make('td', String(item ?? ''))); body.append(tr); } table.append(body); wrap.append(table);
      const filter = make('input', null, 'actions-search'); filter.type = 'search'; filter.setAttribute('aria-label', 'Filter results'); filter.placeholder = 'Filter results'; filter.addEventListener('input', () => { const term = filter.value.toLocaleLowerCase(); let count = 0; for (const row of body.children) { row.hidden = !row.textContent.toLocaleLowerCase().includes(term); if (!row.hidden) count++; } status.textContent = `${count} result rows shown.`; }, { signal }); results.append(filter, wrap);
    }
    if (value.text != null) results.append(make('pre', String(value.text)));
    const copyText = value.copyText ?? (Array.isArray(value.columns) && Array.isArray(value.rows) ? [value.columns, ...value.rows].map(row => row.map(item => String(item ?? '')).join('\t')).join('\n') : undefined);
    if (copyText != null) results.append(button('Copy result', async () => { try { await navigator.clipboard.writeText(String(copyText)); status.textContent = 'Result copied.'; } catch { status.textContent = 'Copy unavailable. Select the result text to copy it.'; } }));
    if (Array.isArray(value.links)) for (const item of value.links.slice(0, 200)) {
      try { const url = new URL(item.url, current.origin); if (url.origin !== current.origin || !['http:','https:'].includes(url.protocol) || url.username || url.password) continue; const link = make('a', String(item.label || 'Open native record')); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; const row = make('p'); row.append(link); results.append(row); } catch { /* Untrusted result links remain inert. */ }
    }
    if (Array.isArray(value.users)) {
      const list = make('div', null, 'actions-users');
      for (const user of value.users.slice(0, 200)) if (typeof user.objectId === 'string' && typeof user.label === 'string') list.append(button(user.label, () => { selectedUser = { objectId:user.objectId, label:user.label }; view = 'Identity'; renderView(); }));
      results.append(list);
    }
  }
  function receive(id, value) {
    const request = requests.get(id); if (disposed || !request || location.origin !== current.origin) return;
    requests.delete(id);
    if (request.kind === 'identity' && identityRequest === id && value?.identity) { identity = { active:Boolean(value.identity.active), label:value.identity.label ?? selectedUser?.label }; renderIdentity(); }
    renderResult(value ?? { title:'Action result', message:'The action completed without a result.' }); lastResultRequest = id; status.textContent = value?.status === 'ok' ? 'Completed.' : value?.status === 'cancelled' ? 'Cancelled.' : 'Action unavailable or failed.';
    renderView(); if (!panel.hidden) results.querySelector('h3')?.focus();
  }
  async function dispatch(kind, label, invoke) {
    const id = requestId(); requests.set(id, { kind, label }); if (kind === 'identity') identityRequest = id;
    status.textContent = `Running ${label}…`; renderResult(null); renderView(); waiting.querySelector('button')?.focus({ preventScroll:true });
    try { const ack = await invoke(id); if (ack?.accepted !== true && requests.has(id)) receive(id, { status:'unsupported', title:label, message:ack?.reason === 'invalid-input' ? 'Check the action inputs and try again.' : 'This tool could not start. Reconnect Lense and try again.' }); }
    catch { receive(id, { status:'error', title:label, message:'This tool could not start. Reconnect Lense and try again.' }); }
  }
  function runAction(action) {
    const supported = availability(action); if (!supported.available || busy()) return;
    const values = params.get(action.id) ?? {}; remember(action.label);
    return dispatch('action', action.label, id => window.__paqviloModelAction?.({ token:current.token, requestId:id, action:action.id, params:values }));
  }
  function startIdentity(objectId) {
    const label = objectId ? selectedUser?.label : 'Stop acting as another user';
    return dispatch('identity', label || 'Act as selected user', id => window.__paqviloModelIdentity?.({ token:current.token, requestId:id, objectId }));
  }
  function actionForm(action, parent) {
    const section = make('form', null, 'actions-detail'); section.append(make('h3', action.label), make('p', action.description));
    const values = params.get(action.id) ?? {}; params.set(action.id, values);
    for (const spec of action.inputs ?? []) {
      const label = make('label', spec.label, 'actions-input'), input = make('input'); input.name = spec.name; input.required = Boolean(spec.required); input.type = spec.type === 'boolean' ? 'checkbox' : 'text';
      if (spec.maxLength) input.maxLength = spec.maxLength;
      if (spec.type === 'table') { input.maxLength = 128; input.pattern = '[A-Za-z][A-Za-z0-9_]{0,127}'; input.title = 'Enter a table logical name using letters, digits and underscores.'; }
      if (spec.type === 'guid') { const guid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'; input.maxLength = 38; input.pattern = `(?:${guid}|\\{${guid}\\})`; input.title = 'Enter a record GUID, optionally enclosed in matching braces.'; }
      if (spec.type === 'boolean') { input.checked = values[spec.name] ?? spec.default ?? false; values[spec.name] = input.checked; }
      else { input.value = values[spec.name] ?? spec.default ?? ''; if (spec.type === 'guid') input.placeholder = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'; }
      input.addEventListener('input', () => { values[spec.name] = spec.type === 'boolean' ? input.checked : input.value; }, { signal }); label.append(input); section.append(label);
    }
    const support = availability(action); if (!support.available) section.append(make('p', support.reason || 'Unavailable on the current native page.', 'actions-reason'));
    const run = button('Run action', () => {}); run.type = 'submit'; run.disabled = !support.available || busy(); section.append(run);
    section.addEventListener('submit', event => { event.preventDefault(); if (section.reportValidity()) runAction(action); }, { signal }); parent.append(section);
  }
  function renderActions() {
    const search = make('input', null, 'actions-search'); search.type = 'search'; search.placeholder = 'Find actions'; search.setAttribute('aria-label', 'Find actions'); search.value = actionSearch;
    const list = make('div', null, 'actions-list'), detail = make('div'); content.append(search);
    const controls = make('div', null, 'actions-toolbar');
    for (const [label, value] of [['All','all'], ['Favorites','favorites'], ['Recent','recent']]) { const control = button(label, () => { actionFilter = value; for (const item of controls.children) item.setAttribute('aria-pressed', String(item === control)); draw(); }, chip); control.setAttribute('aria-pressed', String(value === actionFilter)); controls.append(control); } content.append(controls, list, detail);
    function draw() {
      list.replaceChildren(); const term = search.value.toLocaleLowerCase(), entries = (current.actions ?? []).filter(action => `${action.label} ${action.description} ${action.group}`.toLocaleLowerCase().includes(term) && (actionFilter === 'all' || actionFilter === 'favorites' && favorites.has(action.label) || actionFilter === 'recent' && recent.includes(action.label)));
      // Off a record form, form and record actions gather at the end under one heading instead of mixing with what works here.
      const groupOf = action => (availability(action).needsRecord ? 'Needs a record form' : action.group);
      const groups = [...new Set(entries.map(groupOf))].sort((left, right) => Number(left === 'Needs a record form') - Number(right === 'Needs a record form'));
      for (const group of groups) {
        const section = make('section', null, 'actions-group'); section.append(make('h3', group));
        if (group === 'Needs a record form') section.append(make('p', 'Open a record of this table (or any table) to use these.', 'actions-muted'));
        for (const action of entries.filter(entry => groupOf(entry) === group)) {
          const row = make('div', null, 'actions-item'), select = button(action.label, () => { selectedAction = action.id; detail.replaceChildren(); actionForm(action, detail); }, 'actions-select');
          const support = availability(action); select.append(make('small', support.available ? action.description : support.reason || 'Unavailable on this page.'));
          const favorite = button(favorites.has(action.label) ? '★' : '☆', () => { favorites.has(action.label) ? favorites.delete(action.label) : favorites.add(action.label); persistLabels(); draw(); }, 'actions-star'); favorite.setAttribute('aria-label', `Favorite ${action.label}`); favorite.setAttribute('aria-pressed', String(favorites.has(action.label))); row.append(select, favorite); section.append(row);
        } list.append(section);
      }
      if (!entries.length) list.append(make('p', 'No matching actions.', 'actions-muted'));
    }
    search.addEventListener('input', () => { actionSearch = search.value; draw(); }, { signal }); draw(); const action = current.actions?.find(entry => entry.id === selectedAction); if (action) actionForm(action, detail);
  }
  function renderIdentityView() {
    content.append(make('p', 'Choose a directory user, then explicitly start requests as that user. This applies to this tab’s Dataverse Web API reads and writes. Server permissions still apply; your signed-in account stays the same.', 'actions-muted'));
    const users = current.actions?.find(action => action.id === 'identity:users');
    if (users) actionForm(users, content); else content.append(make('p', 'Directory lookup is unavailable in this session.', 'actions-reason'));
    if (selectedUser) { const check = current.actions?.find(action => action.id === 'identity:status'), support = check ? availability(check) : { available:false, reason:'The current native page does not provide privilege-check support.' }; content.append(make('p', `Selected user: ${selectedUser.label}`)); const start = button('Start acting as selected user', () => startIdentity(selectedUser.objectId)); start.disabled = busy() || identity.active || !support.available; content.append(start); if (!support.available) content.append(make('p', support.reason || 'The current native page does not provide privilege-check support.', 'actions-reason')); if (identity.active) content.append(make('p', 'Stop acting as the current user before starting another identity.', 'actions-muted')); }
    if (identity.active) content.append(button('Stop acting as another user', () => startIdentity(null)));
  }
  function renderCommands() {
    content.append(make('p', 'Commands are stored in this origin’s browser storage. Save or import edits them; only Run executes code in this native app. Code can use await and the current Xrm API.', 'actions-muted'));
    const toolbar = make('div', null, 'actions-buttons'), chooser = make('select'); chooser.setAttribute('aria-label', 'Saved custom commands'); chooser.append(new Option('New command', '')); for (const command of commands) chooser.append(new Option(command.label, command.id)); chooser.value = selectedCommand ?? '';
    chooser.addEventListener('change', () => { selectedCommand = chooser.value || undefined; renderView(); }, { signal });
    const command = commands.find(item => item.id === selectedCommand), draftKey = selectedCommand ?? '_new', draft = drafts.get(draftKey) ?? { label:command?.label ?? '', code:command?.code ?? '' }, form = make('form'), labelInput = make('input'); drafts.set(draftKey, draft); labelInput.value = draft.label; labelInput.required = true; labelInput.maxLength = 120; labelInput.setAttribute('aria-label', 'Command label'); labelInput.placeholder = 'Command label';
    const code = make('textarea', null, 'actions-code'); code.value = draft.code; code.maxLength = 65536; code.required = true; code.spellcheck = false; code.setAttribute('aria-label', 'Command JavaScript');
    labelInput.addEventListener('input', () => { draft.label = labelInput.value; }, { signal }); code.addEventListener('input', () => { draft.code = code.value; }, { signal });
    toolbar.append(chooser, button('New', () => { selectedCommand = undefined; drafts.delete('_new'); renderView(); }));
    const save = button('Save command', () => {}); save.type = 'submit';
    form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; try { const entry = { id:command?.id ?? requestId(), label:labelInput.value.trim(), description:command?.description ?? '', code:code.value }; const next = command ? commands.map(item => item.id === entry.id ? entry : item) : [...commands, entry]; commands = validateCommands({ version:1, commands:next }); writeStore(commandKey, { version:1, commands }); selectedCommand = entry.id; status.textContent = 'Command saved in this browser.'; renderView(); } catch (error) { status.textContent = error.message; } }, { signal });
    const actions = make('div', null, 'actions-buttons'); actions.append(save, button('Delete command', () => { if (!command) return; commands = commands.filter(item => item.id !== command.id); writeStore(commandKey, { version:1, commands }); selectedCommand = undefined; renderView(); })); actions.lastChild.disabled = !command;
    const run = button('Run command', () => { if (!form.reportValidity() || busy()) return; remember(labelInput.value.trim()); void dispatch('command', labelInput.value.trim(), id => host.__paqModelCommands?.token === current.token ? host.__paqModelCommands.run({ id:command?.id ?? 'unsaved', code:code.value, timeoutMs:10000, requestId:id }) : undefined); }); run.disabled = busy(); actions.append(run);
    const file = make('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    file.addEventListener('change', async () => { const selected = file.files?.[0]; if (!selected) return; try { if (selected.size > 4 * 1024 * 1024) throw Error('The import exceeds 4 MiB.'); const imported = validateCommands(JSON.parse(await selected.text())); commands = imported; drafts.clear(); writeStore(commandKey, { version:1, commands }); selectedCommand = undefined; status.textContent = `Imported ${commands.length} commands. Nothing was executed.`; renderView(); } catch (error) { status.textContent = error.message || 'Invalid command JSON.'; } }, { signal });
    actions.append(button('Import JSON', () => file.click()), button('Export JSON', () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ version:1, commands }, null, 2)], { type:'application/json' })), link = make('a'); link.href = url; link.download = 'paqvilo-commands.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
    form.append(labelInput, code, actions, file); content.append(toolbar, form);
  }
  function renderView() {
    waiting.replaceChildren();
    if ([...requests.values()].some(request => request.kind !== 'identity')) waiting.append(button('Stop waiting', () => {
      for (const [id, request] of requests) if (request.kind !== 'identity') requests.delete(id);
      host.__paqModelActionState?.cancelPending?.(); host.__paqModelCommands?.cancelPending?.(); renderResult(null); status.textContent = 'Stopped waiting. Native operations or JavaScript that ignore cancellation may still be running.'; renderView();
    }));
    tabs.replaceChildren(); for (const label of ['Actions','Identity','Custom']) { const tab = button(label, () => { view = label; renderView(); [...tabs.children].find(node => node.textContent === label)?.focus(); }, chip); tab.setAttribute('aria-pressed', String(view === label)); tabs.append(tab); }
    content.replaceChildren(); if (view === 'Actions') renderActions(); else if (view === 'Identity') renderIdentityView(); else renderCommands();
  }
  function open() { if(canonical)host.__pp.openTab('actions');else host.__paqModelInspector?.closePanel?.(); panel.hidden = false; launch.setAttribute('aria-expanded', 'true'); renderView(); content.querySelector('input,button,select')?.focus(); }
  function close(focus = false) { panel.hidden = true; launch.setAttribute('aria-expanded', 'false'); if(focus){if(canonical){host.__pp.openTab('overrides');root.querySelector('[data-v=overrides]')?.focus();}else launch.focus();} }
  const mount = () => {
    const slot = root.querySelector('[data-panel-actions-host]');
    if (slot) { const wasHidden = panel.hidden; if (panel.parentNode !== slot) slot.append(panel); panel.hidden = false; if (wasHidden) renderView(); }
    else panel.hidden = true;
    if (canonical && !actingBar.isConnected) root.querySelector('.wrap')?.prepend(actingBar);
  };
  if (canonical) host.addEventListener('paqvilo-panel-render', event => { if (event.detail?.token === data.token) mount(); }, { signal });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }, { signal });
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) close(true); }, { signal });
  host.__paqModelActions = { token:data.token, receive, close, followup(id, value) { if (disposed || !lastResultRequest || id !== lastResultRequest || location.origin !== current.origin) return; renderResult(value); status.textContent = value?.status === 'ok' ? 'Completed.' : 'Native operation reported an error.'; if (!panel.hidden) results.querySelector('h3')?.focus(); }, update(next) {
    const focused = root.activeElement, anchor = focused && content.contains(focused) ? { label:focused.getAttribute('aria-label'), name:focused.getAttribute('name'), start:focused.selectionStart, end:focused.selectionEnd } : undefined;
    current = next; if (!panel.hidden) renderView();
    if (anchor) { const replacement = [...content.querySelectorAll('input,textarea,select')].find(node => anchor.label ? node.getAttribute('aria-label') === anchor.label : anchor.name && node.getAttribute('name') === anchor.name); if (replacement) { replacement.focus({ preventScroll:true }); if (anchor.start != null) try { replacement.setSelectionRange(anchor.start, anchor.end); } catch {} } }
  }, contextChanged() {
    for (const [id, request] of requests) if (request.kind !== 'identity') requests.delete(id);
    params.clear(); selectedUser = undefined; renderResult(null); host.__paqModelCommands?.cancelPending?.(); status.textContent = 'The native page changed. Previous results and action inputs were cleared.'; if (!panel.hidden) renderView();
  }, dispose() { if (disposed) return; disposed = true; lifetime.abort(); requests.clear(); params.clear(); drafts.clear(); selectedUser = undefined; lastResultRequest = undefined; host.__paqModelActionState?.dispose?.(); host.__paqModelCommands?.dispose?.(); panel.remove(); actingBar.remove(); launch.remove(); root.adoptedStyleSheets = root.adoptedStyleSheets.filter(item => item !== sheet && item !== identitySheet && item !== shared); if (host.__paqModelActions?.token === data.token) delete host.__paqModelActions; } };
  renderView();
  if (canonical) mount();
}
