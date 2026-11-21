// The shell's sidebar and top-bar menus, shared by the administration (/_sim/) and the Canvas pages. A classic script:
// every selector is optional, so it is safe on a page without a sidebar or a top bar.
(() => {
  const $ = (selector) => document.querySelector(selector);
  // Below 760 px the sidebar collapses behind Menu (shell.css); choosing a view closes it again.
  const setNavOpen = (open) => {
    $('.sidebar')?.classList.toggle('is-open', open);
    $('#nav-toggle')?.setAttribute('aria-expanded', String(open));
  };
  $('#nav-toggle')?.addEventListener('click', () => setNavOpen(!$('.sidebar')?.classList.contains('is-open')));
  globalThis.addEventListener('hashchange', () => setNavOpen(false));
  // Below 760 px the top bar's apps and actions are one menu; a choice or a click elsewhere closes it.
  const setTopMenu = (open) => {
    $('.topbar')?.classList.toggle('is-open', open);
    $('#top-more')?.setAttribute('aria-expanded', String(open));
  };
  $('#top-more')?.addEventListener('click', () => setTopMenu(!$('.topbar')?.classList.contains('is-open')));
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#top-more') && ($('.topbar')?.classList.contains('is-open') ?? false))
      setTopMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('.topbar')?.classList.contains('is-open')) {
      setTopMenu(false);
      $('#top-more')?.focus();
    }
  });
})();
