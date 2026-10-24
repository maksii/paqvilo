import { Worker } from "node:worker_threads";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCapture, redactTokens } from "../baseline-capture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  redactSecureConfigurationTokens as redact,
  redactCapabilityEvidence,
  redactCapabilityDiffEvidence,
  redactCaptureControlText as redactText,
  redactCaptureControlEvidence as redactEvidence,
  redactLayoutAttributeValue,
  redactEncodedLayoutTokens,
  redactEncodedLayoutEvidence,
} from "../lib/capture-control-redaction.mjs";
const token = Buffer.from("invented signed configuration fixture").toString(
  "base64",
);
for (const [label, input] of [
  [
    "JSON",
    JSON.stringify({ base64SecureConfiguration: token, sibling: "kept" }),
  ],
  [
    "escaped JSON",
    JSON.stringify(
      JSON.stringify({ Base64SecureConfiguration: token, sibling: "kept" }),
    ),
  ],
  ["JS", `{BASE64SECURECONFIGURATION:'${token}',sibling:'kept'}`],
  [
    "form",
    `first=kept&base64SecureConfiguration=${encodeURIComponent(token)}&sibling=kept`,
  ],
  [
    "multipart",
    `Content-Disposition: form-data; name="Base64SecureConfiguration"\r\n\r\n${token}\r\n--boundary\r\nsibling=kept`,
  ],
  [
    "HTML name first",
    `<input name="base64SecureConfiguration" value="${token}" data-sibling="kept">`,
  ],
  [
    "HTML value first",
    `<input value='${token}' data-sibling='kept' name='BASE64SECURECONFIGURATION'>`,
  ],
  [
    "HTML JSON",
    `<div data-json='{&quot;Base64SecureConfiguration&quot;:&quot;${token}&quot;,&quot;sibling&quot;:&quot;kept&quot;}'></div>`,
  ],
])
  test(`base64SecureConfiguration in ${label} becomes {token}, keeps siblings and is idempotent`, () => {
    const out = redact(input);
    assert.ok(!out.includes(token));
    assert.ok(!out.includes(encodeURIComponent(token)));
    assert.ok(out.includes("{token}"));
    assert.ok(out.includes("kept"));
    assert.equal(redact(out), out);
  });
test("ordinary binary/image/layout base64 stays exact", () => {
  for (const input of [
    `<img src="data:image/png;base64,${token}">`,
    JSON.stringify({ Base64ViewLayouts: token, image: token }),
    token,
  ])
    assert.equal(redact(input), input);
});
test("direct structured field and nested response body remove raw digest input", () => {
  const body = JSON.stringify({
      base64SecureConfiguration: token,
      sibling: "kept",
    }),
    rawDigest = createHash("sha256").update(body).digest("hex");
  const out = redactCapabilityEvidence({
    body,
    bodyHashInput: Buffer.from(body).toString("base64"),
    bodySha256: rawDigest,
    bodyBytes: body.length,
    nested: { BASE64SECURECONFIGURATION: token },
    image: token,
  });
  assert.ok(!JSON.stringify(out).includes(rawDigest));
  assert.ok(!JSON.stringify(out).includes("bodyHashInput"));
  assert.equal(out.image, token);
  assert.equal(out.bodyBytes, body.length);
  assert.equal(
    out.bodySha256,
    createHash("sha256").update(out.body).digest("hex"),
  );
  assert.equal(out.bodyHashProvenance, "redacted-text-sha256");
  assert.equal(out.nested.BASE64SECURECONFIGURATION, "{token}");
});

