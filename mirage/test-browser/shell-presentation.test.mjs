import test from "node:test";
import assert from "node:assert/strict";
import { registerShellConventions } from "../lib/extensions.mjs";
// A neutral footer logo container class (packs declare their own).
registerShellConventions("test", { footerLogoClass: "site-footer-logos" });
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../lib/browser-launch.mjs";
import {
  observedFooterLogos,
  observedFooterLayout,
  reconcileFooterLogos,
} from "../lib/footer-capture.mjs";
import {
  observedHeaderNotifications,
  reconcileHeaderNotifications,
} from "../lib/header-notification-capture.mjs";
test("observed intrinsic footer sizing matches native boxes and local notification rows drive the bell", async () => {
  const css =
    "body{margin:0}.sample-footer{display:flex;justify-content:space-between;padding:25px 50px}.site-footer-logos{display:flex;gap:60px}.site-footer-logos svg{max-height:60px}.dropdown-menu{display:none}";
  const footer =
    '<footer class="sample-footer"><div>Editable links</div><section class="site-footer-logos"><svg width="124" height="85.858" viewBox="0 0 124 85.858"><rect width="124" height="85.858" fill="blue"/></svg><svg height="127.54" viewBox="0 0 337 127.54"><rect width="337" height="127.54" fill="blue"/></svg></section></footer>';
  const observedCss = css + ".site-footer-logos svg{width:auto}";
  const path = "/style.css";
  const layout = observedFooterLayout({ path, sourceCss: css, observedCss });
  const profile = observedFooterLogos(footer, {
    footerSource: footer,
    origin: "https://portal.example",
    layout,
  });
  const header =
    '<header><ul><li class="userProfileHolder">Local identity</li></ul></header>';
  const nativeWidget =
    '<header><ul><li class="userProfileHolder"><a href="#"><svg width="14" height="16"><path d="M1 1"/></svg> <span class="notificationsCount" style="font-size:12px">99</span></a><ul class="alerts-dropdown"><li>PRIVATE</li></ul></li></ul></header>';
  const hp = observedHeaderNotifications(nativeWidget, {
    headerSource: header,
    origin: "https://portal.example",
  });
  const h = reconcileHeaderNotifications(header, header, hp, {
    notifications: [
      { notificationText: "One", visible: true, severity: "info" },
      { notificationText: "Two", visible: true, severity: "warning" },
      { notificationText: "Hidden local row", visible: false, severity: "info" },
    ],
  }).html;
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const measure = () =>
      page.locator(".site-footer-logos>svg").evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
    await page.setContent("<style>" + observedCss + "</style>" + footer);
    const native = await measure();
    await page.setContent(
      "<style>" +
        css +
        "</style>" +
        h +
        reconcileFooterLogos(footer, footer, profile, {
          styleSources: { [path]: css },
        }).html,
    );
    const local = await measure();
    assert.equal(local[0].width, native[0].width);
    assert.equal(local[0].height, native[0].height);
    assert.equal(local[1].width, native[1].width);
    assert.equal(await page.locator(".notificationsCount").textContent(), "2");
    assert.equal(await page.locator(".description").count(), 2);
    assert.doesNotMatch(await page.content(), /PRIVATE|Hidden local/);
    await page.setContent(
      "<style>" +
        css +
        "</style>" +
        reconcileFooterLogos(footer, footer, profile, {
          styleSources: { [path]: css + " " },
        }).html,
    );
    assert.equal((await measure())[0].width, 124);
  } finally {
    await browser.close();
  }
});
