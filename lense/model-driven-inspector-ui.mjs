// Self-contained browser UI: no application text, attribute values, or record values are read.
export function modelDrivenInspectorUi(data) {
  if (location.origin !== data.origin || !document.body || window.__paqviloRetiredModelInspectors?.includes(data.token)) return;
  let host = document.getElementById('paqvilo-model-inspector');
  if (host?.__paqModelInspector?.token === data.token) { host.__paqModelInspector.update(data); return; }
  host?.__paqModelInspector?.dispose();
  host = document.createElement('div'); host.id = 'paqvilo-model-inspector';
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = new CSSStyleSheet(); style.replaceSync(`
    *{box-sizing:border-box} .ui{font:13px/1.5 "Segoe UI",system-ui,sans-serif;color:#242424;text-align:left}
    button:disabled{cursor:progress;opacity:.65}.status{display:flex;align-items:center;gap:8px;padding:9px 10px;margin:10px 0;background:#eff6fc;border-radius:4px;color:#005a9e}.status.error{background:#fff4ce;color:#6b4d00}.spinner{width:14px;height:14px;flex:none;border:2px solid #0078d433;border-top-color:#0078d4;border-radius:50%;animation:spin .9s linear infinite}.scan{position:fixed;inset:0;pointer-events:none;display:none;box-shadow:inset 0 0 0 2px #0078d455}.scan:after{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:#0078d4;box-shadow:0 0 24px 5px #0078d444;animation:scan 2.5s ease-in-out infinite}.scan.active{display:block}.bar-status{font-size:12px;color:#005a9e;padding:0 5px}.bar-status:empty{display:none}@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{from{transform:translateY(0)}to{transform:translateY(100dvh)}}@media(prefers-reduced-motion:reduce){.spinner,.scan:after{animation:none}.scan:after{top:0}}
    button{font:inherit;color:inherit;cursor:pointer;padding:5px 9px;background:#fff;border:1px solid #c8c8c8;border-radius:4px}button:hover{background:#f0f6fc}button:focus-visible{outline:2px solid #0078d4}button[aria-pressed=true]{background:#deecf9;border-color:#0078d4}
    .bar,.panel{pointer-events:auto;background:#fff;border:1px solid #c8c8c8;border-radius:6px;box-shadow:0 4px 18px #0003}.bar{position:fixed;bottom:12px;left:12px;display:flex;align-items:center;gap:6px;padding:6px}.brand{font-weight:600;color:#0078d4;padding:0 6px}.panel{position:fixed;bottom:68px;left:12px;width:460px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 92px);overflow:auto;padding:12px}.panel[hidden]{display:none}.head{display:flex;align-items:center;gap:8px}.head b{flex:1}h3{font-size:13px;margin:14px 0 5px}.muted{color:#616161;font-size:12px}.mono{font:11px/1.5 Consolas,monospace;overflow-wrap:anywhere}.row{border-top:1px solid #eee;padding:6px 0;overflow-wrap:anywhere}.good{color:#107c10}.warn{color:#8a4d00}.outline{position:fixed;pointer-events:none;border:2px solid #0078d4;background:#0078d415;display:none}.selection{border-left:3px solid #0078d4;padding-left:8px}summary{cursor:pointer}details{margin-top:8px}p{margin:5px 0}ul{padding-left:20px}code{overflow-wrap:anywhere}
  `); root.adoptedStyleSheets = [style];
  const ui = document.createElement('div'); ui.className = 'ui'; ui.innerHTML = '<div class="scan" aria-hidden="true"></div><div class="outline"></div><div class="panel" hidden></div><div class="bar"><span class="brand">Paqvilo</span><button data-action="panel" aria-label="Model-driven developer panel">Resources</button><button data-action="pick" aria-pressed="false">X-ray</button><span class="bar-status" role="status" aria-live="polite"></span></div>';
  root.append(ui);
  const panel = ui.querySelector('.panel'), outline = ui.querySelector('.outline'), lifetime = new AbortController();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  let current = data, opened = false, picking = false, selected = null, frame = 0, disposed = false;
  const own = event => event.composedPath().includes(host);
  const drawOutline = () => {
    frame = 0;
    if (!selected?.isConnected || !opened) { outline.style.display = 'none'; return; }
    const rect = selected.getBoundingClientRect();
    Object.assign(outline.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  };
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(drawOutline); };
  const lines = values => values.map(value => `<div class="mono">${esc(value)}</div>`).join('');
  const formCandidates = () => {
    const context = current.context ?? {}, forms = current.catalogue.forms;
    const exact = context.formId && forms.filter(form => form.id === context.formId);
    return exact?.length ? exact : forms.filter(form => context.entity && form.entity === context.entity);
  };
  const sourceInfo = () => {
    if (!selected?.isConnected) return '<p class="muted">Select X-ray, then a field, PCF input or command. Esc returns to normal interaction; hold Ctrl to use the app.</p>';
    const target = selected.closest('[data-id]') ?? selected;
    const dataId = target.getAttribute('data-id') ?? '', fieldName = dataId.split('.')[0];
    const forms = formCandidates(), fields = forms.flatMap(form => form.controls.filter(control => [control.name, control.id].includes(fieldName)).map(control => ({ form, control })));
    const commandLocation = current.context?.pageType === 'entitylist' ? 'grid' : current.context?.formId || current.context?.formType != null || current.context?.pageType === 'entityrecord' ? 'form' : null;
    const matchingCommands = current.catalogue.commands.filter(command => command.id && current.context?.entity && command.entity === current.context.entity
      && command.locations?.includes(commandLocation) && (dataId === command.id || command.nativeControlIds?.includes(dataId)
        || commandLocation === 'form' && dataId === `${command.entity}|NoRelationship|Form|${command.id}`));
    const commands = matchingCommands.length === 1 ? matchingCommands : [];
    let html = `<div class="selection"><b>Element: ${esc(selected.localName)}</b>${dataId ? `<div class="mono">data-id: ${esc(dataId.slice(0, 300))}</div>` : ''}${selected.localName === 'iframe' ? '<p class="warn">Frame boundary: inspect the frame in its own tab. Inner controls are not associated from the parent document.</p>' : ''}</div>`;
    if (!fields.length && !commands.length) html += '<p class="muted">No declared control or command matches this element. App and form resources below remain candidates; ownership is not inferred.</p>';
    if (matchingCommands.length > 1) html += '<p class="warn">Multiple declared commands match this native identifier. Command ownership is ambiguous; handlers are not attributed.</p>';
    for (const { form, control } of fields.slice(0, 20)) {
      html += `<h3>${esc(control.label || control.name)}</h3><p class="mono">Column: ${esc(control.name)} · Control: ${esc(control.id)}</p><p class="muted">${current.context?.formId === form.id ? 'Current native form ID matched' : current.context?.formId ? 'Candidate form matched by table; current native form is absent from selected sources' : 'Candidate form matched by table; current form ID unavailable'}: ${esc(form.name)}</p>${lines([form.source])}`;
      if (control.pcf) {
        const resources = current.resources.filter(resource => resource.name.startsWith(control.pcf.name + '/'));
        html += `<h3>PCF: ${esc(control.pcf.name)}</h3>${resources.map(resourceHtml).join('') || '<p class="warn">No selected PCF assets available.</p>'}`;
      }
      const handlers = form.events.filter(event => !event.attribute || event.attribute === control.name);
      html += `<h3>Declared form events</h3>${handlers.map(event => `<div class="row"><b>${esc(event.name)}</b>${event.attribute ? ' · ' + esc(event.attribute) : ''}${!event.active ? ' (disabled)' : ''}${lines(event.handlers.map(handler => `${handler.enabled ? '' : '[disabled] '}${handler.library}: ${handler.functionName}`))}</div>`).join('') || '<p class="muted">No exported handlers.</p>'}`;
    }
    for (const command of commands.slice(0, 20)) html += `<h3>Declared ribbon command: ${esc(command.label || command.id)}</h3>${lines([command.source, ...command.actions.map(action => `${action.library}: ${action.functionName}`)])}<p class="muted">${command.supported ? 'Supported local command contract' : 'Outside the local command support contract'}. Native execution is controlled by the environment.</p>`;
    return html;
  };
  const resourceHtml = resource => `<div class="row"><b>${esc(resource.name)}</b><span class="${resource.currentRevisionApplied ? 'good' : 'warn'}"> · ${resource.currentRevisionApplied ? 'applied ' + resource.currentRevisionApplied + '×' : 'not observed on this revision'}</span>${lines([resource.source, ...(resource.paths ?? [])])}${resource.unbound ? '<p class="warn">Requires an exact observed native resource map.</p>' : ''}</div>`;
  const render = () => {
    const scrollTop = panel.scrollTop;
    const sections = [...panel.querySelectorAll('details')].map(section => section.open);
    // Leave the native app exposed while selecting: a long details card can
    // otherwise cover the ribbon/control the user is trying to inspect.
    panel.hidden = !opened || picking;
    panel.setAttribute('aria-busy', String(Boolean(current.pendingInspection)));
    ui.querySelector('.scan').classList.toggle('active', picking && Boolean(current.pendingInspection));
    ui.querySelector('.bar-status').textContent = current.pendingInspection ? 'Inspecting app…' : picking ? 'Select an element · Esc to exit' : current.inspectionError ? 'Refresh failed' : '';
    ui.querySelector('[data-action=pick]').setAttribute('aria-pressed', String(picking));
    if (!opened) { outline.style.display = 'none'; return; }
    const context = current.context ?? {}, forms = formCandidates();
    panel.innerHTML = `<div class="head"><b>Model-driven X-ray</b><button data-action="refresh" ${current.pendingInspection ? 'disabled aria-busy="true"' : ''}>${current.pendingInspection ? 'Refreshing…' : 'Refresh'}</button><button data-action="close" aria-label="Close developer panel">×</button></div><p class="muted">Local Solution assets over the selected environment. App actions use native data.</p>${current.pendingInspection ? '<div class="status" role="status"><span class="spinner" aria-hidden="true"></span><span>Reading app context and matching Solution sources…' + (current.observedAt ? ' Previous results stay visible.' : '') + '</span></div>' : current.inspectionError ? '<div class="status error" role="alert">' + esc(current.inspectionError) + '</div>' : ''}<h3>App context</h3>${lines([context.entity && 'Table: ' + context.entity, context.appId && 'App: ' + context.appId, context.formId && 'Form: ' + context.formId, context.identity?.available ? 'User: ' + (context.identity.userId ?? 'available') + (context.identity.roleCount == null ? '' : ' · roles: ' + context.identity.roleCount) : current.pendingInspection ? 'Reading signed-in app context…' : 'Signed-in user context unavailable'].filter(Boolean))}<h3>Selected element</h3>${sourceInfo()}<details><summary>Candidate form sources (${forms.length})</summary>${forms.slice(0, 20).map(form => `<div class="row"><b>${esc(form.name)}</b>${lines([form.source, ...form.libraries])}</div>`).join('')}</details><details open><summary>Solution resources (${current.resourceCount}) · revision ${current.revision}</summary>${current.resources.map(resourceHtml).join('') || '<p class="muted">No selected script/style resources.</p>'}</details><details open><summary>Diagnostics (${current.diagnostics.length}) / runtime problems (${current.problems.length})</summary>${current.diagnostics.map(item => `<div class="row warn">${esc(item.code)}: ${esc(item.message)}</div>`).join('')}${current.problems.map(item => `<div class="row warn">${esc(item.type)}: ${esc(item.text)}${item.url ? `<div class="mono">${esc(item.url)}</div>` : ''}</div>`).join('')}</details><p class="muted">${current.truncated ? 'Lists are bounded to 200 items. ' : ''}A browser cache can prevent native resources from requesting local assets. Applied counts prove delivery, not handler rebinding or constructor replacement. Use browser DevTools for breakpoints; the loopback agent provides bounded DOM, screenshots, navigation and events.</p>`;
    for (const [index, section] of [...panel.querySelectorAll('details')].entries()) if (sections[index] != null) section.open = sections[index];
    panel.scrollTop = scrollTop;
    schedule();
  };
  const pick = value => { picking = value; opened ||= value; render(); };
  const refresh = () => {
    if (current.pendingInspection) return;
    current = { ...current, pendingInspection: true, inspectionError: '' }; render();
    Promise.resolve(window.__paqviloModelInspectorRefresh?.()).then(accepted => { if (accepted === false || accepted == null) throw Error('Refresh unavailable'); }).catch(() => {
      if (disposed) return;
      current = { ...current, pendingInspection: false, inspectionError: 'Refresh could not start. Reconnect Lense and try again.' }; render();
    });
  };
  root.addEventListener('click', event => {
    const action = event.target.closest?.('[data-action]')?.dataset.action;
    if (action === 'panel') { opened = !opened; if (!opened) picking = false; render(); if (opened) refresh(); }
    if (action === 'pick') { pick(!picking); if (picking) refresh(); }
    if (action === 'close') { opened = false; picking = false; render(); }
    if (action === 'refresh') refresh();
  }, { signal: lifetime.signal });
  window.addEventListener('pointermove', event => {
    if (!picking || event.ctrlKey || own(event)) return;
    const node = event.composedPath().find(item => item instanceof Element);
    if (node && node !== selected) { selected = node; schedule(); }
  }, { capture: true, signal: lifetime.signal });
  window.addEventListener('click', event => {
    if (!picking || event.ctrlKey || own(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    selected = event.composedPath().find(item => item instanceof Element) ?? null;
    picking = false; render(); panel.scrollTop = 0;
  }, { capture: true, signal: lifetime.signal });
  for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu']) window.addEventListener(name, event => {
    if (!picking || event.ctrlKey || own(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, { capture: true, passive: false, signal: lifetime.signal });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picking) { event.preventDefault(); event.stopImmediatePropagation(); pick(false); }
    if (event.altKey && event.shiftKey && event.code === 'KeyX') { event.preventDefault(); pick(!picking); if (picking) refresh(); }
    if (picking && !event.ctrlKey && !own(event) && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, signal: lifetime.signal });
  window.addEventListener('scroll', schedule, { capture: true, passive: true, signal: lifetime.signal });
  window.addEventListener('resize', schedule, { passive: true, signal: lifetime.signal });
  host.__paqModelInspector = { token: data.token, update(next) { current = next; render(); }, dispose() { disposed = true; lifetime.abort(); if (frame) cancelAnimationFrame(frame); selected = null; host.remove(); } };
  render();
}
