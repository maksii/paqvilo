// Power Pages Liquid parity. Expected values follow DotLiquid (master sources at
// SyntaxCompatibility.DotLiquid20), the Adxstudio Liquid layer (MIT ADX sources: Web/Mvc/Liquid,
// Cms/*DataAdapter.cs) and Microsoft Learn vectors; mirage/docs/liquid-parity.md lists the
// source of each decision and the items that still need a live observation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importPortal } from "../lib/importer.mjs";
import { DataError } from "../lib/data-error.mjs";
import { createPortalRenderer } from "../lib/liquid.mjs";
import { FILTER_SIGNATURES, createFilters } from "../lib/liquid-filters.mjs";
import { expressionPaths, inventoryPortal, scanTokens } from "../liquid-inventory.mjs";
import { ciSummary, classifyResponse, idParameterTable, renderSweep, resolveTarget } from "../render-sweep.mjs";

const SITE = "9a4d1c2e-0000-4000-8000-000000000001";
const HOME = "9a4d1c2e-0000-4000-8000-000000000010";
const CHILD = "9a4d1c2e-0000-4000-8000-000000000011";
const MAIN = "9a4d1c2e-0000-4000-8000-000000000020";
const CONTACT = "9a4d1c2e-0000-4000-8000-0000000000c1";
const AD = "9a4d1c2e-0000-4000-8000-0000000000a1";
const AD_PLACEMENT = "9a4d1c2e-0000-4000-8000-0000000000a3";
const POLL = "9a4d1c2e-0000-4000-8000-0000000000b1";
const POLL_PLACEMENT = "9a4d1c2e-0000-4000-8000-0000000000b5";
const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));

const template = (id, name, source) => ({
  [`web-templates/${id}/${name}.webtemplate.yml`]: `adx_webtemplateid: 9a4d1c2e-0000-4000-8000-0000000003${id}\nadx_name: ${name}`,
  [`web-templates/${id}/${name}.webtemplate.source.html`]: source,
});
const files = {
  "website.yml": `adx_websiteid: ${SITE}\nadx_name: Parity\nadx_defaultlanguage: 9a4d1c2e-0000-4000-8000-0000000000aa`,
  "websitelanguage.yml": "- adx_websitelanguageid: 9a4d1c2e-0000-4000-8000-0000000000aa\n  adx_name: English",
  "web-pages/home/Home.webpage.yml": `adx_webpageid: ${HOME}\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: ${MAIN}`,
  "web-pages/child/Child.webpage.yml": `adx_webpageid: ${CHILD}\nadx_name: Child\nadx_title: Child title\nadx_parentpageid: ${HOME}\nadx_partialurl: child\nadx_pagetemplateid: ${MAIN}`,
  "web-pages/child/Child.webpage.copy.html": "<p>{{ page.title }}</p>",
  "page-templates/Main.pagetemplate.yml": `adx_pagetemplateid: ${MAIN}\nadx_name: Main\nadx_usewebsiteheaderandfooter: false\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000301`,
  ...template("01", "Main", "<!doctype html><html><body>{% include 'Page Copy' %}</body></html>"),
  ...template("02", "Row", "{{ label }}"),
  ...template("03", "Layout", "<article>{% block main %}default{% endblock %}</article>"),
  ...template("04", "Child", "{% extends 'Layout' %}{% block main %}{% include 'Row' label: 'Output' %}{% endblock %}"),
  ...template("05", "Broken", "before{% if %}after"),
  ...template("06", "item", "[{{ item }}]"),
  "content-snippets/plain/Plain.contentsnippet.yml": "adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000040\nadx_name: Plain",
  "content-snippets/plain/Plain.contentsnippet.value.html": "Plain <b>text</b>",
  "content-snippets/liquid/Liquid.contentsnippet.yml": "adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000041\nadx_name: Liquid",
  "content-snippets/liquid/Liquid.contentsnippet.value.html": "Sum {{ 1 | plus: 1 }}",
  "sitesetting.yml":
    "- adx_name: Search/Enabled\n  adx_value: 'true'\n- adx_name: Custom/Value\n  adx_value: abc\n- adx_name: DateTime/DateFormat\n  adx_value: dd/MM/yyyy\n- adx_name: DateTime/DateTimeFormat\n  adx_value: dd/MM/yyyy HH:MM",
  "web-pages/grand/Grand.webpage.yml": `adx_webpageid: 9a4d1c2e-0000-4000-8000-000000000012\nadx_name: Grand\nadx_title: Grand title\nadx_parentpageid: ${CHILD}\nadx_partialurl: grand\nadx_pagetemplateid: 9a4d1c2e-0000-4000-8000-000000000021`,
  "web-pages/grand/Grand.webpage.copy.html": "<p>Grand copy</p>",
  "page-templates/Shell.pagetemplate.yml": "adx_pagetemplateid: 9a4d1c2e-0000-4000-8000-000000000021\nadx_name: Shell\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000308",
  ...template("08", "Shell Content", "{% include 'Page Copy' %}"),
  "content-snippets/suffix/Suffix.contentsnippet.yml": "adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000042\nadx_name: Browser Title Suffix",
  "content-snippets/suffix/Suffix.contentsnippet.value.html": "&nbsp;· Parity",
  "content-snippets/self/Self.contentsnippet.yml": "adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000043\nadx_name: Self",
  "content-snippets/self/Self.contentsnippet.value.html": "a{{ snippets['Self'] }}b",
  "sitemarker.yml": `- adx_name: Child Marker\n  adx_pageid: ${CHILD}\n  adx_sitemarkerid: 9a4d1c2e-0000-4000-8000-000000000050`,
  "weblink-sets/nav/Nav.weblinkset.yml": "adx_weblinksetid: 9a4d1c2e-0000-4000-8000-000000000060\nadx_name: Primary Navigation",
  "weblink-sets/nav/Nav.weblinkset.weblink.yml": `- adx_weblinkid: 9a4d1c2e-0000-4000-8000-000000000061\n  adx_name: Child link\n  adx_pageid: ${CHILD}\n  adx_weblinksetid: 9a4d1c2e-0000-4000-8000-000000000060\n  adx_displayorder: 1`,
  "publishingstate.yml":
    "- adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f1\n  adx_name: Published\n  adx_isvisible: true\n- adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f2\n  adx_name: Draft\n  adx_isvisible: false",
  "ad.yml": [
    `- adx_adid: ${AD}`,
    "  adx_name: Visible Ad",
    "  adx_title: Ad title",
    "  adx_copy: <p>Copy</p>",
    "  adx_url: ~/child/",
    "  adx_image: ~/banner.png",
    "  adx_imagealttext: Banner",
    "  adx_imageheight: 50",
    "  adx_imagewidth: 100",
    "  adx_openinnewwindow: true",
    "  adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f1",
    "- adx_adid: 9a4d1c2e-0000-4000-8000-0000000000a2",
    "  adx_name: Draft Ad",
    "  adx_publishingstateid: 9a4d1c2e-0000-4000-8000-0000000000f2",
  ].join("\n"),
  "adplacement.yml": `- adx_adplacementid: ${AD_PLACEMENT}\n  adx_name: Sidebar\n  adx_adplacement_ad:\n  - ${AD}\n  - 9a4d1c2e-0000-4000-8000-0000000000a2`,
  "polls/sample/Sample.poll.yml": `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_submitbuttonlabel: Vote`,
  "polls/sample/Sample.poll.polloption.yml": `- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b2\n  adx_name: Yes\n  adx_answer: Yes\n  adx_pollid: ${POLL}\n  adx_votes: 3\n- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b3\n  adx_name: No\n  adx_answer: No\n  adx_pollid: ${POLL}\n  adx_votes: 1`,
  "polls/old/Old.poll.yml": "adx_pollid: 9a4d1c2e-0000-4000-8000-0000000000b4\nadx_name: Old\nadx_expirationdate: 2020-01-01T00:00:00Z",
  "poll-placements/Sidebar.pollplacement.yml": `adx_pollplacementid: ${POLL_PLACEMENT}\nadx_name: Sidebar\nadx_pollplacement_poll:\n- ${POLL}\n- 9a4d1c2e-0000-4000-8000-0000000000b4`,
};

async function fixturePortal(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "liquid-parity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ ...files, ...extra })) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return importPortal(dir);
}

/** Renderer over the fixture; render(source, extra, url) returns { html, diagnostics }. */
async function setup(t, options = {}, extraFiles = {}) {
  const portal = await fixturePortal(t, extraFiles);
  const renderer = createPortalRenderer(portal, {
    entity: async (table, id) =>
      table === "contact" && id === CONTACT ? { contactid: id, fullname: "Ada", Mixed: "case" } : null,
    ...options,
  });
  const child = portal.pages.find((page) => page.url === "/child/");
  const render = async (source, extra = {}, url = "/child/") => {
    const context = renderer.contextForPage(child, url, { now: NOW, ...extra });
    const html = await renderer.renderString(source, context);
    return { html, diagnostics: context.__diagnostics };
  };
  return { portal, renderer, render, child };
}

/** Plain renderer without a page context. */
function plain() {
  const renderer = createPortalRenderer({ templates: {}, snippets: {}, settings: {}, pages: [], webFiles: [], records: [], weblinks: {}, sitemarkers: {}, website: {}, pageTemplates: [] });
  return (source, data = {}) => renderer.renderString(source, data);
}

test("DotLiquid20 whitespace control trims spaces and tabs before a tag and one newline or blank run after it", async () => {
  const render = plain();
  assert.equal(await render("a  {%- assign x = 1 -%}\n  b"), "a  b");
  assert.equal(await render("x\n{%- if true -%}\ny\n{%- endif -%}\nz"), "x\ny\nz");
  assert.equal(await render("[ {{- 'a' -}} ]"), "[a]");
  assert.equal(await render("a\t {%- if true %}b{% endif -%}  \n c"), "ab\n c");
});

