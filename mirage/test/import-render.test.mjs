import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPortal } from "../lib/importer.mjs";
import { createPortalRenderer, renderShellResource } from "../lib/liquid.mjs";
import { observedHeaderNotifications } from "../lib/header-notification-capture.mjs";
import { registerShellConventions } from "../lib/extensions.mjs";
import { observedPageCopyLayout } from "../lib/observed-pagecopy-layout.mjs";
import { observedSnippetComposition } from "../lib/observed-snippet-composition.mjs";

async function fixture(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-simulation-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}
const standard = {
  "website.yml":
    "adx_websiteid: site\nadx_name: Test\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: english",
  "web-pages/home/Home.webpage.yml":
    "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main",
  "web-pages/work/Work.webpage.yml":
    "adx_webpageid: work\nadx_name: Work\nadx_isroot: true\nadx_parentpageid: home\nadx_partialurl: work\nadx_pagetemplateid: main",
  "web-pages/work/content-pages/Work.en-US.webpage.yml":
    "adx_webpageid: translation\nadx_name: Work\nadx_title: Work title\nadx_isroot: false\nadx_rootwebpageid: work\nadx_webpagelanguageid: english\nadx_partialurl: work",
  "web-pages/work/content-pages/Work.en-US.webpage.copy.html":
    "<p>Page body {{request.params.item | escape}}</p>",
  "web-pages/work/content-pages/Work.en-US.webpage.custom_css.css":
    ".work {color: red}",
  "web-pages/work/content-pages/Work.en-US.webpage.custom_javascript.js":
    "window.work = true;",
  "page-templates/Main.pagetemplate.yml":
    "adx_pagetemplateid: main\nadx_name: Main\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: content",
  "web-templates/header/Header.webtemplate.yml":
    "adx_webtemplateid: header\nadx_name: Header",
  "web-templates/header/Header.webtemplate.source.html":
    '<header>{{snippets["Greeting"]}}</header>',
  "web-templates/footer/Footer.webtemplate.yml":
    "adx_webtemplateid: footer\nadx_name: Footer",
  "web-templates/footer/Footer.webtemplate.source.html":
    '<footer>{{ now | date: "yyyy" }}</footer>',
  "web-templates/content/Content.webtemplate.yml":
    "adx_webtemplateid: content\nadx_name: Content",
  "web-templates/content/Content.webtemplate.source.html":
    "{% include 'Page Copy' %}",
  "content-snippets/greeting/Greeting.contentsnippet.yml":
    "adx_contentsnippetid: greeting\nadx_name: Greeting",
  "content-snippets/greeting/Greeting.contentsnippet.value.html": "Hello",
  "web-files/app.js.webfile.yml":
    "adx_webfileid: app\nadx_name: app.js\nadx_partialurl: renamed.js\nadx_parentpageid: home\nfilename: original.js\nmimetype: application/javascript",
  "web-files/app.js": "window.asset = true;",
  "table-permissions/contact.tablepermission.yml":
    "adx_entitypermissionid: permission\nadx_entitylogicalname: contact\nadx_entityname: Contacts\nadx_read: true",
};
test("knowledge categories load lazily through the current data provider and follow paging without cross-render caching", async (t) => {
  const dir = await fixture(t, standard),
    portal = await importPortal(dir),
    reads = [];
  const renderer = createPortalRenderer(portal, {
    fetchXml: async (xml, user) => {
      reads.push({ xml, user });
      if (user.id === "denied") return { entities: [], more_records: false };
      if (xml.includes('page="1"'))
        return {
          entities: [
            { categoryid: "first", categorynumber: "CAT-01001", title: "Forms" },
          ],
          more_records: true,
          paging_cookie: '<cookie id="first" />',
        };
      assert.match(
        xml,
        /paging-cookie="&lt;cookie id=&quot;first&quot; \/&gt;"/,
      );
      return {
        entities: [
          {
            categoryid: "pms",
            categorynumber: "CAT-01003",
            title: "PMS guidance",
          },
        ],
        more_records: false,
      };
    },
  });
  portal.templates.content.source =
    "{% assign category=knowledge.categories | category_number:'CAT-01003' %}<h1>{{ category.title }}</h1>{% assign roots=knowledge.categories | top_level:9 %}{% for root in roots %}{{ root.categorynumber }} {% endfor %}";
  const allowed = await renderer.renderPage("/work/", {
    user: { id: "allowed" },
  });
  assert.match(allowed.html, /<h1>PMS guidance<\/h1>/);
  assert.match(allowed.html, /CAT-01001 CAT-01003/);
  assert.equal(reads.length, 2);
  assert.ok(reads.every((read) => read.user.id === "allowed"));
  const denied = await renderer.renderPage("/work/", {
    user: { id: "denied" },
  });
  assert.doesNotMatch(denied.html, /PMS guidance|CAT-01003/);
  assert.equal(reads.length, 3);
  portal.templates.content.source = "<h1>Ordinary page</h1>";
  await renderer.renderPage("/work/", { user: { id: "allowed" } });
  assert.equal(reads.length, 3);
});

