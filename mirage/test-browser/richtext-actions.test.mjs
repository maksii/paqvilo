import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import { editRichText, assertRichText, resolveRichTextMode } from "../lib/richtext-actions.mjs";

test("native editor actions wait for asynchronous blur binding before authored Save reads it", async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const outer = (field) => {
    const content = `<body contenteditable="true"><script>document.body.addEventListener('blur',()=>{const text=document.body.innerText;setTimeout(()=>{parent.parent.document.getElementById('${field}').value=JSON.stringify('<p>'+text+'</p>');},80);},true);</script></body>`;
    const nested = `<iframe class="cke_wysiwyg_frame" srcdoc="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"></iframe>`;
    return `<div class="control" data-logical-name="${field}"><input id="${field}" type="hidden" value='""'><iframe class="fullPageContentEditorFrame" srcdoc="${nested.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"></iframe></div>`;
  };
  await page.setContent(
    outer("scope") +
      outer("background") +
      "<button id=\"save\" onclick=\"window.saved={scope:document.getElementById('scope').value,background:document.getElementById('background').value}\">Save</button>",
  );
  await editRichText(page, "scope", "Changed precise scope");
  await editRichText(page, "background", "Changed background");
  await page.locator("#save").click();
  assert.deepEqual(await page.evaluate(() => window.saved), {
    scope: JSON.stringify("<p>Changed precise scope</p>"),
    background: JSON.stringify("<p>Changed background</p>"),
  });
  await assertRichText(page, "scope", "Changed precise scope");
  await assert.rejects(
    editRichText(page, "bad field", "value"),
    /logical field/,
  );
});

test("auto mode follows the rendered editor: the native managed frame or the local compatibility editor", async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const escape = (html) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  // The editable body commits its text to the control's hidden JSON input on blur.
  const body = (target) =>
    `<body contenteditable="true"><script>document.body.addEventListener('blur',()=>{${target}.value=JSON.stringify('<p>'+document.body.innerText+'</p>');},true);</script></body>`;
  const native = (field) =>
    `<div class="control" data-logical-name="${field}"><input id="${field}" type="hidden" value='""'><iframe class="fullPageContentEditorFrame" srcdoc="${escape(`<iframe class="cke_wysiwyg_frame" srcdoc="${escape(body(`parent.parent.document.getElementById('${field}')`))}"></iframe>`)}"></iframe></div>`;
  const adapter = (field) =>
    `<div class="control" data-logical-name="${field}"><input id="${field}" type="hidden" value='""'><iframe class="cke_wysiwyg_frame" srcdoc="${escape(body(`parent.document.getElementById('${field}')`))}"></iframe></div>`;
  await page.setContent(native("captured") + adapter("local"));
  assert.equal(await editRichText(page, "captured", "Native text", { mode: "auto" }), "native");
  assert.equal(await editRichText(page, "local", "Adapter text", { mode: "auto" }), "adapter");
  assert.equal(await page.inputValue("#captured"), JSON.stringify("<p>Native text</p>"));
  assert.equal(await page.inputValue("#local"), JSON.stringify("<p>Adapter text</p>"));
  await assertRichText(page, "local", "Adapter text", { mode: "auto" });
  await page.setContent("<div class=\"control\" data-logical-name=\"missing\"></div>");
  await assert.rejects(resolveRichTextMode(page, "missing", { timeout: 300 }), /No rich text editor rendered for missing/);
});

test("typing waits for a hosting modal to finish showing, so its focus handoff cannot cut the text", async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const escape = (html) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  // The form page in the modal: an adapter editor that commits its text on every input.
  const editor = `<body contenteditable="true"><script>document.body.addEventListener('input',()=>{parent.document.getElementById('note').value=JSON.stringify('<p>'+document.body.innerText+'</p>');});</script></body>`;
  const form = `<!doctype html><div class="control" data-logical-name="note"><input id="note" type="hidden" value='""'><iframe class="cke_wysiwyg_frame" srcdoc="${escape(editor)}"></iframe></div>`;
  // Like Bootstrap 3, the modal slides in (a 400 ms transition) and then focuses itself.
  await page.setContent(`<style>.modal{opacity:0}.modal.in{opacity:1;transition:opacity .4s linear}</style>
<div class="modal fade" tabindex="-1" id="dialog"><iframe id="form" srcdoc="${escape(form)}"></iframe></div>
<script>
const modal = document.getElementById("dialog");
requestAnimationFrame(() => requestAnimationFrame(() => {
  modal.classList.add("in");
  modal.addEventListener("transitionend", () => modal.focus(), { once: true });
}));
</script>`);
  const frame = page.frameLocator("#form");
  await frame.locator("iframe.cke_wysiwyg_frame").waitFor();
  const formFrame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame());
  const text = "A notification body long enough to still be typing when the dialog finishes showing ".repeat(16).trim();
  assert.equal(await editRichText(formFrame, "note", text, { mode: "adapter" }), "adapter");
  assert.equal(await formFrame.inputValue("#note"), JSON.stringify(`<p>${text}</p>`));
});
