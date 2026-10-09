// Builds a small paportal extract inside a temporary git repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOME_ID = '00000000-0000-0000-0000-000000000001';
export const SCRIPTS_ID = '00000000-0000-0000-0000-000000000002';
export const ABOUT_ID = '00000000-0000-0000-0000-000000000003';

export const FILES = {
  'website.yml': 'adx_name: Test\nadx_websiteid: 11111111-1111-1111-1111-111111111111\n',
  'web-pages/home/Home.webpage.yml': `adx_webpageid: ${HOME_ID}\nadx_partialurl: /\nadx_name: Home\n`,
  'web-pages/home/content-pages/Home.en-US.webpage.yml': `adx_webpageid: 00000000-0000-0000-0000-0000000000a1\nadx_rootwebpageid: ${HOME_ID}\nadx_partialurl: /\n`,
  'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css': '.hero {\n  color: red;\n}\n.card {\n  margin: 0;\n}\n.footer {\n  padding: 1px;\n}\n',
  'web-pages/home/content-pages/Home.en-US.webpage.custom_javascript.js': '',
  'web-pages/scripts/Scripts.webpage.yml': `adx_webpageid: ${SCRIPTS_ID}\nadx_partialurl: scripts\nadx_parentpageid: ${HOME_ID}\n`,
  'web-pages/about/About.webpage.yml': `adx_webpageid: ${ABOUT_ID}\nadx_partialurl: about-us\nadx_parentpageid: ${HOME_ID}\n`,
  'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js': 'console.log("about one");\nconsole.log("about two");\nconsole.log("about three");\n',
  'web-files/app.js': 'console.log("app");\n',
  'web-files/app.js.webfile.yml': `adx_name: app.js\nadx_partialurl: app.js\nadx_parentpageid: ${SCRIPTS_ID}\nfilename: app.js\nmimetype: text/javascript\n`,
  // served under another name than the file on disk, directly under home
  'web-files/Site-Logo': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'web-files/Site-Logo.webfile.yml': `adx_name: Site Logo\nadx_partialurl: Logo.svg\nadx_parentpageid: ${HOME_ID}\nfilename: logo-final.svg\nmimetype: image/svg+xml\n`,
  'web-files/orphan.png': 'x',
  'web-files/orphan.png.webfile.yml': 'adx_name: orphan.png\nadx_partialurl: orphan.png\nadx_parentpageid: 99999999-9999-9999-9999-999999999999\n',
  'basic-forms/contact/Contact.basicform.yml': 'adx_name: Contact\n',
  'basic-forms/contact/Contact.basicform.custom_javascript.js':
    '$(document).ready(function () {\n  var price = "$1";\n  $("#name").attr("required", true);\n  $("#email").attr("required", true);\n  validate();\n});\n',
  'web-templates/header/Header.webtemplate.yml': 'adx_name: Header\n',
  'web-templates/header/Header.webtemplate.source.html':
    '<header class="site-header">\n  <a class="brand" href="/">{{ website.name }}</a>\n  {% if user %}\n  <span class="who">Signed in as {{ user.fullname }}</span>\n  {% endif %}\n  <nav class="main-nav">\n    <a href="/about-us">About us</a>\n  </nav>\n</header>\n',
  'content-snippets/footer-text/Footer-Text.en-US.contentsnippet.yml': 'adx_name: Footer/Text\n',
  'content-snippets/footer-text/Footer-Text.en-US.contentsnippet.value.html': 'All rights reserved by the agency.',
  'content-snippets/promo/Promo.en-US.contentsnippet.yml': 'adx_name: Promo\n',
  'content-snippets/promo/Promo.en-US.contentsnippet.value.html': 'Fresh promo text',
};

/** What the "online" portal returns for the home page of the fixture above. */
export const ONLINE_HOME = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<link href="/scripts/app.js" rel="preload">',
  '<style type="text/css">.hero {',
  '  color: red;',
  '}',
  '.card {',
  '  margin: 0;',
  '}',
  '.footer {',
  '  padding: 1px;',
  '}</style>',
  '</head><body>',
  '<header class="site-header">',
  '  <a class="brand" href="/">Test Portal</a>',
  '  ',
  '  <span class="who">Signed in as Ada Lovelace</span>',
  '  ',
  '  <nav class="main-nav">',
  '    <a href="/about-us">About us</a>',
  '  </nav>',
  '</header>',
  '<script type="application/json">{"keep":"me"}</script>',
  '<form><script type="text/javascript">$(document).ready(function () {',
  '  var price = "$1";',
  '  $("#name").attr("required", true);',
  '  $("#email").attr("required", true);',
  '  validate();',
  '});</script></form>',
  '<footer>All rights reserved by the agency.</footer>',
  '</body></html>',
  '',
].join('\r\n');

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  // No detached auto-maintenance: it writes .git/objects/maintenance.lock while tests copy the repository.
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, stdio: 'ignore', windowsHide: true, timeout: 30_000 });
}

export function createFixture() {
  // realpath: os.tmpdir() can be an 8.3 short path on Windows
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-test-')));
  for (const [rel, content] of Object.entries(FILES)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'baseline');
  return {
    dir,
    file: (rel) => path.join(dir, rel),
    write: (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    },
    read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
    /** makes the current state of the files the baseline */
    commit: () => {
      git(dir, 'add', '-A');
      git(dir, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', 'more');
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

export const SITE = {
  webFiles: { enabled: true, exclude: [] },
  inline: {
    enabled: true,
    kinds: ['page-js', 'page-css', 'basic-form-js', 'advanced-form-step-js', 'list-js'],
    minSimilarity: 0.5,
    injectMissingPageBlocks: true,
  },
  markup: { enabled: true, kinds: ['web-template', 'content-snippet', 'page-copy', 'page-summary'], baseline: 'HEAD' },
  scope: 'all',
  routes: [],
};