test("observed static copy layout and snippet composition render through native tags and edited source wins", async (t) => {
  const copy = '<script src="/copy.js"></script>',
    parent = '<div class="empty">Use filters</div>',
    child = '<button id="create" style="display:none;">Create</button>';
  const dir = await fixture(t, {
    ...standard,
    "web-pages/work/content-pages/Work.en-US.webpage.copy.html": copy,
    "web-templates/content/Content.webtemplate.source.html": `{% include 'Page Copy' %}{{ snippets['Greeting'] }}`,
    "content-snippets/greeting/Greeting.contentsnippet.value.html": parent,
    "content-snippets/action/Action.contentsnippet.yml":
      "adx_contentsnippetid: action\nadx_name: Action",
    "content-snippets/action/Action.contentsnippet.value.html": child,
  });
  const portal = await importPortal(dir),
    origin = "https://example.invalid";
  const layout = observedPageCopyLayout(
    '<div class="page-copy"><div class="xrm-attribute-value">' +
      copy +
      '<div class="row sectionBlockLayout"><div class="container"></div></div></div></div>',
    { portal, path: "/work/", origin },
  );
  assert.ok(layout);
  const composition = observedSnippetComposition({
    snippets: portal.snippets,
    parentName: "Greeting",
    childName: "Action",
    observedMarkup: parent.replace("</div>", child + "</div>"),
    origin,
    pagePath: "/work/",
  });
  const renderer = createPortalRenderer(portal, {
    observationOrigin: origin,
    shellProfile: {
      pageCopyLayouts: [layout],
      snippetCompositions: [composition],
    },
  });
  const result = await renderer.renderPage("/work/");
  assert.equal(result.status, 200);
  assert.match(result.html, /xrm-editable-html/);
  assert.match(result.html, /sectionBlockLayout/);
  assert.match(result.html, /<button id="create" style="display:none;">/);
  portal.pages.find((p) => p.url === "/work/").html = "Edited";
  portal.snippets.Greeting = "Local parent edit";
  const changed = await renderer.renderPage("/work/");
  assert.doesNotMatch(changed.html, /sectionBlockLayout|id="create"/);
  assert.ok(
    changed.diagnostics.some(
      (d) => d.code === "PAGE_COPY_LAYOUT_SOURCE_CHANGED",
    ),
  );
  assert.ok(
    changed.diagnostics.some(
      (d) => d.code === "SNIPPET_COMPOSITION_SOURCE_CHANGED",
    ),
  );
});

test("observed header notification presentation uses exported Liquid query and current user without copying native data", async (t) => {
  // The data pack serving the portal names the query template (shell.headerNotificationQuery).
  assert.throws(() => registerShellConventions("test", { headerNotificationQuery: " " }), /must name a web template/);
  registerShellConventions("test", { headerNotificationQuery: "Site notifications query" });
  const header =
    '<header><ul><li class="userProfileHolder">Profile</li></ul></header>';
  const dir = await fixture(t, {
    ...standard,
    "web-templates/header/Header.webtemplate.source.html": header,
    "web-templates/notifications/Notifications.webtemplate.yml":
      "adx_webtemplateid: notifications\nadx_name: Site notifications query",
    "web-templates/notifications/Notifications.webtemplate.source.html": `{% fetchxml notices %}<fetch><entity name="notification"/></fetch>{% endfetchxml %}{"notifications": [{% for notice in notices.results.entities %}{"visible":{% if notice.contact == user.id %}true{% else %}false{% endif %},"notificationText":"{{notice.message}}","severity":"info"}{% unless forloop.last %},{% endunless %}{% endfor %}]}`,
  });
  const profile = observedHeaderNotifications(
    '<li class="userProfileHolder"><a href="#"><svg><path d="M0 0"/></svg><span class="notificationsCount">99</span></a></li>',
    { headerSource: header, origin: "https://example.invalid" },
  );
  let identity;
  const renderer = createPortalRenderer(await importPortal(dir), {
    fetchXml: async (_xml, user) => {
      identity = user;
      return {
        entities: [
          { contact: "current", message: "Local notice" },
          { contact: "other", message: "Hidden notice" },
        ],
      };
    },
    shellProfile: { headerNotifications: profile },
  });
  const result = await renderer.renderPage("/work/", {
    user: { id: "current", roles: [] },
  });
  assert.equal(result.status, 200);
  assert.equal(identity.id, "current");
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.match(result.html, /Local notice/);
  assert.doesNotMatch(result.html, /Hidden notice/);
  assert.doesNotMatch(result.html, />99</);
});

