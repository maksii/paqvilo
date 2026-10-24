import { redactText } from './agent-server.mjs';

// Subscribing prevents Playwright's implicit dismiss. In interactive dev the
// browser owns the answer; headless dev records its explicit dismissal instead.
export function devDialogs(context, { configs, sessionFor, attached = false, headless }) {
  const handler = async (dialog) => {
    const page = dialog.page();
    let cfg;
    try {
      cfg = configs.get(new URL(page.url()).origin);
    } catch {
      return;
    }
    const automated = !attached && (headless ?? cfg?.browser?.headless === true);
    if (!automated) return;
    try {
      const type = dialog.type(),
        disposition = type === 'beforeunload' ? 'accepted' : 'dismissed';
      // Playwright already accepts before-unload in unattended sessions. Keep
      // navigation working rather than turning this diagnostic into a veto.
      if (type === 'beforeunload') await dialog.accept();
      else await dialog.dismiss();
      if (cfg)
        sessionFor(cfg.origin)?.emit('dialog', {
          page,
          type,
          message: redactText(dialog.message(), 2000),
          disposition,
        });
    } catch {
      /* the tab or a separate owner already answered */
    }
  };
  context.on('dialog', handler);
  return () => context.off('dialog', handler);
}
