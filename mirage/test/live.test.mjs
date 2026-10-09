import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LiveBridge,
  normalizeLiveRecord,
  validateLivePath,
} from "../lib/live.mjs";
import { AssetCache } from "../lib/asset-cache.mjs";
import { parseFetchXml } from "../lib/data.mjs";

const origin = "https://portal.example.test";
function response({
  status = 200,
  headers = { "content-type": "application/json" },
  body = "{}",
  url = origin + "/",
} = {}) {
  return {
    status: () => status,
    headers: () => headers,
    body: async () => Buffer.from(body),
    url: () => url,
    dispose: async () => {},
  };
}
function bridgeWith(handler, config = {}) {
  const bridge = new LiveBridge({ origin, ...config });
  const calls = [];
  bridge.context = {
    request: {
      fetch: async (url, options) => {
        calls.push({ url, options });
        return handler(url, options, calls.length);
      },
    },
  };
  return { bridge, calls };
}

test("live origins and paths reject credentials, traversal, encoded separators and uncontrolled methods", async () => {
  for (const value of [
    "http://portal.example.test",
    "https://user:password@portal.example.test",
    "https://portal.example.test/path",
  ])
    assert.throws(() => new LiveBridge({ origin: value }));
  for (const value of [
    "https://evil.test/x",
    "//evil.test/a",
    "/a/../b",
    "/%2e%2e/b",
    "/%252e%252e/b",
    "/a\\b",
    "/%5cb",
    "/asset.js#fragment",
    "/asset.js\n",
  ])
    assert.throws(() => validateLivePath(value));
  const { bridge } = bridgeWith(() => response());
  await assert.rejects(bridge.request("/safe", { method: "TRACE" }));
  await assert.rejects(
    bridge.request("/safe", { method: "GET", body: { secret: "body" } }),
  );
});

test("API reads and authorized writes retrieve real CSRF tokens and never forward caller token", async () => {
  const { bridge, calls } = bridgeWith(
    (url) =>
      url.endsWith("/_layout/tokenhtml")
        ? response({
            headers: { "content-type": "text/html" },
            body: '<input value="REAL_SESSION_TOKEN&amp;value" type="hidden" name="__RequestVerificationToken" />',
            url,
          })
        : response({ url }),
    { allowWrites: true },
  );
  await bridge.request("/_api/contacts", { verificationToken: "LOCAL_TOKEN" });
  await bridge.request("/_api/contacts", {
    method: "POST",
    body: { fullname: "Synthetic" },
    verificationToken: "LOCAL_TOKEN",
  });
  assert.equal(calls.length, 4);
  assert.equal(
    calls[1].options.headers.__RequestVerificationToken,
    "REAL_SESSION_TOKEN&value",
  );
  assert.equal(
    calls[3].options.headers.__RequestVerificationToken,
    "REAL_SESSION_TOKEN&value",
  );
  assert.equal(JSON.stringify(calls).includes("LOCAL_TOKEN"), false);
  assert.equal(
    calls.every((c) => c.options.maxRedirects === 0),
    true,
  );
  const deny = bridgeWith(() => response()).bridge;
  await assert.rejects(
    deny.request("/_api/contacts", { method: "POST", body: {} }),
    (e) => e.status === 403,
  );
});

test("authorized raw URL-encoded forms replace local antiforgery and retain repeated fields", async () => {
  const { bridge, calls } = bridgeWith(
    (url) =>
      url.endsWith("/_layout/tokenhtml")
        ? response({
            body: '<input name="__RequestVerificationToken" value="REAL&amp;SESSION"/>',
            url,
          })
        : response({
            status: 201,
            body: Buffer.from([0, 255, 128, 1]),
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": 'attachment; filename="example.bin"',
              "set-cookie": "NEVER_FORWARD",
              "content-length": "4",
            },
            url,
          }),
    { allowWrites: true },
  );
  const result = await bridge.request("/forms/create", {
    method: "POST",
    body: Buffer.from(
      "name=Synthetic+name&tags=A&tags=B&__RequestVerificationToken=LOCAL_TOKEN",
    ),
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
  });
  const submitted = new URLSearchParams(calls[1].options.data.toString());
  assert.deepEqual(submitted.getAll("tags"), ["A", "B"]);
  assert.equal(submitted.get("name"), "Synthetic name");
  assert.equal(submitted.get("__RequestVerificationToken"), "REAL&SESSION");
  assert.equal(
    calls[1].options.headers.__RequestVerificationToken,
    "REAL&SESSION",
  );
  assert.equal(calls[1].options.data.includes("LOCAL_TOKEN"), false);
  assert.deepEqual(result.body, Buffer.from([0, 255, 128, 1]));
  assert.deepEqual(result.headers, {
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="example.bin"',
  });
});