test("header queries own custom audience rules and invalid presentation rows are diagnosed", async (t) => {
  registerShellConventions("presentation-fixture", { headerNotificationQuery: "Authored notices" });
  const header = '<header><ul><li class="userProfileHolder">Profile</li></ul></header>';
  const dir = await fixture(t, {
    ...standard,
    "web-templates/header/Header.webtemplate.source.html": header,
    "web-templates/notices/Notices.webtemplate.yml": "adx_webtemplateid: authored-notices\nadx_name: Authored notices",
    "web-templates/notices/Notices.webtemplate.source.html": JSON.stringify({ notifications: [
      { notificationText: "Authored visible", visible: true, severity: "warning", audience: 99, webRoleName: "Unassigned" },
      { notificationText: "Authored hidden", visible: false, severity: "info", audience: 1 },
      { notificationText: "Numeric severity", visible: true, severity: 2 },
      { notificationText: "String visibility", visible: "false", severity: "info" },
      null,
    ] }),
  });
  const profile = observedHeaderNotifications(
    '<li class="userProfileHolder"><a href="#"><svg><path d="M0 0"/></svg><span class="notificationsCount">99</span></a></li>',
    { headerSource: header, origin: "https://example.invalid" },
  );
  const renderer = createPortalRenderer(await importPortal(dir), { shellProfile: { headerNotifications: profile } });
  const result = await renderer.renderPage("/work/", { user: { id: "current", roles: [] } });
  assert.equal(result.status, 200);
  assert.match(result.html, /Authored visible/);
  assert.match(result.html, /alert-warning/);
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.doesNotMatch(result.html, /Authored hidden|Numeric severity|String visibility/);
  assert.equal(result.diagnostics.find((entry) => entry.code === "HEADER_NOTIFICATION_QUERY_INVALID")?.count, 3);
});

test("portal date formats support single numeric tokens and literal text", async (t) => {
  const renderer = createPortalRenderer(
    await importPortal(await fixture(t, standard)),
  );
  assert.equal(
    await renderer.renderString('{{ value | date: "dd/M/yyyy" }}', {
      value: "2026-01-02",
    }),
    "02/1/2026",
  );
  assert.equal(
    await renderer.renderString('{{ value | date: "d/M/yyyy" }}', {
      value: "2026-01-02",
    }),
    "2/1/2026",
  );
  assert.equal(
    await renderer.renderString(
      `{{ value | date: "yyyy 'year' MM 'month' dd" }}`,
      { value: "2026-01-02" },
    ),
    "2026 year 01 month 02",
  );
  assert.equal(
    await renderer.renderString('{{ value | date: "g" }}', {
      value: "2026-01-02T00:00:00",
    }),
    "1/2/2026 12:00 AM",
  );
});

