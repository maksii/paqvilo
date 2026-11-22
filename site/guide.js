// Guide enhancements: copy buttons, a collapsed contents list on small screens and the contents highlight.
// Without JavaScript the page is complete: every command is selectable text and every link works.
const announcer = Object.assign(document.createElement('p'), { className: 'sr-only' });
announcer.setAttribute('role', 'status');
document.body.append(announcer);

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
    announcer.textContent = copied ? 'Copied to clipboard' : 'Copy failed; select the text instead';
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

// Panel tour. Without this every view is shown in full, one under the other, and a number links to its explanation.
for (const tour of document.querySelectorAll('.tour')) {
  const views = [...tour.querySelectorAll('.tour-view')];
  const tabs = Object.assign(document.createElement('div'), { className: 'tour-tabs' });
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Panel views');
  const buttons = views.map((view) => {
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      id: `${view.id}-tab`,
      textContent: view.querySelector('h4').textContent,
    });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', view.id);
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', button.id);
    tabs.append(button);
    return button;
  });
  const show = (index) => {
    for (const [position, view] of views.entries()) {
      view.hidden = position !== index;
      buttons[position].setAttribute('aria-selected', String(position === index));
      buttons[position].tabIndex = position === index ? 0 : -1;
    }
  };
  for (const [index, button] of buttons.entries()) button.addEventListener('click', () => show(index));
  tabs.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = (buttons.indexOf(document.activeElement) + step + buttons.length) % buttons.length;
    show(next);
    buttons[next].focus();
  });
  tour.prepend(tabs);
  tour.classList.add('is-tabbed');

  for (const view of views) {
    const caption = view.querySelector('.tour-caption');
    const spots = [...view.querySelectorAll('.spot')];
    const items = [...view.querySelectorAll('.tour-legend > li')];
    const select = (index) => {
      for (const [position, spot] of spots.entries()) {
        spot.classList.toggle('is-on', position === index);
        items[position].classList.toggle('is-on', position === index);
      }
      const number = Object.assign(document.createElement('span'), { className: 'n', textContent: index + 1 });
      caption.replaceChildren(number, ...items[index].cloneNode(true).childNodes);
    };
    caption.hidden = false;
    caption.setAttribute('aria-live', 'polite');
    for (const [index, spot] of spots.entries()) {
      spot.addEventListener('click', (event) => {
        event.preventDefault();
        select(index);
      });
      spot.addEventListener('mouseenter', () => select(index));
      spot.addEventListener('focus', () => select(index));
      items[index].addEventListener('mouseenter', () => select(index));
      items[index].addEventListener('click', () => select(index));
    }
    select(0);
  }
  const wanted = views.findIndex((view) => location.hash.startsWith(`#${view.id}`) || view.querySelector(':target'));
  show(Math.max(wanted, 0));
}
