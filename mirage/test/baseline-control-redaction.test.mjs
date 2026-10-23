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
  test(label, () => {
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

import {
  redactLayoutAttributeValue,
  redactEncodedLayoutTokens,
  redactEncodedLayoutEvidence,
} from "../lib/capture-control-redaction.mjs";
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
  const json = JSON.stringify({
      base64SecureConfiguration: nativeToken,
      sibling: 17,
    }),
    layout = Buffer.from(
      JSON.stringify({
        Base64SecureConfiguration: nativeToken,
        Sibling: "kept",
        Image: "ordinary-base64-image",
      }),
    ).toString("base64");
  const html =
      '<main data-view-layouts="' +
      layout +
      '"><input data-before="a>b" value="' +
      nativeToken +
      '" name="base64SecureConfiguration"></main>',
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
              headers: {},
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
        Sibling: "kept",
        Image: "ordinary-base64-image",
      },
    );
    assert.equal(elements[0].sibling, 17);
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