test("tags and outputs are single-line regex tokens and extra filter words are ignored", async () => {
  const render = plain();
  assert.equal(
    await render('{% assign v = "a\nb" %}{{ v }}'),
    "Tag '{% assign v = \"a\nb\" %}' was not properly terminated with regexp: (?-mix:\\%\\})",
  );
  assert.equal(await render("{{ 'x' | upcase downcase }}"), "X");
  // A quoted fragment wins over a member path: 'abc'.size renders the string.
  assert.equal(await render("{{ 'abc'.size }}|{{ s.size }}", { s: "hello" }), "abc|5");
  // `!x` is a variable name, not negation.
  assert.equal(await render("{% if !true %}y{% else %}n{% endif %}{% if !false %}y{% else %}n{% endif %}"), "nn");
});

test("and/or group right to left without precedence and comparisons convert the right operand", async () => {
  const render = plain();
  assert.equal(await render("{% if true or false and false %}y{% else %}n{% endif %}"), "y");
  assert.equal(await render("{% if false and false or true %}y{% else %}n{% endif %}"), "n");
  // Convert.ChangeType(right, left.GetType()); strings compare as strings.
  assert.equal(
    await render(
      "{% if '10' > 9 %}y{% else %}n{% endif %}{% if 10 > '9' %}y{% else %}n{% endif %}{% if 1 == '1' %}y{% else %}n{% endif %}{% if '1' == 1 %}y{% else %}n{% endif %}{% if 1 == 1.0 %}y{% else %}n{% endif %}",
    ),
    "nyyyy",
  );
  assert.equal(
    await render("{% if 'abc' contains 'b' %}a{% endif %}{% if list contains 2 %}b{% endif %}{% if 'abc' startswith 'a' %}c{% endif %}{% if list endswith 3 %}d{% endif %}", {
      list: [1, 2, 3],
    }),
    "abcd",
  );
  assert.equal(
    await render("{% if 'abc' contains 1 %}y{% endif %}"),
    "Liquid error: Unable to cast object of type 'System.Int32' to type 'System.String'.",
  );
});

test("empty and blank are DotLiquid symbols with master semantics and render as their type name", async () => {
  const render = plain();
  assert.equal(
    await render(
      "{% if '' == empty %}a{% endif %}{% if nil == empty %}b{% endif %}{% if '  ' == blank %}c{% endif %}{% if nil == blank %}d{% endif %}{% if false == blank %}e{% endif %}{% if list == empty %}f{% endif %}",
      { list: [1] },
    ),
    "acde",
  );
  assert.equal(await render("{{ empty }}|{% assign a = blank %}{{ a }}"), "DotLiquid.Util.Symbol|DotLiquid.Util.Symbol");
  // `user.roles | default: empty` for an anonymous user hands the symbol to join.
  assert.equal(
    await render("{%- assign roles = user.roles | default: empty -%}{{ roles | join: ',' }}"),
    "Liquid error: Object of type 'DotLiquid.Util.Symbol' cannot be converted to type 'System.Collections.IEnumerable'.",
  );
});

test("if/elsif/elseif/unless/case follow DotLiquid block rules", async () => {
  const render = plain();
  assert.equal(await render("{% if false %}a{% elsif true %}b{% endif %}{% if false %}a{% elseif true %}c{% endif %}"), "bc");
  // If ignores markup after else; case rejects it.
  assert.equal(await render("{% if false %}a{% else if false %}b{% endif %}"), "b");
  assert.equal(
    await render("{% case 1 %}{% when 2 %}x{% else foo %}y{% endcase %}"),
    "Syntax Error in 'case' tag - Valid else condition: {% else %} (no parameters)",
  );
  assert.equal(
    await render("{% case 2 %}{% when 1 or 2 %}x{% endcase %}{% case 2 %}{% when 3, 2 %}y{% endcase %}{% case 5 %}{% when 1 %}a{% else %}z{% endcase %}"),
    "xyz",
  );
  assert.equal(await render("{% unless false %}u{% else %}v{% endunless %}"), "u");
});

test("for loops support limit, offset, reversed, variable ranges, else, forloop, break and continue", async () => {
  const render = plain();
  assert.equal(
    await render("{% for i in (1..5) limit: 2 offset: 1 %}{{ i }}{% endfor %}|{% for i in (1..3) reversed %}{{ i }}{% endfor %}|{% for i in missing %}x{% else %}none{% endfor %}"),
    "23|321|none",
  );
  assert.equal(await render("{% assign n = 3 %}{% for i in (1..n) %}{{ i }}{% endfor %}"), "123");
  assert.equal(
    await render("{% for i in (1..3) %}{{ forloop.index }}{{ forloop.index0 }}{{ forloop.rindex }}{{ forloop.rindex0 }}{{ forloop.first }}{{ forloop.last }}{{ forloop.length }},{% endfor %}"),
    "1032truefalse3,2121falsefalse3,3210falsetrue3,",
  );
  assert.equal(
    await render("{% for i in (1..5) %}{% if i == 2 %}{% continue %}{% endif %}{% if i == 4 %}{% break %}{% endif %}{{ i }}{% endfor %}"),
    "13",
  );
  assert.equal(await render("{% for i in (1..2) %}{% else whatever %}{% endfor %}{% for i in none %}{% else whatever %}e{% endfor %}"), "e");
});

test("cycle, tablerow, increment and decrement keep DotLiquid output", async () => {
  const render = plain();
  assert.equal(await render("{% for i in (1..4) %}{% cycle 'a', 'b', 'c' %}{% endfor %}|{% cycle 'g': 'x', 'y' %}{% cycle 'g': 'x', 'y' %}"), "abca|xy");
  // TableRow uses TextWriter.WriteLine (CRLF on the Windows host).
  assert.equal(
    await render("{% tablerow i in (1..3) cols: 2 %}{{ i }}{{ tablerowloop.col }}{{ tablerowloop.col_last }}{% endtablerow %}"),
    '<tr class="row1">\r\n<td class="col1">11false</td><td class="col2">22true</td></tr>\r\n<tr class="row2"><td class="col1">31false</td></tr>\r\n',
  );
  assert.equal(await render("{% increment c %}{% increment c %}{% decrement d %}{% decrement d %}|{{ c }}"), "01-1-2|2");
});

test("capture, raw, comment and member-path assignment", async (t) => {
  const render = plain();
  assert.equal(await render("{% capture x %}a{{ 1 }}{% endcapture %}{{ x }}|{% raw %}{{ x }}{% endraw %}|{% comment %}hidden{% endcomment %}"), "a1|{{ x }}|");
  const { render: pageRender } = await setup(t);
  // Assign creates a variable literally named "page.title"; the page drop is unchanged.
  assert.equal((await pageRender("{% assign page.title = 'Changed' %}{{ page.title }}|{{ ['page.title'] }}")).html, "Child title|Changed");
  // Variable names are case-insensitive (Adxstudio InvariantCultureNamingConvention).
  assert.equal((await pageRender("{{ PAGE.title }}|{% assign Foo = 1 %}{{ foo }}")).html, "Child title|1");
});

test("string and escape filters match .NET encoders", async () => {
  const render = plain();
  assert.equal(await render("{{ s | escape }}|{{ s | h }}", { s: `<p>é & "'</p>` }), "&lt;p&gt;&#233; &amp; &quot;&#39;&lt;/p&gt;|&lt;p&gt;&#233; &amp; &quot;&#39;&lt;/p&gt;");
  assert.equal(await render("{{ s | url_escape }}|{{ s | url_encode }}", { s: "This & that//" }), "This+%26+that%2F%2F|This+%26+that%2F%2F");
  assert.equal(await render("{{ s | xml_escape }}", { s: `<a href="x">'&` }), "&lt;a href=&quot;x&quot;&gt;&apos;&amp;");
  assert.equal(await render("{{ s | escape_once }}", { s: "1 &lt; 2 & 3" }), "1 &lt; 2 &amp; 3");
  assert.equal(await render("{{ 'a b' | url_encode }}|{{ 'a+b%20c' | url_decode }}"), "a+b|a b c");
  assert.equal(await render("{{ 'capitalize me' | capitalize }}|{{ 'élan' | upcase }}"), "Capitalize Me|ÉLAN");
  assert.equal(await render("{{ s | truncate: 10 }}|{{ s | truncate_words: 2 }}", { s: "This is a long sentence" }), "This is...|This is...");
  assert.equal(await render("{{ s | split: ',' | size }}|{{ s | split: ',' | join: '|' }}", { s: "a,b,,c" }), "3|a|b|c");
  assert.equal(await render("{{ s | strip_newlines }}|{{ s | newline_to_br }}", { s: "a\nb\r\nc" }), "abc|a<br />\nb<br />\r\nc");
  assert.equal(await render("{{ s | strip_html }}", { s: "<p>Hello <b>World</b></p><script>x</script>" }), "Hello World");
  assert.equal(
    await render("{{ s | text_to_html }}", { s: "Line one\nLine two\n\nhttp://example.com x" }),
    '<p>Line one<br />Line two</p><p><a href="http://example.com/" rel="nofollow">http://example.com/</a> x</p>',
  );
  assert.equal(await render("{{ s | html_safe_escape }}", { s: '<img src="images/myimage.jpg" onerror="alert(1);">' }), '<img src="images/myimage.jpg">');
  assert.equal(await render("{{ s | html_safe_escape }}", { s: '<p onclick="x()">ok<script>bad()</script></p>' }), "<p>ok</p>");
  // DotLiquid20 replace/replace_first use .NET regular expressions.
  assert.equal(await render("{{ 'a.b' | replace: '.', '-' }}|{{ 'a.b' | replace_first: '.', '-' }}|{{ 'aXbX' | remove: 'X' }}|{{ 'aXbX' | remove_first: 'X' }}"), "---|-.b|ab|abX");
  assert.equal(await render("{{ 'a(b' | replace: '(', '[' }}"), `Liquid error: parsing "(" - Not enough )'s.`);
  assert.equal(await render("{{ 'x' | slice: 0 }}|{{ 'abc' | slice: 1, 2 }}|{{ 'a' | append: 'b' }}|{{ 'a' | prepend: 'b' }}"), "x|bc|ab|ba");
});