test("quoted greater-than before exact name is redacted", () => {
  const out = redact(
    '<input data-other="a>b" value="' +
      token +
      '" name="base64SecureConfiguration">',
  );
  assert.ok(!out.includes(token));
  assert.ok(out.includes("a>b"));
});
test("valid unquoted input attributes are redacted", () => {
  assert.equal(
    redact("<input value=" + token + " name=base64SecureConfiguration>"),
    '<input value="{token}" name=base64SecureConfiguration>',
  );
});
test("contextual structured diff tokens are removed while unrelated values remain", () => {
  const out = redactCapabilityDiffEvidence([
    {
      field: "body.base64SecureConfiguration",
      live: token,
      mirage: token,
      check: "kept",
    },
    { field: "body.image", live: token, mirage: token },
  ]);
  assert.equal(out[0].live, "{token}");
  assert.equal(out[0].mirage, "{token}");
  assert.equal(out[0].check, "kept");
  assert.equal(out[1].live, token);
});
test("JSON escaped slash/unicode token codepoints leave no suffix", () => {
  for (const encoded of [
    "abc" + String.fromCharCode(92) + "/def=",
    String.fromCharCode(92) + "u0061bcDEF=",
  ]) {
    const out = redact(
      '{"base64SecureConfiguration":"' + encoded + '","sibling":"kept"}',
    );
    assert.equal(
      out,
      '{"base64SecureConfiguration":"{token}","sibling":"kept"}',
    );
  }
});

test("semantically escaped JSON token key and arbitrary JSON escaped value are redacted", () => {
  const key = String.fromCharCode(92) + "u0042ase64SecureConfiguration";
  const source =
    '{"' +
    key +
    '":"abc' +
    String.fromCharCode(92) +
    "u002fdef" +
    String.fromCharCode(92) +
    'nsecret","sibling":"kept"}';
  const out = redact(source);
  assert.equal(JSON.parse(out).Base64SecureConfiguration, "{token}");
  assert.equal(JSON.parse(out).sibling, "kept");
});

const secret = "fixture-opaque-security-token.abc123==";
const original = JSON.stringify(
  [
    {
      Base64SecureConfiguration: secret,
      ViewName: "Fixture view",
      Columns: [{ Name: "Title", Width: 100 }],
      Nested: { base64SecureConfiguration: secret },
    },
  ],
  null,
  2,
);
const encoded = Buffer.from(original).toString("base64");
const decode = (value) =>
  JSON.parse(Buffer.from(value, "base64").toString("utf8"));

test("qualified layout redaction preserves every JSON sibling and valid base64 shape", () => {
  const after = redactLayoutAttributeValue("data-view-layouts", encoded);
  const expected = JSON.parse(original);
  expected[0].Base64SecureConfiguration = "{token}";
  expected[0].Nested.base64SecureConfiguration = "{token}";
  assert.deepEqual(decode(after), expected);
  assert.equal(Buffer.from(after, "base64").toString("base64"), after);
  assert.equal(redactLayoutAttributeValue("data-view-layouts", after), after);
});

test("token-free layouts, ordinary image/attachment base64 and unrelated attributes remain byte-for-byte", () => {
  const clean = Buffer.from(
    '[ { "Columns" : [1, 2], "Id" : "view" } ]',
  ).toString("base64");
  assert.equal(redactLayoutAttributeValue("data-view-layouts", clean), clean);
  assert.equal(redactLayoutAttributeValue("data-image", encoded), encoded);
  const value = {
    documentbody: encoded,
    image: encoded,
    screenshot: encoded,
    bodyHashInput: encoded,
    nested: [{ name: "data-view-layouts-neighbor", value: encoded }],
  };
  assert.deepEqual(redactEncodedLayoutEvidence(value), value);
  assert.equal(
    redactEncodedLayoutTokens('<img data-other-layout="' + encoded + '">'),
    '<img data-other-layout="' + encoded + '">',
  );
});

