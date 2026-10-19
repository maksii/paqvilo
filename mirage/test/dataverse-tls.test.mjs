import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import crypto from "node:crypto";
import https from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createSelfSignedCertificate, ensureCertificate } from "../lib/dataverse-tls.mjs";

// Invented names and loopback endpoints only.
const DAY = 86_400_000;
const execFileAsync = promisify(execFile);
const python = spawnSync("python", ["--version"]).status === 0 ? "python" : null;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function get(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path: "/", method: "GET", ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("generated certificate is a CA-flagged self-signed loopback certificate", () => {
  const { key, cert, fingerprint256, notAfter } = createSelfSignedCertificate();
  const x509 = new crypto.X509Certificate(cert);

  assert.match(x509.subject, /CN=Paqvilo Mirage Dataverse simulator/);
  assert.equal(x509.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(x509.checkIP("::1"), "::1");
  assert.equal(x509.checkHost("localhost"), "localhost");
  assert.equal(x509.ca, true);
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.equal(x509.verify(crypto.createPublicKey(cert)), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(key)), true);
  assert.match(x509.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(fingerprint256, x509.fingerprint256);
  assert.equal(new Date(notAfter).getTime(), new Date(x509.validTo).getTime());
  const lifetimeDays = (new Date(x509.validTo).getTime() - Date.now()) / DAY;
  assert.ok(Math.abs(lifetimeDays - 825) < 0.01, `validTo ${lifetimeDays} days ahead`);

  // Node does not expose keyUsage bits (its keyUsage is EKU), so check the DER: critical, BIT STRING 03 02 02 a4.
  const der = Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const kuAt = der.indexOf(Buffer.from("0603551d0f", "hex"));
  assert.ok(kuAt > 0, "keyUsage OID present");
  assert.deepEqual([...der.subarray(kuAt + 5, kuAt + 14)], [0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x02, 0xa4]);
});

test("https server is trusted via ca option and rejected without it", async (t) => {
  const { key, cert } = createSelfSignedCertificate();
  const server = https.createServer({ key, cert }, (req, res) => res.end("ok"));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const trusted = await get(port, { ca: cert });
  assert.deepEqual(trusted, { status: 200, body: "ok" });

  await assert.rejects(get(port), (error) => {
    assert.ok(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code), error.code);
    return true;
  });
});

test("global fetch trusts the certificate through NODE_EXTRA_CA_CERTS", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "paqvilo-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { key, cert } = createSelfSignedCertificate();
  const caFile = join(dir, "ca.pem");
  await writeFile(caFile, cert);
  const server = https.createServer({ key, cert }, (req, res) => res.end("ok"));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const script = "fetch(process.env.TEST_URL).then((r) => r.text()).then((text) => process.stdout.write(text))";
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile, TEST_URL: `https://127.0.0.1:${port}/` },
  });
  assert.equal(stdout, "ok");
});

test("python ssl trusts the certificate as a CA bundle", { skip: python ? false : "python is not installed" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "paqvilo-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { key, cert } = createSelfSignedCertificate();
  const caFile = join(dir, "ca.pem");
  await writeFile(caFile, cert);
  const server = https.createServer({ key, cert }, (req, res) => res.end("ok"));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const code = [
    "import ssl, sys, urllib.request",
    "ctx = ssl.create_default_context(cafile=sys.argv[2])",
    "print(urllib.request.urlopen(sys.argv[1], context=ctx).read().decode())",
  ].join("\n");
  const { stdout } = await execFileAsync(python, ["-I", "-c", code, `https://127.0.0.1:${port}/`, caFile]);
  assert.equal(stdout.trim(), "ok");
});

test("ensureCertificate reuses a valid file and regenerates one that expires within 7 days", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "paqvilo-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "nested", "mirage.pem");

  const first = await ensureCertificate(file);
  assert.equal(first.file, file);
  assert.match(await readFile(file, "utf8"), /-----BEGIN CERTIFICATE-----[\s\S]+-----BEGIN PRIVATE KEY-----/);
  const second = await ensureCertificate(file);
  assert.equal(second.fingerprint256, first.fingerprint256);
  assert.equal(second.key, first.key);

  const nearExpiry = await ensureCertificate(file, { clock: () => Date.now() + 820 * DAY });
  assert.notEqual(nearExpiry.fingerprint256, first.fingerprint256);
});