test("math filters promote real operands to decimal, divide integers, round to even and format decimals without trailing zeros", async () => {
  const render = plain();
  // DotLiquid >= 2.1 DoMathsOperation (Microsoft Learn still lists the 2.0 truncating vectors).
  assert.equal(await render("{{ 10 | plus: 1.1 }}|{{ 10 | minus: 1.1 }}|{{ 10 | times: 2.2 }}"), "11.1|8.9|22");
  assert.equal(await render("{{ 10 | divided_by: 3 }}|{{ 10.0 | divided_by: 3 }}|{{ 10 | modulo: 3 }}|{{ 5 | divided_by: 2.0 }}"), "3|3.3333333333333333333333333333|1|2.5");
  assert.equal(await render("{{ 1 | divided_by: 0 }}"), "Liquid error: Attempted to divide by zero.");
  assert.equal(await render("{{ 4.5612 | round: 2 }}|{{ 2.5 | round }}|{{ 3.5 | round }}|{{ 2.675 | round: 2 }}|{{ nil | round }}"), "4.56|2|4|2.68|0");
  // Adxstudio MathFilters.Ceil/Floor return int; nil is 0.
  assert.equal(await render("{{ 1.2 | ceil }}|{{ 1.8 | floor }}|{{ '3.7' | floor }}|{{ nil | ceil }}"), "2|1|3|0");
  assert.equal(await render("{{ 1.50 }}|{{ 12.5 | times: 10 }}|{{ 0.1 | plus: 0.2 }}"), "1.5|125|0.3");
  // Plus concatenates string input; other mismatches raise the expression error.
  assert.equal(await render("{{ '1' | plus: 1 }}|{{ 1 | plus: 'a' }}"), "11|Liquid error: The binary operator Add is not defined for the types 'System.Int32' and 'System.String'.");
  assert.equal(await render("{{ -5 | abs }}|{{ 5 | at_least: 7 }}|{{ 5 | at_most: 3 }}"), "5|7|3");
});

test("type, number-format and additional filters follow Adxstudio", async (t) => {
  const render = plain();
  assert.equal(await render("{{ 'on' | boolean }}|{{ 'no' | boolean }}|{{ 'x' | boolean }}|{{ 'enabled' | boolean }}|{{ 'disabled' | boolean }}"), "true|false||true|false");
  assert.equal(await render("{{ '10.1' | integer }}|{{ '10' | integer }}|{{ '1.50' | decimal }}|{{ 5 | string }}"), "|10|1.5|5");
  assert.equal(await render("[{{ '' | default: 'x' }}]|[{{ nil | default: 'x' }}]|[{{ false | default: 'x' }}]"), "[]|[x]|[false]");
  assert.equal(await render("{{ n | file_size }}|{{ n | file_size: 2 }}|{{ 2050 | file_size: 0 }}", { n: 10000000 }), "9.5 MB|9.54 MB|2 KB");
  assert.equal(
    await render("{{ 1234.5678 | decimals: 2 }}|{{ 1234.5 | max_decimals: 2 }}|{{ 1234.5678 | invariant_culture_decimal_value: 2 }}|{{ 1234.5 | format: 'N2' }}"),
    "1,234.57|1,234.5|1234.57|1,234.50",
  );
  const { render: pageRender } = await setup(t);
  const user = { id: CONTACT, contactid: CONTACT, fullname: "Ada", roles: ["Editors"] };
  assert.equal((await pageRender("{{ user | has_role: 'Editors' }}|{{ user | has_role: 'Admins' }}", { user })).html, "true|false");
  assert.equal((await pageRender("{% assign code = '{{ page.title }}' %}{{ code | liquid }}")).html, "Child title");
});

test("date filters use en-US .NET formats on UTC values", async () => {
  const render = plain();
  assert.equal(
    await render("{{ now }}|{{ now | date: 'g' }}|{{ now | date: 'MMMM dd, yyyy' }}|{{ now | date_add_days: 1.5 | date_to_iso8601 }}|{{ now | date_to_rfc822 }}", { now: NOW }),
    "1/2/2026 3:04:05 AM|1/2/2026 3:04 AM|January 02, 2026|2026-01-03T15:04:05Z|Fri, 02 Jan 2026 03:04:05 Z",
  );
  const d = new Date(Date.UTC(2024, 0, 31, 13, 5, 0));
  assert.equal(await render("{{ d | date_add_months: 1 | date: 'd' }}|{{ d | date_add_years: -1 | date: 'yyyy' }}", { d }), "2/29/2024|2023");
  assert.equal(await render("{{ s | date: 'yyyy' }}|{{ 'garbage' | date: 'yyyy' }}", { s: "2024-05-07T07:20:46Z" }), "2024|garbage");
});

test("URL filters keep absolute and relative forms", async () => {
  const render = plain();
  assert.equal(
    await render("{{ 'https://example.com/path?page=1' | add_query: 'foo', 'bar' }}|{{ '/path?page=1' | add_query: 'page', 2 }}|{{ 'https://example.com/path?foo=bar&page=2' | remove_query: 'page' }}"),
    "https://example.com/path?page=1&foo=bar|/path?page=2|https://example.com/path?foo=bar",
  );
  // A relative URL keeps its own path text and fragment.
  assert.equal(await render("{{ 'path?a=1#f' | add_query: 'b', 2 }}|{{ '../next/?id=1' | add_query: 'tab', 'x' }}"), "path?a=1&b=2#f|../next/?id=1&tab=x");
  assert.equal(
    await render("{{ u | base }}|{{ u | host }}|{{ u | path }}|{{ '/path?foo=bar&page=2' | path_and_query }}|{{ u | port }}|{{ u | scheme }}", {
      u: "https://example.com/path?foo=bar&page=2",
    }),
    "https://example.com|example.com|/path|/path?foo=bar&page=2|443|https",
  );
});

test("array filters", async () => {
  const render = plain();
  const list = [{ a: 1, b: "x" }, { a: 2, b: "x" }, { a: 3, b: "y" }];
  // EnumerableFilters.where compares with object.Equals (no conversion).
  assert.equal(
    await render("{{ list | where: 'a', 1 | size }}|{{ list | where: 'a', '1' | size }}|{{ list | order_by: 'a', 'desc' | map: 'a' | join: ',' }}|{{ list | group_by: 'b' | size }}|{{ list | select: 'a' | join: ',' }}", { list }),
    "1|0|3,2,1|2|1,2,3",
  );
  assert.equal(await render("{{ l | batch: 2 | size }}|{{ l | skip: 1 | take: 1 | first }}|{{ l | concat: m | size }}|{{ l | reverse | join: '' }}", { l: [1, 2, 3], m: [4] }), "2|2|4|321");
  assert.equal(await render("{{ a | uniq | join: '' }}|{{ a | compact | size }}", { a: ["b", "a", "b", null] }), "ba|3");
  assert.equal(await render("{{ 'abc' | size }}|{{ l | size }}|{{ l | first }}|{{ l | last }}|{{ 'abc' | first }}|{{ l.first }}|{{ l.last }}|{{ l.size }}", { l: [1, 2, 3] }), "3|3|1|3|a|1|3|3");
});

test("unknown filters return their input unchanged and are reported", async (t) => {
  const { render } = await setup(t);
  const result = await render("{{ '{\"a\":1}' | json_parse }}|{{ 1.5 | number }}|{{ now | date_to_is08601 }}|{{ 'r' | raw }}");
  assert.equal(result.html, '{"a":1}|1.5|1/2/2026 3:04:05 AM|r');
  assert.deepEqual(
    result.diagnostics.filter((d) => d.code === "liquid-unknown-filter").map((d) => d.filter).sort(),
    ["date_to_is08601", "json_parse", "number", "raw"],
  );
});

test("json writes request values verbatim and serialises other values like the local filter contract", async (t) => {
  const render = plain();
  const { render: page } = await setup(t);
  const echo = async (value) =>
    (await page("{{ request.params['page'] | default: 1 | json }}", {}, value === undefined ? "/child/" : `/child/?page=${encodeURIComponent(value)}`)).html;
  const inputs = ["-", " - ", " ", '"-"', '"" ""', "1.50", "[]", "true"];
  const outputs = [];
  for (const input of inputs) outputs.push(await echo(input));
  assert.deepEqual(outputs, ["-", " - ", " ", "&quot;-&quot;", "&quot;&quot; &quot;&quot;", "1.50", "[]", "true"]);
  assert.deepEqual([await echo("01"), await echo("1"), await echo(undefined)], ["01", "1", "1"]);
  const reports = [
    "{%- capture info -%}",
    "  {%- if id -%}",
    "    {% for item in items %}",
    "      {%- if item.id == id -%}",
    "        {{ item.info }}",
    "      {%- endif -%}",
    "    {% endfor %}",
    "  {%- endif -%}",
    "{%- endcapture -%}",
    "const headerHtml = {{ info | default: '' | json  }};",
  ].join("\r\n");
  assert.equal(await render(reports, { id: "00000000-0000-0000-0000-000000000000", items: [{ id: "a", info: "x" }, { id: "b", info: "y" }] }), 'const headerHtml = "";');
  assert.equal(await render("const headerHtml = {{ info | default: '' | json }};", { info: '    " "\r\n' }), 'const headerHtml = "" "";');
  assert.equal(await render("{{ info | json }}", { info: '        `a\n\t"b"\n`\r\n' }), '"`a\n\t"b"\n`"');
  assert.equal(await render("[{{ s | json }}]|[{{ e | json }}]|[{{ q | json }}]", { s: " \r\n\t", e: "", q: ' a"b ' }), '[""]|[""]|["a"b"]');
  // Booleans, numbers, nil, arrays, hashes and dates keep the Json.NET-style serialisation.
  assert.equal(await render("{{ t | json }}|{{ f | json }}|{{ nil | json }}|{{ 1.5 | json }}", { t: true, f: false }), "true|false|null|1.5");
  assert.equal(
    await render("{{ list | json }}|{{ hash | json }}|{{ d | json }}", { list: [1, "a", null], hash: { a: 1, b: [true] }, d: new Date(Date.UTC(2024, 4, 7, 7, 20, 46)) }),
    '[1,"a",null]|{"a":1,"b":[true]}|"2024-05-07T07:20:46Z"',
  );
  const loop = { name: "x" };
  loop.self = loop;
  assert.equal(await render("{{ v | json }}", { v: loop }), "Liquid error: Self referencing loop detected for property 'self'.");
});

