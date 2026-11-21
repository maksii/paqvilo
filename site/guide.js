// Guide enhancements: copy buttons, a collapsed contents list on small screens and the contents highlight.
// Without JavaScript the page is complete: every command is selectable text and every link works.
const status = Object.assign(document.createElement('p'), { className: 'sr-only' });
status.setAttribute('role', 'status');
document.body.append(status);

for (const block of document.querySelectorAll('.cmd')) {
  if (!navigator.clipboard) break;
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Copy' });
  button.addEventListener('click', async () => {
    let copied = true;
    try {
      await navigator.clipboard.writeText(block.querySelector('code').textContent);
    } catch {
      copied = false;
    }
    button.textContent = copied ? 'Copied' : 'Select the text';
    status.textContent = copied ? 'Copied to clipboard' : 'Copy failed; select the text instead';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
  block.append(button);
}

// The contents list is a sidebar on wide screens and a closed disclosure above the tasks on narrow ones.
const contents = document.querySelector('.toc details');
const narrow = globalThis.matchMedia('(max-width: 1100px)');
const fit = () => {
  contents.open = !narrow.matches;
};
fit();
narrow.addEventListener('change', fit);
contents.addEventListener('click', (event) => {
  if (narrow.matches && event.target.closest('a')) contents.open = false;
});

// Mark the task being read.
const links = new Map([...document.querySelectorAll('.toc a')].map((link) => [link.hash.slice(1), link]));
if ('IntersectionObserver' in globalThis) {
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links.values()) link.removeAttribute('aria-current');
        links.get(entry.target.id)?.setAttribute('aria-current', 'true');
      }
    },
    { rootMargin: '-10% 0px -75% 0px' },
  );
  for (const id of links.keys()) {
    const task = document.getElementById(id);
    if (task) spy.observe(task);
  }
}