test("HTML quote, entity and escaped JSON envelopes retain neighboring bytes", () => {
  for (const quote of ['"', "'", '\\"', '\\\\"', "&quot;", "&#34;", "&#x22;"]) {
    const input =
      "<div data-view-layouts=" +
      quote +
      encoded +
      quote +
      ' data-label="sibling">';
    const output = redactEncodedLayoutTokens(input);
    const after = redactLayoutAttributeValue("data-view-layouts", encoded);
    assert.equal(
      output,
      "<div data-view-layouts=" +
        quote +
        after +
        quote +
        ' data-label="sibling">',
    );
    assert.equal(redactEncodedLayoutTokens(output), output);
  }
});

test("unquoted known layout attributes are redacted without matching neighboring attribute names", () => {
  const after = redactLayoutAttributeValue("data-view-layouts", encoded);
  assert.equal(
    redactEncodedLayoutTokens(
      "<div data-view-layouts=" + encoded + " data-label=sibling>",
    ),
    "<div data-view-layouts=" + after + " data-label=sibling>",
  );
  for (const name of ["x-data-view-layouts", "data-view-layouts-extra"]) {
    const input = "<div " + name + '="' + encoded + '">';
    assert.equal(redactEncodedLayoutTokens(input), input);
  }
});

test("structured element inventory keys are qualified separately from arbitrary string values", () => {
  const result = redactEncodedLayoutEvidence({
    elements: [
      { attributes: { "data-view-layouts": encoded, "data-image": encoded } },
    ],
  });
  assert.equal(
    decode(result.elements[0].attributes["data-view-layouts"])[0]
      .Base64SecureConfiguration,
    "{token}",
  );
  assert.equal(result.elements[0].attributes["data-image"], encoded);
});

test("duplicate JSON token keys are all replaced without dropping fields through object reserialization", () => {
  const duplicate =
    '{"Base64SecureConfiguration":"' +
    secret +
    '","Base64SecureConfiguration":"' +
    secret +
    '","neighbor":17}';
  const after = Buffer.from(
    redactLayoutAttributeValue(
      "data-view-layouts",
      Buffer.from(duplicate).toString("base64"),
    ),
    "base64",
  ).toString("utf8");
  assert.equal(
    after,
    '{"Base64SecureConfiguration":"{token}","Base64SecureConfiguration":"{token}","neighbor":17}',
  );
});

test("unpadded and URL-safe canonical envelopes retain their encoding convention", () => {
  for (const encoding of ["base64", "base64url"]) {
    const value = Buffer.from(original).toString(encoding).replace(/=+$/, "");
    const result = redactLayoutAttributeValue("data-view-layouts", value);
    assert.equal(result.endsWith("="), false);
    assert.equal(decode(result)[0].Base64SecureConfiguration, "{token}");
  }
});

test("invalid or oversized declared envelopes fail closed with constant diagnostics", () => {
  for (const value of [
    "%%%invalid%%%",
    "ZmFrZQ==",
    Buffer.from("null").toString("base64"),
    "A".repeat(4 * 1024 * 1024 + 1),
  ]) {
    assert.throws(
      () => redactLayoutAttributeValue("data-view-layouts", value),
      /Capture layout/,
    );
    assert.throws(
      () =>
        redactEncodedLayoutTokens('<div data-view-layouts="' + value + '">'),
      /Capture layout/,
    );
  }
});

test("layout changes remove raw text digest inputs and hash sanitized text while preserving wire sizes", () => {
  const body = '<div data-view-layouts="' + encoded + '">';
  const source = {
    response: {
      body,
      bodyHashInput: Buffer.from(body).toString("base64"),
      bodySha256: "original",
      bodyBytes: 12345,
    },
  };
  const result = redactEncodedLayoutEvidence(source);
  assert.equal(result.response.bodyHashInput, undefined);
  assert.equal(result.response.bodyHashProvenance, "redacted-text-sha256");
  assert.equal(
    result.response.bodySha256,
    createHash("sha256").update(result.response.body).digest("hex"),
  );
  assert.equal(result.response.bodyBytes, 12345);
  const binary = {
    response: {
      body: null,
      bodyHashInput: encoded,
      bodySha256: "binary-hash",
      bodyBytes: 12345,
    },
  };
  assert.deepEqual(redactEncodedLayoutEvidence(binary), binary);
});

