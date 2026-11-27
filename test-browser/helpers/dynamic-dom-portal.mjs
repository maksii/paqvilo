// An invented loopback "portal" whose export holds one page's web template and the web files of its scripts, opened in
// a Lense overlay session with the panel, and what X-ray answers for its elements.
import http from 'node:http';
import { listenOwnedServer } from './owned-server.mjs';
import { overlayPanel } from './overlay-panel.mjs';
import { createFixture, SCRIPTS_ID, HOME_ID } from '../../test/fixture.mjs';
import { createSimulator } from '../../mirage/server.mjs';

export const LAYOUT = 'web-templates/layout/Layout.webtemplate.source.html';
const shellHead = '<!DOCTYPE html>\n<html lang="en-US"><head><title>Home</title></head><body>\n';
const shellFoot = '\n</body></html>\n';

/**
 * Serves `template` (the Layout web template, without Liquid, written into the page shell as the portal writes it) at
 * `/`. `webFiles` maps a name to the script the export holds as the web file served at `/scripts/<name>`; `served`
 * maps a name to what the portal itself serves there when it differs (the local file is laid over it). `other` maps a
 * path to a script the portal serves that the export does not hold; `external` maps a path to a script of another site
 * (its origin is `externalOrigin`, written into the template as `{{external}}`); `pages` maps a path to another page the
 * portal serves as it is (a frame's document). With `mirage`, Mirage renders the same export (the home page's page
 * template is the Layout web template) and serves its web files; `served`, `other`, `external`, `json` and `pages`
 * are the fake portal's only.
 */
export async function dynamicPortal(
  t,
  { template, webFiles = {}, served = {}, other = {}, external = {}, json = {}, pages = {}, mirage = false },
) {
  const fx = createFixture();
  if (mirage) {
    fx.write(
      'web-pages/home/Home.webpage.yml',
      `adx_webpageid: ${HOME_ID}\nadx_partialurl: /\nadx_name: Home\nadx_pagetemplateid: 00000000-0000-0000-0000-00000000ab01\n`,
    );
    fx.write(
      'page-templates/Layout.pagetemplate.yml',
      'adx_pagetemplateid: 00000000-0000-0000-0000-00000000ab01\nadx_name: Layout\nadx_webtemplateid: 00000000-0000-0000-0000-00000000aa01\nadx_usewebsiteheaderandfooter: false\n',
    );
  }
  fx.write(
    'web-templates/layout/Layout.webtemplate.yml',
    'adx_name: Layout\nadx_webtemplateid: 00000000-0000-0000-0000-00000000aa01\n',
  );
  let fileNumber = 0;
  for (const [name, text] of Object.entries(webFiles)) {
    fx.write('web-files/' + name, served[name] ?? text);
    const id = '00000000-0000-0000-0000-0000000bb' + String(++fileNumber).padStart(3, '0');
    fx.write(
      'web-files/' + name + '.webfile.yml',
      `adx_name: ${name}\nadx_webfileid: ${id}\nadx_partialurl: ${name}\nadx_parentpageid: ${SCRIPTS_ID}\nfilename: ${name}\nmimetype: text/javascript\n`,
    );
  }
  let externalOrigin = '';
  if (Object.keys(external).length)
    externalOrigin = await listenOwnedServer(
      t,
      http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://invented.invalid').pathname;
        if (!Object.hasOwn(external, pathname)) return response.writeHead(404).end();
        return response
          .writeHead(200, { 'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html' })
          .end(external[pathname]);
      }),
    );
  const text = template.replaceAll('{{external}}', externalOrigin);
  fx.write(LAYOUT, text);
  fx.commit();
  // The local copy of a laid-over file is what the developer works on: written after the baseline.
  for (const [name, local] of Object.entries(webFiles))
    if (Object.hasOwn(served, name)) fx.write('web-files/' + name, local);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://invented.invalid').pathname;
    const name = pathname.startsWith('/scripts/') ? pathname.slice('/scripts/'.length) : null;
    if (name && Object.hasOwn(webFiles, name))
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(served[name] ?? webFiles[name]);
    if (Object.hasOwn(other, pathname))
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(other[pathname]);
    if (Object.hasOwn(pages, pathname))
      return response.writeHead(200, { 'content-type': 'text/html' }).end(pages[pathname]);
    if (Object.hasOwn(json, pathname))
      return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json[pathname]));
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    return response.writeHead(200, { 'content-type': 'text/html' }).end(shellHead + text + shellFoot);
  });
  let app;
  // The portal and the other site are both loopback servers here; on the internet a portal's document is public and so
  // is another site's script, which the local-network checks never stop. A fulfilled document has no address space.
  const { origin, page, panel, session, errors } = await overlayPanel(
    t,
    fx,
    async () => {
      if (!mirage) return listenOwnedServer(t, server);
      app = await createSimulator({
        sourceDir: fx.dir,
        stateFile: fx.file('.paqvilo/mirage-state.json'),
        watch: false,
        sourceMaps: false,
        initial: {
          version: 1,
          tables: {},
          mappings: {},
          permissions: [],
          settings: { permissionMode: 'permissive' },
          simulator: { mode: 'local', pageMode: 'local', identity: null, endpoints: [], live: {} },
        },
      });
      return new URL(app.url).origin;
    },
    {
      allow: () => [externalOrigin],
      args: ['--disable-features=LocalNetworkAccessChecks'],
      session: mirage ? { mirage: true } : {},
      close: [
        async () => {
          await app?.close();
        },
      ],
    },
  );
  return { fx, origin, externalOrigin, page, panel, session, errors, text };
}

