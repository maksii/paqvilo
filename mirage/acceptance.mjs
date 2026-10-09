import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { editRichText, assertRichText } from "./lib/richtext-actions.mjs";
import {
  reconcileSupersededRead,

  correlateNetworkConsole,
} from "./lib/request-evidence.mjs";
import { auditQuery } from "./lib/audit-log.mjs";
import {
  awaitWritesBeforeDocument,
  DOCUMENT_REQUEST_PATTERN,
  awaitNetworkQuiet,
  frameState,
} from "./lib/navigation-settle.mjs";
import { classifyNativeNetworkFailures } from "./lib/native-network-baseline.mjs";
import {
  observeReadAborts,
  reconcileIntentionalReadAbort,
} from "./lib/intentional-abort.mjs";

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return "<invalid URL>";
  }
};
const failureUrl = (value) => {
  try {
    const url = new URL(value);
    const query = new URLSearchParams(auditQuery(url.searchParams));
    return (
      url.origin + url.pathname + (url.search ? "?" + query.toString() : "")
    );
  } catch {
    return "<invalid URL>";
  }
};
const safeMessage = (value) =>
  String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /((?:access_token|id_token|password|secret|authorization|cookie)\s*[=:]\s*)[^\s&]+/gi,
      "$1[redacted]",
    )
    .replace(/https?:\/\/[^\s)]+/g, (url) => safeUrl(url));
const loopback = (value) => {
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Local simulator and browser debugging addresses must use loopback without credentials.",
    );
  return url;
};
const expand = (value, variables) =>
  Array.isArray(value)
    ? value.map((item) => expand(item, variables))
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            expand(item, variables),
          ]),
        )
      : typeof value === "string"
        ? value.replace(/\{\{([\w]+)\}\}/g, (_all, name) => {
            if (variables[name] === undefined)
              throw new Error(`Unknown flow variable ${name}`);
            return String(variables[name]);
          })
        : value;
const locate = (page, target) =>
  target.selector
    ? page.locator(target.selector)
    : target.role
      ? page.getByRole(target.role, {
          name: target.name,
          exact: target.exact !== false,
        })
      : target.label
        ? page.getByLabel(target.label, { exact: target.exact !== false })
        : target.text
          ? page.getByText(target.text, { exact: target.exact !== false })
          : (() => {
              throw new Error(
                "A flow action requires selector, role, label, or text.",
              );
            })();
const expectedFields = (record, fields, contains) =>
  Object.entries(fields ?? {}).every(
    ([name, value]) => JSON.stringify(record[name]) === JSON.stringify(value),
  ) &&
  Object.entries(contains ?? {}).every(
    ([name, value]) =>
      typeof record[name] === "string" &&
      typeof value === "string" &&
      record[name].includes(value),
  );

