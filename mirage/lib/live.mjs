import { chromium } from "playwright-core";
import { parseFetchXml, withLiquidEntityId } from "./data.mjs";

const fail = (message, status = 502) =>
  Object.assign(new Error(message), { status, code: "LIVE_BRIDGE" });

/** Validate before URL normalization can hide traversal or encoded separators. */
export function validateLivePath(pathname) {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    /[\\\u0000-\u001f\u007f#]/.test(pathname)
  )
    throw fail(
      "Live paths must be relative to the configured origin without fragments or control characters.",
      400,
    );
  let decoded = pathname.split("?")[0];
  for (let i = 0; i < 3; i++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw fail("Live path has invalid percent encoding.", 400);
    }
    if (
      decoded.includes("\\") ||
      decoded.startsWith("//") ||
      decoded.split("/").some((s) => s === ".." || s === ".") ||
      /[\u0000-\u001f\u007f?#]/.test(decoded)
    )
      throw fail(
        "Live path traversal or encoded path delimiters are not allowed.",
        400,
      );
    if (!/%[\da-f]{2}/i.test(decoded)) break;
  }
  return pathname;
}

const tokenDecode = (value) =>
  value.replace(
    /&amp;|&quot;|&#39;|&apos;|&lt;|&gt;/g,
    (v) =>
      ({
        "&amp;": "&",
        "&quot;": '"',
        "&#39;": "'",
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      })[v],
  );
