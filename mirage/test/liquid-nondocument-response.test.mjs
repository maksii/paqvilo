import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import {
  injectRuntimeCompatibility,
  injectRuntimeDependencies,
} from "../lib/source-dependencies.mjs";

// Power Pages serves the output of a page template that does not use the website
// header/footer verbatim: ExampleApp "fetch" pages return JSON or HTML fragments that
// DataTables and jQuery .load() consume. Local runtime assets must never be added.
const json = `{"rows":[{% for i in (1..2) %}{"n":{{ i }}}{% unless forloop.last %},{% endunless %}{% endfor %}],"total":2}`;
const fragment = `<div class="fragment">{{ "a & b" | escape }}</div>`;
async function portalSource(t, authoredScript) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "liquid-nondocument-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: data",
    "web-pages/rows/Rows.webpage.yml": "adx_webpageid: rows\nadx_name: Rows\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: rows\nadx_pagetemplateid: data",
    "web-pages/part/Part.webpage.yml": "adx_webpageid: part\nadx_name: Part\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: part\nadx_pagetemplateid: fragment",
    "page-templates/Data.pagetemplate.yml": "adx_pagetemplateid: data\nadx_name: Data\nadx_webtemplateid: json\nadx_usewebsiteheaderandfooter: false",
    "page-templates/Fragment.pagetemplate.yml": "adx_pagetemplateid: fragment\nadx_name: Fragment\nadx_webtemplateid: fragment\nadx_usewebsiteheaderandfooter: false",
    "web-templates/json/Json.webtemplate.yml": "adx_webtemplateid: json\nadx_name: Json\nadx_mimetype: application/json",
    "web-templates/json/Json.webtemplate.source.html": json,
    "web-templates/fragment/Fragment.webtemplate.yml": "adx_webtemplateid: fragment\nadx_name: Fragment",
    "web-templates/fragment/Fragment.webtemplate.source.html": fragment,
  };
  if (authoredScript) {
    files["web-files/app.js.webfile.yml"] = "adx_webfileid: app\nadx_name: app.js\nadx_partialurl: app.js\nadx_parentpageid: home\nfilename: app.js\nmimetype: application/javascript";
    files["web-files/app.js"] = authoredScript;
  }
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return root;
}
for (const [label, script] of [
  ["without detected browser dependencies", null],
  [
    "with authored jQuery, Moment, date-format and plugin usage",
    "$(function(){ moment().format(); new Date().format('dd/MM/yyyy'); $('#d').datetimepicker(); $('#m').dialog(); $('#t').tooltip(); });",
  ],
]) {
  test(`header/footer-less JSON and fragment templates are served byte-identical ${label}`, async (t) => {
    const root = await portalSource(t, script);
    const app = await createSimulator({
      sourceDir: root,
      stateFile: path.join(root, "state.json"),
      watch: false,
      initial: { settings: { permissionMode: "permissive" }, simulator: { identity: { id: null, roles: [] } } },
    });
    t.after(() => app.close());
    const rows = await fetch(new URL("/rows/", app.url));
    assert.equal(rows.status, 200);
    assert.match(rows.headers.get("content-type"), /^application\/json/);
    const body = await rows.text();
    assert.equal(body, '{"rows":[{"n":1},{"n":2}],"total":2}');
    assert.deepEqual(JSON.parse(body), { rows: [{ n: 1 }, { n: 2 }], total: 2 });
    const part = await fetch(new URL("/part/", app.url));
    assert.equal(part.status, 200);
    assert.equal(await part.text(), '<div class="fragment">a &amp; b</div>');
  });
}

test("runtime injectors leave non-document output untouched and are idempotent on documents", () => {
  const dependencies = { jquery: true, moment: true, dateFormat: true, dateTimePicker: true, bootstrapPlugins: true, jqueryUiDialog: true, footerSpacing: true };
  for (const output of ['{"a":1}', "<div>fragment</div>", "<script>window.x=1</script><p>fragment with script</p>", ""]) {
    assert.equal(injectRuntimeDependencies(output, dependencies), output);
    assert.equal(injectRuntimeCompatibility(output, dependencies), output);
  }
  const page = '<!doctype html><html><head><script src="/scripts/jquery.min.js"></script></head><body><footer>f</footer></body></html>';
  const once = injectRuntimeCompatibility(injectRuntimeDependencies(page, dependencies), dependencies);
  const twice = injectRuntimeCompatibility(injectRuntimeDependencies(once, dependencies), dependencies);
  assert.equal(twice, once);
  assert.equal(once.match(/footer-spacing-compat\.js/g).length, 1);
  assert.equal(once.match(/datetimepicker-compat\.js/g).length, 1);
});

test("documents report local compatibility adapters in a response header, not as html or body attributes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "liquid-compat-header-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test\nadx_footerwebtemplateid: footer",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: content\nadx_usewebsiteheaderandfooter: true",
    "web-templates/content/Content.webtemplate.yml": "adx_webtemplateid: content\nadx_name: Content",
    "web-templates/content/Content.webtemplate.source.html": "<p>Body</p>",
    "web-templates/footer/Footer.webtemplate.yml": "adx_webtemplateid: footer\nadx_name: Footer",
    "web-templates/footer/Footer.webtemplate.source.html": "<footer>Footer</footer>",
    // A page without the website header and footer serves its template's document as it is.
    "web-pages/bare/Bare.webpage.yml": "adx_webpageid: bare\nadx_name: Bare\nadx_parentpageid: home\nadx_partialurl: bare\nadx_pagetemplateid: bare",
    "page-templates/Bare.pagetemplate.yml": "adx_pagetemplateid: bare\nadx_name: Bare\nadx_webtemplateid: baredocument\nadx_usewebsiteheaderandfooter: false",
    "web-templates/baredocument/BareDocument.webtemplate.yml": "adx_webtemplateid: baredocument\nadx_name: Bare document",
    "web-templates/baredocument/BareDocument.webtemplate.source.html": "<!DOCTYPE html><html><head><title>Bare</title></head><body><p>Bare</p><footer>Footer</footer></body></html>",
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const app = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, "state.json"),
    watch: false,
    initial: { settings: { permissionMode: "permissive" }, simulator: { identity: { id: null, roles: [] } } },
  });
  t.after(() => app.close());
  // Layout pages load the platform bundles, whose local equivalents include the adapters
  // (lib/platform-manifest.mjs): no adapter is in the document, so none is reported.
  const response = await fetch(new URL("/", app.url));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(response.headers.get("x-sim-compatibility"), null);
  assert.match(html, /<script src="\/resource\/powerappsportal\/dist\/app\.bundle-[0-9a-f]+\.js"/);
  assert.doesNotMatch(/<html\b[^>]*>/.exec(html)[0], /data-sim-/);
  assert.doesNotMatch(/<body\b[^>]*>/.exec(html)[0], /data-sim-/);
  // A template document without the platform bundles gets the adapters it needs, reported in the header.
  const bare = await fetch(new URL("/bare/", app.url));
  assert.equal(bare.status, 200);
  const bareHtml = await bare.text();
  assert.match(bare.headers.get("x-sim-compatibility") ?? "", /footer-spacing/);
  assert.doesNotMatch(/<html\b[^>]*>/.exec(bareHtml)[0], /data-sim-/);
  assert.doesNotMatch(/<body\b[^>]*>/.exec(bareHtml)[0], /data-sim-/);
});
