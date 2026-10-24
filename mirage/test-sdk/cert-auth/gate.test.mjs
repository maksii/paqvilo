// SDK verification gate: certificate client authentication (private_key_jwt) against the Mirage Dataverse simulator.
// A fresh RSA key pair and self-signed certificate are generated per run and registered for the gate application;
// @azure/msal-node 7.1.0 and MSAL.NET (Microsoft.Identity.Client 4.91.0) each redeem their own client assertion over
// the TLS authority and call WhoAmI. Opt-in (`npm test` in this folder or `npm run test:sdk`); never part of `npm run validate`.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate, constants, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSelfSignedCertificate } from "../../lib/dataverse-tls.mjs";
import { registerCertificate, startGate } from "../harness.mjs";

const T = { timeout: 600_000 };
const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "msal-child.mjs");
const PROJECT = path.join(here, "Gate", "Gate.csproj");
const EXE = path.join(here, "Gate", "bin", "Release", "net10.0", process.platform === "win32" ? "Gate.exe" : "Gate");
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
const dotnetSkip = dotnet.status === 0 ? false : "dotnet is not installed: MSAL.NET half of the gate skipped";

const gate = await startGate({ tls: true });
after(() => gate.close());
const { tlsOrigin, tenantId, clientId } = gate;
const TOKEN_PATH = `/${tenantId}/oauth2/v2.0/token`;
const WHOAMI_PATH = "/api/data/v9.2/WhoAmI";

// Per-run client credential: never written to disk, never reused.
const credential = createSelfSignedCertificate({ commonName: "cert-auth gate client", hosts: [] });
const x509 = new X509Certificate(credential.cert);
const thumbprints = await registerCertificate(gate, credential.cert);
const caFingerprint = new X509Certificate(gate.caPem).fingerprint256;

const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 300_000);
  child.on("error", reject);
  child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const jsonLines = (stdout) => stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
const recorded = () => gate.requests().map((entry) => ({ method: entry.method, path: entry.path, status: entry.status, grant: entry.grant, appId: entry.appId }));

test("the registered thumbprints are the certificate's fingerprints", () => {
  assert.equal(thumbprints.thumbprint256, x509.fingerprint256.replaceAll(":", ""));
  assert.equal(thumbprints.thumbprint, x509.fingerprint.replaceAll(":", ""));
});

test("@azure/msal-node redeems a PS256 x5t#S256 certificate assertion over TLS and calls WhoAmI", T, async (t) => {
  const before = recorded().length;
  const result = await run(process.execPath, [CHILD], {
    NODE_EXTRA_CA_CERTS: gate.caFile,
    SIM_TLS_ORIGIN: tlsOrigin, SIM_TENANT: tenantId, SIM_CLIENT_ID: clientId,
    SIM_THUMBPRINT_SHA256: thumbprints.thumbprint256, SIM_KEY_PEM: credential.key, SIM_CERT_PEM: credential.cert,
  });
  const [report] = jsonLines(result.stdout);
  t.diagnostic(JSON.stringify(report));
  assert.ok(report, `child printed nothing: exit ${result.status}\n${result.stderr.slice(-2000)}`);
  assert.equal(report.ok, true, report.error);
  assert.equal(report.appid.toLowerCase(), clientId.toLowerCase());
  assert.equal(report.appidacr, "2", "appidacr 2 marks certificate authentication");
  assert.match(report.userId, GUID);
  assert.equal(report.organizationId.toLowerCase(), gate.organizationId.toLowerCase());

  const log = recorded().slice(before);
  assert.ok(log.some((e) => e.method === "POST" && e.path === TOKEN_PATH && e.status === 200 && e.grant === "client_credentials"), `token POST missing: ${JSON.stringify(log)}`);
  assert.ok(log.some((e) => e.method === "GET" && e.path === WHOAMI_PATH && e.status === 200 && e.appId?.toLowerCase() === clientId.toLowerCase()), `WhoAmI missing: ${JSON.stringify(log)}`);
});

test("MSAL.NET WithCertificate redeems its assertion with instance discovery off and calls WhoAmI", { ...T, skip: dotnetSkip }, async (t) => {
  const buildStarted = Date.now();
  const build = spawnSync("dotnet", ["build", PROJECT, "-c", "Release", "-nologo"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(build.status, 0, `dotnet build failed:\n${`${build.stdout}${build.stderr}`.slice(-4000)}`);
  assert.ok(fs.existsSync(EXE), `built executable not found: ${EXE}`);
  t.diagnostic(`dotnet build: ${Date.now() - buildStarted} ms`);

  const before = recorded().length;
  const result = await run(EXE, [], {
    SIM_TLS_ORIGIN: tlsOrigin, SIM_TENANT: tenantId, SIM_CLIENT_ID: clientId,
    SIM_CERT_PEM: credential.cert, SIM_KEY_PEM: credential.key, SIM_CA_FINGERPRINT: caFingerprint,
  });
  const steps = jsonLines(result.stdout);
  t.diagnostic(steps.map((s) => `${s.step}: ${s.ok ? "ok" : "FAIL"} ${s.detail}`).join("\n"));
  for (const name of ["token", "whoami"]) assert.ok(steps.some((s) => s.step === name), `step "${name}" missing; exit ${result.status}\n${result.stderr.slice(-2000)}`);
  assert.deepEqual(steps.filter((s) => !s.ok), [], "every MSAL.NET step must succeed");
  assert.equal(result.status, 0, `Gate exit code ${result.status}\n${result.stderr.slice(-2000)}`);

  const log = recorded().slice(before);
  assert.ok(log.some((e) => e.method === "POST" && e.path === TOKEN_PATH && e.status === 200 && e.grant === "client_credentials"), `token POST missing: ${JSON.stringify(log)}`);
  assert.ok(log.some((e) => e.method === "GET" && e.path === WHOAMI_PATH && e.status === 200), `WhoAmI missing: ${JSON.stringify(log)}`);
});

test("a tampered assertion is refused with AADSTS700027", T, async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: `${tlsOrigin}${TOKEN_PATH}`, iss: clientId, sub: clientId, nbf: now, exp: now + 600, jti: randomUUID() };
  const head = b64({ alg: "PS256", typ: "JWT", "x5t#S256": Buffer.from(thumbprints.thumbprint256, "hex").toString("base64url") });
  const body = b64(claims);
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: credential.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString("base64url");
  // Genuine signature, claims altered afterwards: the signature no longer covers the body.
  const tampered = `${head}.${b64({ ...claims, sub: randomUUID() })}.${signature}`;
  const response = await fetch(`${gate.origin}${TOKEN_PATH}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, grant_type: "client_credentials", scope: `${tlsOrigin}/.default`, client_assertion_type: ASSERTION_TYPE, client_assertion: tampered }),
  });
  const error = await response.json();
  assert.equal(response.status, 400);
  assert.equal(error.error, "invalid_client");
  assert.deepEqual(error.error_codes, [700027]);
  assert.match(error.error_description, /^AADSTS700027: /);
  assert.ok(recorded().some((e) => e.method === "POST" && e.path === TOKEN_PATH && e.status === 400), "the refused POST is in the request log");
});
