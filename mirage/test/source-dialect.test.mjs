import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { importPortal } from "../lib/importer.mjs";
import { assertPortalSource, detectSourceDialect, portalSourceDir, PortalSourceError } from "../lib/source-dialect.mjs";
import { createSimulator } from "../server.mjs";
import { bootstrapReport, resolveReportInputs } from "../bootstrap-report.mjs";
import { bootstrapProject } from "../lib/project-config.mjs";

// A source the importer cannot read must fail loudly, naming its layout, instead of importing
// as an empty portal (ecosystem review docs/runtime-evidence.md, X1: a
// .powerpages-site code site imported as "standard" with 0 pages and no error). The short-key
// layout itself is imported now (test/short-key-import.test.mjs); mspp_ YAML is still refused.

const execFileAsync = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-source-dialect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  return fs.realpath(root);
}

// A synthetic code site in the .powerpages-site "git format": unprefixed keys and id:.
const SHORT_KEY_SITE = {
  ".powerpages-site/website.yml": "defaultlanguage: 6a0f0c2e-0000-4000-8000-000000000001\nfooterwebtemplateid: 6a0f0c2e-0000-4000-8000-000000000002\nheaderwebtemplateid: 6a0f0c2e-0000-4000-8000-000000000003\nid: 6a0f0c2e-0000-4000-8000-000000000004\nname: Synthetic Code Site\nwebsite_language: 1033\n",
  ".powerpages-site/web-pages/home/Home.webpage.yml": "id: 6a0f0c2e-0000-4000-8000-000000000010\nisroot: true\nname: Home\npagetemplateid: 6a0f0c2e-0000-4000-8000-000000000020\nparentpageid:\npartialurl: /\npublishingstateid: 6a0f0c2e-0000-4000-8000-000000000030\n",
  ".powerpages-site/web-pages/home/Home.webpage.copy.html": "<div id=\"root\"></div>",
  ".powerpages-site/web-pages/home/content-pages/en-US/Home.webpage.yml": "id: 6a0f0c2e-0000-4000-8000-000000000011\nisroot: false\nname: Home\npagetemplateid: 6a0f0c2e-0000-4000-8000-000000000020\npartialurl: /\nrootwebpageid: 6a0f0c2e-0000-4000-8000-000000000010\nwebpagelanguageid: 6a0f0c2e-0000-4000-8000-000000000001\n",
  ".powerpages-site/page-templates/Default.pagetemplate.yml": "id: 6a0f0c2e-0000-4000-8000-000000000020\nname: Default studio template\nwebtemplateid: 6a0f0c2e-0000-4000-8000-000000000040\n",
  ".powerpages-site/web-templates/default/Default.webtemplate.yml": "id: 6a0f0c2e-0000-4000-8000-000000000040\nname: Default studio template\n",
  ".powerpages-site/web-templates/default/Default.webtemplate.source.html": "{{ page.adx_copy }}",
  ".powerpages-site/site-settings/CodeSite-Enabled.sitesetting.yml": "id: 6a0f0c2e-0000-4000-8000-000000000050\nname: CodeSite/Enabled\nsource: 0\nvalue: true\n",
  ".powerpages-site/table-permissions/Contact.tablepermission.yml": "adx_entitypermission_webrole:\n- 6a0f0c2e-0000-4000-8000-000000000060\nentitylogicalname: contact\nentityname: Contact\nid: 6a0f0c2e-0000-4000-8000-000000000070\nread: true\nscope: 756150001\n",
  "lense/main.tsx": "export {};\n",
};

const MSPP_MESSAGE = /No portal pages were recognised in .*mspp\. Detected layout: PAC YAML with mspp_ keys\. The Mirage does not import this layout yet; use a PAC YAML export with adx_ keys, a \.powerpages-site export or the site's unpacked Solution \(powerpagecomponents\/\)\./;
const MSPP_SITE = {
  "mspp/website.yml": "mspp_name: Site\nmspp_websiteid: 6a0f0c2e-0000-4000-8000-000000000099\n",
  "mspp/web-pages/home/Home.webpage.yml": "mspp_name: Home\nmspp_partialurl: /\n",
};

test("source layouts are named: short-key, code-site project, mspp_ YAML, Solution without a site, adx_ YAML, unpacked Solution and unknown", async (t) => {
  const root = await tree(t, {
    ...SHORT_KEY_SITE,
    ...MSPP_SITE,
    "solution/Other/Solution.xml": "<ImportExportXml />",
    "standard/website.yml": "adx_name: Standard\nadx_websiteid: 6a0f0c2e-0000-4000-8000-000000000098\n",
    "enhanced/powerpagecomponents/6a0f0c2e-0000-4000-8000-000000000097/powerpagecomponent.xml": "<powerpagecomponent />",
    "empty/readme.txt": "nothing",
  });
  const dialect = (relative) => detectSourceDialect(path.join(root, relative));
  // Short-key exports and code-site projects (through .powerpages-site/) are imported.
  assert.deepEqual([dialect(".powerpages-site").dialect, dialect(".powerpages-site").imported], ["short-key-yaml", true]);
  assert.equal(dialect(".powerpages-site").evidence, "website.yml with id: and unprefixed keys");
  assert.deepEqual([dialect("").dialect, dialect("").imported], ["code-site-project", true]);
  assert.equal(portalSourceDir(root), path.join(root, ".powerpages-site"));
  assert.equal(portalSourceDir(path.join(root, "standard")), path.join(root, "standard"));
  assert.deepEqual([dialect("mspp").dialect, dialect("mspp").imported], ["enhanced-yaml", false]);
  assert.equal(dialect("solution").dialect, "solution-without-site");
  assert.deepEqual([dialect("standard").dialect, dialect("standard").imported], ["standard-yaml", true]);
  assert.deepEqual([dialect("enhanced").dialect, dialect("enhanced").imported], ["enhanced-solution", true]);
  assert.equal(dialect("empty").dialect, "unknown");
  assert.equal(dialect("missing").dialect, "unknown");
  // Without website.yml the record files decide; short-key relationship keys keep adx_.
  const records = await tree(t, { "web-pages/home/Home.webpage.yml": "id: 6a0f0c2e-0000-4000-8000-000000000010\nname: Home\npartialurl: /\n", "table-permissions/A.tablepermission.yml": "adx_entitypermission_webrole:\n- x\nid: y\n" });
  assert.equal(detectSourceDialect(records).dialect, "short-key-yaml");
  // The short-key site and its project folder import with their page.
  for (const source of [path.join(root, ".powerpages-site"), root]) {
    const portal = await importPortal(source);
    assert.deepEqual([portal.source.dialect, portal.pages.map((page) => page.url)], ["short-key-yaml", ["/"]]);
    assert.equal(assertPortalSource(portal), portal);
  }
});

