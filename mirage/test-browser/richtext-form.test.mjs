import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { createSimulator } from "../server.mjs";

test("rich text editor changes preserve native JSON binding, authored observers and stored HTML through native form submit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rte-browser-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: site\nadx_name: Test",
    "web-pages/home/Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: template",
    "page-templates/Main.pagetemplate.yml":
      "adx_pagetemplateid: template\nadx_name: Main\nadx_webtemplateid: main",
    "web-templates/main/Main.webtemplate.yml":
      "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/main/Main.webtemplate.source.html":
      '{% entityform name: "Narrative" %}',
    "basic-forms/Narrative.basicform.yml":
      "adx_entityformid: narrative-form\nadx_name: Narrative\nadx_entityname: example\nadx_mode: 100000000",
    // Native custom JavaScript precedes the form markup, so it observes after ready.
    "basic-forms/Narrative.basicform.custom_javascript.js": `document.addEventListener('DOMContentLoaded',()=>new MutationObserver(changes=>{const value=changes[0].target.value;window.observedHTML=JSON.parse(value);const doc=new DOMParser().parseFromString(window.observedHTML,'text/html');window.observedText=doc.body.textContent;}).observe(document.getElementById('narrative'),{attributes:true}));`,
  };
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  const initial = {
    tables: { example: [] },
    mappings: { example: { entitySet: "examples", idColumn: "exampleid" } },
    permissions: [],
    settings: { permissionMode: "permissive" },
    simulator: {
      identity: { id: "editor" },
      componentSchemas: {
        "narrative-form": {
          entity: "example",
          fields: [
            {
              name: "narrative",
              type: "textarea",
              richText: {
                name: "MscrmControls.RichTextEditor.RichTextEditorControl",
              },
            },
          ],
        },
      },
    },
  };
  const stateFile = path.join(root, "state.json");
  await fs.writeFile(stateFile, JSON.stringify(initial));
  const app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    richTextCompatibility: false,
  });
  t.after(() => app.close());
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(
    "**/webresources/msdyn_/RichTextEditorControl/**",
    (route) => {
      if (route.request().url().endsWith(".json"))
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ defaultSupportedProps: { height: 185 } }),
        });
      return route.fulfill({
        contentType: "application/javascript",
        body: `window.CKEDITOR={replace(id,config){const node=document.getElementById(id),editable=document.createElement('div');editable.contentEditable=!config.readOnly;editable.className='cke_editable';editable.setAttribute('role','textbox');editable.setAttribute('aria-label','Narrative editor');editable.innerHTML=node.value;node.after(editable);node.hidden=true;const handlers={};editable.addEventListener('input',()=>handlers.change?.());setTimeout(()=>handlers.instanceReady?.(),0);return{getData:()=>editable.innerHTML,on:(event,fn)=>handlers[event]=fn};}};`,
      });
    },
  );
  await page.goto(app.url);
  await page
    .locator("[data-sim-richtext-editor][data-mounted=ready]")
    .waitFor();
  await page
    .getByRole("textbox", { name: "Narrative editor" })
    .fill("Meaningful scope change");
  const expected = "<div><strong>Meaningful scope change</strong></div>";
  await page
    .getByRole("textbox", { name: "Narrative editor" })
    .evaluate((editor, html) => {
      editor.innerHTML = html;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, expected);
  assert.equal(
    await page.locator("#narrative").inputValue(),
    JSON.stringify(expected),
  );
  await page.waitForFunction(
    () => window.observedText === "Meaningful scope change",
  );
  // OOB inline postback still runs when authored validation scripts trigger a
  // disabled submit control programmatically; a disabled physical click cannot.
  await page.locator("#InsertButton").evaluate((button) => {
    button.disabled = true;
    button.click();
  });
  assert.equal(app.store.snapshot().tables.example.length, 0);
  const saved = page.waitForResponse((response) =>
    response.url().includes("/__sim/forms/"),
  );
  await page
    .locator("#InsertButton")
    .evaluate((button) =>
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
  assert.equal((await saved).status(), 201);
  assert.equal(app.store.snapshot().tables.example[0].narrative, expected);
  assert.deepEqual(errors, []);
});
