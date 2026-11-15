import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../server.mjs';
import { ownedFixture } from '../../testing/owned-fixture.mjs';

export async function sourceDebugFixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-source-debug-')));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const script = 'window.inventedDebugger = function () {\n  return 42;\n};\n',
    style = '.invented { color: red; }\n';
  for (const [relative, text] of Object.entries({
    'portal/website.yml': 'adx_websiteid: invented\nadx_name: Invented\n',
    'portal/web-pages/home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main\n',
    'portal/page-templates/main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\n',
    'portal/web-templates/main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main\n',
    'portal/web-templates/main.webtemplate.source.html': '<html><body><script>window.inlineDebugger = true;</script></body></html>',
    'portal/web-files/debug.webfile.yml': 'adx_webfileid: debug\nadx_name: debug.js\nadx_partialurl: debug.js\n',
    'portal/web-files/debug.js': script,
    'portal/web-files/debug.css.webfile.yml': 'adx_webfileid: style\nadx_name: debug.css\nadx_partialurl: debug.css\n',
    'portal/web-files/debug.css': style,
    'solution/WebResources/debug.js': script,
    'solution/WebResources/debug.js.data.xml': '<WebResource><Name>x_/debug.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/debug.js</FileName></WebResource>',
    'solution/WebResources/debug.css': style,
    'solution/WebResources/debug.css.data.xml': '<WebResource><Name>x_/debug.css</Name><WebResourceType>2</WebResourceType><FileName>WebResources/debug.css</FileName></WebResource>',
  })) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const runtime = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    modelDriven: { trustedExtensions: true },
    watch: false,
    port: 0,
    ...options,
  });
  ownedFixture(t).add(() => runtime.close());
  const catalogue = await fetch(runtime.url + '/_apps/api').then((response) => response.json());
  return { root, runtime, script, style, resources: catalogue.clientExtensions.resources };
}
