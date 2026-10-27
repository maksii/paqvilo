const $ = (id) => document.getElementById(id);
const select = $('app'),
  frame = $('preview'),
  status = $('connection'),
  error = $('error');
let apps = [],
  selected = null,
  selectedOrigin = null;
const parameters = new Map();
const clear = (element) => element.replaceChildren();
const text = (parent, tag, value) => {
  const node = document.createElement(tag);
  node.textContent = value;
  parent.append(node);
  return node;
};
function safePath(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, selectedOrigin);
    return url.pathname;
  } catch {
    return '';
  }
}
function lines(value) {
  const result = new URLSearchParams();
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Each parameter needs a name followed by = and a value.');
    result.append(line.slice(0, separator).trim(), line.slice(separator + 1));
  }
  return result;
}
function renderList(id, values, empty) {
  const element = $(id);
  clear(element);
  if (!values.length) text(element, 'li', empty);
  else for (const value of values) text(element, 'li', value);
}
function launch() {
  if (!selected?.localAppUrl) {
    frame.hidden = true;
    frame.removeAttribute('src');
    selectedOrigin = null;
    status.textContent = 'No local app URL';
    return;
  }
  try {
    const target = new URL(selected.localAppUrl);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      !(
        target.hostname === 'localhost' ||
        target.hostname.endsWith('.localhost') ||
        /^127(?:\.\d{1,3}){3}$/.test(target.hostname) ||
        target.hostname === '[::1]'
      )
    )
      throw new Error('The local app URL must be loopback HTTP(S).');
    selectedOrigin = target.origin;
    for (const [key, value] of lines($('parameters').value)) target.searchParams.append(key, value);
    const opened = new URL(selected.launchUrl, location.origin);
    opened.search = lines($('parameters').value).toString();
    $('open').href = opened.href;
    frame.src = target.href;
    frame.hidden = false;
    status.textContent = 'Waiting for bridge';
    error.textContent = '';
  } catch (problem) {
    selectedOrigin = null;
    frame.hidden = true;
    frame.removeAttribute('src');
    error.textContent = problem.message;
  }
}
function choose(name, { keepFrame = false } = {}) {
  if (selected) parameters.set(selected.name, $('parameters').value);
  selected = apps.find((app) => app.name === name) ?? null;
  if (!keepFrame) {
    selectedOrigin = null;
    clear($('events'));
    status.textContent = 'Not connected';
    frame.hidden = true;
    frame.removeAttribute('src');
  }
  $('reload').disabled = !selected;
  $('apply').disabled = !selected;
  $('parameters').disabled = !selected;
  $('open').hidden = !selected;
  if (!selected) {
    $('server').textContent = 'Server reachability not checked';
    return;
  }
  $('server').textContent =
    selected.server?.state === 'reachable'
      ? `Server reachable${selected.server.status ? ` (HTTP ${selected.server.status})` : ''}; app readiness is not verified.`
      : selected.server?.state === 'unavailable'
        ? 'Server unavailable. Start the app dev server and check its local URL, then refresh.'
        : 'Server reachability not checked';
  renderList('app-settings', selected.appSettingNames ?? [], 'No app settings declared.');
  $('parameters').value = parameters.get(selected.name) ?? '';
  $('open').href = selected.launchUrl;
  $('open').target = '_blank';
  $('open').rel = 'noopener';
  renderList(
    'diagnostics',
    (selected.diagnostics ?? []).map((d) => `${d.code}: ${d.message}`),
    'No configuration diagnostics.',
  );
  renderList(
    'connections',
    (selected.connectionReferences ?? []).map(
      (r) =>
        `${r.key}${r.apiId ? ` · ${r.apiId}` : ''}${r.dataSources?.length ? ` · ${r.dataSources.join(', ')}` : ''}`,
    ),
    'No declared connections.',
  );
  const mappings = $('mappings');
  clear(mappings);
  for (const [name, entity] of Object.entries(selected.entitySets ?? {})) {
    text(mappings, 'dt', name);
    text(mappings, 'dd', entity);
  }
  const address = new URL(location.href);
  address.searchParams.set('app', selected.name);
  history.replaceState(null, '', address);
  if (!keepFrame) launch();
}
select.addEventListener('change', () => choose(select.value));
$('reload').addEventListener('click', launch);
$('apply').addEventListener('click', () => {
  if (selected) parameters.set(selected.name, $('parameters').value);
  launch();
});
window.addEventListener('message', (message) => {
  const payload = message.data,
    event = payload?.event;
  if (
    !selected ||
    !selectedOrigin ||
    message.source !== frame.contentWindow ||
    message.origin !== selectedOrigin ||
    payload?.type !== 'paqvilo:code-app' ||
    payload.app !== selected.name ||
    !event ||
    !['request', 'request-error', 'bridge-ready', 'bridge-error', 'app-error'].includes(event.kind)
  )
    return;
  const path = safePath(event.path);
  const prefix = `/_apps/code/${encodeURIComponent(selected.name)}/`;
  if (event.path != null && (!path || !path.startsWith(prefix))) return;
  if (event.kind === 'bridge-ready') status.textContent = 'Bridge connected';
  if (event.kind === 'bridge-error') status.textContent = 'Bridge initialization failed; inspect DevTools';
  if (event.kind === 'app-error') status.textContent = 'App error; inspect DevTools';
  if (event.kind === 'request-error' && event.status === 401 && path.endsWith('/context'))
    status.textContent = 'Staff session required; select a user in Admin';
  const parts = [event.kind];
  if (['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].includes(event.method)) parts.push(event.method);
  if (path) parts.push(path.replace(/\([^)]*\)?/g, '(...)').slice(0, 500));
  if (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599) parts.push(String(event.status));
  if (Number.isFinite(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 600000)
    parts.push(`${Math.round(event.durationMs)} ms`);
  // Arbitrary messages can carry secrets. Only display the event kind and bounded request metadata.
  text($('events'), 'li', parts.join(' · '));
  while ($('events').children.length > 100) $('events').firstElementChild.remove();
});
async function refreshApps(probe = false) {
  const button = $('refresh');
  button.disabled = true;
  try {
    const previous = selected,
      previousName = selected?.name ?? new URL(location.href).searchParams.get('app');
    if (selected) parameters.set(selected.name, $('parameters').value);
    const response = await fetch('/_apps/code/_api/apps' + (probe ? '?probe=1' : ''), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load apps (HTTP ${response.status}).`);
    const data = await response.json();
    apps = Array.isArray(data.apps) ? data.apps : [];
    clear(select);
    for (const app of apps) {
      const option = text(select, 'option', app.name);
      option.value = app.name;
    }
    select.disabled = !apps.length;
    error.textContent = '';
    if (!apps.length) {
      text(select, 'option', 'No code apps configured');
      choose(null);
      error.textContent = 'Add code apps in Setup and restart the preview.';
    } else {
      const next = apps.find((app) => app.name === previousName) ?? apps[0];
      select.value = next.name;
      choose(next.name, {
        keepFrame: Boolean(previous && previous.name === next.name && previous.localAppUrl === next.localAppUrl),
      });
    }
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}
$('refresh').addEventListener('click', () => void refreshApps(true));
await refreshApps();
