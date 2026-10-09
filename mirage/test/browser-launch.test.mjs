import test from "node:test";
import assert from "node:assert/strict";
import { browserChannel, browserLaunchOptions } from "../lib/browser-launch.mjs";

test("Mirage browser selection honors override and has portable defaults", () => {
  assert.equal(browserChannel({ platform: "win32", env: {} }), "msedge");
  assert.equal(browserChannel({ platform: "linux", env: {} }), "chromium");
  assert.equal(browserChannel({ platform: "darwin", env: {} }), "chromium");
  assert.equal(browserChannel({ platform: "linux", env: { PAQVILO_BROWSER: "msedge" } }), "msedge");
  assert.deepEqual(browserLaunchOptions({ headless: true }, { platform: "linux", env: {} }), {
    headless: true,
    channel: undefined,
  });
});