test("multipart uploads preserve file bytes and replace or add real session antiforgery fields", async () => {
  const boundary = "SyntheticBoundary123";
  const file = Buffer.from([0, 255, 128, 13, 10, 1]);
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="__RequestVerificationToken"\r\n\r\nLOCAL_TOKEN\r\n--${boundary}--\r\n`,
  );
  const { bridge, calls } = bridgeWith(
    (url) =>
      url.endsWith("/_layout/tokenhtml")
        ? response({
            body: '<input name="__RequestVerificationToken" value="REAL_SESSION"/>',
            url,
          })
        : response({ url }),
    { allowWrites: true },
  );
  await bridge.request("/forms/upload", {
    method: "POST",
    contentType: `multipart/form-data; boundary="${boundary}"`,
    body: Buffer.concat([prefix, file, suffix]),
  });
  const sent = calls[1].options.data;
  assert.equal(
    sent.subarray(prefix.length, prefix.length + file.length).equals(file),
    true,
  );
  assert.equal(sent.includes("LOCAL_TOKEN"), false);
  assert.equal(sent.includes("REAL_SESSION"), true);
  assert.equal(
    sent.subarray(-Buffer.byteLength(`--${boundary}--\r\n`)).toString(),
    `--${boundary}--\r\n`,
  );
  const without = Buffer.concat([
    prefix,
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  await bridge.request("/forms/upload", {
    method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: without,
  });
  assert.equal(
    calls[3].options.data.includes(
      'name="__RequestVerificationToken"\r\n\r\nREAL_SESSION',
    ),
    true,
  );
  assert.equal(calls[3].options.data.includes(file), true);
});

test("invalid and oversized form payloads fail before issuing a token or submitting data", async () => {
  const { bridge, calls } = bridgeWith(
    () => {
      throw new Error("No request should occur");
    },
    { allowWrites: true },
  );
  for (const options of [
    { body: Buffer.alloc(8 * 1024 * 1024 + 1) },
    {
      body: Buffer.from("x"),
      contentType: "application/json\r\nAuthorization: bad",
    },
    {
      body: Buffer.from("bad"),
      contentType: "multipart/form-data; boundary=example",
    },
    { body: Buffer.from("--example--"), contentType: "multipart/form-data" },
    {
      body: Buffer.from([255]),
      contentType: "application/x-www-form-urlencoded",
    },
  ])
    await assert.rejects(
      bridge.request("/form", { method: "POST", ...options }),
      (e) => [400, 413].includes(e.status),
    );
  assert.equal(calls.length, 0);
  const disabled = bridgeWith(() => {
    throw new Error("Must not read token");
  });
  await assert.rejects(
    disabled.bridge.request("/form", {
      method: "POST",
      body: Buffer.from("x=1"),
      contentType: "application/x-www-form-urlencoded",
    }),
    (e) => e.status === 403,
  );
  assert.equal(disabled.calls.length, 0);
});

test("raw JSON and non-form binary requests preserve bytes exactly", async () => {
  const { bridge, calls } = bridgeWith(
    (url) =>
      url.endsWith("/_layout/tokenhtml")
        ? response({
            body: '<input name="__RequestVerificationToken" value="REAL"/>',
            url,
          })
        : response({ url }),
    { allowWrites: true },
  );
  for (const [contentType, body] of [
    ["application/json", Buffer.from('{"example":"Synthetic"}')],
    ["application/octet-stream", Buffer.from([0, 255, 1])],
  ]) {
    await bridge.request("/endpoint", { method: "PATCH", contentType, body });
    assert.deepEqual(calls.at(-1).options.data, body);
  }
});

test("live conditional requests preserve concurrency headers and reject header injection", async () => {
  const { bridge, calls } = bridgeWith(
    (url) =>
      url.endsWith("/_layout/tokenhtml")
        ? response({
            body: '<input name="__RequestVerificationToken" value="REAL"/>',
            url,
          })
        : response({ status: 412, url }),
    { allowWrites: true },
  );
  const result = await bridge.request("/_api/contacts(example)", {
    method: "PATCH",
    body: Buffer.from("{}"),
    ifMatch: 'W/"123"',
    ifNoneMatch: "*",
  });
  assert.equal(result.status, 412);
  assert.equal(calls[1].options.headers["if-match"], 'W/"123"');
  assert.equal(calls[1].options.headers["if-none-match"], "*");
  const before = calls.length;
  await assert.rejects(
    bridge.request("/read", { ifMatch: "*\r\nCookie: bad" }),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, before);
});

test("live record normalization respects actual choice metadata and keeps numeric and aggregate values", () => {
  const row = {
    _parentcustomerid_value: "account-id",
    "_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname":
      "account",
    "_parentcustomerid_value@OData.Community.Display.V1.FormattedValue":
      "Synthetic account",
    customchoice: 1,
    "customchoice@OData.Community.Display.V1.FormattedValue": "Choice A",
    calculatedtype: 3,
    "calculatedtype@OData.Community.Display.V1.FormattedValue": "3",
    customstatus: 2,
    "customstatus@OData.Community.Display.V1.FormattedValue": "Enabled",
  };
  const mapping = {
    fields: {
      customchoice: { type: "number", dataverseType: "picklist" },
      calculatedtype: { type: "number", dataverseType: "int" },
      customstatus: { type: "number", dataverseType: "status" },
    },
  };
  const normalized = normalizeLiveRecord(row, mapping);
  assert.deepEqual(normalized.parentcustomerid, {
    id: "account-id",
    name: "Synthetic account",
    logical_name: "account",
  });
  assert.deepEqual(normalized.customchoice, { value: 1, label: "Choice A" });
  assert.equal(normalized.calculatedtype, 3);
  assert.deepEqual(normalized.customstatus, { value: 2, label: "Enabled" });
  assert.equal(
    normalizeLiveRecord(row, mapping, { aggregate: true }).customchoice,
    1,
  );
});

test("live redirects and response headers stay origin-confined without credentials", async () => {
  const { bridge } = bridgeWith((url) =>
    response({
      status: 302,
      headers: { location: "https://login.example.test/authorize?code=secret" },
      url,
    }),
  );
  await assert.rejects(
    bridge.request("/page"),
    (e) => e.status === 401 && !e.message.includes("secret"),
  );
  const same = bridgeWith((url) =>
    response({
      status: 302,
      headers: { location: "/styles/next.css", "set-cookie": "secret" },
      url,
    }),
  ).bridge;
  assert.deepEqual((await same.request("/styles/first.css")).headers, {
    "content-type": "application/octet-stream",
    location: "/styles/next.css",
  });
  const headers = bridgeWith((url) =>
    response({
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=secret",
        authorization: "Bearer secret",
        etag: "version",
      },
      url,
    }),
  ).bridge;
  assert.deepEqual((await headers.request("/safe")).headers, {
    "content-type": "application/json",
    etag: "version",
  });
  const failure = bridgeWith(() => {
    throw new Error(
      "Request failed https://portal.example.test/?access_token=TOP_SECRET Authorization: password",
    );
  }).bridge;
  await assert.rejects(
    failure.request("/safe"),
    (e) => !e.message.includes("TOP_SECRET") && !e.message.includes("password"),
  );
  const escaped = bridgeWith(() =>
    response({ url: "https://elsewhere.example.test/a" }),
  ).bridge;
  await assert.rejects(escaped.request("/safe"));
});

test("live FetchXML resolves native portal entity mappings and optional endpoint override", async () => {
  await assert.rejects(
    new LiveBridge({ origin }).fetchXml("<fetch/>"),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      new LiveBridge({ origin, fetchXmlPath: "https://evil.test/{fetchXml}" }),
  );
  const { bridge, calls } = bridgeWith(
    (url) =>
      response({
        body: JSON.stringify({
          value: [{ contactid: "local-example" }],
          "@odata.count": 1,
        }),
        url,
      }),
    { fetchXmlPath: "/local-fetch?xml={fetchXml}" },
  );
  const result = await bridge.fetchXml(
    '<fetch><entity name="contact"/></fetch>',
  );
  assert.equal(result.entities.length, 1);
  assert.equal(result.total_record_count, 1);
  assert.equal(calls[0].url.includes("%3Cfetch%3E"), true);
});

test("native live FetchXML preserves joins/filters and normalizes lookup/choice annotations with CRM paging", async () => {
  const cookie = '<cookie page="1"><contactid last="row1" /></cookie>';
  const payload = {
    value: [
      {
        contactid: "row1",
        _parentcustomerid_value: "org1",
        "_parentcustomerid_value@OData.Community.Display.V1.FormattedValue":
          "Example organisation",
        "_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname":
          "account",
        statuscode: 1,
        "statuscode@OData.Community.Display.V1.FormattedValue": "Active",
        amount: 17.5,
        "amount@OData.Community.Display.V1.FormattedValue": "€17.50",
      },
    ],
    "@Microsoft.Dynamics.CRM.morerecords": true,
    "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie": `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent(cookie))}" />`,
    "@Microsoft.Dynamics.CRM.totalrecordcount": 2,
  };
  const { bridge, calls } = bridgeWith((url) =>
    url.endsWith("/_layout/tokenhtml")
      ? response({
          body: '<input name="__RequestVerificationToken" value="REAL"/>',
          url,
        })
      : response({ body: JSON.stringify(payload), url }),
  );
  const xml =
    '<fetch count="1"><entity name="contact"><attribute name="statuscode"/><link-entity name="account" from="accountid" to="parentcustomerid"/><filter><condition attribute="statuscode" operator="eq" value="1"/></filter></entity></fetch>';
  const result = await bridge.fetchXml(xml, {
    contact: { entitySet: "contacts", idColumn: "contactid" },
  });
  assert.equal(new URL(calls[1].url).searchParams.get("fetchXml"), xml);
  assert.equal(
    calls[1].options.headers.Prefer,
    'odata.include-annotations="*"',
  );
  assert.deepEqual(result.entities[0].parentcustomerid, {
    id: "org1",
    name: "Example organisation",
    logical_name: "account",
  });
  assert.deepEqual(result.entities[0].statuscode, {
    value: 1,
    label: "Active",
  });
  assert.equal(result.entities[0].amount, 17.5);
  assert.equal(result.more_records, true);
  assert.equal(result.paging_cookie, cookie);
  assert.equal(result.total_record_count, 2);
});