test("contextual layout differences preserve comparison counts and verdicts while removing capability values", () => {
  const source = {
    passed: false,
    differences: 1,
    items: [
      {
        field: "attributes.data-view-layouts",
        live: encoded,
        mirage: encoded,
        severity: "different",
      },
    ],
  };
  const result = redactEncodedLayoutEvidence(source);
  assert.equal(result.passed, false);
  assert.equal(result.differences, 1);
  assert.equal(result.items[0].severity, "different");
  assert.equal(
    decode(result.items[0].live)[0].Base64SecureConfiguration,
    "{token}",
  );
  assert.equal(
    decode(result.items[0].mirage)[0].Base64SecureConfiguration,
    "{token}",
  );
});

test("capture persistence removes plain and encoded signed tokens in every evidence surface", async () => {
  const out = await fs.mkdtemp(
    path.join(os.tmpdir(), "paqvilo-control-redaction-"),
  );
  const nativeToken = Buffer.from(
    "invented per-process signed control configuration",
  ).toString("base64");
  const uploadHandle = Buffer.from(
    "invented per-process upload handle",
  ).toString("base64");
  const json = JSON.stringify({
      base64SecureConfiguration: nativeToken,
      ctl00$Main$AttachFile_HiddenField_InstanceId: uploadHandle,
      sibling: 17,
    }),
    layout = Buffer.from(
      JSON.stringify({
        Base64SecureConfiguration: nativeToken,
        AttachFile_HiddenField_InstanceId: uploadHandle,
        Sibling: "kept",
        Image: "ordinary-base64-image",
      }),
    ).toString("base64");
  const html =
      '<main data-view-layouts="' +
      layout +
      '"><input data-before="a>b" value="' +
      nativeToken +
      '" name="base64SecureConfiguration"><input id="AttachFile_HiddenField_InstanceId" value="' +
      uploadHandle +
      '"></main>',
    hash = (value) => createHash("sha256").update(value).digest("hex");
  try {
    await writeCapture(
      {
        summary: {
          id: "invented/signed-controls",
          status: "captured",
          problems: [],
        },
        raw: {
          finalUrl: "https://portal.invalid/",
          requests: [
            {
              seq: 1,
              method: "POST",
              url: "https://portal.invalid/service",
              headers: {
                "x-ms-form-session-id": uploadHandle,
                "x-preserved": "kept",
              },
              body: json,
              response: {
                status: 200,
                headers: {},
                body: html,
                bodyBytes: Buffer.byteLength(html),
                bodyHashInput: Buffer.from(html).toString("base64"),
              },
            },
          ],
          dom: html,
          frames: [{ path: "/frame", dom: html }],
          elements: [
            { attributes: { "data-view-layouts": layout }, sibling: 17 },
            {
              attributes: {
                name: "ctl00$Main$AttachFile_HiddenField_InstanceId",
                value: uploadHandle,
              },
            },
          ],
          console: [{ type: "log", text: json }],
          pageErrors: [json],
          dialogs: [{ message: json }],
        },
      },
      {
        outDir: out,
        origin: "https://portal.invalid",
        side: "native",
        scenarioId: "invented/signed-controls",
      },
    );
    const requests = JSON.parse(
        await fs.readFile(path.join(out, "requests.json"), "utf8"),
      ),
      elements = JSON.parse(
        await fs.readFile(path.join(out, "elements.json"), "utf8"),
      );
    assert.deepEqual(JSON.parse(requests[0].body), {
      base64SecureConfiguration: "{token}",
      ctl00$Main$AttachFile_HiddenField_InstanceId: "{token}",
      sibling: 17,
    });
    assert.deepEqual(
      JSON.parse(
        Buffer.from(
          elements[0].attributes["data-view-layouts"],
          "base64",
        ).toString("utf8"),
      ),
      {
        Base64SecureConfiguration: "{token}",
        AttachFile_HiddenField_InstanceId: "{token}",
        Sibling: "kept",
        Image: "ordinary-base64-image",
      },
    );
    assert.equal(requests[0].headers["x-ms-form-session-id"], "{token}");
    assert.equal(requests[0].headers["x-preserved"], "kept");
    assert.equal(elements[0].sibling, 17);
    assert.equal(elements[1].attributes.value, "{token}");
    assert.equal(requests[0].response.bodySha256, hash(redactTokens(html)));
    assert.equal(
      requests[0].response.bodyHashProvenance,
      "redacted-text-sha256",
    );
    assert.equal(requests[0].response.bodyBytes, Buffer.byteLength(html));
    for (const file of await fs.readdir(out)) {
      if (!/\.(json|html)$/.test(file)) continue;
      const text = await fs.readFile(path.join(out, file), "utf8");
      assert.ok(!text.includes(nativeToken), file);
      assert.ok(!text.includes(uploadHandle), file);
      assert.ok(!text.includes(layout), file);
      assert.ok(!text.includes(hash(html)), file);
    }
  } finally {
    assert.ok(
      path.resolve(out).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await fs.rm(out, { recursive: true, force: true });
  }
});

test(
  "escaped-quote text finishes in bounded worker and still redacts a following real field",
  { timeout: 10000 },
  async () => {
    const worker = new Worker(
      `const{parentPort,workerData}=require('node:worker_threads');import(workerData.module).then(({redactSecureConfigurationTokens:redact})=>{const text='"'+String.fromCharCode(92,34).repeat(500000)+'"';const field='{"base64SecureConfiguration":"invented-secret","sibling":17}';parentPort.postMessage({unchanged:redact(text)===text,redacted:redact(text+field)===text+'{"base64SecureConfiguration":"{token}","sibling":17}'});});`,
      {
        eval: true,
        workerData: {
          module: new URL(
            "../lib/capture-control-redaction.mjs",
            import.meta.url,
          ).href,
        },
      },
    );
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Control redaction exceeded worker deadline")),
          5000,
        );
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      assert.deepEqual(result, { unchanged: true, redacted: true });
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  },
);