const formatted = "@OData.Community.Display.V1.FormattedValue";
const lookupType = "@Microsoft.Dynamics.CRM.lookuplogicalname";
const moreFlag = (value) => value === true || value === "true" || value === 1;
export function normalizeLiveRecord(
  record,
  mapping,
  { aggregate = false } = {},
) {
  const output = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (key.includes("@")) continue;
    const label = record[key + formatted];
    const logical = record[key + lookupType];
    const lookup = /^_(.*)_value$/.exec(key);
    if (lookup || logical) {
      const name = lookup?.[1] ?? key;
      output[name] =
        value == null
          ? null
          : { id: value, name: label ?? "", logical_name: logical ?? null };
    } else if (typeof value === "number" && label != null && !aggregate) {
      const definition =
        mapping?.fields?.[key] ?? mapping?.fieldMetadata?.[key];
      const type = String(
        definition?.dataverseType ?? definition?.type ?? "",
      ).toLowerCase();
      if (
        definition?.options ||
        ["picklist", "state", "status", "choice", "optionset"].includes(type) ||
        (!definition && /(?:status|state|code|type)$/i.test(key))
      )
        output[key] = { value, label };
    }
  }
  return withLiquidEntityId(output, mapping, { aggregate });
}
export function decodePagingCookie(value) {
  if (!value) return null;
  let result = String(value);
  const nested = /\bpagingcookie\s*=\s*(["'])(.*?)\1/i.exec(result);
  if (nested) result = tokenDecode(nested[2]);
  if (nested || !result.trimStart().startsWith("<"))
    for (let i = 0; i < 2 && /%[\da-f]{2}/i.test(result); i++) {
      try {
        result = decodeURIComponent(result);
      } catch {
        throw fail("Live FetchXML returned an invalid encoded paging cookie.");
      }
    }
  return tokenDecode(result);
}
const escapeFetchXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const serializeFetchXml = (node) =>
  `<${node.name}${Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeFetchXml(value)}"`)
    .join(
      "",
    )}>${escapeFetchXml(node.text ?? "")}${node.children.map(serializeFetchXml).join("")}</${node.name}>`;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const csrfField = "__RequestVerificationToken";
function checkedContentType(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !/^[-\w!#$&^_.+]+\/[-\w!#$&^_.+]+(?:\s*;.*)?$/.test(value)
  )
    throw fail("Invalid live Content-Type header.", 400);
  return value;
}
function checkedBody(body) {
  let size;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array)
    size = body.byteLength;
  else if (typeof body === "string") size = Buffer.byteLength(body);
  else {
    try {
      size = Buffer.byteLength(JSON.stringify(body));
    } catch {
      throw fail("Live request body is not serializable.", 400);
    }
  }
  if (size > MAX_REQUEST_BYTES)
    throw fail("Live request body exceeds the 8 MiB limit.", 413);
  return body instanceof Uint8Array && !Buffer.isBuffer(body)
    ? Buffer.from(body)
    : body;
}
/** Build a replacement without decoding uploaded bytes or accepting malformed MIME framing. */
function formTokenWriter(body, contentType) {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (
    !["application/x-www-form-urlencoded", "multipart/form-data"].includes(mime)
  )
    return null;
  if (typeof body !== "string" && !Buffer.isBuffer(body))
    throw fail("Live form requests require raw encoded bytes.", 400);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (mime === "application/x-www-form-urlencoded") {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw fail("Live URL-encoded form is not valid UTF-8.", 400);
    }
    const params = new URLSearchParams(text);
    return (token) => {
      params.set(csrfField, token);
      return Buffer.from(params.toString());
    };
  }
  const match = /;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (
    !boundary ||
    boundary.length > 70 ||
    !/^[\x21-\x7e]+$/.test(boundary) ||
    /["\\]/.test(boundary)
  )
    throw fail("Live multipart form needs a valid boundary.", 400);
  const delimiter = Buffer.from("--" + boundary),
    marker = Buffer.from("\r\n--" + boundary),
    separator = Buffer.from("\r\n\r\n");
  const fields = [];
  let cursor = 0,
    closing = -1,
    parts = 0;
  if (!bytes.subarray(0, delimiter.length).equals(delimiter))
    throw fail("Malformed live multipart form framing.", 400);
  while (cursor < bytes.length) {
    const suffix = cursor + delimiter.length;
    if (bytes.subarray(suffix, suffix + 2).toString() === "--") {
      closing = cursor;
      if (!["", "\r\n"].includes(bytes.subarray(suffix + 2).toString()))
        throw fail("Malformed live multipart closing boundary.", 400);
      break;
    }
    if (
      bytes.subarray(suffix, suffix + 2).toString() !== "\r\n" ||
      ++parts > 1000
    )
      throw fail("Malformed or excessive live multipart form parts.", 400);
    const headerStart = suffix + 2,
      headerEnd = bytes.indexOf(separator, headerStart);
    if (headerEnd < 0 || headerEnd - headerStart > 16384)
      throw fail("Malformed live multipart part headers.", 400);
    const next = bytes.indexOf(marker, headerEnd + 4);
    if (next < 0)
      throw fail("Live multipart form has no closing boundary.", 400);
    const headers = bytes.subarray(headerStart, headerEnd).toString("latin1");
    const disposition =
      /^content-disposition:\s*form-data\s*;([^\r\n]*)/im.exec(headers)?.[1];
    if (!disposition)
      throw fail("Live multipart part needs a form-data disposition.", 400);
    const name = /(?:^|;)\s*name="([^"\r\n]*)"/i.exec(disposition)?.[1];
    if (name === csrfField) {
      if (/(?:^|;)\s*filename\*?\s*=/i.test(disposition))
        throw fail("Live antiforgery form field cannot be a file upload.", 400);
      fields.push({ start: headerEnd + 4, end: next });
    }
    cursor = next + 2;
  }
  if (closing < 0)
    throw fail("Live multipart form has no closing boundary.", 400);
  return (token) => {
    const chunks = [];
    let start = 0;
    for (const field of fields) {
      chunks.push(bytes.subarray(start, field.start), Buffer.from(token));
      start = field.end;
    }
    chunks.push(bytes.subarray(start, closing));
    if (!fields.length)
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${csrfField}"\r\n\r\n${token}\r\n`,
        ),
      );
    chunks.push(bytes.subarray(closing));
    return Buffer.concat(chunks);
  };
}
function safeResponseHeaders(headers) {
  const output = {
    "content-type": headers["content-type"] || "application/octet-stream",
  };
  for (const name of [
    "entityid",
    "etag",
    "content-disposition",
    "content-language",
    "last-modified",
  ])
    if (
      typeof headers[name] === "string" &&
      !/[\r\n\u0000]/.test(headers[name])
    )
      output[name] = headers[name];
  if (/[\r\n\u0000]/.test(output["content-type"]))
    throw fail("Invalid live response Content-Type.");
  return output;
}