test("native FetchXML top uses a bounded first page and rejects an endpoint ignoring limits", async () => {
  let records = [{ accountid: "one" }];
  const { bridge, calls } = bridgeWith((url) =>
    url.endsWith("/_layout/tokenhtml")
      ? response({
          body: '<input name="__RequestVerificationToken" value="REAL"/>',
          url,
        })
      : response({
          body: JSON.stringify({
            value: records,
            "@Microsoft.Dynamics.CRM.morerecords": true,
            "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie":
              '<cookie page="1"/>',
          }),
          url,
        }),
  );
  const result = await bridge.fetchXml(
    `<fetch top="1"><entity name="account"><attribute name="accountid"/><filter><condition attribute="name" operator="eq" value="A &amp; B"/></filter></entity></fetch>`,
    { entitySet: "accounts" },
  );
  const sent = parseFetchXml(
    new URL(calls.at(-1).url).searchParams.get("fetchXml"),
  );
  assert.equal(sent.attrs.top, undefined);
  assert.equal(sent.attrs.count, "1");
  assert.equal(sent.attrs.page, "1");
  assert.equal(sent.children[0].children[1].children[0].attrs.value, "A & B");
  assert.equal(result.entities.length, 1);
  assert.equal(result.more_records, false);
  assert.equal(result.paging_cookie, null);
  records.push({ accountid: "two" });
  await assert.rejects(
    bridge.fetchXml('<fetch top="1"><entity name="account"/></fetch>', {
      entitySet: "accounts",
    }),
    /violates.*record limit/,
  );
  await assert.rejects(
    bridge.fetchXml('<fetch count="1"><entity name="account"/></fetch>', {
      entitySet: "accounts",
    }),
    /violates.*record limit/,
  );
  await assert.rejects(
    bridge.fetchXml(
      '<fetch top="1" count="1"><entity name="account"/></fetch>',
      { entitySet: "accounts" },
    ),
    /without count or paging/,
  );
});