test("standard PAC names, language copy, URL, annotation attachment, and rendered shell", async (t) => {
  const dir = await fixture(t, standard);
  const portal = await importPortal(dir);
  assert.equal(portal.format, "standard");
  assert.equal(portal.pages.length, 2);
  assert.equal(portal.snippets.Greeting, "Hello");
  assert.equal(portal.templates.Content.source, "{% include 'Page Copy' %}");
  assert.equal(portal.webFiles[0].url, "/renamed.js");
  assert.equal(path.basename(portal.webFiles[0].file), "app.js");
  assert.equal(
    portal.records.find((r) => r.kind === "tablepermission").id,
    "permission",
  );
  const rendered = await createPortalRenderer(portal).renderPage(
    "/work/?item=%3Cinput%3E",
    { now: new Date("2026-01-01") },
  );
  assert.equal(rendered.status, 200);
  // The platform layout's <html> also carries crm-lang, crm-lcid, data-lang and same-site-mode.
  assert.match(rendered.html, /<html lang="en-US" dir="ltr" crm-lang="en-US" crm-lcid="1033" data-lang="en-US" same-site-mode="None">/);
  assert.match(rendered.html, /<header>Hello<\/header>/);
  assert.match(rendered.html, /<p>Page body &lt;input&gt;<\/p>/);
  // Authored footer markup is served unchanged; the local overlap repair
  // (lib/footer-spacing-compat.js) is part of the app bundle's local equivalent.
  assert.match(rendered.html, /<footer>2026<\/footer>/);
  assert.doesNotMatch(rendered.html, /data-sim-footer-spacing/);
  // The platform's after-footer bundles follow the footer; the page script comes last.
  assert.match(
    rendered.html,
    /<footer>2026<\/footer>(?:<script src="\/resource\/powerappsportal\/dist\/[^"]+"[^>]*><\/script>){4}<script>window\.work = true;<\/script><\/body>/,
  );
  assert.doesNotMatch(rendered.html, /\/__sim-static\//);
  assert.match(rendered.html, /\.work \{color: red\}/);
  assert.equal(rendered.page.title, "Work title");
  // The minimal export has no "Page Copy" web template; the runtime template is used and reported.
  assert.deepEqual(
    rendered.diagnostics.map((d) => d.code),
    ["liquid-managed-template-source"],
  );
});

test("omitted basic form mode imports the documented Insert default", async (t) => {
  const dir = await fixture(t, {
    ...standard,
    "basic-forms/create/Create.basicform.yml":
      "adx_entityformid: create\nadx_name: Create\nadx_entityname: contact\nadx_formname: Main",
  });
  const portal = await importPortal(dir);
  assert.equal(portal.forms[0].mode, 100000000);
});

function component(id, type, name, content, extra = "") {
  const encode = (v) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<powerpagecomponent powerpagecomponentid="${id}"><content>${encode(JSON.stringify(content))}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode>${extra}</powerpagecomponent>`;
}
test("enhanced PAC components decode JSON/XML once and preserve sibling fields", async (t) => {
  const dir = await fixture(t, {
    "Assets/powerpagesites.xml":
      '<powerpagesites><powerpagesite powerpagesiteid="site"><content>{"headerwebtemplateid":"header"}</content><name>Enhanced</name></powerpagesite></powerpagesites>',
    "powerpagecomponents/home/powerpagecomponent.xml": component(
      "home",
      2,
      "Home",
      { isroot: true, partialurl: "/", pagetemplateid: "main" },
    ),
    "powerpagecomponents/work/powerpagecomponent.xml": component(
      "work",
      2,
      "Work",
      {
        isroot: true,
        parentpageid: "home",
        partialurl: "work",
        pagetemplateid: "main",
      },
    ),
    "powerpagecomponents/lang/powerpagecomponent.xml": component(
      "lang",
      2,
      "Work",
      {
        isroot: false,
        rootwebpageid: "work",
        copy: '<p>{{snippets["Greeting"]}}</p>',
        customcss: ".exact{color:blue}",
        customjavascript: "window.enhanced = 1;",
      },
    ),
    "powerpagecomponents/main/powerpagecomponent.xml": component(
      "main",
      6,
      "Main",
      { webtemplateid: "body", usewebsiteheaderandfooter: false },
    ),
    "powerpagecomponents/body/powerpagecomponent.xml": component(
      "body",
      8,
      "Body",
      { source: "{% include 'Page Copy' %}" },
    ),
    "powerpagecomponents/snippet/powerpagecomponent.xml": component(
      "snippet",
      7,
      "Greeting",
      { value: "A & B <span>ok</span>" },
    ),
    "powerpagecomponents/file/powerpagecomponent.xml": component(
      "file",
      3,
      "app.js",
      { parentpageid: "home", partialurl: "app.js" },
      '<filecontent mimetype="application/javascript">app.js</filecontent>',
    ),
    "powerpagecomponents/file/filecontent/app.js": "window.enhancedAsset = 1;",
    "powerpagecomponents/shortcut/powerpagecomponent.xml": component(
      "shortcut",
      32,
      "Work shortcut",
      {
        parentpage_webpageid: "home",
        webpageid: "work",
        title: "Shortcut title",
        displayorder: 2,
      },
    ),
  });
  const portal = await importPortal(dir);
  assert.equal(portal.format, "enhanced");
  assert.equal(portal.website.name, "Enhanced");
  assert.equal(portal.webFiles[0].url, "/app.js");
  assert.deepEqual(
    portal.shortcuts.map((item) => ({ url: item.url, title: item.title })),
    [{ url: "/work/", title: "Shortcut title" }],
  );
  const r = await createPortalRenderer(portal).renderPage("/work/");
  assert.equal(r.status, 200);
  assert.match(r.html, /<p>A & B <span>ok<\/span><\/p>/);
  assert.match(r.html, /window.enhanced = 1/);
  assert.match(r.html, /exact\{color:blue/);
  assert.equal(
    portal.records.find((x) => x.id === "lang").customjavascript,
    "window.enhanced = 1;",
  );
});

test("sitemap shortcuts expose hidden targets in display order while retaining target page permissions", async (t) => {
  const dir = await fixture(t, {
    ...standard,
    "shortcut.yml":
      "- adx_shortcutid: home-link\n  adx_parentpage_webpageid: home\n  adx_webpageid: home\n  adx_name: Homepage\n  adx_displayorder: 2\n- adx_shortcutid: work-link\n  adx_parentpage_webpageid: home\n  adx_webpageid: work\n  adx_name: Hidden target\n  adx_title: Work shortcut\n  adx_displayorder: 1",
    "web-pages/work/content-pages/Work.en-US.webpage.yml":
      standard["web-pages/work/content-pages/Work.en-US.webpage.yml"] +
      "\nadx_hiddenfromsitemap: true",
    "webrole.yml": "- adx_webroleid: reader\n  adx_name: Reader",
    "webpageaccesscontrolrule.yml":
      "- adx_webpageaccesscontrolruleid: protect\n  adx_webpageid: work\n  adx_right: 2\n  adx_webpageaccesscontrolrule_webrole:\n  - reader",
  });
  const portal = await importPortal(dir),
    renderer = createPortalRenderer(portal);
  const root = portal.pages.find((p) => p.id === "home");
  const denied = renderer.contextForPage(root, "/", {
    user: { id: "user", roles: [] },
  });
  assert.deepEqual(
    denied.sitemap.root.children.map((p) => p.id),
    ["home-link"],
  );
  const allowed = renderer.contextForPage(root, "/", {
    user: { id: "user", roles: ["Reader"] },
  });
  assert.deepEqual(
    allowed.sitemap.root.children.map((p) => p.id),
    ["work-link", "home-link"],
  );
  assert.equal(allowed.sitemap.root.children[0].url, "/work/");
  assert.equal(allowed.sitemap.root.children[0].title, "Work shortcut");
  assert.equal(allowed.sitemap.root.children[0].name, "Work shortcut");
  assert.equal(allowed.sitemap.root.children[0].internalName, "Hidden target");
  assert.equal(allowed.sitemap.root.children[1].title, root.title);
});

test("fetchxml variables, async entities, roles, include parameters, inheritance and elseif", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates.Layout = {
    source: "<article>{% block main %}default{% endblock %}</article>",
  };
  portal.templates.Child = {
    source:
      "{% extends 'Layout' %}{% block main %}{% include 'Row' label: 'Output' %}{% endblock %}",
  };
  portal.templates.Row = {
    source: "{{label}}:{{entities.contact[request.params.id].fullname}}",
  };
  let xmlReceived;
  const renderer = createPortalRenderer(portal, {
    fetchXml: async (xml, user) => {
      xmlReceived = xml;
      assert.equal(user.id, "contact-user");
      return { entities: [{ name: "Alpha" }], total_record_count: 1 };
    },
    entity: async (table, id) => {
      assert.equal(table, "contact");
      assert.equal(id, "0c4f7a1e-5b6d-4e3f-9a8b-7c6d5e4f3a2b");
      return { fullname: "Ada" };
    },
  });
  // entities[table][id] loads records only for GUID keys (EntitySetDrop).
  const context = renderer.contextForPage(
    portal.pages[1],
    "/work/?id=0c4f7a1e-5b6d-4e3f-9a8b-7c6d5e4f3a2b",
    { user: { id: "contact-user", roles: ["Reader"] } },
  );
  assert.equal(
    await renderer.renderString(
      "{% fetchxml found %}<fetch><entity name='contact'><filter><condition attribute='contactid' operator='eq' value='{{user.id}}' /></filter></entity></fetch>{% endfetchxml %}{% for item in found.results.entities %}{{item.name}}{% endfor %}|{{found.results.total_record_count}}",
      context,
    ),
    "Alpha|1",
  );
  assert.match(xmlReceived, /value='contact-user'/);
  assert.equal(
    await renderer.renderString("{% include 'Child' %}", context),
    "<article>Output:Ada</article>",
  );
  assert.equal(
    await renderer.renderString(
      "{% assign reader=user | has_role:'Reader' %}{% if reader %}yes{% elseif false %}no{% endif %}",
      context,
    ),
    "yes",
  );
});

test("render diagnostics expose unsupported tags and filters instead of reporting coverage", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  // DotLiquid returns the input of an unknown filter unchanged; the admin still sees it.
  portal.templates.Content.source = "<p>{{ 1 | unsupported_filter }}</p>";
  let r = await createPortalRenderer(portal).renderPage("/work/");
  assert.equal(r.status, 200);
  assert.match(r.html, /<p>1<\/p>/);
  assert.equal(r.diagnostics[0].code, "liquid-unknown-filter");
  assert.equal(r.diagnostics[0].filter, "unsupported_filter");
  portal.templates.Content.source = '{% entityform name: "Unavailable" %}';
  r = await createPortalRenderer(portal).renderPage("/work/");
  assert.equal(r.diagnostics[0].code, "unsupported-platform-component");
  // A template that fails to parse is replaced by the bare parser message.
  portal.templates.Content.source = "before{% unknown_portal_tag %}after";
  r = await createPortalRenderer(portal).renderPage("/work/");
  assert.equal(r.status, 200);
  // Platform chrome (antiforgery holder, platform bundles, native controls root) surrounds the content.
  assert.match(r.html, /<header>Hello<\/header>(?:<div[^>]*><\/div>|<script src="\/resource\/powerappsportal\/[^"]+"[^>]*><\/script>)*Unknown tag 'unknown_portal_tag'(?:<div[^>]*><\/div>|<script src="\/resource\/powerappsportal\/[^"]+"[^>]*><\/script>)*<footer>/);
  assert.equal(r.diagnostics[0].code, "liquid-syntax-error");
  assert.match(r.diagnostics[0].message, /unknown_portal_tag/);
});

test("nested snippet Liquid, member assignments, null user, and Power Pages filter tolerance", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.snippets.Greeting =
    '{% if user %}Member{% else %}Visitor{% endif %} {{snippets["Second"]}}';
  portal.snippets.Second = "{{page.title}}";
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(portal.pages[1], "/work/", {
    user: { id: null, roles: ["Anonymous Users"] },
  });
  assert.equal(context.user, null);
  assert.equal(context.page.adx_entityform, null);
  assert.equal(
    await renderer.renderString('{{ snippets["Greeting"] }}', context),
    "Visitor Work title",
  );
  // DotLiquid assign names a variable "page.title"; it does not change the page drop.
  assert.equal(
    await renderer.renderString(
      "{% assign page.title = \"Changed\" %}{{page.title}}|{{ ['page.title'] }}",
      context,
    ),
    "Work title|Changed",
  );
  assert.equal(
    await renderer.renderString(
      '{% capture value %}a\nb{% endcapture %}{% assign value = value | | strip_newlines %}{{value}}',
      context,
    ),
    "ab",
  );
  // DotLiquid tags cannot span lines, even inside a quoted string.
  assert.equal(
    await renderer.renderString('{% assign value = "a\nb" %}{{value}}', context),
    "Tag '{% assign value = \"a\nb\" %}' was not properly terminated with regexp: (?-mix:\\%\\})",
  );
  assert.equal(
    await renderer.renderString(
      "{% raw %}{% assign x = {{y}} %}{% endraw %}",
      context,
    ),
    "{% assign x = {{y}} %}",
  );
});

test("shell profile preserves captured dependency phases around source content and footer", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal, {
    shellProfile: {
      stylesheets: ["/resource/font-awesome.css", "/bootstrap.min.css"],
      headScripts: ["/scripts/jquery.min.js"],
      beforeContentScripts: ["/resource/jquery-ui.min.js"],
      bodyScripts: ["/resource/legacy-before-footer.js"],
      afterFooterScripts: ["/resource/bootstrap.bundle.js"],
    },
  });
  const result = await renderer.renderPage("/work/");
  assert.equal(result.status, 200);
  assert.ok(
    result.html.indexOf("/resource/font-awesome.css") <
      result.html.indexOf("/bootstrap.min.css"),
  );
  assert.ok(
    result.html.indexOf("/scripts/jquery.min.js") <
      result.html.indexOf("<body "),
  );
  assert.ok(
    result.html.indexOf("/resource/bootstrap.bundle.js") >
      result.html.indexOf("</footer>"),
  );
  assert.ok(
    result.html.indexOf("/resource/jquery-ui.min.js") >
      result.html.indexOf("<body "),
  );
  assert.ok(
    result.html.indexOf("/resource/jquery-ui.min.js") <
      result.html.indexOf("/resource/legacy-before-footer.js"),
  );
  assert.ok(
    result.html.indexOf("/resource/legacy-before-footer.js") <
      result.html.indexOf("<footer>"),
  );
  // The authored footer is not annotated; the local footer-spacing repair is part of the
  // platform app bundle's local equivalent, which follows the captured after-footer phase.
  assert.match(result.html, /<footer>2026<\/footer>/);
  assert.doesNotMatch(result.html, /\/__sim-static\//);
  assert.equal(result.html.split("/resource/powerappsportal/dist/app.bundle-").length, 2);
  assert.ok(
    result.html.indexOf("/resource/powerappsportal/dist/app.bundle-") >
      result.html.indexOf("/resource/bootstrap.bundle.js"),
  );
  assert.equal(renderer.inspectCapabilities().diagnostics.length, 0);
  const invalid = await createPortalRenderer(portal, {
    shellProfile: { headScripts: ["javascript:alert(1)"] },
  }).renderPage("/work/");
  assert.equal(invalid.status, 500);
});

test("deployment profile changes values in memory and preserves source and navigation child flags", async (t) => {
  const dir = await fixture(t, {
    ...standard,
    "deployment-profiles/sandbox.deployment.yml":
      "adx_contentsnippet:\n- adx_contentsnippetid: greeting\n  adx_name: RenamedGreeting\n  adx_value: true\nadx_webtemplate:\n- adx_webtemplateid: content\n  adx_source: \"{{snippets['Greeting']}}\"",
    "weblink-sets/nav/Nav.weblinkset.yml":
      "adx_weblinksetid: nav\nadx_name: Primary Navigation",
    "weblink-sets/nav/Nav.weblinkset.weblink.yml":
      "- adx_weblinkid: home-link\n  adx_name: Home\n  adx_pageid: home\n  adx_weblinksetid: nav\n  adx_displaypagechildlinks: true\n  adx_openinnewwindow: true",
  });
  const original = await fs.readFile(
    path.join(
      dir,
      "content-snippets/greeting/Greeting.contentsnippet.value.html",
    ),
    "utf8",
  );
  const portal = await importPortal(dir, { deploymentProfile: "sandbox" });
  assert.equal(portal.snippets.Greeting, "true");
  assert.equal(portal.snippets.RenamedGreeting, "true");
  assert.ok(
    portal.diagnostics.some(
      (d) => d.code === "DEPLOYMENT_PROFILE_SNIPPET_NAME_ALIAS",
    ),
  );
  assert.equal(portal.profileChanges.length, 2);
  assert.equal(portal.templates.Content.source, "{{snippets['Greeting']}}");
  assert.equal(
    await fs.readFile(
      path.join(
        dir,
        "content-snippets/greeting/Greeting.contentsnippet.value.html",
      ),
      "utf8",
    ),
    original,
  );
  const link = portal.weblinks["Primary Navigation"].weblinks[0];
  assert.equal(link.display_page_child_links, true);
  assert.equal(link.Open_In_New_Window, true);
  const renderer = createPortalRenderer(portal);
  const ctx = renderer.contextForPage(portal.pages[1]);
  assert.equal(ctx.sitemap["/"].children[0].url, "/work/");
  await assert.rejects(
    () => importPortal(dir, { deploymentProfile: "missing" }),
    /absent/,
  );
});

test("Power Pages numeric request equality and no-header template MIME preserve AJAX semantics", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  assert.equal(await renderer.renderString("{% case item.order %}{% when '1' %}pill{% when '2', '3' %}package{% else %}other{% endcase %}", { item: { order: 1 } }), "pill");
  assert.equal(await renderer.renderString("{% case item.order %}{% when '1' %}pill{% when '2', '3' %}package{% else %}other{% endcase %}", { item: { order: 3 } }), "package");
  assert.equal(await renderer.renderString("{% case item.order %}{% when 1 %}first{% when 'unrelated' %}second{% else %}other{% endcase %}", { item: { order: 'unrelated' } }), "second");
  assert.equal(
    await renderer.renderString(
      "{% assign count = request.params.count | liquid %}{% if count == 0 %}total{% else %}rows{% endif %}",
      { request: { params: { count: "0" } } },
    ),
    "total",
  );
  assert.equal(
    await renderer.renderString(
      "{% if request.params.count != 0 %}rows{% endif %}",
      { request: { params: { count: "10" } } },
    ),
    "rows",
  );
  portal.pageTemplates[0].useHeaderFooter = false;
  portal.templates.Content.source = '{"totalCount":1}';
  let result = await renderer.renderPage("/work/");
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(result.isDocument, false);
  portal.templates.Content.metadata.adx_mimetype = "application/json;";
  result = await renderer.renderPage("/work/");
  assert.equal(result.contentType, "application/json; charset=utf-8");
});

test("Liquid syntax repairs preserve quoted filter-like string values", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  const result = await renderer.renderString(
    '{% assign literal = "| | date:%Y, (value) | thing=abc" %}{{ literal }}',
    {},
  );
  assert.equal(result, "| | date:%Y, (value) | thing=abc");
});

test("platform poll placements render the embedded placeholder and the poll service selects by state and dates", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.records.push(
    {
      kind: "pollplacement",
      id: "sidebar",
      name: "Sidebar",
      adx_pollplacement_poll: ["poll"],
    },
    {
      kind: "poll",
      id: "poll",
      name: "Question",
      adx_active: false,
      adx_question: "Which option?",
    },
    { kind: "polloption", id: "yes", name: "Yes", adx_pollid: "poll" },
  );
  const renderer = createPortalRenderer(portal);
  const ctx = renderer.contextForPage(portal.pages[1]);
  // The embedded poll template (random_poll) renders the placeholder the poll service fills.
  assert.match(
    await renderer.renderString(
      '{% include "poll" poll_placement_name:"Sidebar" %}',
      ctx,
    ),
    /<div class="poll" data-url="\/_services\/polls\/[^/]*\/placements\/sidebar\/random" data-submit-url="\/_services\/polls\/[^/]*\/SubmitPoll\?id=sidebar"><\/div>/,
  );
  assert.deepEqual(ctx.__diagnostics, []);
  const service = '{% assign poll_placement_name = "Sidebar" %}{% mirage_poll %}';
  const served = await renderer.renderString(service, renderer.contextForPage(portal.pages[1]));
  assert.match(served, /<div class="poll-questionpanel" data-id="poll" data-name="Question">/);
  assert.match(served, /Which option\?/);
  portal.records.find((r) => r.kind === "poll").statecode = 1;
  assert.equal((await renderer.renderString(service, renderer.contextForPage(portal.pages[1]))).trim(), "");
  // side_navigation is the embedded runtime template (EmbeddedResourceFileSystem).
  const navigation = await renderer.renderString(
    '{% include "side_navigation" %}',
    renderer.contextForPage(portal.pages[0]),
  );
  assert.match(navigation, /<ul class="side-nav" role="navigation">/);
  assert.match(navigation, /<li class="active">\s*<a href="\/" title="Home">/);
  assert.match(navigation, /<a href="\/work\/" title="Work title">/);
});

test("include names resolve web templates case-insensitively before embedded runtime templates", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates["Side Navigation"] = {
    name: "Side Navigation",
    source:
      "<nav data-exported>{{ page.parent.title }}:{% for item in page.parent.children %}{{item.title}}{% endfor %}</nav>",
  };
  const renderer = createPortalRenderer(portal),
    ctx = renderer.contextForPage(portal.pages[1]);
  // adx_name lookup is a Dataverse string comparison (case-insensitive).
  assert.equal(
    await renderer.renderString('{% include "side navigation" %}', ctx),
    "<nav data-exported>Home:Work title</nav>",
  );
  // The snake_case runtime name does not match the display name of the web template.
  assert.match(
    await renderer.renderString('{% include "side_navigation" %}', ctx),
    /<ul class="side-nav" role="navigation">/,
  );
});

test("observed shell profile retains resource loading attributes safely", () => {
  assert.equal(
    renderShellResource({ href: "/print.css", media: "print" }, "css"),
    '<link rel="stylesheet" href="/print.css" media="print">',
  );
  assert.equal(
    renderShellResource(
      { src: "/module.js", defer: true, async: true, type: "module" },
      "js",
    ),
    '<script src="/module.js" defer async type="module"></script>',
  );
  assert.throws(
    () =>
      renderShellResource({ src: "/data.js", type: "application/json" }, "js"),
    /Unsupported/,
  );
  assert.throws(() => renderShellResource("//other/script.js", "js"), /paths/);
  assert.throws(
    () =>
      renderShellResource("https://example.com/script.js", "js", {
        localOnly: true,
      }),
    /paths/,
  );
});

test("browser title suffix renders exported Liquid and retains entities without allowing markup", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.snippets["Browser Title Suffix"] =
    "&nbsp;· {{ website.name }} </title><script>alert(1)</script>";
  const result = await createPortalRenderer(portal).renderPage("/work/");
  assert.match(
    result.html,
    /<title>Work title &nbsp;· Test &lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/,
  );
});

test("metadata-only managed Page Copy renders source scripts and custom templates own landmarks", async (t) => {
  const files = {
    ...standard,
    "web-templates/page-copy/Page-Copy.webtemplate.yml":
      "adx_webtemplateid: managed-copy\nadx_name: Page Copy",
    "web-templates/content/Content.webtemplate.source.html":
      "<div class='page-header'>Header</div><main id='mainContent'>{% include 'Page Copy' %}</main>",
  };
  const portal = await importPortal(await fixture(t, files));
  portal.pages.find((p) => p.url === "/work/").html =
    '<script defer src="/scripts/master.js"></script><p>Source copy</p>';
  const result = await createPortalRenderer(portal).renderPage("/work/");
  assert.match(
    result.html,
    /<script defer src="\/scripts\/master.js"><\/script>/,
  );
  assert.equal((result.html.match(/id=['"]mainContent['"]/g) ?? []).length, 1);
  // The platform layout's <body> carries data-sitemap-state and the DateTime/* attributes.
  assert.match(
    result.html,
    /<body data-sitemap-state="\/work\/:\/"[^>]*>[\s\S]*?<header>Hello<\/header>(?:<div id="antiforgerytoken"[^>]*><\/div>)?(?:<script src="\/resource\/powerappsportal\/dist\/[^"]+"[^>]*><\/script>){6}<div class='page-header'>/,
  );
});

test("inherited DataTable layout treats missing components as nil and preserves blank/empty comparisons", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates["DataTable Tabs"] = {
    source:
      '{% block variables %}{% endblock %}{% for name in panels %}{% if entityForm != null and entityForm != "" %}{% entityform name: entityForm %}{% else %}<table id="{{name}}"></table>{% endif %}{% endfor %}',
  };
  const renderer = createPortalRenderer(portal);
  const html = await renderer.renderString(
    '{% extends "DataTable Tabs" %}{% block variables %}{% assign panels="draft,all"|split:"," %}{% endblock %}',
    {},
  );
  assert.equal(html, '<table id="draft"></table><table id="all"></table>');
  assert.equal(
    await renderer.renderString(
      "{% if missing == nil %}nil{% endif %}{% if values == empty %}empty{% endif %}{% if whitespace == blank %}blank{% endif %}",
      { values: [], whitespace: "  " },
    ),
    "nilemptyblank",
  );
});

test("query filters preserve relative navigation paths and fragment spelling", async (t) => {
  const renderer = createPortalRenderer(
    await importPortal(await fixture(t, standard)),
  );
  assert.equal(
    await renderer.renderString(
      '{{ "itemselection/#step" | add_query: "id", "record" | add_query: "orderId", 1 }}',
      {},
    ),
    "itemselection/?id=record&orderId=1#step",
  );
  assert.equal(
    await renderer.renderString(
      '{{ "../details/?id=record&keep=x#section" | remove_query: "id" }}',
      {},
    ),
    "../details/?keep=x#section",
  );
  assert.equal(
    await renderer.renderString(
      '{{ "https://example.com/path/?id=old" | add_query: "id", "new" }}',
      {},
    ),
    "https://example.com/path/?id=new",
  );
});

test("DotLiquid path split and include variable casing select the authored creation header", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  portal.templates.HeaderFlags = {
    source:
      '{% assign parts=request.path | split:"/" %}{% assign itemSelection=itemSelection %}{% if parts.size == 2 and parts[0] == "requests" and parts[1] == "new" %}<h1>Create new request</h1>{% endif %}<button style="display:{{itemSelection}}">Save</button>',
  };
  const renderer = createPortalRenderer(portal);
  assert.equal(
    await renderer.renderString(
      '{% include "HeaderFlags" itemselection:"none" %}',
      { request: { path: "/requests/new/" } },
    ),
    '<h1>Create new request</h1><button style="display:none">Save</button>',
  );
  assert.equal(
    await renderer.renderString(
      '{% assign Label="first" %}{% assign label="second" %}{{LABEL}} {{ dictionary.NAME }}',
      { dictionary: { Name: "Source name" } },
    ),
    "second Source name",
  );
  assert.equal(
    await renderer.renderString(
      '{{ "" | split:"," | size }} {{ "a,,b," | split:"," | join:"|" }}',
      {},
    ),
    "1 a|b",
  );
});

test("portal params alias includes URL and request-body overrides", async (t) => {
  const portal = await importPortal(await fixture(t, standard));
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(
    portal.pages.find((p) => p.url === "/work/"),
    "/work/?dynamicfilter=nickname",
  );
  assert.equal(
    await renderer.renderString(
      "{{ params.dynamicfilter }}|{{ request.params.dynamicfilter }}",
      context,
    ),
    "nickname|nickname",
  );
  const posted = renderer.contextForPage(portal.pages[0], "/", {
    request: { params: { dynamicfilter: "POST value" } },
  });
  assert.equal(
    await renderer.renderString("{{ params.dynamicfilter }}", posted),
    "POST value",
  );
});

test("URL decoding treats form plus as spaces while preserving encoded plus signs", async (t) => {
  const renderer = createPortalRenderer(
    await importPortal(await fixture(t, standard)),
  );
  assert.equal(
    await renderer.renderString(
      '{{ "%3Csvg+width%3D%2715%27%3E%2B%3C%2Fsvg%3E" | url_decode }}',
    ),
    "<svg width='15'>+</svg>",
  );
});
