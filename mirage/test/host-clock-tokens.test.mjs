import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../api.mjs";
import { fixedClock, signInHeaders } from "../testing.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const CONTACT = "c3000000-0000-4000-8000-000000000071";
const START = Date.parse("2030-06-01T12:00:00.000Z");

test("the portal implicit grant token is dated by the organization clock", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "host-clock-"));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: 8c3d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e71\nadx_name: Invented Clock",
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true",
    "sitesetting.yml": '- adx_sitesettingid: 5e000000-0000-4000-8000-000000000071\n  adx_name: ImplicitGrantFlow/TokenExpirationTime\n  adx_value: "120"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const clock = fixedClock(START);
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, clock,
    initial: { version: 1, mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
      tables: { contact: [{ contactid: CONTACT, fullname: "Invented Person", statecode: 0 }] }, permissions: [],
      simulator: { mode: "local", pageMode: "local", live: { allowWrites: false }, endpoints: [] } } });
  ownedFixture(t).add(() => sim.close());
  const issue = async () => {
    const response = await fetch(`${sim.url}/_services/auth/token`, { method: "POST", headers: signInHeaders(sim, CONTACT) });
    assert.equal(response.status, 200);
    return JSON.parse(Buffer.from((await response.text()).split(".")[1], "base64url").toString("utf8"));
  };
  const first = await issue();
  assert.equal(first.iat, START / 1000);
  assert.equal(first.exp, START / 1000 + 120);
  clock.advance(3_600_000);
  const later = await issue();
  assert.equal(later.exp, START / 1000 + 3600 + 120);
});