test("native FetchXML OData continuation is retained and confined, and incomplete paging is rejected", async () => {
  const { bridge, calls } = bridgeWith((url) =>
    url.endsWith("/_layout/tokenhtml")
      ? response({
          body: '<input name="__RequestVerificationToken" value="REAL"/>',
          url,
        })
      : response({
          body: JSON.stringify(
            url.includes("skiptoken")
              ? { value: [{ contactid: "next" }] }
              : {
                  value: [{ contactid: "first" }],
                  "@odata.nextLink": origin + "/_api/contacts?$skiptoken=NEXT",
                },
          ),
          url,
        }),
  );
  const first = await bridge.fetchXml(
    '<fetch><entity name="contact"/></fetch>',
    { entitySet: "contacts" },
  );
  assert.equal(first.more_records, true);
  assert.match(first.paging_cookie, /^paqvilo-mirage-next:/);
  const second = await bridge.fetchXml(
    `<fetch paging-cookie="${first.paging_cookie}"><entity name="contact"/></fetch>`,
    { entitySet: "contacts" },
  );
  assert.equal(second.entities[0].contactid, "next");
  assert.equal(calls.at(-1).url, origin + "/_api/contacts?$skiptoken=NEXT");
  const incomplete = bridgeWith(
    (url) =>
      response({
        body: JSON.stringify({ value: [], more_records: true }),
        url,
      }),
    { fetchXmlPath: "/query?xml={fetchXml}" },
  ).bridge;
  await assert.rejects(
    incomplete.fetchXml('<fetch><entity name="contact"/></fetch>'),
    /Incomplete results/,
  );
  const escaped = bridgeWith(
    (url) =>
      response({
        body: JSON.stringify({
          value: [],
          "@odata.nextLink": "https://other.test/_api/contacts?token=secret",
        }),
        url,
      }),
    { fetchXmlPath: "/query?xml={fetchXml}" },
  ).bridge;
  await assert.rejects(
    escaped.fetchXml('<fetch><entity name="contact"/></fetch>'),
    (e) => !e.message.includes("secret"),
  );
});