/** Uses a connected browser's own cookie jar. No cookies or credentials are exported. */
export class LiveBridge {
  /**
   * `writesPermitted`: whether this runtime may send any write to the live environment at
   * all. The Mirage runtime passes it only when started with --allow-live-writes; then
   * the connection's allowWrites switch decides. A bridge built directly (tools, tests)
   * keeps the switch alone.
   */
  constructor(config = {}, { writesPermitted = true } = {}) {
    this.writesPermitted = writesPermitted === true;
    this.configure(config);
  }
  configure(config = {}) {
    if (config.origin) {
      const url = new URL(config.origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw fail(
          "Live origin must be an HTTPS origin without credentials or a path.",
          400,
        );
      this.origin = url.origin;
    } else this.origin = null;
    this.allowWrites = config.allowWrites === true;
    this.fetchXmlPath = config.fetchXmlPath || null;
    if (this.fetchXmlPath) {
      validateLivePath(
        this.fetchXmlPath
          .replaceAll("{fetchXml}", "local")
          .replaceAll("{entitySet}", "entity"),
      );
      if (!this.fetchXmlPath.includes("{fetchXml}"))
        throw fail("fetchXmlPath must contain {fetchXml}.", 400);
    }
  }
  async connect(cdpUrl) {
    const url = new URL(cdpUrl);
    if (
      !["http:", "ws:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw fail("Use a loopback browser debugging endpoint.", 400);
    await this.close();
    let browser;
    try {
      browser = await chromium.connectOverCDP(url.href, { timeout: 10000 });
    } catch {
      throw fail(
        "Could not connect to the loopback browser debugging endpoint. Confirm its port and availability.",
        409,
      );
    }
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      await browser.close();
      throw fail(
        "The debugging endpoint must expose exactly one browser identity.",
        400,
      );
    }
    this.browser = browser;
    this.context = contexts[0];
    browser.on("disconnected", () => {
      this.context = null;
      this.browser = null;
    });
    return this.status();
  }
  status() {
    return {
      connected: Boolean(this.context),
      origin: this.origin,
      allowWrites: this.allowWrites,
      // "disabled": the runtime was not started with --allow-live-writes; "off": allowed but
      // switched off; "enabled": writes reach the live environment.
      liveWrites: !this.writesPermitted ? "disabled" : this.allowWrites ? "enabled" : "off",
      fetchXmlPath: this.fetchXmlPath,
      fetchXmlMode: this.fetchXmlPath ? "endpoint" : "portal-web-api",
    };
  }
  async request(
    pathname,
    {
      method = "GET",
      body,
      contentType = "application/json",
      prefer,
      ifMatch,
      ifNoneMatch,
    } = {},
  ) {
    if (!this.origin)
      throw fail("Configure the live portal origin in the admin page.", 409);
    if (!this.context)
      throw fail(
        "Connect the intended signed-in browser in the admin page.",
        409,
      );
    validateLivePath(pathname);
    const url = new URL(pathname, this.origin);
    if (url.origin !== this.origin)
      throw fail("Cross-origin forwarding is not allowed.", 400);
    method = method.toUpperCase();
    if (
      !["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"].includes(
        method,
      )
    )
      throw fail("Unsupported live HTTP method.", 400);
    if (["GET", "HEAD"].includes(method) && body !== undefined)
      throw fail("Read requests cannot carry a body.", 400);
    if (!["GET", "HEAD"].includes(method) && !this.writesPermitted)
      throw Object.assign(
        fail(
          "Live writes are disabled for this runtime: start the Mirage with --allow-live-writes (mirage dev and start pass it through) to send create, update or delete requests to the live environment.",
          403,
        ),
        { code: "LIVE_WRITES_DISABLED" },
      );
    if (!["GET", "HEAD"].includes(method) && !this.allowWrites)
      throw fail(
        "Live writes are disabled. Enable them explicitly in the connection settings.",
        403,
      );
    const headers = { accept: "*/*" };
    if (prefer != null) {
      if (
        typeof prefer !== "string" ||
        prefer.length > 512 ||
        /[\r\n]/.test(prefer)
      )
        throw fail("Invalid live Prefer header.", 400);
      headers.Prefer = prefer;
    }
    for (const [name, value] of [
      ["if-match", ifMatch],
      ["if-none-match", ifNoneMatch],
    ])
      if (value != null) {
        if (
          typeof value !== "string" ||
          value.length > 512 ||
          /[\u0000-\u001f\u007f]/.test(value)
        )
          throw fail("Invalid live conditional request header.", 400);
        headers[name] = value;
      }
    let tokenWriter;
    if (body !== undefined) {
      headers["content-type"] = checkedContentType(contentType);
      body = checkedBody(body);
      tokenWriter = formTokenWriter(body, contentType);
    }
    if (
      !["GET", "HEAD"].includes(method) ||
      url.pathname.startsWith("/_api/")
    ) {
      // The real portal issues a session-bound antiforgery token. Never forward a local token.
      const token = await this.verificationToken();
      if (
        typeof token !== "string" ||
        token.length > 16384 ||
        /[\r\n\u0000]/.test(token)
      )
        throw fail("The live portal issued an invalid verification token.");
      headers.__RequestVerificationToken = token;
      if (tokenWriter) body = checkedBody(tokenWriter(token));
    }
    let response, status, responseHeaders, bytes;
    try {
      response = await this.context.request.fetch(url.href, {
        method,
        data: body,
        headers,
        maxRedirects: 0,
        timeout: 30000,
        failOnStatusCode: false,
      });
      status = response.status();
      responseHeaders = response.headers();
      const responseUrl = new URL(response.url?.() || url.href);
      if (responseUrl.origin !== this.origin)
        throw fail("Live response escaped the configured origin.", 400);
      bytes = await response.body();
      if (bytes.length > 32 * 1024 * 1024)
        throw fail("Live response exceeds the 32 MiB limit.", 413);
    } catch (error) {
      if (error.code === "LIVE_BRIDGE") throw error;
      throw fail(
        "The live portal request failed or timed out. Inspect the connected browser and its network state.",
      );
    } finally {
      await response?.dispose();
    }
    if (status >= 300 && status < 400) {
      let target;
      try {
        target = new URL(responseHeaders.location || "/", url.href);
      } catch {
        throw fail("The live portal returned an invalid redirect.", 502);
      }
      if (
        target.origin !== this.origin ||
        /signin|login|authorize/i.test(target.pathname)
      )
        throw fail(
          "The connected browser must complete portal sign-in. No redirect or credential was forwarded.",
          401,
        );
      if (target.username || target.password || target.hash)
        throw fail(
          "Live redirects must remain at the configured origin without credentials or fragments.",
          400,
        );
      validateLivePath(target.pathname + target.search);
      return {
        status,
        headers: {
          ...safeResponseHeaders(responseHeaders),
          location: target.pathname + target.search,
        },
        body: bytes,
      };
    }
    return {
      status,
      headers: safeResponseHeaders(responseHeaders),
      body: bytes,
    };
  }
  async verificationToken() {
    const response = await this.request("/_layout/tokenhtml");
    if (response.status !== 200)
      throw fail(
        "The live portal did not issue a verification token. Complete sign-in in its browser.",
        401,
      );
    for (const input of response.body
      .toString("utf8")
      .match(/<input\b[^>]*>/gi) ?? []) {
      const attrs = Object.fromEntries(
        [...input.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [
          m[1].toLowerCase(),
          m[3],
        ]),
      );
      if (attrs.name === "__RequestVerificationToken" && attrs.value)
        return tokenDecode(attrs.value);
    }
    throw fail(
      "The live portal did not issue a verification token. Complete sign-in in its browser.",
      401,
    );
  }
  async fetchXml(xml, mappingOrMap) {
    let fetch;
    try {
      fetch = parseFetchXml(xml);
    } catch {
      throw fail(
        "Live FetchXML requires a complete valid fetch document.",
        400,
      );
    }
    const root = fetch.children.find((node) => node.name === "entity");
    if (
      !root?.attrs.name ||
      fetch.children.filter((node) => node.name === "entity").length !== 1
    )
      throw fail("Live FetchXML requires exactly one entity.", 400);
    const mapping = mappingOrMap?.entitySet
      ? mappingOrMap
      : mappingOrMap?.[root.attrs.name];
    let nativeXml = xml;
    const top = fetch.attrs.top == null ? null : Number(fetch.attrs.top);
    if (
      top != null &&
      (!Number.isSafeInteger(top) ||
        top < 1 ||
        top > 5000 ||
        fetch.attrs.count ||
        fetch.attrs.page ||
        fetch.attrs["paging-cookie"])
    )
      throw fail(
        "Live FetchXML top requires a positive limit up to 5000 without count or paging attributes.",
        400,
      );
    if (top != null && !this.fetchXmlPath) {
      // Observed reference-portal ignores top, but honors count/page. Request the same bounded
      // first result page and suppress continuation to preserve FetchXML top semantics.
      const attrs = { ...fetch.attrs, count: String(top), page: "1" };
      delete attrs.top;
      nativeXml = serializeFetchXml({ ...fetch, attrs });
    }
    if (
      mapping?.logicalName &&
      mapping.logicalName.toLowerCase() !== root.attrs.name.toLowerCase()
    )
      throw fail("Live FetchXML mapping does not match its root entity.", 400);
    let requestPath;
    if (this.fetchXmlPath)
      requestPath = this.fetchXmlPath
        .replaceAll("{fetchXml}", encodeURIComponent(xml))
        .replaceAll(
          "{entitySet}",
          encodeURIComponent(mapping?.entitySet ?? ""),
        );
    else {
      if (!mapping?.entitySet || !/^\w+$/.test(mapping.entitySet))
        throw fail(
          `Live FetchXML needs an entity-set mapping for ${root.attrs.name}.`,
          400,
        );
      requestPath = `/_api/${mapping.entitySet}?fetchXml=${encodeURIComponent(nativeXml)}`;
      const cookie = fetch.attrs["paging-cookie"];
      if (cookie?.startsWith("paqvilo-mirage-next:")) {
        let continuation;
        try {
          continuation = Buffer.from(
            cookie.slice("paqvilo-mirage-next:".length),
            "base64url",
          ).toString("utf8");
          validateLivePath(continuation);
        } catch {
          throw fail("Invalid live FetchXML continuation cookie.", 400);
        }
        if (!continuation.startsWith(`/_api/${mapping.entitySet}?`))
          throw fail("Live FetchXML continuation escaped its entity set.", 400);
        requestPath = continuation;
      }
    }
    const response = await this.request(requestPath, {
      prefer: 'odata.include-annotations="*"',
    });
    if (response.status !== 200)
      throw fail(
        `Live FetchXML returned HTTP ${response.status}. The connected user and portal Web API table/field settings must permit this query; redirects are not followed.`,
        response.status >= 400 ? response.status : 502,
      );
    let result;
    try {
      result = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw fail("Live FetchXML endpoint did not return JSON.");
    }
    if (!Array.isArray(result.entities ?? result.value))
      throw fail(
        "Live FetchXML endpoint must return an entities or value array.",
      );
    const requestedLimit =
      top ?? (fetch.attrs.count == null ? null : Number(fetch.attrs.count));
    if (
      requestedLimit != null &&
      (!Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1 ||
        (result.entities ?? result.value).length > requestedLimit)
    )
      throw fail(
        "Live FetchXML response violates its requested record limit; extra records were not accepted.",
      );
    const more =
      top == null &&
      (moreFlag(
        result.more_records ?? result["@Microsoft.Dynamics.CRM.morerecords"],
      ) ||
        Boolean(result["@odata.nextLink"]));
    let pagingCookie = decodePagingCookie(
      result.paging_cookie ??
        result["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"],
    );
    let nextLink = null;
    if (result["@odata.nextLink"]) {
      let next;
      try {
        next = new URL(result["@odata.nextLink"], this.origin);
      } catch {
        throw fail("Live FetchXML returned an invalid next-page URL.");
      }
      if (
        next.origin !== this.origin ||
        next.username ||
        next.password ||
        next.hash
      )
        throw fail(
          "Live FetchXML next page escaped the configured portal origin.",
          400,
        );
      nextLink = next.pathname + next.search;
      validateLivePath(nextLink);
      if (
        !this.fetchXmlPath &&
        !nextLink.startsWith(`/_api/${mapping.entitySet}?`)
      )
        throw fail("Live FetchXML next page escaped its entity set.", 400);
      pagingCookie ??=
        "paqvilo-mirage-next:" + Buffer.from(nextLink).toString("base64url");
    }
    if (more && !pagingCookie)
      throw fail(
        "Live FetchXML reports more records without a paging cookie or continuation URL. Incomplete results were not accepted.",
      );
    return {
      entities: (result.entities ?? result.value).map((row) =>
        normalizeLiveRecord(row, mapping, {
          aggregate: fetch.attrs.aggregate === "true",
        }),
      ),
      more_records: more,
      paging_cookie: top == null ? pagingCookie : null,
      total_record_count:
        result.total_record_count ??
        result["@odata.count"] ??
        result["@Microsoft.Dynamics.CRM.totalrecordcount"] ??
        -1,
      total_record_count_limit_exceeded: moreFlag(
        result["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"],
      ),
      ...(nextLink && top == null ? { next_link: nextLink } : {}),
    };
  }
  async close() {
    const browser = this.browser;
    this.context = null;
    this.browser = null;
    if (browser) await browser.close();
  }
}
