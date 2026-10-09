import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOTSTRAP_CORE_SCRIPT,
  JQUERY_CORE_SCRIPT,
  injectRuntimeCompatibility,
  runtimeCompatibilityPaths,
} from "../lib/source-dependencies.mjs";

const COMPAT = {
  bootstrap: "/__sim-static/vendor/bootstrap-plugins-compat.js",
  picker: "/__sim-static/vendor/datetimepicker-compat.js",
  dialog: "/__sim-static/vendor/jqueryui-dialog-compat.js",
};
const page = (head, body = "") => `<!doctype html><html><head>${head}</head><body><a href="#" class="dropdown-toggle" data-toggle="dropdown">PMS</a>${body}</body></html>`;
const script = (src) => `<script src="${src}"></script>`;
const count = (html, text) => html.split(text).length - 1;

test("jQuery and Bootstrap core builds are recognised by file name, including hashed platform bundles", () => {
  for (const url of ["/scripts/jquery.min.js", "/js/jquery-3.6.0.min.js", "/jquery.js?v=1", "/lib/jquery.slim.min.js"])
    assert.equal(JQUERY_CORE_SCRIPT.test(url), true, url);
  for (const url of ["/xrm-adx/js/jquery-ui-1.11.4.min.js", "/js/jquery.validate.min.js", "/js/jquery.blockUI.js"])
    assert.equal(JQUERY_CORE_SCRIPT.test(url), false, url);
  for (const url of [
    "/resource/powerappsportal/dist/bootstrap.bundle-105a4995b8.js",
    "/bootstrap.min.js",
    "/css/bootstrap-3.4.1.min.js",
    "/bootstrap.bundle.min.js?v=2",
  ])
    assert.equal(BOOTSTRAP_CORE_SCRIPT.test(url), true, url);
  for (const url of ["/js/bootstrap-datetimepicker.min.js", "/js/bootstrap-select.js", "/js/bootstrap-multiselect.js"])
    assert.equal(BOOTSTRAP_CORE_SCRIPT.test(url), false, url);
  assert.deepEqual(
    runtimeCompatibilityPaths({ bootstrapPlugins: true }, ["/resource/powerappsportal/dist/bootstrap.bundle-105a4995b8.js"]),
    [],
  );
});

test("compatibility adapters are added once after the last jQuery core include and never for a native bundle", () => {
  const dependencies = { bootstrapPlugins: true, dateTimePicker: true, jqueryUiDialog: true };
  const html = page(`${script("/scripts/jquery.min.js")}${script("/rm.js")}${script("/scripts/jquery.min.js")}${script("/xrm-adx/js/jquery-ui-1.11.4.min.js")}`);
  const output = injectRuntimeCompatibility(html, dependencies);
  // One copy of each adapter, directly after the second (last) jQuery include.
  assert.equal(count(output, COMPAT.bootstrap), 1);
  assert.equal(count(output, COMPAT.picker), 1);
  assert.ok(output.indexOf(COMPAT.bootstrap) > output.lastIndexOf('src="/scripts/jquery.min.js"'));
  assert.ok(output.indexOf(COMPAT.bootstrap) < output.indexOf("jquery-ui-1.11.4"));
  // The page's own jQuery UI provides dialog; no local dialog adapter.
  assert.equal(count(output, COMPAT.dialog), 0);
  // Preparing the same document twice changes nothing.
  assert.equal(injectRuntimeCompatibility(output, dependencies), output);
  // A captured platform Bootstrap bundle (hashed name) owns the data API.
  const native = injectRuntimeCompatibility(
    page(`${script("/scripts/jquery.min.js")}${script("/scripts/jquery.min.js")}`, script("/resource/powerappsportal/dist/bootstrap.bundle-105a4995b8.js")),
    dependencies,
  );
  assert.equal(count(native, COMPAT.bootstrap), 0);
  assert.equal(count(native, COMPAT.picker), 1);
  assert.equal(count(native, COMPAT.dialog), 1);
  // Without a jQuery include there is nothing to attach plugins to.
  assert.equal(injectRuntimeCompatibility(page(""), dependencies), page(""));
});

test("the Date adapter provides the platform's Datejs Date.parse and Date.today before authored scripts", async () => {
  const { default: vm } = await import("node:vm");
  const { readFile } = await import("node:fs/promises");
  const { discoverSourceDependencies, runtimeDependencyPaths } = await import("../lib/source-dependencies.mjs");
  const source = await readFile(new URL("../lib/date-format-compat.js", import.meta.url), "utf8");
  const sandbox = { console: { info() {} }, document: { documentElement: { dataset: {} } } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  vm.runInContext(source, sandbox);
  const result = vm.runInContext(
    `({
      parsed: Date.parse("08/10/2026 12:34") instanceof Date,
      month: Date.parse("08/10/2026 12:34").getMonth(),
      day: Date.parse("08/10/2026 12:34").getDate(),
      hours: Date.parse("8/10/2026 3:05 PM").getHours(),
      invalidMonth: Date.parse("25/10/2026 12:34"),
      empty: Date.parse(""),
      none: Date.parse(null),
      passthrough: (() => { const value = new Date(2026, 0, 2); return Date.parse(value) === value; })(),
      iso: Date.parse("2026-10-08T05:50:32Z").toISOString(),
      named: Date.parse("October 8, 2026").getDate(),
      text: Date.parse("Invalid date"),
      todayMidnight: Date.today().getHours() + Date.today().getMinutes(),
      format: new Date(2025, 1, 3).format("dd/M/yyyy"),
      mode: globalThis.__portalSimulation.compatibility.dateParseMode,
    })`,
    sandbox,
  );
  assert.deepEqual({ ...result }, { parsed: true, month: 7, day: 10, hours: 15, invalidMonth: null, empty: null, none: null, passthrough: true, iso: "2026-10-08T05:50:32.000Z", named: 8, text: null, todayMidnight: 0, format: "03/2/2025", mode: "datejs-compatibility" });
  // A real Datejs (the captured postpreform bundle) is kept.
  const datejs = { console: { info() {} }, document: { documentElement: { dataset: {} } } };
  vm.createContext(datejs);
  vm.runInContext("Date.parse = function (e) { var t = null; try { t = u.Grammar.start.call({}, e); } catch (r) {} return t; };", datejs);
  vm.runInContext(source, datejs);
  assert.match(vm.runInContext("String(Date.parse)", datejs), /Grammar/);
  // Sources that call Date.parse/Date.today load the adapter at the start of <head>.
  const portal = { webFiles: [], templates: { Main: { source: "<script>var d = Date.parse(value); Date.today();</script>" } }, snippets: {}, pages: [], forms: [], lists: [], records: [] };
  const dependencies = await discoverSourceDependencies(portal);
  assert.equal(dependencies.dateFormat, true);
  assert.deepEqual(runtimeDependencyPaths(dependencies, []), ["/__sim-static/vendor/date-format-compat.js"]);
  assert.equal((await discoverSourceDependencies({ ...portal, templates: { Main: { source: "<p>No dates</p>" } } })).dateFormat, false);
});