test("native FetchXML rejects mismatched mappings and preserves literal percent sequences inside decoded XML cookies", async () => {
  const cookie = '<cookie page="1"><name last="Synthetic%25label"/></cookie>';
  const { bridge, calls } = bridgeWith(
    (url) =>
      response({
        body: JSON.stringify({
          value: [],
          more_records: true,
          paging_cookie: cookie,
        }),
        url,
      }),
    { fetchXmlPath: "/query?xml={fetchXml}" },
  );
  await assert.rejects(
    bridge.fetchXml('<fetch><entity name="contact"/></fetch>', {
      logicalName: "account",
      entitySet: "accounts",
    }),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, 0);
  const result = await bridge.fetchXml(
    '<fetch><entity name="contact"/></fetch>',
    { logicalName: "contact", entitySet: "contacts" },
  );
  assert.equal(result.paging_cookie, cookie);
});

test("asset cache captures verified static bytes, persists digest metadata and follows only same-origin static redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-assets-"));
  try {
    const { bridge } = bridgeWith((url) =>
      url.endsWith("first.css")
        ? response({
            status: 302,
            headers: { location: "/styles/final.css" },
            url,
          })
        : response({
            headers: {
              "content-type": url.includes(".css")
                ? "text/css; charset=utf-8"
                : "application/javascript",
              "set-cookie": "SESSION_SECRET",
            },
            body: url.includes(".css")
              ? "body{color:red}"
              : "window.localExample = true;",
            url,
          }),
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await cache.capture(
      ["/xrm-adx/js/jquery-ui-1.11.4.min.js", "/styles/first.css"],
      bridge,
    );
    assert.equal(result.captured.length, 2);
    assert.equal(result.failures.length, 0);
    const manifestText = await readFile(
      join(directory, "manifest.json"),
      "utf8",
    );
    assert.equal(manifestText.includes("SESSION_SECRET"), false);
    assert.equal(manifestText.includes("cookie"), false);
    const restored = await new AssetCache({ directory, origin }).init();
    assert.equal(
      (await restored.get("/styles/first.css")).body.toString(),
      "body{color:red}",
    );
    assert.equal(restored.manifest().assets[1].finalPath, "/styles/final.css");
    assert.equal(await restored.get("/"), null);
    assert.equal(await restored.get("/workspace/"), null);
    assert.equal(
      (await restored.get("/styles/first.css?_=1234567890")).body.toString(),
      "body{color:red}",
    );
    assert.equal(await restored.get("/styles/first.css?_=abc"), null);
    assert.equal(await restored.get("/styles/first.css?_=123&_=456"), null);
    assert.equal(
      await restored.get("/styles/first.css?variant=other&_=123"),
      null,
    );
    await assert.rejects(restored.get("/styles/first.css?token=SECRET&_=123"));
    assert.equal(
      await restored.get("/styles/first.css", { origin: null }),
      null,
    );
    const item = result.captured[0];
    await writeFile(join(directory, item.sha256 + ".bin"), "corrupted");
    await assert.rejects(
      restored.get(item.path),
      (e) => e.code === "ASSET_INTEGRITY",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("proven empty JavaScript response preserves observed bytes with explicit inference diagnostic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-assets-empty-"));
  try {
    const { bridge } = bridgeWith((url) =>
      response({ headers: {}, body: "", url }),
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await cache.capture(["/empty.js"], bridge);
    assert.equal(result.captured[0].bytes, 0);
    assert.equal(result.captured[0].diagnostic, "ASSET_OBSERVED_EMPTY");
    assert.equal(result.captured[0].contentTypeInferred, true);
    assert.equal((await cache.get("/empty.js")).body.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset capture rejects login HTML, mismatched types, sensitive query parameters and cross-origin redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-assets-"));
  try {
    const { bridge } = bridgeWith((url) =>
      url.includes("redirect")
        ? response({
            status: 302,
            headers: { location: "https://evil.test/code.js" },
            url,
          })
        : url.includes("html")
          ? response({
              headers: { "content-type": "application/javascript" },
              body: '<!doctype html><html><form><input name="password"></form></html>',
              url,
            })
          : response({
              headers: { "content-type": "text/html" },
              body: "<h1>Sign in</h1>",
              url,
            }),
    );
    const cache = await new AssetCache({ directory, origin }).init();
    const result = await cache.capture(
      [
        "/html.js",
        "/wrong.js",
        "/redirect.js",
        "/code.js?access_token=DO_NOT_SAVE",
        "/%2e%2e/code.js",
      ],
      bridge,
    );
    assert.equal(result.captured.length, 0);
    assert.equal(result.failures.length, 5);
    assert.equal(JSON.stringify(result).includes("DO_NOT_SAVE"), false);
    assert.equal(cache.manifest().assets.length, 0);
    await assert.rejects(
      cache.capture(["/code.js"], {
        origin: "https://another.example.test",
        request: () => {
          throw new Error("should not run");
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Microsoft platform CDN capture uses isolated anonymous requests and rejects other origins and paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-assets-public-"));
  try {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return new Response("window.bootstrapExample=true;", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          "set-cookie": "DO_NOT_PERSIST",
        },
      });
    };
    const cache = await new AssetCache({ directory, origin, fetchImpl }).init();
    const result = await cache.capturePublic([
      "/resource/powerappsportal/dist/bootstrap.js",
    ]);
    assert.equal(result.captured.length, 1);
    assert.equal(
      result.captured[0].sourceOrigin,
      "https://content.powerapps.com",
    );
    assert.equal(calls[0].options.credentials, "omit");
    assert.deepEqual(Object.keys(calls[0].options.headers), ["accept"]);
    assert.equal(
      (
        await cache.get("/resource/powerappsportal/dist/bootstrap.js")
      ).body.toString(),
      "window.bootstrapExample=true;",
    );
    await assert.rejects(cache.capturePublic(["/other.js"]));
    assert.equal(
      (await readFile(join(directory, "manifest.json"), "utf8")).includes(
        "DO_NOT_PERSIST",
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CSS platform capture follows font dependencies and explicitly reports external dependency exclusion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pp-assets-css-"));
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return url.endsWith(".css")
        ? new Response(
            "@font-face{src:url(../fonts/local.woff)} body{background:url(https://outside.example.test/image.png)}",
            { headers: { "content-type": "text/css" } },
          )
        : new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "font/woff" },
          });
    };
    const cache = await new AssetCache({ directory, origin, fetchImpl }).init();
    const result = await cache.capturePublic([
      "/resource/powerappsportal/dist/style.css",
    ]);
    assert.equal(result.captured.length, 2);
    assert.equal(
      result.captured[1].path,
      "/resource/powerappsportal/fonts/local.woff",
    );
    assert.equal(result.failures[0].code, "ASSET_DEPENDENCY_ORIGIN");
    assert.equal(
      calls.some((url) => url.includes("outside.example.test")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