test("split follows DotLiquid StandardFilters.Split", async () => {
  const render = plain();
  // IsNullOrWhiteSpace(input) ? new[] { input } : input.Split(pattern, RemoveEmptyEntries)
  assert.equal(await render("{{ '' | split: ',' | size }}|{{ nil | split: ',' | size }}|{{ ' ' | split: ',' | size }}"), "1|1|1");
  assert.equal(await render("{{ 'abc' | split: ',' | size }}|{{ 'abc' | split: ',' | first }}|{{ 'a,,b,' | split: ',' | join: '|' }}"), "1|abc|a|b");
  assert.equal(await render("{% assign parts = v | split: ',' %}{% for p in parts %}[{{ p }}]{% endfor %}", { v: null }), "[]");
});

test("filter arguments follow the Strainer: a missing parameter without a default and surplus arguments raise inline errors", async () => {
  const render = plain();
  // Strainer.Invoke fills the widest overload with default values: a parameter without one raises
  // a SyntaxException naming it, and surplus arguments make MethodInfo.Invoke throw.
  assert.equal(await render("{{ 'a' | append }}"), "Liquid syntax error: Error - Filter 'append' does not have a default value for 'string' and no value was supplied");
  assert.equal(await render("{{ 'a' | append: 'b', 'c' }}|{{ -3 | abs: 1 }}"), "Liquid error: Parameter count mismatch.|Liquid error: Parameter count mismatch.");
  assert.equal(await render("{{ now | date }}", { now: NOW }), "Liquid syntax error: Error - Filter 'date' does not have a default value for 'format' and no value was supplied");
  // Adxstudio signatures replace DotLiquid's: where(input, key, value) needs a value and
  // default(input, default) takes no allow_false argument.
  assert.equal(await render("{{ l | where: 'a' }}", { l: [] }), "Liquid syntax error: Error - Filter 'where' does not have a default value for 'value' and no value was supplied");
  assert.equal(await render("{{ false | default: 'bar', allow_false: true }}"), "Liquid error: Parameter count mismatch.");
  // An Adxstudio overload with another parameter count is added next to DotLiquid's
  // currency(input, languageTag = null); one argument selects the widest, which needs a record.
  assert.equal(await render("{{ 5 | currency }}"), "Liquid syntax error: Error - Filter 'currency' does not have a default value for 'record' and no value was supplied");
  // Parameters with defaults may be omitted; filters without a known signature are not checked.
  assert.equal(await render("{{ 'hello world' | truncate }}|{{ 5.6 | round }}|{{ 'a' | json: 1 }}|{{ 'a' | missing_filter: 1, 2 }}"), 'hello world|6|"a"|a');
});

test("the Strainer signature table covers the filter catalogue", () => {
  const catalogue = Object.keys(createFilters({}));
  // json and html_safe_escape are Power Pages filters without a published signature.
  assert.deepEqual(catalogue.filter((name) => !Object.hasOwn(FILTER_SIGNATURES, name)).sort(), ["html_safe_escape", "json"]);
  assert.deepEqual(Object.keys(FILTER_SIGNATURES).filter((name) => !catalogue.includes(name)), []);
});

test("capture names, root brackets, nil string operands, sort comparison and round digits follow DotLiquid master and Adxstudio", async () => {
  const render = plain();
  // Capture names match \A\s*([\w-]+)\s*\Z; anything else is a syntax error.
  assert.equal(await render("{% capture foo-a %}x{% endcapture %}{{ foo-a }}"), "x");
  assert.equal(await render("a{% capture foo bar %}x{% endcapture %}b"), "Syntax Error in 'capture' tag - Valid syntax: capture [var]");
  // Context.TryGetVariable calls Resolve(...).ToString() on a root bracket, which throws for nil.
  assert.equal(await render("{{ [missing] }}|{{ ['x'] }}|{{ [name] }}", { x: 1, name: "x" }), "Liquid error: Object reference not set to an instance of an object.|1|1");
  // Append and prepend interpolate their operands: $"{input}{@string}".
  assert.equal(await render("{{ nil | append: 'b' }}|{{ nil | prepend: 'a' }}"), "b|a");
  // Sort compares with StringComparer.OrdinalIgnoreCase at DotLiquid20: characters of a string
  // ordinally, strings without case, and values that are not IComparable fail.
  assert.equal(await render("{{ 'BzAa4' | sort | join: '' }}|{{ l | sort | join: '' }}|{{ l | sort_natural | join: '' }}", { l: ["b", "A", "a", "B"] }), "4ABaz|AabB|AabB");
  assert.equal(await render("{{ h | sort }}", { h: [{ a: 1 }, { a: 2 }] }), "Liquid error: Failed to compare two elements in the array.");
  assert.equal(await render("{{ h | sort: 'a' | map: 'a' | join: ',' }}", { h: [{ a: 2 }, { a: 1 }] }), "1,2");
  // Adxstudio round: Math.Round(decimal, decimals) accepts 0 to 28 digits.
  assert.equal(await render("{{ 5.666 | round: 2 }}|{{ 5.666 | round: 28 }}"), "5.67|5.666");
  assert.equal(await render("{{ 5.666 | round: -1 }}"), "Liquid error: Decimal can only round to between 0 and 28 digits of precision.\r\nParameter name: decimals");
});

test("errors render inline, parse failures render their bare message and missing templates render the platform text", async (t) => {
  const { render, renderer, portal } = await setup(t);
  let result = await render("a{{ 1 | divided_by: 0 }}b");
  assert.equal(result.html, "aLiquid error: Attempted to divide by zero.b");
  assert.equal(result.diagnostics[0].code, "liquid-error");
  result = await render("a{% nosuch %}b");
  assert.equal(result.html, "Unknown tag 'nosuch'");
  assert.equal(result.diagnostics[0].code, "liquid-syntax-error");
  result = await render("<{% include 'Broken' %}>");
  assert.match(result.html, /^<Liquid syntax error: .+>$/);
  result = await render("<{% include 'Nope' %}>");
  assert.equal(result.html, '<Template "Nope" not found.>');
  assert.equal(result.diagnostics[0].code, "liquid-template-not-found");
  // A failing page template still answers 200 with the rendered text.
  portal.templates[portal.pageTemplates[0].webTemplateId].source = "<!doctype html><html><body>{% nosuch %}</body></html>";
  const page = await renderer.renderPage("/child/");
  assert.equal(page.status, 200);
  assert.equal(page.html, "Unknown tag 'nosuch'");
});