/** Run explicit actions against exported portal UI; record failures rather than converting partial flows into passes. */
export async function runAcceptance({
  localUrl,
  liveOrigin,
  cdpUrl,
  outputDir,
  flows,
  nativeNetworkBaseline,
  channel = process.env.PAQVILO_BROWSER ||
    (process.platform === "win32" ? "msedge" : "chromium"),
  timeout = 15000,
  // Optional async hook run on the local browser context before the flows, e.g. a
  // paqvilo-mirage-auth session sign-in of the persona under test.
  prepareContext = null,
}) {
  const local = loopback(localUrl);
  if (!["http:", "https:"].includes(local.protocol))
    throw new Error("Local simulator requires HTTP(S).");
  const live = liveOrigin ? new URL(liveOrigin) : null;
  if (
    live &&
    (live.protocol !== "https:" ||
      live.pathname !== "/" ||
      live.search ||
      live.hash ||
      live.username ||
      live.password)
  )
    throw new Error("Live comparison requires a credential-free HTTPS origin.");
  if (!Array.isArray(flows) || !flows.length)
    throw new Error("Provide explicit acceptance flows.");
  outputDir = path.resolve(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  let observedIdentity;
  const readState = async (full = false) => {
    const response = await fetch(
      new URL("/__sim/api/state" + (full ? "" : "?summary=1"), local.origin),
      { signal: AbortSignal.timeout(timeout) },
    );
    if (!response.ok)
      throw new Error(`Simulator state returned HTTP ${response.status}`);
    const state = await response.json();
    observedIdentity =
      state.status?.effectiveIdentity ?? state.config?.identity;
    return state;
  };
  const requireLocal = (state) => {
    if (
      state.config?.mode !== "local" ||
      state.config?.pageMode !== "local" ||
      state.config?.endpoints?.some((endpoint) => endpoint.mode === "live")
    )
      throw new Error(
        "Local acceptance requires local data/page providers and no live endpoint routing.",
      );
  };
  const state = await readState();
  requireLocal(state);
  if (
    !state.status?.sourceFingerprint ||
    !state.status?.implementationFingerprint
  )
    throw new Error(
      "Acceptance requires the portal source and loaded mirage implementation fingerprints.",
    );
  const result = {
    time: new Date().toISOString(),
    passed: false,
    sourceFingerprint: state.status?.sourceFingerprint,
    implementationFingerprint: state.status?.implementationFingerprint,
    viewport: { width: 1440, height: 1000 },
    flows: [],
  };
  let ownedBrowser, attachedBrowser, blockingProxy;
  try {
    // Local flows reach only loopback: every other request goes to a local proxy that refuses
    // it, and is reported as blocked. Unlike request interception this cannot stall a page's
    // synchronous requests (lib/navigation-settle.mjs).
    blockingProxy = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => blockingProxy.listen(0, "127.0.0.1", resolve));
    ownedBrowser = await chromium.launch({
      channel: channel === "chromium" ? undefined : channel,
      headless: true,
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
      ],
      proxy: {
        server: `http://127.0.0.1:${blockingProxy.address().port}`,
        bypass: "127.0.0.1,localhost,[::1]",
      },
    });
    const localContext = await ownedBrowser.newContext({
      viewport: result.viewport,
      serviceWorkers: "block",
    });
    if (typeof prepareContext === "function") await prepareContext(localContext, local.origin);
    if (flows.some((flow) => flow.mode === "live")) {
      if (!live || !cdpUrl)
        throw new Error(
          "Live observations require --origin and the intended existing --cdp browser.",
        );
      loopback(cdpUrl);
      attachedBrowser = await chromium.connectOverCDP(cdpUrl);
      if (attachedBrowser.contexts().length !== 1)
        throw new Error("Use exactly one attached browser identity.");
      const context = attachedBrowser.contexts()[0];
      if (
        context
          .serviceWorkers()
          .some((worker) => new URL(worker.url()).origin === live.origin)
      )
        throw new Error(
          "Relevant live service workers prevent reliable write interception.",
        );
      for (const existing of context.pages().filter((page) => {
        try {
          return new URL(page.url()).origin === live.origin;
        } catch {
          return false;
        }
      })) {
        const registrations = await existing.evaluate(async () =>
          navigator.serviceWorker
            ? (await navigator.serviceWorker.getRegistrations()).map(
                (registration) => registration.scope,
              )
            : [],
        );
        if (registrations.length)
          throw new Error(
            "Relevant live service worker registrations prevent reliable write interception.",
          );
      }
    }
    const variables = {};
    for (const [index, flow] of flows.entries()) {
      const isLive = flow.mode === "live",
        origin = isLive ? live.origin : local.origin,
        context = isLive ? attachedBrowser.contexts()[0] : localContext;
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);
      await page.setViewportSize(result.viewport);
      const observation = {
        name: flow.name,
        mode: isLive ? "live-read-only" : "local",
        passed: false,
        steps: [],
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        failedResponses: [],
        blockedRequests: [],
        writes: [],
        screenshots: [],
        resources: [],
      };
      result.flows.push(observation);
      const sourceAborts = [];
      if (!isLive) {
        await page.exposeBinding("__simObserveReadAbort", (_source, value) => {
          if (
            sourceAborts.length < 1000 &&
            value &&
            typeof value.url === "string" &&
            typeof value.stack === "string"
          )
            sourceAborts.push({
              ...value,
              url: failureUrl(value.url),
              stack: safeMessage(value.stack).slice(0, 10000),
            });
        });
        await page.addInitScript(observeReadAborts);
      }
      const pending = new Map(),
        responseObservations = [];
      const cdp = await context.newCDPSession(page),
        cdpRecords = new Map(),
        frameEvents = [];
      await cdp.send("Network.enable");
      await cdp.send("Page.enable");
      // A local navigation waits (bounded) for the script writes of the document it replaces;
      // only document requests are paused (lib/navigation-settle.mjs).
      if (!isLive) {
        cdp.on("Fetch.requestPaused", (event) => {
          const parents = () =>
            new Map(
              frameEvents
                .filter((row) => row.parentFrameId)
                .map((row) => [row.frameId, row.parentFrameId]),
            );
          // Writes of replaced documents or removed frames can no longer complete.
          awaitWritesBeforeDocument(event.frameId, () => [...cdpRecords.values()], parents, {
            timeout,
            frames: () => frameState(frameEvents),
          })
            .then((wait) => {
              if (wait)
                (observation.navigationWaits ??= []).push({
                  navigation: safeUrl(event.request.url),
                  ...wait,
                });
            })
            .catch(() => {})
            .finally(() =>
              cdp
                .send("Fetch.continueRequest", { requestId: event.requestId })
                .catch(() => {}),
            );
        });
        await cdp.send("Fetch.enable", { patterns: [DOCUMENT_REQUEST_PATTERN] });
      }
      for (const event of ["frameAttached", "frameDetached", "frameNavigated"])
        cdp.on("Page." + event, (value) =>
          frameEvents.push({
            event,
            observedAt: new Date().toISOString(),
            ...(event === "frameNavigated"
              ? {
                  frameId: value.frame.id,
                  parentFrameId: value.frame.parentId,
                  loaderId: value.frame.loaderId,
                }
              : {
                  frameId: value.frameId,
                  parentFrameId: value.parentFrameId,
                  reason: value.reason,
                }),
          }),
        );
      cdp.on("Network.requestWillBeSent", (event) => {
        let url;
        try {
          url = new URL(event.request.url);
        } catch {
          return;
        }
        cdpRecords.set(event.requestId, {
          requestId: event.requestId,
          loaderId: event.loaderId,
          frameId: event.frameId,
          type: event.type,
          path:
            url.origin === local.origin ? url.pathname + url.search : url.href,
          method: event.request.method,
          startedAt: new Date(event.wallTime * 1000).toISOString(),
          startedTimestamp: event.timestamp,
          parentTrace: Object.entries(event.request.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "x-sim-parent-trace",
          )?.[1],
        });
      });
      cdp.on("Network.responseReceived", (event) => {
        const record = cdpRecords.get(event.requestId);
        if (record) {
          record.status = event.response.status;
          record.mimeType = event.response.mimeType;
          record.serverTraceId = Object.entries(
            event.response.headers ?? {},
          ).find(([name]) => name.toLowerCase() === "x-sim-trace-id")?.[1];
        }
      });
      cdp.on("Network.loadingFinished", (event) => {
        const record = cdpRecords.get(event.requestId);
        if (record) record.finishedTimestamp = event.timestamp;
      });
      cdp.on("Network.loadingFailed", (event) => {
        const record = cdpRecords.get(event.requestId);
        if (record) {
          record.failure = event.errorText;
          record.failedTimestamp = event.timestamp;
          record.failedAt =
            Date.parse(record.startedAt) +
            (event.timestamp - record.startedTimestamp) * 1000;
        }
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          observation.consoleErrors.push(safeMessage(message.text()));
          (observation.consoleMessages ??= []).push({
            text: safeMessage(message.text()),
            argumentCount: message.args().length,
            url: message.location().url
              ? failureUrl(message.location().url)
              : null,
          });
        }
      });
      page.on("pageerror", (error) =>
        observation.pageErrors.push(safeMessage(error.stack ?? error.message)),
      );
      page.on("requestfailed", (request) => {
        const record = pending.get(request),
          requestKey = String(record?.order ?? "");
        if (!isLive) {
          let target = null;
          try {
            target = new URL(request.url());
          } catch {
            target = null;
          }
          // The owned browser's proxy refused a request that would leave loopback.
          if (target && /^(https?|wss?):$/.test(target.protocol) && target.origin !== origin)
            observation.blockedRequests.push({
              method: request.method(),
              url: safeUrl(request.url()),
            });
        }
        const response = observation.failedResponses.find(
          (item) => item.requestKey === requestKey,
        );
        observation.failedRequests.push({
          kind: "network",
          requestKey,
          method: request.method(),
          url: failureUrl(request.url()),
          status: record?.status,
          error: safeMessage(request.failure()?.errorText),
          errorText: safeMessage(request.failure()?.errorText),
          ...(response
            ? {
                correlatedResponse: {
                  requestKey,
                  method: response.method,
                  url: response.url,
                  status: response.status,
                },
              }
            : {}),
        });
      });
      page.on("response", (response) => {
        const record = pending.get(response.request());
        if (record) record.status = response.status();
        if (response.status() >= 400) {
          const failure = {
            kind: "http",
            requestKey: String(record?.order ?? ""),
            method: response.request().method(),
            url: failureUrl(response.url()),
            status: response.status(),
          };
          observation.failedResponses.push(failure);
          if (
            !isLive &&
            response.headers()["content-type"]?.includes("application/json")
          )
            responseObservations.push(
              response
                .json()
                .then((body) => {
                  if (body.error)
                    failure.error = {
                      code: safeMessage(body.error.code),
                      message: safeMessage(body.error.message),
                    };
                })
                .catch(() => {}),
            );
        }
      });
      const proofInputs = new Map();
      let lastRequestActivity = Date.now();
      page.on("request", (request) => {
        const record = {
          order: observation.resources.length + 1,
          method: request.method(),
          url: safeUrl(request.url()),
          type: request.resourceType(),
          started: Date.now(),
        };
        pending.set(request, record);
        if (record.type !== "eventsource") lastRequestActivity = Date.now();
        const url = new URL(request.url());
        proofInputs.set(request, {
          method: record.method,
          path:
            url.origin === local.origin ? url.pathname + url.search : url.href,
          startedAt: new Date(record.started).toISOString(),
          parentTrace: request.headers()["x-sim-parent-trace"],
          identity: observedIdentity,
          stream: record.type === "eventsource",
        });
        observation.resources.push(record);
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
          observation.writes.push({
            method: request.method(),
            url: safeUrl(request.url()),
          });
      });
      for (const event of ["requestfinished", "requestfailed"])
        page.on(event, (request) => {
          const record = pending.get(request);
          if (record) {
            if (record.type !== "eventsource") lastRequestActivity = Date.now();
            record.durationMs = Date.now() - record.started;
            record.finished = event === "requestfinished";
            pending.delete(request);
          }
        });
      // Live observations block every non-read request. Local flows are confined to loopback
      // by the owned browser's proxy (blocked requests are recorded when they fail).
      if (isLive)
        await page.route("**/*", (route) => {
          const request = route.request();
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            observation.blockedRequests.push({
              method: request.method(),
              url: safeUrl(request.url()),
            });
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
      const capture = async (label) => {
        const file = path.join(
          outputDir,
          `${index + 1}-${flow.name.replace(/[^a-z0-9]/gi, "-")}-${label}.png`,
        );
        await page.screenshot({
          path: file,
          fullPage: true,
          animations: "disabled",
        });
        observation.screenshots.push(file);
      };
      // A user acts once a loaded page has finished its own requests: exported pages chain
      // load-time reads and writes after their ready handlers (bounded and recorded).
      const loadQuiet = async () => {
        const quiet = await awaitNetworkQuiet(() => [...cdpRecords.values()], {
          frames: () => frameState(frameEvents),
          timeout,
          ignore: (row) => row.path.startsWith("/__sim/events"),
        });
        (observation.loadWaits ??= []).push({ url: safeUrl(page.url()), ...quiet });
      };
      const settle = async () => {
        const active = () =>
          [...pending.values()].filter(
            (record) =>
              record.type !== "eventsource" &&
              !record.url.endsWith("/__sim/events"),
          );
        const deadline = Date.now() + timeout;
        let lastProofCheck = 0;
        // Native save callbacks can schedule a subgrid refresh after the modal
        // closes. Observe that work before initiating another navigation.
        while (
          (active().length || Date.now() - lastRequestActivity < 500) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!isLive && Date.now() - lastProofCheck > 750) {
            lastProofCheck = Date.now();
            const response = await fetch(
              local.origin + "/__sim/api/audit/export",
              { signal: AbortSignal.timeout(timeout) },
            );
            if (response.ok) {
              const audit = await response.json();
              const frameTree = await cdp.send("Page.getFrameTree");
              const flatten = (node) => [
                node.frame,
                ...(node.childFrames ?? []).flatMap(flatten),
              ];
              const currentFrames = flatten(frameTree.frameTree);
              observation.finalFrameTree = currentFrames.map(
                ({ id, parentId, loaderId }) => ({ id, parentId, loaderId }),
              );
              for (const [request, record] of pending) {
                const proof = reconcileSupersededRead(
                  proofInputs.get(request),
                  {
                    cdpRecords: [...cdpRecords.values()],
                    audit,
                    origin: local.origin,
                    identity: observedIdentity,
                    frameEvents,
                    currentFrames,
                  },
                );
                if (proof) {
                  record.navigationObservation = proof;
                  (observation.supersededReads ??= []).push(proof);
                  pending.delete(request);
                }
              }
            }
          }
        }
        await Promise.allSettled(responseObservations);
        if (active().length)
          throw new Error(
            "Portal requests did not settle: " +
              active()
                .map((record) => record.method + " " + record.url)
                .join(", "),
          );
      };
      try {
        for (const [stepIndex, definition] of flow.steps.entries()) {
          if (!isLive) requireLocal(await readState());
          const step = Object.fromEntries(
            Object.entries(definition).map(([key, value]) => [
              key,
              expand(value, variables),
            ]),
          );
          const entry = {
            action: step.action,
            label: step.description ?? step.action,
            passed: false,
          };
          observation.steps.push(entry);
          if (
            isLive &&
            (step.mutation ||
              [
                "identity",
                "preset",
                "record",
                "rememberRecord",
                "waitRecord",
                "richtext",
              ].includes(step.action))
          )
            throw new Error(
              "A local mutation/state assertion cannot execute in a live observation flow.",
            );
          const surface = step.frame
            ? (Array.isArray(step.frame) ? step.frame : [step.frame]).reduce(
                (surface, selector) => surface.frameLocator(selector),
                page,
              )
            : page;
          const target = () => locate(surface, step);
          if (step.action === "navigate") {
            await settle();
            if (
              !step.path?.startsWith("/") ||
              step.path.startsWith("//") ||
              step.path.includes("\\")
            )
              throw new Error("Navigation must use a portal-relative path.");
            if (
              step.waitUntil &&
              !["load", "domcontentloaded"].includes(step.waitUntil)
            )
              throw new Error(
                "Navigation readiness must be load or domcontentloaded.",
              );
            const response = await page.goto(origin + step.path, {
              // Exported pages may leave asynchronous data requests open while
              // their document and controls are already usable. Navigation
              // readiness is DOM availability; flow assertions and `settle`
              // continue to report unfinished or failed requests separately.
              waitUntil: step.waitUntil ?? "domcontentloaded",
            });
            entry.status = response?.status();
            if (entry.status !== (step.status ?? 200))
              throw new Error(
                `Expected HTTP ${step.status ?? 200}, observed ${entry.status}.`,
              );
            if (!isLive) await loadQuiet();
          } else if (step.action === "load")
            await page.waitForLoadState("load");
          else if (step.action === "reveal") {
            await settle();
            const control = surface.locator(step.selector);
            await control.waitFor({ state: "attached" });
            entry.alreadyVisible = await control.isVisible();
            if (!entry.alreadyVisible)
              await locate(surface, step.trigger).click();
            await control.waitFor({ state: "visible" });
          } else if (step.action === "click") await target().click();
          else if (step.action === "fill") await target().fill(step.value);
          else if (step.action === "type") {
            await target().fill("");
            await target().pressSequentially(step.value);
          } else if (step.action === "richtext")
            await editRichText(page, step.field, step.value, {
              mode: step.mode ?? "native",
            });
          else if (step.action === "richtextText")
            await assertRichText(page, step.field, step.value, {
              mode: step.mode ?? "native",
            });
          else if (step.action === "select")
            await target().selectOption(step.value);
          else if (step.action === "check")
            await target().setChecked(step.checked !== false);
          else if (step.action === "visible")
            await target().waitFor({
              state: step.visible === false ? "hidden" : "visible",
            });
          else if (step.action === "text") {
            await target()
              .filter({ hasText: step.value })
              .waitFor({ state: "visible" });
          } else if (step.action === "value") {
            // Authored modal scripts can initialize defaults after the control
            // is attached. Assert the resulting value within the action deadline.
            const deadline = Date.now() + timeout;
            let matched = false;
            let observed = false;
            while (Date.now() < deadline) {
              let value;
              try {
                value = await target().inputValue({
                  timeout: Math.max(1, deadline - Date.now()),
                });
              } catch (error) {
                // A read cut short by the deadline after the control was seen is a value mismatch.
                if (!observed) throw error;
                break;
              }
              observed = true;
              matched = step.contains
                ? value.includes(step.value)
                : value === step.value;
              if (matched) break;
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.min(100, Math.max(1, deadline - Date.now())),
                ),
              );
            }
            if (!matched)
              throw new Error(`The expected field value was not observed.`);
          } else if (step.action === "url") {
            if (
              step.waitUntil &&
              !["load", "domcontentloaded"].includes(step.waitUntil)
            )
              throw new Error(
                "Navigation readiness must be load or domcontentloaded.",
              );
            await page.waitForURL(
              (url) =>
                url.pathname === step.path &&
                (step.queryName
                  ? url.searchParams.get(step.queryName) === step.value
                  : true),
              { waitUntil: step.waitUntil ?? "domcontentloaded" },
            );
            if (!isLive) await loadQuiet();
          } else if (step.action === "settle") {
            await settle();
          } else if (step.action === "identity") {
            // Portal identity is per browser session (paqvilo-mirage-auth cookie), so the step
            // signs this flow's browser context in through the session API: `roles` is a
            // manual role override and `contactId` alone signs in with that local contact's
            // memberships. Without `contactId` the step keeps the signed-in contact, else the
            // configured persona's. The open page then reloads as the new identity.
            const current = await readState();
            const signedIn = await (
              await context.request.get(new URL("/__sim/api/session", local.origin).href)
            ).json();
            const contactId =
              step.contactId ??
              signedIn.contactId ??
              current.config?.identity?.contactId ??
              current.config?.identity?.id;
            if (!contactId)
              throw new Error(
                "The identity step needs a contactId: no contact is signed in or configured.",
              );
            const response = await context.request.post(
              new URL("/__sim/api/session/sign-in", local.origin).href,
              {
                headers: { "x-sim-csrf": current.csrf },
                data: { contactId, ...(step.roles ? { roles: step.roles } : {}) },
              },
            );
            if (!response.ok())
              throw new Error(
                `Session sign-in returned HTTP ${response.status()}: ${await response.text()}`,
              );
            const session = await response.json();
            if (
              step.roles &&
              JSON.stringify(session.roles) !== JSON.stringify(step.roles)
            )
              throw new Error("Role changes were not applied to the browser session.");
            if (page.url().startsWith(local.origin + "/")) {
              await page.reload({ waitUntil: step.waitUntil ?? "domcontentloaded" });
              await loadQuiet();
            }
          } else if (step.action === "preset") {
            await page.goto(local.origin + "/__sim/#access");
            await page
              .getByLabel("Available preset", { exact: true })
              .selectOption(step.id);
            await page
              .getByRole("button", {
                name: "Apply selected preset",
                exact: true,
              })
              .click();
            await page
              .locator("#confirm")
              .getByRole("button", { name: "Apply preset", exact: true })
              .click();
            await page.locator("#confirm").waitFor({ state: "hidden" });
          } else if (
            ["record", "rememberRecord", "waitRecord"].includes(step.action)
          ) {
            let current, matches;
            const deadline =
              Date.now() + (step.action === "waitRecord" ? timeout : 0);
            do {
              current = await readState(true);
              requireLocal(current);
              matches = (current.data?.[step.entity] ?? []).filter((record) =>
                expectedFields(record, step.fields, step.contains),
              );
              if (
                matches.length === (step.count ?? 1) ||
                Date.now() >= deadline
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            } while (true);
            if (matches.length !== (step.count ?? 1))
              throw new Error(
                `Expected ${step.count ?? 1} matching ${step.entity} records, observed ${matches.length}.`,
              );
            if (step.variable) {
              const mapping = current.config.mappings.find(
                (mapping) => mapping.logicalName === step.entity,
              );
              variables[step.variable] =
                matches[0][
                  step.idColumn ?? mapping?.idColumn ?? `${step.entity}id`
                ];
            }
            entry.matchCount = matches.length;
          } else if (step.action === "screenshot")
            await capture(step.name ?? String(stepIndex + 1));
          else throw new Error(`Unsupported acceptance action ${step.action}`);
          entry.passed = true;
        }
        await page.waitForTimeout(300);
        await settle();
        await capture("final");
        if (
          new URL(page.url()).origin !== origin ||
          /signin|login|authorize/i.test(new URL(page.url()).pathname) ||
          (await page.locator("input[type=password]:visible").count())
        )
          throw new Error("Sign-in or origin redirect was observed.");
        let unexpectedRequests = observation.failedRequests,
          unexpectedResponses = observation.failedResponses;
        observation.sourceAborts = sourceAborts;
        observation.sourceCancelledReads = [];
        if (!isLive)
          unexpectedRequests = unexpectedRequests.filter((failure) => {
            const proof = reconcileIntentionalReadAbort(failure, {
              resources: observation.resources,
              cdpRecords: [...cdpRecords.values()],
              sourceAborts,
              origin: local.origin,
            });
            if (proof) observation.sourceCancelledReads.push(proof);
            return !proof;
          });
        if (!isLive && nativeNetworkBaseline) {
          const compared = await classifyNativeNetworkFailures(
            [...unexpectedRequests, ...unexpectedResponses],
            nativeNetworkBaseline,
          );
          observation.nativeNetworkComparison = compared;
          if (!compared.validation.valid)
            throw new Error(
              "Native network observation became invalid: " +
                compared.validation.diagnostics
                  .map((item) => item.code)
                  .join(", "),
            );
          unexpectedRequests = compared.unexpectedFailures.filter(
            (item) => item.kind === "network",
          );
          unexpectedResponses = compared.unexpectedFailures.filter(
            (item) => item.kind === "http",
          );
        }
        observation.duplicateNetworkConsole = [];
        observation.unexpectedConsoleErrors = [];
        for (const message of observation.consoleMessages ?? []) {
          const duplicate = correlateNetworkConsole(
            message,
            observation.failedResponses,
          );
          if (duplicate) {
            observation.duplicateNetworkConsole.push(duplicate);
            continue;
          }
          // The browser's own requests (CDP type Other, such as /favicon.ico) are not page
          // requests; their HTTP console diagnostics are recorded but are not flow failures.
          const status = Number(/status of (\d{3})/.exec(message.text ?? "")?.[1]);
          const own =
            message.argumentCount === 0 &&
            message.url &&
            [...cdpRecords.values()].find((row) => {
              try {
                return row.type === "Other" && row.status === status && new URL(row.path, origin).href === message.url;
              } catch {
                return false;
              }
            });
          if (own)
            (observation.browserRequestConsole ??= []).push({ console: message, path: own.path, status });
          else observation.unexpectedConsoleErrors.push(message);
        }
        const failures = ["pageErrors", "blockedRequests"].filter(
          (key) => observation[key].length,
        );
        if (observation.unexpectedConsoleErrors.length)
          failures.push("consoleErrors");
        if (unexpectedRequests.length) failures.push("failedRequests");
        if (
          unexpectedResponses.some(
            (response) =>
              !(flow.allowedHttpStatuses ?? []).includes(response.status),
          )
        )
          failures.push("failedResponses");
        if (failures.length)
          throw new Error(
            `Runtime observations failed: ${failures.join(", ")}.`,
          );
        observation.passed = true;
      } catch (error) {
        observation.error = safeMessage(error.message);
        observation.pendingRequests = [...pending.values()].map((record) => ({
          ...record,
          elapsedMs: Date.now() - record.started,
        }));
        await capture("failure").catch(() => {});
      } finally {
        await Promise.allSettled(responseObservations);
        observation.finalUrl = safeUrl(page.url());
        if (!isLive)
          try {
            const response = await fetch(
              local.origin + "/__sim/api/audit/export",
              { signal: AbortSignal.timeout(timeout) },
            );
            if (response.ok) {
              observation.auditFile = path.join(
                outputDir,
                `${index + 1}-request-audit.json`,
              );
              await fs.writeFile(
                observation.auditFile,
                JSON.stringify(await response.json(), null, 2),
              );
            }
            observation.browserNetworkFile = path.join(
              outputDir,
              `${index + 1}-browser-network.json`,
            );
            const records = [...cdpRecords.values()].map((record) => {
              const url = new URL(record.path, local.origin);
              return {
                ...record,
                path: url.pathname,
                query: auditQuery(url.searchParams),
              };
            });
            await fs.writeFile(
              observation.browserNetworkFile,
              JSON.stringify({ records, frameEvents }, null, 2),
            );
          } catch (error) {
            observation.auditError = safeMessage(error.message);
          }
        await page.close();
      }
    }
    const final = await readState();
    result.sourceFingerprintAfter = final.status?.sourceFingerprint;
    result.sourceChanged =
      result.sourceFingerprint !== result.sourceFingerprintAfter;
    result.implementationFingerprintAfter =
      final.status?.implementationFingerprint;
    result.implementationChanged =
      result.implementationFingerprint !==
      result.implementationFingerprintAfter;
    result.passed =
      !result.sourceChanged &&
      !result.implementationChanged &&
      result.flows.every((flow) => flow.passed);
  } catch (error) {
    result.error = safeMessage(error.message);
  } finally {
    await ownedBrowser?.close();
    await attachedBrowser?.close();
    if (blockingProxy) await new Promise((resolve) => blockingProxy.close(resolve));
    result.report = path.join(outputDir, "report.json");
    await fs.writeFile(result.report, JSON.stringify(result, null, 2));
  }
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        local: { type: "string" },
        origin: { type: "string" },
        cdp: { type: "string" },
        plan: { type: "string" },
        output: {
          type: "string",
          default: ".paqvilo/simulator/acceptance/evidence",
        },
      },
    });
    const flows = JSON.parse(await fs.readFile(values.plan, "utf8"));
    const result = await runAcceptance({
      localUrl: values.local,
      liveOrigin: values.origin,
      cdpUrl: values.cdp,
      outputDir: values.output,
      flows,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(safeMessage(error.message));
    process.exitCode = 1;
  }
}
