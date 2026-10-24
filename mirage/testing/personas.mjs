import { connectRuntime } from './runtime.mjs';
import { createPortalSession } from './sessions.mjs';

async function launch(options) {
  const { origin, config, site, fetchImpl, personaKey, scenario, instanceKey, returnUrl } = options;
  if (!personaKey && !scenario) throw new Error('Choose personaKey or scenario');
  if (personaKey && scenario) throw new Error('Choose either personaKey or scenario');
  const parent = await connectRuntime({ origin, config, site, fetchImpl });
  const report = await parent.personas();
  const definition = report.personas.find(
    (p) => p.key === (scenario ? report.scenarios.find((s) => s.id === scenario)?.persona : personaKey),
  );
  const opened = await parent.launchPersona({ personaKey, scenario, instanceKey, returnUrl });
  const { cookieHeader, ...description } = opened;
  return { parent, opened, description: { ...description, extensions: definition?.extensions ?? {} } };
}

/** A cookie-isolated HTTP visitor selected by catalogue key or scenario. The
 * returned client uses the actual context origin, never a hard-coded port.
 * close() ends only this visitor; context disposal is an explicit parent API. */
export async function createPersonaSession(options = {}) {
  const { opened, description } = await launch(options);
  const client = await createPortalSession({ ...options, origin: opened.origin, contactId: opened.contactId });
  return Object.freeze({ ...client, persona: description });
}

/** Creates a fresh Playwright BrowserContext with declared locale, time zone,
 * viewport and colour scheme, then installs the local identity cookie. Caller
 * owns context.close(); shared runtimes live until explicitly stopped. */
export async function createPersonaBrowserContext(browser, options = {}) {
  const { opened, description } = await launch(options);
  const context = await browser.newContext({ ...opened.browser, ...options.browserOptions });
  try {
    const separator = opened.cookieHeader.indexOf('=');
    await context.addCookies([
      {
        name: opened.cookieHeader.slice(0, separator),
        value: opened.cookieHeader.slice(separator + 1),
        url: opened.origin,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    return { context, origin: opened.origin, startPath: opened.path, url: opened.url, persona: description };
  } catch (cause) {
    await context.close();
    throw cause;
  }
}