/** What X-ray answers for one element, in plain data (run in the page). */
const answerSource = `(node) => {
  const xray = globalThis.__paqviloXrayUi;
  const found = xray.identify(node);
  const exact = found.evidence.source.refs.find((ref) => ref.status === 'exact');
  const where = (ref) =>
    ref
      ? { file: (ref.ref ?? '').replaceAll('\\\\', '/'), line: ref.region?.line ?? null, column: ref.region?.column ?? null }
      : null;
  return {
    title: found.title,
    kind: found.kind,
    contained: found.contained,
    owner: found.evidence.owner.status === 'exact' ? found.evidence.owner.component.kind : null,
    source: exact ? { ...where(exact), how: exact.evidenceLabel, relationship: exact.relationship ?? null } : null,
    sources: found.evidence.source.refs.map((ref) => ({ ...where(ref), status: ref.status, how: ref.evidenceLabel })),
    inside: found.evidence.enclosing.filter((row) => row.status === 'exact').map((row) => row.component?.kind),
    rows: found.evidence.facts.map((row) => ({
      label: row.label ?? null,
      status: row.status,
      relationship: row.relationship ?? null,
      component: row.component?.kind ?? null,
      at: where(row.refs?.[0]),
    })),
    limits: found.evidence.limits?.reasons ?? [],
    unavailable: found.evidence.unavailable.map((item) => item.reason),
  };
}`;

/** X-ray's answers for `selectors` (a name -> CSS selector map; a selector may match in an open shadow root via >>>). */
export async function answers(page, selectors) {
  return page.evaluate(
    ({ selectors, source }) => {
      // The answer function travels as text: it is compiled in the page.
      const answer = new Function('return ' + source)();
      const find = (selector) => {
        if (selector.startsWith('window.')) return window[selector.slice('window.'.length)];
        let root = document;
        const parts = selector.split(' >>> ');
        for (let i = 0; i < parts.length - 1; i++) root = root.querySelector(parts[i]).shadowRoot;
        return root.querySelector(parts.at(-1));
      };
      const out = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const node = find(selector);
        out[name] = node ? answer(node) : null;
      }
      return out;
    },
    { selectors, source: answerSource },
  );
}

/**
 * Waits until X-ray has its inspection report, the portal's proof of the document is in (`server` is answered with
 * its template) and every element of `selectors` that exists has its script verdict (no callsite still pending).
 */
export async function settled(fx, selectors, server = '#content') {
  await fx.page.waitForFunction(() => typeof globalThis.__paqviloXrayUi?.coverage === 'function');
  await fx.panel.coverageFor(fx.page);
  await fx.page.waitForFunction(
    ({ selectors, server, slot }) => {
      const xray = globalThis.__paqviloXrayUi;
      if (xray.identify(document.querySelector(server)).evidence.source.status !== 'exact') return false;
      const reader = window[slot];
      const pending = (packet) =>
        packet.availability.some((item) => item.reason === 'creation-proof-pending') ||
        packet.facts.some((fact) => fact.reason === 'creation-proof-pending');
      for (const selector of selectors) {
        let root = document,
          node;
        if (selector.startsWith('window.')) node = window[selector.slice('window.'.length)];
        else {
          const parts = selector.split(' >>> ');
          for (let i = 0; i < parts.length - 1 && root; i++) root = root.querySelector(parts[i])?.shadowRoot;
          node = root?.querySelector(parts.at(-1));
        }
        if (!node) return false;
        if (pending(reader.query(node, {}))) return false;
      }
      return true;
    },
    { selectors: Object.values(selectors), server, slot: fx.session.domProvenanceSlot },
  );
  return answers(fx.page, selectors);
}

/** The 1-based line of the first occurrence of `needle` in `text`. */
export const lineOf = (text, needle) => {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error('not in the text: ' + needle);
  return text.slice(0, at).split('\n').length;
};