test("an mspp_ YAML source is refused by import, serve, inspect, bootstrap-report and project bootstrap, naming its layout", async (t) => {
  const root = await tree(t, MSPP_SITE);
  const site = path.join(root, "mspp");
  // The importer records the layout and flags zero recognised pages (it still returns, for tools).
  const portal = await importPortal(site);
  assert.equal(portal.pages.length, 0);
  assert.equal(portal.source.dialect, "enhanced-yaml");
  const flagged = portal.diagnostics.find((item) => item.code === "PORTAL_SOURCE_EMPTY");
  assert.equal(flagged.dialect, "enhanced-yaml");
  assert.match(flagged.message, MSPP_MESSAGE);
  assert.throws(() => assertPortalSource(portal), (error) => error instanceof PortalSourceError && error.code === "PORTAL_SOURCE_EMPTY" && error.dialect === "enhanced-yaml" && MSPP_MESSAGE.test(error.message));
  // serve
  await assert.rejects(createSimulator({ sourceDir: site, stateFile: path.join(root, "state.json"), port: 0, watch: false, requirePortalSource: true }), MSPP_MESSAGE);
  // Embedded uses (tests, tools) start, recording the layout and PORTAL_SOURCE_EMPTY.
  const embedded = await createSimulator({ sourceDir: site, stateFile: path.join(root, "embedded.json"), port: 0, watch: false });
  try {
    const { status } = await (await fetch(embedded.url + "/__sim/api/state")).json();
    assert.equal(status.bootstrap.sourceLayout.dialect, "enhanced-yaml");
    assert.equal((await (await fetch(embedded.url + "/__sim/api/status")).json()).diagnostics.byCode.PORTAL_SOURCE_EMPTY, 1);
  } finally {
    await embedded.close();
  }
  // inspect (CLI): a non-zero exit with the message
  const inspected = await execFileAsync(process.execPath, [CLI, "inspect", "--source", site, "--json"], { timeout: 60000 }).then(
    () => null,
    (error) => error,
  );
  assert.ok(inspected, "inspect fails");
  assert.notEqual(inspected.code, 0);
  assert.match(inspected.stderr, MSPP_MESSAGE);
  // bootstrap-report and project bootstrap
  await assert.rejects(bootstrapReport(await resolveReportInputs({ source: site, "solution-root": [] }), { noCache: true }), MSPP_MESSAGE);
  // Project bootstrap imports for tools; the CLI refuses (serve and inspect --project).
  const project = await bootstrapProject({ portals: [{ id: "mspp", sourceDir: site }], solutionRoots: [], lcid: 1033 });
  assert.throws(() => assertPortalSource(project.portals[0].portal), MSPP_MESSAGE);
});

test("an adx_ export without web pages and an unknown folder fail with their own reason; a portal with pages imports as before", async (t) => {
  const root = await tree(t, {
    "empty-standard/website.yml": "adx_name: Standard\nadx_websiteid: 6a0f0c2e-0000-4000-8000-000000000098\n",
    "empty-standard/web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "unknown/notes.txt": "not a portal",
    "portal/website.yml": "adx_name: Standard\nadx_websiteid: 6a0f0c2e-0000-4000-8000-000000000098\n",
    "portal/web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "portal/page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main",
    "portal/web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "portal/web-templates/Main.webtemplate.source.html": "<p>home</p>",
  });
  await assert.rejects(createSimulator({ sourceDir: path.join(root, "empty-standard"), stateFile: path.join(root, "a.json"), port: 0, watch: false, requirePortalSource: true }), /Detected layout: PAC YAML with adx_ keys\. It has no web pages\./);
  await assert.rejects(
    createSimulator({ sourceDir: path.join(root, "unknown"), stateFile: path.join(root, "b.json"), port: 0, watch: false, requirePortalSource: true }),
    /Detected layout: no recognised portal layout \(no website\.yml, web-pages\/, web-files\/ or powerpagecomponents\/\)\. Point it at the folder that contains website\.yml \(a PAC YAML or \.powerpages-site export\), or at an unpacked Solution with powerpagecomponents\/\./,
  );
  const portal = await importPortal(path.join(root, "portal"));
  assert.deepEqual([portal.pages.length, portal.source.dialect, portal.diagnostics.some((item) => item.code === "PORTAL_SOURCE_EMPTY")], [1, "standard-yaml", false]);
  assert.equal(assertPortalSource(portal), portal);
  const app = await createSimulator({ sourceDir: path.join(root, "portal"), stateFile: path.join(root, "c.json"), port: 0, watch: false, requirePortalSource: true });
  t.after(() => app.close());
  assert.equal((await fetch(app.url + "/")).status, 200);
});
