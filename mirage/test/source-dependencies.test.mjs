import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPortal } from "../lib/importer.mjs";
import {
  discoverSourceDependencies,
  runtimeCompatibilityPaths,
  runtimeDependencyPaths,
  injectRuntimeDependencies,
} from "../lib/source-dependencies.mjs";

test("source dependency discovery selects local globals only for authored uses", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-dependencies-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, "app.js");
  await fs.writeFile(script, "$(function(){ window.label=moment.utc('2025-01-01').format('YYYY'); $('#date').datetimepicker({format:'DD/MM/YYYY'}); });");
  const dependencies = await discoverSourceDependencies({
    webFiles: [{ url: "/js/app.js", file: script }],
    templates: { home: { source: "<main>local page</main>" } },
    snippets: {},
  });
  assert.equal(dependencies.jquery, true);
  assert.equal(dependencies.moment, true);
  assert.equal(dependencies.dateTimePicker, true);
  assert.deepEqual(runtimeDependencyPaths(dependencies), [
    "/__sim-static/vendor/moment.min.js",
    "/__sim-static/vendor/jquery.min.js",
  ]);
  assert.deepEqual(runtimeCompatibilityPaths(dependencies), ["/__sim-static/vendor/datetimepicker-compat.js"]);
  assert.deepEqual(
    runtimeDependencyPaths(dependencies, [
      "/portal/jquery-3.7.1.min.js",
      "/portal/moment.min.js",
      "/portal/bootstrap-datetimepicker.min.js",
    ]),
    [],
  );
  assert.deepEqual(runtimeCompatibilityPaths(dependencies, [
    "/portal/jquery-3.7.1.min.js", "/portal/moment.min.js", "/portal/bootstrap-datetimepicker.min.js",
  ]), []);
});

test("source-provided dependencies are mapped before the local compatibility asset", async () => {
  const dependencies = await discoverSourceDependencies({
    webFiles: [
      { url: "/js/jquery.min.js" },
      { url: "/js/moment.min.js" },
      { url: "/js/custom-datetimepicker.js" },
      { url: "/js/page.js" },
    ],
    templates: { home: { source: "<script>moment.utc('2025-01-01'); $('#x').datetimepicker();</script>" } },
  });
  assert.deepEqual(runtimeDependencyPaths(dependencies), [
    "/js/moment.min.js",
    "/js/jquery.min.js",
  ]);
  assert.deepEqual(runtimeCompatibilityPaths(dependencies), ["/js/custom-datetimepicker.js"]);
});

test("pages without those source globals do not receive compatibility dependencies", async () => {
  const dependencies = await discoverSourceDependencies({
    webFiles: [],
    templates: { home: { source: "<p>static local content</p>" } },
  });
  assert.deepEqual(runtimeDependencyPaths(dependencies), []);
});

test("runtime dependency tags load before authored inline scripts", () => {
  const html = "<html><head><title>Page</title></head><body><script>window.used = moment.utc();</script></body></html>";
  const injected = injectRuntimeDependencies(html, { jquery: true, moment: true });
  assert.ok(injected.indexOf("/__sim-static/vendor/jquery.min.js") < injected.indexOf("window.used"));
  assert.ok(injected.indexOf("/__sim-static/vendor/moment.min.js") < injected.indexOf("window.used"));
  assert.equal(injectRuntimeDependencies(html, { jquery: true, moment: true }, ["/jquery.min.js"])
    .includes("/__sim-static/vendor/jquery.min.js"), false);
});

test("standard portal page, form, list, and advanced step JavaScript contribute runtime dependencies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-dependency-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true",
    "Home.webpage.custom_javascript.js": "$(function(){ window.pageDate = moment.utc(); });",
    "Contact.basicform.yml": "adx_entityformid: contact-form\nadx_name: Contact\nadx_entityname: contact",
    "Contact.basicform.custom_javascript.js": "$('#contact').dialog();",
    "Products.list.yml": "adx_entitylistid: products\nadx_name: Products\nadx_entityname: product",
    "Products.list.custom_javascript.js": "$('#products').tooltip();",
    "Apply.advancedformstep.yml": "adx_webformstepid: apply-step\nadx_name: Apply",
    "Apply.advancedformstep.custom_javascript.js": "Date.prototype.format; $('#date').datetimepicker();",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const portal = await importPortal(root);
  assert.match(portal.pages[0].js, /moment/);
  assert.match(portal.forms[0].js, /dialog/);
  assert.match(portal.lists[0].js, /tooltip/);
  assert.match(portal.records.find((record) => record.kind === "advancedformstep").customJavascript, /datetimepicker/);
  const dependencies = await discoverSourceDependencies(portal);
  assert.equal(dependencies.jquery, true);
  assert.equal(dependencies.moment, true);
  assert.equal(dependencies.jqueryUiDialog, true);
  assert.equal(dependencies.bootstrapPlugins, true);
  assert.equal(dependencies.dateFormat, true);
  assert.equal(dependencies.dateTimePicker, true);
});
