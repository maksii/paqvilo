import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { readFileSync } from 'node:fs';

const BOOTSTRAP = 'virtual:paqvilo-code-app-bootstrap';
const APP = 'virtual:paqvilo-code-app-context';
const ENTRY = 'virtual:paqvilo-code-app-entry/';
const ORDER = 'virtual:paqvilo-code-app-order';
const INLINE = 'virtual:paqvilo-code-app-inline/';
const source = (name) => fileURLToPath(new URL(name, import.meta.url)).replaceAll('\\', '/');
const browserFile = (name) => '/@fs/' + source(name);
const publicId = (id) => '/@id/__x00__' + id;

function localOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Set mirageUrl or PAQVILO_MIRAGE_URL to the running Mirage loopback origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('The Mirage URL must be a loopback HTTP(S) origin without credentials, path, query or fragment.');
  return url.origin;
}

/** Development-only public SDK integration. Native serve/build configurations remain unchanged. */
export function codeApps(options = {}) {
  let app, origin, nativeApp, root, configFile;
  const configurationStamp = () => {
    if (!configFile) return 'unconfigured';
    try {
      return createHash('sha256').update(readFileSync(configFile)).digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT') return 'missing';
      // An atomic save, a scanner or a lock can deny the read briefly (EPERM/EBUSY on Windows).
      return 'unknown';
    }
  };
  const entries = new Map();
  const inlineSources = new Map();
  return {
    name: 'paqvilo-code-apps',
    enforce: 'pre',
    apply(_config, environment) {
      return (
        environment.command === 'serve' &&
        options.enabled !== false &&
        (options.enabled === true ||
          environment.mode === (options.mode ?? 'mirage') ||
          Boolean(process.env.PAQVILO_MIRAGE_URL))
      );
    },
    config() {
      app = options.app ?? process.env.PAQVILO_CODE_APP;
      if (typeof app !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(app))
        throw new Error('Set the codeApps app option or PAQVILO_CODE_APP to the registered Code Apps name.');
      origin = localOrigin(options.mirageUrl ?? process.env.PAQVILO_MIRAGE_URL);
      return {
        server: {
          host: '127.0.0.1',
          strictPort: true,
          proxy: { '/_apps/code/': { target: origin, changeOrigin: true } },
        },
        optimizeDeps: { include: ['@microsoft/power-apps/data', '@microsoft/power-apps/internal/data'] },
      };
    },
    configResolved(config) {
      root = config.root;
      configFile = path.resolve(root, options.config ?? 'power.config.json');
      if (config.plugins?.some((plugin) => plugin.name === 'powerApps'))
        throw new Error(
          'Choose codeApps() for Mirage development or Microsoft powerApps() for native development/build; do not enable both in the same Vite run.',
        );
      if (!['127.0.0.1', 'localhost', '::1'].includes(config.server.host))
        throw new Error('The Code Apps Mirage development server must bind to a loopback host.');
      try {
        nativeApp = createRequire(path.join(config.root, 'package.json'))
          .resolve('@microsoft/power-apps/app')
          .replaceAll('\\', '/');
      } catch {
        throw new Error('Install @microsoft/power-apps in the code app before enabling the Mirage Vite integration.');
      }
      // Keep the application and normal Vite workspace readable alongside these adapter modules.
      if (!config.server.fs.allow.includes(config.root)) config.server.fs.allow.push(config.root);
      config.server.fs.allow.push(source('.'), path.resolve(nativeApp, '../../..'));
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/(?![\\/])/.test(req.url ?? '')) {
          res.writeHead(400);
          res.end('Expected a local request path');
          return;
        }
        if (!req.url.startsWith('/_apps/code/')) return next();
        const port = server.httpServer?.address()?.port;
        const scheme = server.config.server.https ? 'https:' : 'http:';
        const hosts = ['127.0.0.1', 'localhost', '[::1]'].map((host) => `${host}:${port}`);
        if (
          !hosts.includes(req.headers.host) ||
          (req.headers.origin && req.headers.origin !== `${scheme}//${req.headers.host}`)
        ) {
          res.writeHead(403);
          res.end('Invalid Code Apps proxy origin');
          return;
        }
        if (req.headers.origin) req.headers.origin = origin;
        next();
      });
      configFile = path.resolve(server.config.root, options.config ?? 'power.config.json');
      server.watcher.add(configFile);
      const reload = (file) => {
        if (path.resolve(file) === configFile) server.ws.send({ type: 'full-reload', path: '*' });
      };
      server.watcher.on('change', reload);
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
      // The document can load before its HMR transport connects. Reconcile the
      // document's configuration with current bytes after that connection, so
      // a full-reload broadcast sent before it existed cannot be lost.
      // A document rendered while the configuration was unreadable carries an unknown
      // stamp and reloads once the bytes are readable; an unreadable read at check
      // time is retried briefly, after which the watcher's next event still reloads.
      const rechecks = new Set();
      const reconcile = (data, client, attempt = 0) => {
        if (typeof data?.stamp !== 'string') return;
        const current = configurationStamp();
        if (current === 'unknown') {
          if (attempt >= 20) return;
          const timer = setTimeout(() => {
            rechecks.delete(timer);
            reconcile(data, client, attempt + 1);
          }, 100);
          rechecks.add(timer);
          return;
        }
        if (data.stamp !== current) client.send({ type: 'full-reload', path: '*' });
      };
      server.ws.on('paqvilo:config-check', reconcile);
      server.httpServer?.once('close', () => {
        for (const timer of rechecks) clearTimeout(timer);
        rechecks.clear();
        for (const event of ['change', 'add', 'unlink']) server.watcher.off(event, reload);
        server.ws.off('paqvilo:config-check', reconcile);
      });
    },
    resolveId(id, importer) {
      if (id === '@microsoft/power-apps/app') return '\0' + APP;
      if (id === BOOTSTRAP || id === APP || id === ORDER || id.startsWith(ENTRY) || id.startsWith(INLINE))
        return '\0' + id;
      if (importer?.startsWith('\0' + INLINE) && /^\.{1,2}\//.test(id)) {
        const inline = inlineSources.get(importer.slice(1));
        return this.resolve(id, inline.file, { skipSelf: true });
      }
    },
    load(id) {
      if (id === '\0' + BOOTSTRAP)
        return `
import { configure, getStatus } from ${JSON.stringify(browserFile('./code-apps-client.js'))};
import { createCodeAppSdkExecutor } from ${JSON.stringify(browserFile('./code-apps-sdk.js'))};
import { setDataOperationExecutor } from '@microsoft/power-apps/internal/data';
const report = event => {
  if (window.parent !== window) window.parent.postMessage({type:'paqvilo:code-app',app:${JSON.stringify(app)},event},${JSON.stringify(origin)});
};
configure({app:${JSON.stringify(app)},onEvent:event=>{
  report(event);
  if(event.kind==='request' && /\\/context$/.test(event.path) && event.status===200) report({kind:'bridge-ready'});
}});
try {
  const status = await getStatus();
  setDataOperationExecutor(createCodeAppSdkExecutor({entitySets:status.entitySets}));
} catch(error) { report({kind:'bridge-error',status:error.status||0}); throw error; }
window.addEventListener('error',()=>report({kind:'app-error'}));
window.addEventListener('unhandledrejection',()=>report({kind:'app-error'}));
if(import.meta.hot) {
  const checkConfiguration=()=>{
    const stamp=document.querySelector('meta[name="paqvilo-code-app-config"]')?.content;
    if(stamp) import.meta.hot.send('paqvilo:config-check',{stamp});
  };
  import.meta.hot.on('vite:ws:connect',checkConfiguration);
  checkConfiguration();
  import.meta.hot.dispose(()=>{
    import.meta.hot.off('vite:ws:connect',checkConfiguration);
    setDataOperationExecutor(undefined);
  });
}
`;
      if (id === '\0' + APP)
        return `
import ${JSON.stringify(BOOTSTRAP)};
export { getContext } from ${JSON.stringify(browserFile('./code-apps-client.js'))};
export { setConfig } from ${JSON.stringify('/@fs/' + nativeApp)};
`;
      // Entries start in document order, but each awaits the bootstrap, so their own imports would evaluate in
      // network order. One queue keeps the page's module scripts in document order; a failed script does not
      // stop later ones.
      // ponytail: an entry waits until its predecessor settles, including top-level await, not only its synchronous part.
      if (id === '\0' + ORDER)
        return 'let tail=Promise.resolve();export function inOrder(load){const run=tail.then(load);tail=run.catch(()=>{});return run;}';
      if (id.startsWith('\0' + ENTRY)) {
        const target = entries.get(id.slice(1));
        if (!target) throw new Error('Unknown Code Apps module entry. Reload the application.');
        return `import { inOrder } from ${JSON.stringify(ORDER)}; await inOrder(async () => { await import(${JSON.stringify(BOOTSTRAP)}); await import(${JSON.stringify(target)}); });`;
      }
      if (id.startsWith('\0' + INLINE)) return inlineSources.get(id.slice(1))?.code;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const edits = [];
        const visit = (node) => {
          if (
            node.tagName === 'script' &&
            node.attrs?.some((attr) => attr.name === 'type' && attr.value === 'module')
          ) {
            const src = node.attrs.find((attr) => attr.name === 'src')?.value;
            if (!src || !/^(?:\/@vite\/|\/@id\/)/.test(src)) {
              const location = node.sourceCodeLocation;
              const code = !src && html.slice(location.startTag.endOffset, location.endTag.startOffset);
              const url = src && new URL(src, 'http://paqvilo.local' + context.path);
              const inlineId =
                INLINE +
                createHash('sha256')
                  .update(context.path + ':' + location.startOffset + ':' + code)
                  .digest('hex')
                  .slice(0, 16);
              const target = src
                ? url.origin === 'http://paqvilo.local'
                  ? url.pathname + url.search + url.hash
                  : url.href
                : inlineId;
              const id = ENTRY + createHash('sha256').update(target).digest('hex').slice(0, 16);
              entries.set(id, target);
              if (src) {
                edits.push([location.attrs.src.startOffset, location.attrs.src.endOffset, `src="${publicId(id)}"`]);
              } else {
                inlineSources.set(inlineId, {
                  code,
                  file: context.filename ?? path.join(root ?? '.', context.path.slice(1)),
                });
                edits.push([location.startTag.endOffset - 1, location.endTag.startOffset, ` src="${publicId(id)}">`]);
              }
            }
          }
          for (const child of node.childNodes ?? []) visit(child);
        };
        visit(parse(html, { sourceCodeLocationInfo: true }));
        for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
          html = html.slice(0, start) + replacement + html.slice(end);
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: { name: 'paqvilo-code-app-config', content: configurationStamp() },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}
