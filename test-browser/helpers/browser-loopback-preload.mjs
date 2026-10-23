import { chromium } from "playwright-core";

// The subprocess browser uses this fixture's HTTP listener as a rejecting proxy.
// Keep configuration as data rather than constructing executable preload text.
const value = process.env.PAQVILO_TEST_LOOPBACK_PROXY;
delete process.env.PAQVILO_TEST_LOOPBACK_PROXY;
const origin = new URL(value);
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  !origin.port ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  value !== origin.origin
) {
  throw new Error(
    "The test browser proxy must be an exact loopback HTTP origin",
  );
}

const launch = chromium.launchPersistentContext;
chromium.launchPersistentContext = function (profile, options) {
  return launch.call(this, profile, {
    ...options,
    proxy: { server: origin.origin, bypass: "127.0.0.1,localhost" },
    args: [
      ...(options.args || []),
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  });
};
