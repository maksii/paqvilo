// Guide interactions: path/shell pickers, copy buttons, a stored checklist, the catalogue builder,
// clip playback and the contents highlight.
// Without JavaScript every path stays visible and the page remains readable.
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
const KEY = 'paqvilo-guide';
const saved = store.get(KEY) || {};
const state = { path: saved.path || 'demo', shell: saved.shell || 'ps', done: saved.done && typeof saved.done === 'object' ? saved.done : {} };
const save = () => store.set(KEY, state);

const pickers = document.getElementById('pickers');
const steps = [...document.querySelectorAll('.steps')];
const progress = document.getElementById('progress-text');
const status = document.getElementById('copy-status');

function render() {
  for (const list of steps) list.hidden = list.dataset.path !== state.path;
  document.body.classList.toggle('shell-ps', state.shell === 'ps');
  document.body.classList.toggle('shell-sh', state.shell === 'sh');
  const boxes = [...document.querySelectorAll(`.steps[data-path="${state.path}"] input[type=checkbox]`)];
  progress.textContent = `${boxes.filter((box) => box.checked).length} of ${boxes.length} steps done`;
}

for (const name of ['path', 'shell']) {
  const input = pickers.querySelector(`input[name=${name}][value="${state[name]}"]`);
  if (input) input.checked = true; else state[name] = pickers.querySelector(`input[name=${name}]`).value;
}
pickers.addEventListener('change', (event) => { state[event.target.name] = event.target.value; save(); render(); });

for (const box of document.querySelectorAll('.step input[type=checkbox]')) {
  box.checked = state.done[box.id] === true;
  box.addEventListener('change', () => { state.done[box.id] = box.checked; save(); render(); });
}
document.getElementById('progress-reset').addEventListener('click', () => {
  for (const box of document.querySelectorAll(`.steps[data-path="${state.path}"] input[type=checkbox]`)) { box.checked = false; delete state.done[box.id]; }
  save(); render();
});

// Copy buttons; shell labels only on runnable commands, not on file contents.
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.setAttribute('readonly', '');
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
for (const block of document.querySelectorAll('.cmd')) {
  const bar = document.createElement('div');
  bar.className = 'cmd-bar';
  bar.innerHTML = block.classList.contains('plain') ? '<span>FILE</span>' : '<span class="only-ps">POWERSHELL</span><span class="only-sh">BASH</span>';
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copy' });
  button.setAttribute('aria-label', 'Copy to clipboard');
  button.addEventListener('click', async () => {
    // innerText skips the hidden shell variant.
    const ok = await copy(block.querySelector('code').innerText);
    button.textContent = ok ? 'Copied' : 'Select and copy';
    status.textContent = ok ? 'Copied to clipboard' : 'Copy failed; select the text instead';
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  bar.append(button);
  block.prepend(bar);
}

// Catalogue builder: only the fields of the documented starting catalogue.
const form = document.getElementById('build-config');
const output = document.getElementById('cfg-output');
const error = document.getElementById('cfg-error');
// Quote anything that is not a plain YAML scalar; JSON strings are valid YAML.
const special = /^(?:[-+]?[0-9._]+|true|false|null|yes|no|on|off|y|n|~)$/i;
const scalar = (value) => (/^[A-Za-z0-9._/:-]+$/.test(value) && !/^[-:]|:$/.test(value) && !special.test(value) ? value : JSON.stringify(value));
const key = (value) => (/^[A-Za-z0-9_-]+$/.test(value) && !special.test(value) ? value : JSON.stringify(value));

function build() {
  const data = Object.fromEntries(new FormData(form));
  const site = data.site.trim() || 'portal';
  const exportPath = data.export.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || 'sources/portal-export';
  const url = data.url.trim() || 'https://your-portal.example.test';
  const editor = data.editor.trim();
  const problems = [];
  // docs/setup.md: HTTP(S) origins without credentials, paths or query strings.
  let origin = url;
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) origin = parsed.origin;
    else problems.push('Use an HTTP(S) origin without credentials, path or query string.');
  } catch { problems.push('Use a full origin, such as https://your-portal.example.test.'); }
  error.textContent = problems.join(' ');
  // Absolute paths work for separate checkouts; relative ones resolve from the catalogue directory.
  const cut = exportPath.lastIndexOf('/');
  const parent = cut < 0 ? '.' : exportPath.slice(0, cut) || '/';
  const root = /^(?:[A-Za-z]:|\/|\.)/.test(parent) ? parent : `./${parent}`;
  const source = exportPath.slice(cut + 1);
  output.textContent = [
    ...(editor ? [`editor: ${scalar(editor)}`] : []),
    `sourceRoot: ${scalar(root)}`,
    `defaultSite: ${key(site)}`,
    'portals: selected',
    'sites:',
    `  ${key(site)}:`,
    `    source: ${scalar(source)}`,
    '    defaultEnv: dev',
    '    environments:',
    `      dev: ${scalar(origin)}`,
    '    mirage:',
    '      port: 8787',
    '      solutionRoots: []',
  ].join('\n');
}
form.addEventListener('input', build);
form.addEventListener('submit', (event) => event.preventDefault());

// Clips: play only while visible, never auto-play under reduced motion, keep a viewer's pause.
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const clips = [...document.querySelectorAll('video')];
const held = new Set(); // paused by the viewer or by reduced motion
const ours = new Set(); // pauses this script made
const pause = (clip) => { if (!clip.paused) { ours.add(clip); clip.pause(); } };
function applyMotion() {
  for (const clip of clips) {
    if (reduce.matches) { pause(clip); held.add(clip); } else held.delete(clip);
  }
}
// The observer below starts clips in view; native autoplay would also start those off screen.
if ('IntersectionObserver' in window) for (const clip of clips) { clip.autoplay = false; pause(clip); }
for (const clip of clips) {
  clip.addEventListener('pause', () => { if (!ours.delete(clip)) held.add(clip); });
  clip.addEventListener('play', () => held.delete(clip));
}
applyMotion();
reduce.addEventListener('change', applyMotion);
if ('IntersectionObserver' in window) {
  const watch = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) pause(target);
      else if (!held.has(target)) target.play().catch(() => {});
    }
  }, { threshold: 0.3 });
  for (const clip of clips) watch.observe(clip);
}

// Contents: mark the chapter being read.
const links = new Map([...document.querySelectorAll('.toc a')].map((a) => [a.hash.slice(1), a]));
if ('IntersectionObserver' in window) {
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const a of links.values()) a.removeAttribute('aria-current');
      links.get(entry.target.id)?.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  for (const id of links.keys()) { const section = document.getElementById(id); if (section) spy.observe(section); }
}

build();
render();