test(
  "malformed repeated multipart headers and large input whitespace finish in a bounded worker",
  { timeout: 10000 },
  async () => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ redactSecureConfigurationTokens: redact }) => {
      const headers = 'name="base64SecureConfiguration"\\r\\n'.repeat(500000);
      const whitespace = ' '.repeat(1000000);
      const ordinary = '<input ' + whitespace + 'disabled>';
      const secure = '<input name="base64SecureConfiguration" value="fixture-value" ' + whitespace + 'disabled>';
      parentPort.postMessage({ headers: redact(headers) === headers, ordinary: redact(ordinary) === ordinary, secure: redact(secure) === secure.replace('"fixture-value"', '"{token}"') });
    }).catch(error => { throw error; });`,
      {
        eval: true,
        workerData: {
          module: new URL(
            "../lib/capture-control-redaction.mjs",
            import.meta.url,
          ).href,
        },
      },
    );
    let timer;
    try {
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Control scanner exceeded its worker deadline.")),
          5000,
        );
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      assert.deepEqual(result, { headers: true, ordinary: true, secure: true });
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  },
);

for (const name of [
  "AttachFile_HiddenField_InstanceId",
  "ctl00$Main$AttachFile_HiddenField_InstanceId",
  "ctl00_Main_AttachFile_HiddenField_InstanceId",
]) {
  test("protected upload handle " + name, () => {
    for (const input of [
      JSON.stringify({ [name]: token, sibling: "kept" }),
      JSON.stringify(JSON.stringify({ [name]: token })),
      '<input name="' + name + '" value="' + token + '">',
      '<input id="' + name + '" value="' + token + '">',
      'Content-Disposition: form-data; name="' +
        name +
        '"\r\n\r\n' +
        token +
        "\r\n--b",
      name + "=" + encodeURIComponent(token) + "&sibling=kept",
    ]) {
      const output = redact(input);
      assert.ok(!output.includes(token), output);
      assert.ok(output.includes("{token}"));
    }
    assert.equal(redactCapabilityEvidence({ [name]: token })[name], "{token}");
    assert.equal(
      redactCapabilityEvidence({ name, value: token }).value,
      "{token}",
    );
    assert.equal(
      redactCapabilityEvidence({ id: name, defaultValue: token }).defaultValue,
      "{token}",
    );
    const diff = redactCapabilityDiffEvidence({
      field: "body." + name,
      live: token,
      mirage: token,
    });
    assert.equal(diff.live, "{token}");
    assert.equal(diff.mirage, "{token}");
  });
}
test("general instance and annotation identities remain exact", () => {
  const value = {
    InstanceId: token,
    runtime: { instanceId: token },
    AttachFile_HiddenField_AnnotationIds: token,
  };
  assert.deepEqual(redactCapabilityEvidence(value), value);
});

test("encoded scoped form names redact while adjacent and general IDs remain exact", () => {
  assert.equal(
    redact(
      "ctl00%24Main%24AttachFile_HiddenField_InstanceId=" +
        token +
        "&InstanceId=" +
        token,
    ),
    "ctl00%24Main%24AttachFile_HiddenField_InstanceId={token}&InstanceId=" +
      token,
  );
  assert.equal(
    redact("NotAttachFile_HiddenField_InstanceId=" + token),
    "NotAttachFile_HiddenField_InstanceId=" + token,
  );
});

test("exact upload session header redacts raw, escaped and contextual evidence", () => {
  for (const input of [
    JSON.stringify({ "x-ms-form-session-id": token, sibling: "kept" }),
    JSON.stringify(
      JSON.stringify({ "x-ms-form-session-id": token, sibling: "kept" }),
    ),
  ]) {
    const out = redact(input);
    assert.ok(!out.includes(token));
    assert.ok(out.includes("kept"));
  }
  assert.equal(
    redactCapabilityEvidence({
      headers: { "x-ms-form-session-id": token, sessionId: "ordinary-row-id" },
    }).headers["x-ms-form-session-id"],
    "{token}",
  );
  assert.equal(
    redactCapabilityEvidence({
      headers: { "x-ms-form-session-id": token, sessionId: "ordinary-row-id" },
    }).headers.sessionId,
    "ordinary-row-id",
  );
  assert.deepEqual(
    redactCapabilityDiffEvidence({
      field: "headers.x-ms-form-session-id",
      live: token,
      mirage: token,
    }),
    {
      field: "headers.x-ms-form-session-id",
      live: "{token}",
      mirage: "{token}",
    },
  );
});

test("declared CSP header nonce sources redact and ordinary nonce business data remains exact", () => {
  const policy =
    "default-src 'self'; script-src 'nonce-inventedAbc123+/=' 'strict-dynamic'; img-src https://images.invalid";
  const input = {
    headers: {
      "Content-Security-Policy": policy,
      "content-security-policy-report-only": policy,
      ordinary: policy,
    },
    nonce: "ordinaryBusinessNonce",
    attributes: { nonce: "ordinary-business-value" },
    description: "literal 'nonce-business'",
  };
  const result = redactEvidence(input);
  assert.equal(
    result.headers["Content-Security-Policy"],
    policy.replace("inventedAbc123+/=", "{token}"),
  );
  assert.equal(
    result.headers["content-security-policy-report-only"],
    result.headers["Content-Security-Policy"],
  );
  assert.equal(
    result.headers.ordinary,
    policy.replace("inventedAbc123+/=", "{token}"),
  ); // Same independently declared capability copied elsewhere.
  assert.equal(result.nonce, input.nonce);
  assert.deepEqual(result.attributes, input.attributes);
  assert.equal(result.description, input.description);
  assert.deepEqual(redactEvidence(result), result);
});

test("actual HTML nonce attributes and declared meta policy survive quoted greater-than and escaped JSON", () => {
  const html =
    '<script data-keep="a>b" NONCE="inventedNonce123">ok</script><style nonce=secondNonce456>keep</style><meta content="script-src &#39;nonce-thirdNonce789&#39; https://scripts.invalid" http-equiv="Content-Security-Policy"><div data-nonce="ordinary-business">kept</div>';
  for (const input of [
    html,
    JSON.stringify({ body: html }),
    JSON.stringify(JSON.stringify({ body: html })),
  ]) {
    const result = redactText(input);
    for (const nonce of ["inventedNonce123", "secondNonce456", "thirdNonce789"])
      assert.ok(!result.includes(nonce));
    assert.ok(result.includes("ordinary-business"));
    assert.ok(result.includes("scripts.invalid"));
    assert.equal(redactText(result), result);
  }
});

test("tagged HTML attribute maps and declared CSP diff values redact without rewriting business nonce keys", () => {
  assert.deepEqual(
    redactEvidence({
      tag: "script",
      attributes: { nonce: "inventedNonce123", title: "keep" },
    }),
    { tag: "script", attributes: { nonce: "{token}", title: "keep" } },
  );
  assert.deepEqual(
    redactEvidence({ tagName: "STYLE", attrs: { NONCE: "inventedNonce123" } }),
    { tagName: "STYLE", attrs: { NONCE: "{token}" } },
  );
  const diff = {
    field: "response.headers.Content-Security-Policy",
    live: "script-src 'nonce-inventedA'",
    mirage: "script-src 'nonce-inventedB'",
  };
  assert.deepEqual(redactCapabilityDiffEvidence(diff), {
    ...diff,
    live: "script-src 'nonce-{token}'",
    mirage: "script-src 'nonce-{token}'",
  });
  const business = {
    field: "payload.nonce",
    live: "ordinary",
    mirage: "ordinary",
  };
  assert.deepEqual(redactCapabilityDiffEvidence(business), business);
});

test("nonce persistence removes protected values and raw text digests from every capture surface", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-csp-nonce-"));
  const nonce = "inventedPersistenceNonce123",
    html = `<script nonce="${nonce}">ok</script>`,
    policy = `script-src 'nonce-${nonce}' https://scripts.invalid`,
    hash = (value) => createHash("sha256").update(value).digest("hex");
  try {
    await writeCapture(
      {
        summary: { id: "invented/csp-nonce", status: "captured", problems: [] },
        raw: {
          finalUrl: "https://portal.invalid/",
          requests: [
            {
              seq: 1,
              method: "GET",
              url: "https://portal.invalid/",
              headers: {},
              body: null,
              response: {
                status: 200,
                headers: { "content-security-policy": policy },
                body: html,
                bodyBytes: Buffer.byteLength(html),
                bodyHashInput: Buffer.from(html).toString("base64"),
              },
            },
          ],
          dom: html,
          frames: [{ path: "/frame", dom: html }],
          elements: [{ tag: "script", attributes: { nonce } }],
          console: [
            {
              type: "log",
              text: JSON.stringify({
                headers: { "content-security-policy": policy },
              }),
            },
          ],
          pageErrors: [],
          dialogs: [],
        },
      },
      {
        outDir: out,
        origin: "https://portal.invalid",
        side: "native",
        scenarioId: "invented/csp-nonce",
      },
    );
    const files = await fs.readdir(out);
    for (const name of files.filter((name) => /\.(json|html)$/.test(name))) {
      const text = await fs.readFile(path.join(out, name), "utf8");
      assert.ok(!text.includes(nonce), name);
      assert.ok(!text.includes(hash(html)), name);
      assert.ok(!text.includes(Buffer.from(html).toString("base64")), name);
    }
    const requests = JSON.parse(
      await fs.readFile(path.join(out, "requests.json"), "utf8"),
    );
    assert.equal(
      requests[0].response.bodyHashProvenance,
      "redacted-text-sha256",
    );
    assert.equal(
      requests[0].response.bodySha256,
      hash(requests[0].response.body),
    );
    assert.ok(
      requests[0].response.headers["content-security-policy"].includes(
        "scripts.invalid",
      ),
    );
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test("large escaped strings and malformed HTML nonce tags remain bounded", async () => {
  const module = new URL(
    "../lib/capture-control-redaction.mjs",
    import.meta.url,
  ).href;
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');import(${JSON.stringify(module)}).then(({redactCaptureControlText:redact})=>{const plain='"'+'\\\\"'.repeat(300000)+'"';if(redact(plain)!==plain)throw Error('ordinary escaped text changed');const malformed='<script nonce="'.repeat(100000);redact(malformed);const html='<script '+ ' '.repeat(1000000)+'nonce="inventedBoundedNonce">keep</script>';if(redact(html).includes('inventedBoundedNonce'))throw Error('nonce retained');parentPort.postMessage(true);});`,
    { eval: true },
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Nonce redaction exceeded bounded worker deadline")),
        8000,
      );
      worker.once("message", () => {
        clearTimeout(timer);
        resolve();
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
});

test("HTML comments and raw-text business strings are not interpreted as nonce attributes", () => {
  const business =
    '<!-- <script nonce="ordinaryComment"> -->' +
    "<script>const ordinary = '<span nonce=\"ordinaryBusiness\">';</script>" +
    '<textarea><script nonce="ordinaryText"></textarea>';
  assert.equal(redactText(business), business);
  assert.equal(
    redactText(JSON.stringify({ body: business })),
    JSON.stringify({ body: business }),
  );
});

test("independently declared long nonce exact copies redact in JS and JSON while common short business strings remain exact", () => {
  const nonce = "inventedLongNonce123+/=",
    header = `script-src 'nonce-${nonce}'`,
    body =
      "window.runtimeNonce=" + JSON.stringify(nonce).replace("/", "\\/") + ";";
  const input = {
    headers: { "content-security-policy": header },
    body,
    bodyHashInput: Buffer.from(body).toString("base64"),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    nonce,
    unrelatedNonce: "ordinaryBusinessNonce",
    longerBusinessWord: "prefix" + nonce + "suffix",
  };
  const output = redactEvidence(input);
  assert.equal(output.nonce, "{token}");
  assert.ok(!output.body.includes("inventedLongNonce"));
  assert.ok(!Object.hasOwn(output, "bodyHashInput"));
  assert.equal(
    output.bodySha256,
    createHash("sha256").update(output.body).digest("hex"),
  );
  assert.equal(output.unrelatedNonce, input.unrelatedNonce);
  assert.equal(output.longerBusinessWord, input.longerBusinessWord);
  assert.deepEqual(redactEvidence(output), output);
  assert.equal(
    redactEvidence({
      headers: { "content-security-policy": "script-src 'nonce-a'" },
      business: "a",
    }).business,
    "a",
  );
});

test("unbounded declared nonce sets fail closed without including capability values", () => {
  const html = Array.from(
    { length: 257 },
    (_, n) =>
      `<span nonce="inventedNonceValue${String(n).padStart(5, "0")}"></span>`,
  ).join("");
  assert.throws(
    () => redactEvidence({ body: html }),
    (error) =>
      /exceeds its bound/.test(error.message) &&
      !error.message.includes("inventedNonce"),
  );
});

test("standalone HTML text also protects exact copies of its declared nonce", () => {
  const nonce = "inventedStandaloneNonce123";
  const html =
    '<script nonce="' + nonce + '">window.copy="' + nonce + '";</script>';
  assert.ok(!redactText(html).includes(nonce));
});