test("include, extends and block resolve web templates by case-insensitive name before runtime templates", async (t) => {
  const { render } = await setup(t);
  assert.equal((await render("{% include 'Child' %}")).html, "<article>Output</article>");
  assert.equal((await render("{% include 'row' label: 'B' %}|[{{ label }}]")).html, "B|[]");
  assert.equal((await render("{% include 'item' for list %}", { list: [1, 2, 3] })).html, "[1][2][3]");
  assert.equal((await render("{% include 'item' with 'x' %}")).html, "[x]");
  // The page copy include uses the runtime page_copy template (editable markup for non-editors;
  // TagBuilder class attribute through the AntiXSS attribute encoder).
  assert.equal(
    (await render("{% include 'page_copy' %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute&#32;page-copy"><div class="xrm-attribute-value"><p>Child title</p></div></div>',
  );
});

test("page, sitemap, weblinks, sitemarkers, settings and snippets objects", async (t) => {
  const { render } = await setup(t);
  assert.equal(
    (await render("{{ page.title }}|{{ page.url }}|{{ page.parent.title }}|{{ page.breadcrumbs.size }}|{{ page.id }}|{{ page.adx_name }}|[{{ page.ADX_NAME }}]")).html,
    `Child title|/child/|Home|1|${CHILD}|Child|[]`,
  );
  assert.equal((await render("{{ sitemap.current.title }}|{{ sitemap.root.title }}|{{ sitemap.root.children.size }}|{{ sitemap['/child/'].title }}")).html, "Child title|Home|1|Child title");
  assert.equal(
    (await render("{{ weblinks['Primary Navigation'].weblinks.size }}|{{ weblinks['Primary Navigation'].weblinks[0].name }}|{{ weblinks['Primary Navigation'].weblinks[0].url }}")).html,
    "1|Child link|/child/",
  );
  assert.equal((await render("{{ sitemarkers['Child Marker'].url }}|[{{ sitemarkers['Nope'] }}]")).html, "/child/|[]");
  assert.equal((await render("{{ settings['Search/Enabled'] }}|{{ settings['Custom/Value'] }}|[{{ settings['Missing'] }}]")).html, "true|abc|[]");
  // Snippet values are rendered as Liquid in the current context (Microsoft Learn: content snippets).
  assert.equal((await render("{{ snippets['Plain'] }}|{{ snippets.Liquid }}|[{{ snippets['Missing'] }}]")).html, "Plain <b>text</b>|Sum 2|[]");
  assert.equal((await render("{{ page }}|{{ website }}")).html, "|");
  // Snippet values are rendered on access; a snippet that includes itself stops with an inline error.
  assert.equal((await render("{{ snippets['Self'] }}")).html, "aLiquid error: Recursive content snippet Selfb");
});

test("the managed Page Copy template nests the editable wrapper and the layout carries the platform body attributes", async (t) => {
  const { render, renderer } = await setup(t);
  const copy = await render("{% include 'Page Copy' %}");
  assert.equal(
    copy.html,
    '<div class="page-copy"><div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Child title</p></div></div></div>',
  );
  assert.ok(copy.diagnostics.some((d) => d.code === "liquid-managed-template-source"));
  const page = await renderer.renderPage("/child/grand/");
  assert.equal(page.status, 200);
  assert.ok(page.html.includes("<title>Grand title &nbsp;· Parity</title>"));
  assert.ok(
    page.html.includes(
      '<body data-sitemap-state="/child/grand/:/child/:/" data-dateformat="dd/MM/yyyy" data-timeformat="h:mm tt" data-datetimeformat="dd/MM/yyyy HH:MM" data-app-path="/" data-ckeditor-basepath="/js/BaseHtmlContentDesigner/Libs/msdyncrm_/libs/ckeditor/" data-case-deflection-url="/_services/search/' +
        SITE +
        '">',
    ),
  );
  assert.ok(page.html.includes('<div class="page-copy"><div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Grand copy</p>'));
});

test("request, params, website, user and now objects with default HTML encoding of user and request", async (t) => {
  const { render } = await setup(t);
  const url = "/child/?q=%3Cb%3E&x=1";
  let result = await render("{{ request.path }}|{{ request.path_and_query }}|{{ request.query }}|{{ request.params.q }}|{{ request.params['q'] | escape }}|{{ request.params.size }}|{{ params.x }}", {}, url);
  assert.equal(result.html, "/child/|/child/?q=%3Cb%3E&amp;x=1|?q=%3Cb%3E&amp;x=1|&lt;b&gt;|&lt;b&gt;|2|1");
  assert.equal((await render("{% if user %}signed{% else %}anon{% endif %}")).html, "anon");
  const user = { id: CONTACT, contactid: CONTACT, fullname: "Ada <Lovelace>", roles: ["Authenticated Users", "Editors"] };
  result = await render("{{ user.fullname }}|{{ user.fullname | escape }}|{{ user.roles | join: ',' }}|{% if user.roles contains 'Editors' %}e{% endif %}", { user });
  assert.equal(result.html, "Ada &lt;Lovelace&gt;|Ada &lt;Lovelace&gt;|Authenticated Users,Editors|e");
  assert.equal(
    (await render("{{ website.name }}|{{ website.sign_in_url }}|{{ website.sign_out_url }}|{{ website.id }}")).html,
    `Parity|/SignIn?returnUrl=%2Fchild%2F|/Account/Login/LogOff?returnUrl=%2Fchild%2F|${SITE}`,
  );
  assert.equal((await render("{{ now | date: 'yyyy-MM-dd' }}")).html, "2026-01-02");
  // Site/EnableDefaultHtmlEncoding = false restores raw output.
  const unencoded = await setup(t, {}, { "sitesetting.yml": "- adx_name: Site/EnableDefaultHtmlEncoding\n  adx_value: 'false'" });
  assert.equal((await unencoded.render("{{ request.params.q }}", {}, url)).html, "<b>");
});

test("entities load records by GUID; attribute names are exact and drop properties are not", async (t) => {
  const { render } = await setup(t);
  const result = await render(
    `{% assign c = entities.contact['${CONTACT}'] %}{{ c.fullname }}|{{ c.Mixed }}|[{{ c.mixed }}]|{{ c.ID }}|{{ c.logical_name }}|{{ entities['contact']['{${CONTACT.toUpperCase()}}'].fullname }}|[{{ entities.contact['missing'].fullname }}]`,
  );
  assert.equal(result.html, `Ada|case|[]|${CONTACT}|contact|Ada|[]`);
  assert.deepEqual(result.diagnostics, []);
});

test("simulator infrastructure errors abort the render; Liquid and Dataverse errors render inline", async (t) => {
  const LIVE = "9a4d1c2e-0000-4000-8000-0000000000d1";
  const DENIED = "9a4d1c2e-0000-4000-8000-0000000000d2";
  const { render, renderer, portal } = await setup(t, {
    entity: async (table, id) => {
      if (id === LIVE) throw Object.assign(new Error("Live data read returned HTTP 403."), { status: 403, code: "LIVE_BRIDGE" });
      if (id === DENIED) throw new DataError("Read permission denied", 403, "PermissionDenied");
      return null;
    },
    fetchXml: async () => {
      throw new DataError("FetchXML condition requires attribute", 400, "InvalidFetchXml");
    },
    renderComponent: async () => {
      throw Object.assign(new Error("Component entityform 'x' requires a form/view schema."), { status: 501, code: "COMPONENT_SCHEMA_REQUIRED" });
    },
  });
  // Table permissions: a record the user cannot read is nil (EntitySetDrop).
  assert.equal((await render(`[{{ entities.contact['${DENIED}'].fullname }}]`)).html, "[]");
  // Dataverse faults keep DotLiquid's inline rendering.
  assert.equal((await render("{% fetchxml q %}<fetch><entity name='contact'/></fetch>{% endfetchxml %}after")).html, "Liquid error: FetchXML condition requires attributeafter");
  await assert.rejects(render(`{{ entities.contact['${LIVE}'].fullname }}`), (error) => error.code === "LIVE_BRIDGE");
  await assert.rejects(render("{% entityform name: 'x' %}"), (error) => error.code === "COMPONENT_SCHEMA_REQUIRED");
  // renderPage turns the propagated failure into the page status.
  portal.templates[portal.pageTemplates[0].webTemplateId].source = `<!doctype html><html><body>{{ entities.contact['${LIVE}'].fullname }}</body></html>`;
  const page = await renderer.renderPage("/child/");
  assert.equal(page.status, 403);
  assert.match(page.html, /Live data read returned HTTP 403/);
});

test("polls and ads objects follow the Adxstudio data adapters", async (t) => {
  const { render } = await setup(t);
  assert.equal(
    (await render("{% assign ad = ads['Visible Ad'] %}{{ ad.title }}|{{ ad.redirect_url }}|{{ ad.image.url }}|{{ ad.image.alternate_text }}|{{ ad.image.height }}|{{ ad.open_in_new_window }}|{{ ad.copy }}|{{ ad.adx_name }}|{{ ad.logical_name }}|{{ ad.ad_url }}")).html,
    `Ad title|/child/|/banner.png|Banner|50|true|<p>Copy</p>|Visible Ad|adx_ad|/_services/ads/${SITE}/${AD}`,
  );
  // Hidden publishing states are filtered out; placements list only accepted ads.
  assert.equal((await render("[{{ ads['Draft Ad'] }}]|{{ ads.placements['Sidebar'].ads.size }}|{{ ads.placements.Sidebar.random_url }}")).html, `[]|1|/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random`);
  assert.equal(
    (await render("{% assign poll = polls['Sample'] %}{{ poll.question }}|{{ poll.submit_button_label }}|{{ poll.votes }}|{% for o in poll.options %}{{ o.answer }}:{{ o.votes }}:{{ o.percentage }};{% endfor %}|{{ poll.has_user_voted }}|{{ poll.submit_url }}")).html,
    `Which?|Vote|4|Yes:3:75;No:1:25;|false|/_services/polls/${SITE}/SubmitPoll?id=${POLL}`,
  );
  // Expired polls are not selectable, by name or through a placement.
  assert.equal(
    (await render("[{{ polls['Old'] }}]|{{ polls.placements['Sidebar'].polls.size }}|{{ polls.placements[id].random_url }}", { id: POLL_PLACEMENT })).html,
    `[]|1|/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random`,
  );
});

test("ad and poll services render one placement item with its web template or the MasterPortal view template", async (t) => {
  const squash = (html) => html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  const { render } = await setup(t);
  // The embedded ad and poll templates render the placeholders that the services fill.
  assert.equal(
    squash((await render("{% include 'ad' ad_placement_name: 'Sidebar' %}{% include 'poll' poll_placement_name: 'Sidebar' %}")).html),
    `<div class="ad" data-url="/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random"></div>` +
      `<div class="poll" data-url="/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random" data-submit-url="/_services/polls/${SITE}/SubmitPoll?id=${POLL_PLACEMENT}"></div>`,
  );
  // AdController.RandomAd: Views/Ad/Ad.ascx renders AdTemplate.ascx with ad and show_copy.
  assert.equal(
    squash((await render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad %}")).html),
    '<div><a class="ad-link" href="/child/" title="Ad title"><h5 class="ad-title">Ad title</h5><img class="ad-link-image center-block" src="/banner.png" alt="Banner" height="50" width="100" style="height:50px;width:100px;"></a><div class="ad-copy"><p>Copy</p></div></div>',
  );
  // PollController.RandomPoll: Views/Poll/Poll.ascx renders PollTemplate.ascx with poll; the expired
  // poll in the placement is not selectable.
  const poll = squash((await render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll %}")).html);
  assert.ok(poll.startsWith(`<div><div class="poll-questionpanel" data-id="${POLL}" data-name="Sample"><h5 class="poll-question">Which?</h5>`), poll);
  assert.deepEqual([...poll.matchAll(/<span class="poll-option">([^<]*)<\/span>/g)].map((m) => m[1]), ["Yes", "No"]);
  for (const part of [">Vote</button>", ">View results</button>", "<p>Total votes: 4</p>", ">Return to poll</button>", '<span class="poll-percentage pull-right">75%</span>'])
    assert.ok(poll.includes(part), part);
  // Placement actions (WebFormsContent.master sidebar): AdPlacementTemplate and PollPlacementTemplate
  // with random true render the placeholders that the services fill.
  assert.equal(
    squash((await render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad_placement %}")).html),
    `<div class="ad" data-url="/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random"></div>`,
  );
  const panel = squash((await render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll_placement %}")).html);
  assert.ok(panel.startsWith('<div class="content-panel panel panel-default"><div class="panel-heading"><h4><span class="fa fa-question-circle" aria-hidden="true"></span>'), panel);
  assert.ok(panel.includes(">Poll</span></span></h4></div>"), panel);
  assert.ok(
    panel.endsWith(`<div class="panel-body poll random" data-url="/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random" data-submit-url="/_services/polls/${SITE}/SubmitPoll?id=${POLL_PLACEMENT}"></div></div>`),
    panel,
  );
  const observed = await setup(t, {}, {
    "ad.yml": `- adx_adid: ${AD}\n  adx_name: Placeholder\n  adx_url: ~/\n  adx_openinnewwindow: false`,
    "polls/sample/Sample.poll.yml": `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_submitbuttonlabel: Vote\nadx_active: false`,
    "polls/sample/Sample.poll.polloption.yml": `- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b3\n  adx_name: No\n  adx_answer: No\n  adx_pollid: ${POLL}\n  adx_votes: 2\n  adx_displayorder: 2\n- adx_polloptionid: 9a4d1c2e-0000-4000-8000-0000000000b2\n  adx_name: Yes\n  adx_answer: Yes\n  adx_pollid: ${POLL}\n  adx_votes: 7\n  adx_displayorder: 1`,
  });
  assert.equal(squash((await observed.render("{% assign ad_placement_name = 'Sidebar' %}{% mirage_ad %}")).html), '<div><a class="ad-link" href="/" title=""></a></div>');
  const served = squash((await observed.render("{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll %}")).html);
  assert.deepEqual([...served.matchAll(/<span class="poll-option">([^<]*)<\/span>/g)].map((m) => m[1]), ["Yes", "No"]);
  assert.ok(served.includes('<span class="poll-percentage pull-right">78%</span>'), served);
  // An item with a web template renders through it; the ad or poll name selects directly.
  const templated = await setup(t, {}, {
    "polls/sample/Sample.poll.yml": `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which?\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000309`,
    ...template("09", "Poll View", "<b>{{ poll.name }}|{{ poll.votes }}</b>"),
  });
  assert.equal((await templated.render("{% assign poll_name = 'Sample' %}{% mirage_poll %}")).html, "<b>Sample|4</b>");
  assert.equal((await templated.render(`{% assign poll_placement_name = '${POLL_PLACEMENT}' %}{% mirage_poll %}`)).html, "<b>Sample|4</b>");
});

test("editable, substitution and component tags keep their contracts", async (t) => {
  const calls = [];
  const { render } = await setup(t, {
    renderComponent: async (tag, args) => {
      calls.push([tag, args]);
      return tag === "entitylist" ? { html: "<table></table>", context: { entitylist: { name: args.name } } } : `<${tag}/>`;
    },
  });
  assert.equal(
    (await render("{% editable page 'adx_copy' type: 'html', liquid: true %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>Child title</p></div></div>',
  );
  assert.equal((await render("{% substitution %}sub{% endsubstitution %}")).html, "sub");
  assert.equal(
    (await render("{% entityform name: 'Edit' %}{% entitylist name: 'Contacts' %}[{{ entitylist.name }}]{% endentitylist %}{% chart chart_id: 'c' %}")).html,
    "<entityform/><table></table>[Contacts]<chart/>",
  );
  assert.deepEqual(calls, [
    ["entityform", { name: "Edit" }],
    ["entitylist", { name: "Contacts" }],
    ["chart", { chart_id: "c" }],
  ]);
  const { render: bare } = await setup(t);
  const result = await bare("{% powerbi path: 'x' %}");
  assert.match(result.html, /data-mirage-component="powerbi" role="alert"/);
  assert.equal(result.diagnostics[0].code, "unsupported-platform-component");
});

test("a snippet record without a value is nil and its editable wrapper is marked no-value", async (t) => {
  const { render } = await setup(t, {}, {
    "content-snippets/empty/Empty.en-US.contentsnippet.yml":
      "adx_contentsnippetid: 9a4d1c2e-0000-4000-8000-000000000044\nadx_contentsnippetlanguageid: 9a4d1c2e-0000-4000-8000-0000000000ab\nadx_name: Empty/Snippet",
  });
  const html = (await render("{% editable snippets 'Empty/Snippet' type: 'text' %}")).html;
  assert.deepEqual(/class="([^"]*)"/.exec(html)[1].split("&#32;").sort(), ["no-value", "xrm-attribute", "xrm-editable-text"]);
  assert.ok(html.endsWith(' data-languageContext="English"><div class="xrm-attribute-value"></div></div>'), html);
  // Dataverse stores empty text as null: the value is nil for output, conditions and default.
  assert.equal(
    (await render("[{{ snippets['Empty/Snippet'] }}]{% if snippets['Empty/Snippet'] %}set{% else %}nil{% endif %}|{{ snippets['Empty/Snippet'] | default: 'Fallback' }}")).html,
    "[]nil|Fallback",
  );
  // A snippet with a value keeps the plain wrapper.
  assert.equal(
    (await render("{% editable snippets 'Plain' type: 'html' %}")).html,
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value">Plain <b>text</b></div></div>',
  );
});

test("fetchxml exposes results, totals and the query text", async (t) => {
  let received;
  const { render } = await setup(t, {
    fetchXml: async (xml) => {
      received = xml;
      return { entities: [{ fullname: "Alpha" }, { fullname: "Beta" }], total_record_count: 2, more_records: false };
    },
  });
  const result = await render(
    "{% fetchxml q %}<fetch><entity name='contact'><filter><condition attribute='fullname' operator='eq' value='{{ page.title }}' /></filter></entity></fetch>{% endfetchxml %}{% for e in q.results.entities %}{{ e.fullname }};{% endfor %}|{{ q.results.total_record_count }}|{{ q.results.more_records }}",
  );
  assert.equal(result.html, "Alpha;Beta;|2|false");
  assert.match(received, /value='Child title'/);
  // Without a table permission granting read the results are empty, not an error.
  const denied = await setup(t, {
    fetchXml: async () => {
      throw new DataError("Table permission denies read on contact", 403, "PermissionDenied");
    },
  });
  assert.equal(
    (await denied.render("{% fetchxml q %}<fetch><entity name='contact'/></fetch>{% endfetchxml %}{{ q.results.entities.size }}|{{ q.permission_granted }}")).html,
    "0|false",
  );
});

test("Liquid inventory counts tags, filters and objects and classifies support", async (t) => {
  const portal = await fixturePortal(t, {
    ...template("07", "Probe", "{% for i in list %}{{ i | nosuch }}{{ i | json }}{{ forloop.index }}{% endfor %}{{ request.params['id'] | escape }}{{ blogs.posts }}{% else if x %}"),
  });
  const report = await inventoryPortal(portal);
  const status = (list, name) => list.find((entry) => entry.name === name)?.status;
  assert.equal(status(report.tags, "for"), "supported");
  assert.equal(status(report.tags, "endfor"), "structural");
  assert.equal(status(report.filters, "escape"), "supported");
  assert.equal(status(report.filters, "json"), "supported");
  assert.equal(status(report.filters, "nosuch"), "unknown");
  assert.equal(status(report.objects, "request"), "global");
  assert.equal(status(report.objects, "forloop"), "contextual");
  assert.equal(status(report.objects, "i"), "local");
  assert.equal(status(report.objects, "blogs"), "unsupported");
  assert.equal(status(report.properties, "request.params"), "supported");
  assert.equal(status(report.properties, "forloop.index"), "supported");
  assert.deepEqual(report.unsupported.map((entry) => `${entry.kind}:${entry.name}`), ["object:blogs"]);
  assert.ok(report.includes.some((entry) => entry.name === "Page Copy" && entry.resolution === "runtime-managed"));
  assert.ok(report.syntaxErrors.some((entry) => entry.source === "web-template:Broken"));
  assert.deepEqual(scanTokens("a{% raw %}{{ x }}{% endraw %}{{- y -}}", new Set(["raw"])).map((token) => token.markup.trim()), ["raw", "endraw", "y"]);
  assert.deepEqual(
    expressionPaths("snippets['A b'] | default: page.title, 'x' | date: fmt").map((entry) => `${entry.root}.${entry.member}`),
    ["snippets.A b", "page.title", "fmt.null"],
  );
});

test("render sweep classifies Liquid errors and local injection into non-document responses", () => {
  const injected = classifyResponse({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: '<script src="/__sim-static/vendor/x.js"></script>{"a":1}',
    diagnostics: [{ code: "liquid-unknown-filter", message: "json" }],
  });
  assert.equal(injected.document, false);
  assert.deepEqual(injected.injected, ["sim-static"]);
  assert.equal(injected.liquidNotices.length, 1);
  const page = classifyResponse({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><html><body>Liquid error: boom<script data-paqvilo-mirage-runtime></script></body></html>',
    diagnostics: [{ code: "liquid-runtime-error", message: "boom" }],
  });
  assert.equal(page.document, true);
  assert.deepEqual(page.injected, []);
  assert.deepEqual(page.inlineErrors, ["Liquid error: boom"]);
  assert.equal(page.liquidErrors.length, 1);
  assert.equal(idParameterTable(["{% assign p = entities['sample_product'][request.params.id] %}"]), "sample_product");
  assert.equal(idParameterTable(['<fetch><entity name="sample_change"><filter><condition attribute="sample_changeid" operator="eq" value="{{ params[\'id\'] }}" /></filter></entity></fetch>']), "sample_change");
  assert.equal(idParameterTable(["{{ request.params.page }}"]), null);
});

test("user web-role relationship and enhanced attribute aliases follow the site's data model", async (t) => {
  // Standard model: adx_webrole_contact lists adx_webrole records.
  const { render } = await setup(t, {}, {
    "webrole.yml": "- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e1\n  adx_name: Editors\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e2\n  adx_name: Readers",
  });
  const user = { id: CONTACT, contactid: CONTACT, fullname: "Ada", roles: ["Editors"] };
  assert.equal(
    (await render("{{ user.adx_webrole_contact.size }}|{{ user.adx_webrole_contact[0].adx_name }}|{{ user.adx_webrole_contact[0].logical_name }}|[{{ user.powerpagecomponent_mspp_webrole_contact }}]", { user })).html,
    "1|Editors|adx_webrole|[]",
  );
  // Enhanced model: powerpagecomponent_mspp_webrole_contact lists powerpagecomponent rows, and
  // bare content columns are readable with adx_ and mspp_ prefixes.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "liquid-enhanced-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const component = (id, type, name, content) =>
    `<powerpagecomponent powerpagecomponentid="${id}"><content>${JSON.stringify(content).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</content><name>${name}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`;
  const write = async (name, body) => {
    await fs.mkdir(path.join(dir, path.dirname(name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  };
  await write(
    "Assets/powerpagesites.xml",
    `<powerpagesites><powerpagesite powerpagesiteid="${SITE}"><content>{"website_language": 1033}</content><name>Enhanced</name></powerpagesite></powerpagesites>`,
  );
  await write("powerpagecomponents/a/powerpagecomponent.xml", component("9a4d1c2e-0000-4000-8000-0000000000f5", 11, "Publisher", { anonymoususersrole: false, authenticatedusersrole: false }));
  await write("powerpagecomponents/b/powerpagecomponent.xml", component("9a4d1c2e-0000-4000-8000-0000000000f6", 8, "Main", { source: "{{ page.title }}" }));
  await write("powerpagecomponents/c/powerpagecomponent.xml", component("9a4d1c2e-0000-4000-8000-0000000000f7", 6, "Main", { webtemplateid: "9a4d1c2e-0000-4000-8000-0000000000f6", usewebsiteheaderandfooter: false }));
  await write("powerpagecomponents/d/powerpagecomponent.xml", component("9a4d1c2e-0000-4000-8000-0000000000f8", 2, "Home", { partialurl: "/", pagetemplateid: "9a4d1c2e-0000-4000-8000-0000000000f7" }));
  const portal = await importPortal(dir);
  assert.equal(portal.format, "enhanced");
  const renderer = createPortalRenderer(portal);
  const context = renderer.contextForPage(portal.pages[0], "/", { user: { id: CONTACT, contactid: CONTACT, roles: ["Publisher"] } });
  assert.equal(
    await renderer.renderString(
      "{% for r in user.powerpagecomponent_mspp_webrole_contact %}{{ r.name }}:{{ r.logical_name }}{% endfor %}|[{{ user.adx_webrole_contact }}]|{{ page.partialurl }}|{{ page.adx_partialurl }}|{{ page.mspp_partialurl }}|{{ website.mspp_website_language }}",
      context,
    ),
    "Publisher:powerpagecomponent|[]|/|/|/|1033",
  );
});

test("render sweep resolves export directories and Mirage projects and summarises each persona for CI", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-sweep-target-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "portal"));
  await fs.mkdir(path.join(dir, "solution"));
  const fromSource = await resolveTarget({ source: path.join(dir, "portal"), portal: "demo", solutionRoots: [path.join(dir, "solution")] });
  assert.equal(fromSource.id, "demo");
  assert.equal(fromSource.sourceDir, path.join(dir, "portal"));
  assert.deepEqual(fromSource.solutionRoots, [path.join(dir, "solution")]);
  assert.equal(fromSource.stateFile, null);
  await fs.writeFile(path.join(dir, "project.yml"), "version: 2\nportals:\n  - id: demo\n    path: ./portal\n");
  const fromProject = await resolveTarget({ project: path.join(dir, "project.yml"), portal: "demo", solutionRoots: [] });
  assert.equal(fromProject.id, "demo");
  assert.equal(path.basename(fromProject.sourceDir), "portal");
  assert.match(fromProject.stateFile, /demo[\\/]state\.json$/);
  await assert.rejects(resolveTarget({ project: path.join(dir, "project.yml"), portal: "missing", solutionRoots: [] }), /not configured/);
  const run = {
    persona: "anonymous",
    pages: 2,
    requests: 3,
    byStatus: { 200: 2, 302: 1 },
    liquidErrorPages: ["/a/"],
    liquidDiagnosticCounts: { "liquid-error": 2, "liquid-unknown-filter": 1 },
    injectedNonDocuments: [],
    failures: [],
  };
  assert.deepEqual(ciSummary({ portal: "demo", inventory: { unsupported: [], syntaxErrors: [{}] } }, run), {
    portal: "demo",
    persona: "anonymous",
    pages: 2,
    requests: 3,
    statuses: { 200: 2, 302: 1 },
    liquidErrorPages: 1,
    liquidErrors: 2,
    unknownFilterUses: 1,
    missingTemplateUses: 0,
    unsupported: 0,
    authoredSyntaxErrors: 1,
    injectedNonDocuments: 0,
    failures: 0,
  });
});

test("render sweep personas change only the identity and keep the state's rows", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-sweep-personas-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const portalFiles = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Personas`,
    "webrole.yml":
      "- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e1\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e2\n  adx_name: Editors\n- adx_webroleid: 9a4d1c2e-0000-4000-8000-0000000000e3\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true",
    "web-pages/home/Home.webpage.yml": `adx_webpageid: ${HOME}\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: ${MAIN}`,
    "page-templates/Main.pagetemplate.yml": `adx_pagetemplateid: ${MAIN}\nadx_name: Main\nadx_usewebsiteheaderandfooter: false\nadx_webtemplateid: 9a4d1c2e-0000-4000-8000-000000000301`,
    ...template(
      "01",
      "Main",
      "<!doctype html><html><body>[{{ user.roles | join: ',' }}]{% fetchxml q %}<fetch><entity name='item'/></fetch>{% endfetchxml %}rows={{ q.results.entities.size }}</body></html>",
    ),
  };
  for (const [name, content] of Object.entries(portalFiles)) {
    const target = path.join(dir, "portal", name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await fs.mkdir(path.join(dir, "solutions"));
  const state = {
    mappings: { item: { entitySet: "items", idColumn: "itemid" } },
    tables: { item: [{ itemid: "1", name: "One" }, { itemid: "2", name: "Two" }] },
    permissions: [],
    plugins: [],
    settings: { permissionMode: "permissive" },
    simulator: { mode: "local", pageMode: "local", identity: { id: null, roles: [] }, live: {}, endpoints: [] },
  };
  const stateFile = path.join(dir, "state", "state.json");
  await fs.mkdir(path.dirname(stateFile));
  await fs.writeFile(stateFile, JSON.stringify(state));
  const before = await fs.readFile(stateFile, "utf8");
  const report = await renderSweep({
    source: path.join(dir, "portal"),
    portal: "personas",
    solutionRoots: [path.join(dir, "solutions")],
    state: stateFile,
    persona: "all",
    keepBodies: true,
  });
  const bodies = Object.fromEntries(report.runs.map((run) => [run.persona, run.results.find((result) => result.url === "/").body]));
  assert.match(bodies.anonymous, /\[\]rows=2/);
  assert.match(bodies.authenticated, /\[Authenticated Users\]rows=2/);
  assert.match(bodies["all-roles"], /\[(?=[^\]]*Authenticated Users)(?=[^\]]*Editors)[^\]]*\]rows=2/);
  assert.doesNotMatch(bodies["all-roles"], /Anonymous Users/);
  assert.ok(report.runs.every((run) => run.state.preset === null));
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
});

test("web link sets with the same name are reachable by ID and the first active set wins by name", async (t) => {
  const first = "9a4d1c2e-0000-4000-8000-000000000071";
  const second = "9a4d1c2e-0000-4000-8000-000000000072";
  const third = "9a4d1c2e-0000-4000-8000-000000000073";
  const set = (id, linkName) => ({ id, name: "Default", weblinks: [{ id: `${id}-l`, name: linkName, url: "/", weblinks: [], metadata: {} }] });
  const { renderer, portal, child } = await setup(t);
  // Importer contract: weblinkSets lists every active set; weblinks maps a name to its first set.
  portal.weblinkSets = [set(first, "First"), set(second, "Second"), set(third, "Third")];
  portal.weblinks = { ...portal.weblinks, Default: portal.weblinkSets[0] };
  const context = renderer.contextForPage(child, "/child/", { now: NOW });
  assert.equal(
    await renderer.renderString(
      `{{ weblinks['Default'].weblinks[0].name }}|{{ weblinks['${second}'].weblinks[0].name }}|{{ weblinks['{${third.toUpperCase()}}'].weblinks[0].name }}|[{{ weblinks['default'] }}]|[{{ weblinks['9a4d1c2e-0000-4000-8000-0000000000ff'] }}]`,
      context,
    ),
    "First|Second|Third|[]|[]",
  );
});

test("the platform layout carries the language attributes and links content stylesheets of the page path", async (t) => {
  const css = (id, name, parent, order, extra = "") => ({
    [`web-files/${name}.webfile.yml`]: `adx_webfileid: 9a4d1c2e-0000-4000-8000-0000000004${id}\nadx_name: ${name}\nadx_partialurl: ${name}\nadx_parentpageid: ${parent}${order == null ? "" : `\nadx_displayorder: ${order}`}${extra}`,
    [`web-files/${name}`]: `/* ${name} */`,
  });
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Parity\nadx_website_language: 1031`,
    ...css("01", "second.css", HOME, 2),
    ...css("02", "first.css", HOME, 1),
    ...css("03", "bootstrap.min.css", HOME, 0),
    ...css("04", "child.css", CHILD, 0),
    ...css("05", "inactive.css", HOME, 0, "\nstatecode: 1"),
    ...css("06", "script.js", HOME, 0),
    ...css("07", "beta.css", HOME, 3),
    ...css("08", "alpha.css", HOME, 3),
  };
  const { renderer, portal } = await setup(t, {}, files);
  const stamp = Date.UTC(2026, 0, 2, 3, 4, 5);
  for (const file of portal.webFiles) await fs.utimes(file.file, new Date(stamp + 678), new Date(stamp + 678));
  const page = await renderer.renderPage("/child/grand/");
  assert.equal(page.status, 200);
  // crm-lcid is the LCID of the request's website language (English here), not adx_website_language.
  assert.match(page.html, /<html lang="en-US" dir="ltr" crm-lang="en-US" crm-lcid="1033" data-lang="en-US" same-site-mode="None">/);
  const headLinks = (html) => [...html.slice(0, html.indexOf("</head>")).matchAll(/<link href="([^"]+)" rel="stylesheet" \/>/g)].map((match) => match[1]);
  // bootstrap.min.css first, then the root's styles by display order and name, then the child page's.
  assert.deepEqual(headLinks(page.html), [
    `/bootstrap.min.css?${stamp}`,
    `/first.css?${stamp}`,
    `/second.css?${stamp}`,
    `/alpha.css?${stamp}`,
    `/beta.css?${stamp}`,
    `/child/child.css?${stamp}`,
  ]);
  // The home page has a bootstrap.min.css child, so the default is "web-file"; the observed
  // per-site setting "platform" links the platform's Bootstrap instead.
  portal.observed = { bootstrapStylesheet: "platform", evidence: "synthetic" };
  const observedPlatform = (await createPortalRenderer(portal).renderPage("/child/grand/")).html;
  assert.equal((observedPlatform.match(/bootstrap\.min\.css/g) ?? []).length, 1);
  assert.match(observedPlatform, /href="\/css\/bootstrap\.min\.css"/);
  assert.equal(headLinks(observedPlatform)[0], `/first.css?${stamp}`);
  delete portal.observed;
  // Head/Bootstrap replaces the bootstrap link; without either the platform's own
  // /css/bootstrap.min.css is linked once, and no web-file Bootstrap appears.
  portal.snippets["Head/Bootstrap"] = '<link rel="stylesheet" href="/custom-bootstrap.css">';
  const withSnippet = (await renderer.renderPage("/child/grand/")).html;
  assert.match(withSnippet, /<link rel="stylesheet" href="\/custom-bootstrap\.css">/);
  assert.doesNotMatch(withSnippet, /bootstrap\.min\.css/);
  delete portal.snippets["Head/Bootstrap"];
  portal.webFiles = portal.webFiles.filter((file) => !file.url.endsWith("bootstrap.min.css"));
  const platformBootstrap = (await createPortalRenderer(portal).renderPage("/child/grand/")).html;
  assert.equal((platformBootstrap.match(/bootstrap\.min\.css/g) ?? []).length, 1);
  assert.match(platformBootstrap, /href="\/css\/bootstrap\.min\.css"/);
});

test("website languages follow the import and the request: the wet-boew bilingual export", async (t) => {
  // test/fixtures/wet-boew-bilingual: an unmodified subset of alfredofosu/wet-boew-power-pages-template
  // (MIT, commit b568a61; see the fixture's README.md and LICENSE). English (en) is the default
  // language, French (fr) the second; MultiLanguage/DisplayLanguageCodeInURL is true. Its website
  // languages share their portal language's ID and take code, LCID and display name from
  // .portalconfig/portallanguage.yml.
  const ENGLISH = "479653ed-6561-4160-a081-e917bb73b148";
  const FRENCH = "fba5eb7d-a87b-f011-b4cc-000d3ae86a1f";
  const portal = await importPortal(fileURLToPath(new URL("./fixtures/wet-boew-bilingual/", import.meta.url)));
  assert.deepEqual(
    portal.websiteLanguages.map(({ id, portalLanguageId, code, lcid, displayName, isDefault }) => ({ id, portalLanguageId, code, lcid, displayName, isDefault })),
    [
      { id: ENGLISH, portalLanguageId: ENGLISH, code: "en", lcid: 1033, displayName: "English", isDefault: true },
      { id: FRENCH, portalLanguageId: FRENCH, code: "fr", lcid: 1036, displayName: "Français", isDefault: false },
    ],
  );
  const renderer = createPortalRenderer(portal);
  const overview = portal.pages.find((page) => page.url === "/overview/");
  const view = (source, url, extra = {}) => renderer.renderString(source, renderer.contextForPage(overview, url, extra));
  const squash = (html) => html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  const probe =
    "{{ website.selected_language.code }}|{{ website.selected_language.name }}|" +
    "{% for language in website.languages %}{{ language.code }}={{ language.name }}={{ language.url_substitution }};{% endfor %}|" +
    "{{ page.available_languages.size }}|{{ page.title }}|{{ snippets['GCWeb/App/Name'] }}|{{ resx.Poll_Results_Label }}|" +
    "{% for link in weblinks['Default'].weblinks %}{{ link.name }},{% endfor %}";
  // The default language (English) when the path has no language code; a code that starts the path
  // selects the language and the language URLs keep the path without it. Page title, snippets,
  // resource strings and the per-language "Default" web link set follow the selection.
  assert.equal(
    await view(probe, "/overview/?x=1"),
    "en|English|en=English=en/overview/?x=1;fr=Français=fr/overview/?x=1;|2|Overview|Application Name|View results|Home,Overview,First Section,Second Section,",
  );
  assert.equal(
    await view(probe, "/fr/overview/?x=1"),
    "fr|Français|en=English=en/overview/?x=1;fr=Français=fr/overview/?x=1;|2|Aperçu|Nom de l'application|Afficher les résultats|Accueil,Aperçu,Première section,Deuxième section,",
  );
  // The server passes the code its language route removed; hosts read the request's language.
  assert.equal(await view("{{ website.selected_language.code }}|{{ page.title }}", "/overview/", { languageCode: "FR" }), "fr|Aperçu");
  assert.deepEqual(renderer.contextForPage(overview, "/fr/overview/").__language, { id: FRENCH, code: "fr", lcid: 1036, name: "Français", isDefault: false });
  assert.equal(renderer.requestLanguage(new URL("http://localhost/fr/overview/")).path, "/overview/");
  // The export's own Languages Dropdown template (page.languages, url_substitution).
  assert.equal(
    squash(await view("{% include 'Languages Dropdown' %}", "/fr/overview/")),
    '<ul class="dropdown-menu" role="menu"><li role="menuitem"><a class="dropdown-item" href="/en/overview/" title="English" data-code="en">English</a></li><li role="menuitem"><a class="dropdown-item" href="/fr/overview/" title="Français" data-code="fr">Français</a></li></ul>',
  );
  // Editable snippets carry the request language's display name.
  assert.match(await view("{% editable snippets 'GCWeb/App/Name' type: 'text' %}", "/fr/overview/"), /data-languageContext="Fran&#231;ais"><div class="xrm-attribute-value">Nom de l'application<\/div>/);
  // The page shell: html language attributes, the localized title and copy, and the export's
  // header language toggle (GCWeb/App/Header) pointing at the other language.
  const french = await renderer.renderPage("/fr/overview/");
  assert.match(french.html, /<html lang="fr" dir="ltr" crm-lang="fr" crm-lcid="1036" data-lang="fr"/);
  assert.ok(french.html.includes('<div class="xrm-attribute-value">Aperçu</div>') && french.html.includes('<a lang="en" href="/en/overview/">'));
  const english = await renderer.renderPage("/overview/");
  assert.match(english.html, /<html lang="en" dir="ltr" crm-lang="en" crm-lcid="1033" data-lang="en"/);
  assert.ok(english.html.includes('<div class="xrm-attribute-value">Overview</div>') && english.html.includes('<a lang="fr" href="/fr/overview/">'));
  // Without website languages (legacy exports) there is no language object; the layout uses the
  // culture of the website language LCID.
  const legacy = await setup(t, {}, { "website.yml": `adx_websiteid: ${SITE}\nadx_name: Legacy\nadx_website_language: 1031`, "websitelanguage.yml": "[]" });
  assert.equal((await legacy.render("[{{ website.languages.size }}][{{ website.selected_language }}]")).html, "[0][]");
  assert.match((await legacy.renderer.renderPage("/child/grand/")).html, /<html lang="de-DE" dir="ltr" crm-lang="de-DE" crm-lcid="1031" data-lang="de-DE"/);
  // A single-language export keeps one language and English resources.
  const { render } = await setup(t);
  assert.equal((await render("{{ website.languages.size }}|{{ website.selected_language.code }}|{{ website.selected_language.url }}")).html, "1|en-US|en-US/child/");
});

test("the observed bootstrapStylesheet setting is validated with its evidence", async () => {
  const { observedConfig } = await import("../lib/project-config.mjs");
  assert.deepEqual(observedConfig({ bootstrapStylesheet: "platform", evidence: "fixture/reports/home-stylesheet.json" }), {
    bootstrapStylesheet: "platform",
    evidence: "fixture/reports/home-stylesheet.json",
  });
  assert.throws(() => observedConfig({ bootstrapStylesheet: "cdn", evidence: "x" }), /bootstrapStylesheet must be platform or web-file/);
  assert.throws(() => observedConfig({ bootstrapStylesheet: "web-file" }), /evidence/);
});
