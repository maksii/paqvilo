/** Exercise the visible native editor, then wait for its bound value to commit. */
export function richTextBody(page, field, { mode = "native" } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(field))
    throw new Error("Rich text field must be a logical field name.");
  const root = `div.control[data-logical-name="${field}"]`;
  if (mode === "native")
    return page
      .frameLocator(`${root} iframe.fullPageContentEditorFrame`)
      .frameLocator("iframe.cke_wysiwyg_frame")
      .locator("body");
  if (mode === "adapter")
    return page
      .frameLocator(`${root} iframe.cke_wysiwyg_frame`)
      .locator("body");
  throw new Error("Unsupported rich text control mode.");
}

/**
 * The mode of the rendered editor: "native" when the managed control's frame is present
 * (its CKEditor bytes are captured), "adapter" for the local compatibility editor.
 */
export async function resolveRichTextMode(page, field, { timeout = 30000 } = {}) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(field))
    throw new Error("Rich text field must be a logical field name.");
  const root = `div.control[data-logical-name="${field}"]`;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator(`${root} iframe.fullPageContentEditorFrame`).count()) return "native";
    if (await page.locator(`${root} iframe.cke_wysiwyg_frame`).count()) return "adapter";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No rich text editor rendered for ${field}.`);
}

/**
 * When `frame` is a frame inside a modal of its parent page, wait (bounded) until the modal has
 * finished showing: Bootstrap moves focus to the modal when its show transition ends, which
 * takes focus from an editor typed into earlier, as it would from a user typing that soon.
 */
export async function settleHostModal(frame, { timeout = 5000 } = {}) {
  const host = typeof frame.frameElement === "function" ? await frame.frameElement().catch(() => null) : null;
  if (!host) return;
  await host
    .evaluate(
      (iframe, timeout) =>
        new Promise((resolve) => {
          const modal = iframe.closest(".modal");
          if (!modal) return resolve();
          const started = Date.now();
          let quietSince = null;
          const check = () => {
            const shown = modal.classList.contains("in") || modal.classList.contains("show");
            const moving = (modal.getAnimations?.({ subtree: true }) ?? []).some((animation) => animation.playState === "running");
            const focused = modal.contains(iframe.ownerDocument.activeElement);
            if (shown && !moving) quietSince ??= Date.now();
            else quietSince = null;
            // Shown with its transitions finished for a moment, and focus handed to the modal
            // (Bootstrap does that when the transition ends), or a second without it.
            const quiet = quietSince === null ? -1 : Date.now() - quietSince;
            if ((quiet >= 150 && (focused || quiet > 1000)) || Date.now() - started > timeout) return resolve();
            setTimeout(check, 50);
          };
          check();
        }),
      timeout,
    )
    .catch(() => {});
}

/** Edit a rich text control; mode "auto" follows the rendered editor. Returns the mode used. */
export async function editRichText(page, field, text, options) {
  const mode = options?.mode === "auto" ? await resolveRichTextMode(page, field) : options?.mode;
  const body = richTextBody(page, field, { ...options, mode });
  await body.waitFor({ state: "visible" });
  await settleHostModal(page);
  const documentBefore = await page.evaluate(() => performance.timeOrigin).catch(() => null);
  await body.click();
  await body.press("Control+A");
  await body.pressSequentially(text);
  // Native PCF batches editor changes. Blur commits its model before authored
  // Save handlers read the hidden JSON-valued control.
  await body.press("Tab");
  try {
    await page.waitForFunction(
      ({ field, text }) => {
        const input = document.getElementById(field);
        if (!input) return false;
        try {
          const html = JSON.parse(input.value);
          if (typeof html !== "string") return false;
          return new DOMParser()
            .parseFromString(html, "text/html")
            .body.textContent.includes(text);
        } catch {
          return false;
        }
      },
      { field, text },
    );
  } catch (error) {
    // Say what the editor held when its value did not commit.
    const state = await page
      .evaluate((field) => {
        const container = document.querySelector(`div.control[data-logical-name="${field}"]`);
        const frames = [...(container?.querySelectorAll("iframe.cke_wysiwyg_frame") ?? [])];
        return {
          documentStart: performance.timeOrigin,
          mounted: container?.querySelector("[data-sim-richtext-editor]")?.dataset.mounted ?? null,
          frames: frames.map((frame) => ({ connected: frame.isConnected, bound: Boolean(frame.contentDocument?.body?.__ppSimBound), text: frame.contentDocument?.body?.textContent?.slice(0, 80) ?? null })),
          input: document.getElementById(field)?.value?.slice(0, 120) ?? null,
        };
      }, field)
      .catch((cause) => ({ unavailable: cause.message }));
    throw new Error(`Rich text ${field} did not commit the typed text: ${JSON.stringify({ documentBefore, ...state })}`, { cause: error });
  }
  return mode ?? "native";
}

export async function assertRichText(page, field, text, options) {
  const mode = options?.mode === "auto" ? await resolveRichTextMode(page, field) : options?.mode;
  const body = richTextBody(page, field, { ...options, mode });
  await body.waitFor({ state: "visible" });
  if (!(await body.innerText()).includes(text))
    throw new Error(`Visible rich text value did not match ${field}.`);
}
