// Change log unit tests on an invented store: committed events are delivered by hand, as DataStore does after a commit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChangeLog } from "../lib/dataverse-changes.mjs";
import { clockFunction, fixedClock } from "../lib/runtime-clock.mjs";

const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "aaaaaaaa-0000-0000-0000-00000000000b";
const C = "aaaaaaaa-0000-0000-0000-00000000000c";
const EXPIRED = "Version stamp associated with the client has expired. Please perform a full sync.";
const CLOCK = () => Date.parse("2026-10-19T12:00:00Z");

function fakeStore() {
  const consumers = new Set();
  return {
    revision: 0,
    // The persisted org row version the change log stamps with; a commit moves it as a Dataverse write does.
    state: { rowVersion: 0 },
    resolveMapping: () => ({ idColumn: "widgetid" }),
    addCommittedEvents(provider) {
      consumers.add(provider);
      return () => consumers.delete(provider);
    },
    subscribers: () => consumers.size,
    // One commit: the revision and row version move, then every consumer sees the events.
    commit(...events) {
      this.revision++;
      this.state.rowVersion++;
      for (const provider of consumers) provider(events);
    },
    // A commit that did not stamp any row (a portal write): only the store revision moves.
    commitUnstamped(...events) {
      this.revision++;
      for (const provider of consumers) provider(events);
    },
  };
}

const written = (id) => ({ entity: "widget", operation: "update", row: { widgetid: id } });
const removed = (id) => ({ entity: "widget", operation: "delete", row: { widgetid: id } });
const stampOf = (token) => token.slice(token.indexOf("!") + 1);
const expired = (error) => error.status === 400 && error.details?.innerCode === "0x80044352" && error.message === EXPIRED;

describe("dataverse change log", () => {
  it("issues revision and epoch-stamped tokens, and reports changed and deleted rows after a revision", async () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    store.commit(written(A));
    const first = log.token();
    assert.match(first, /^1!\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d$/);
    store.commit(removed(B));
    assert.deepEqual(log.parse(first), { revision: 1 });
    assert.deepEqual(await log.since("widget", 1), { changed: [], deleted: [B] });
    assert.deepEqual(await log.since("widget", 0), { changed: [A], deleted: [B] });
    assert.deepEqual(await log.since("gadget", 0), { changed: [], deleted: [] });
    assert.equal(log.parse("nope"), null);
  });

  it("expires a token from another log, as after a restart, and accepts this log's own tokens", () => {
    const store = fakeStore();
    const before = createChangeLog(store, { clock: CLOCK });
    store.commit(written(A));
    const old = before.token();
    before.close();
    const after = createChangeLog(store, { clock: CLOCK });
    assert.throws(() => after.parse(old), expired);
    assert.deepEqual(after.parse(after.token()), { revision: 1 });
  });

  it("expires forged tokens: a wrong stamp, or a revision the store has not reached", () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    store.commit(written(A));
    const stamp = stampOf(log.token());
    assert.throws(() => log.parse("0!01/01/2000 00:00:00"), expired);
    assert.throws(() => log.parse(`${store.revision + 1}!${stamp}`), expired);
    assert.deepEqual(log.parse(`1!${stamp}`), { revision: 1 });
  });

  it("trims the ring at a small limit and expires tokens older than the oldest kept entry", async () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK, limit: 2 });
    store.commit(written(A));
    store.commit(written(B));
    store.commit(written(C));
    const stamp = stampOf(log.token());
    assert.throws(() => log.parse(`0!${stamp}`), expired);
    assert.deepEqual(log.parse(`1!${stamp}`), { revision: 1 });
    assert.deepEqual(await log.since("widget", 1), { changed: [B, C], deleted: [] });
    await assert.rejects(log.since("widget", 0), expired);
  });

  it("rewinds to a revision, dropping the entries a rolled-back changeset logged", async () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    store.commit(written(A));
    store.commit(removed(B));
    log.rewind(1);
    assert.deepEqual(await log.since("widget", 0), { changed: [A], deleted: [] });
  });

  it("gives a commit that stamped no row version the next one, so a token issued before it does not hide it", async () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    store.commit(written(A));
    const token = log.token();
    store.commitUnstamped(written(B));
    assert.equal(store.state.rowVersion, 2);
    assert.deepEqual(await log.since("widget", log.parse(token).revision), { changed: [B], deleted: [] });
    assert.equal(log.current(), 2);
  });

  it("expires every token issued before reset, and keeps only entries logged after it", async () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    store.commit(removed(B));
    const old = log.token();
    log.reset();
    assert.throws(() => log.parse(old), expired);
    const fresh = log.token();
    assert.deepEqual(log.parse(fresh), { revision: 1 });
    assert.deepEqual(await log.since("widget", 1), { changed: [], deleted: [] });
  });

  it("expires a token from before a restart under a fixed clock, although the new log takes the same epoch", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-log-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const file = path.join(root, "state.json");
    const first = fakeStore();
    const before = createChangeLog(first, { clock: clockFunction(fixedClock()) });
    const old = before.token();
    first.commit(written(A));
    await fs.writeFile(file, JSON.stringify(first.state));
    // Restart: a new store from the same state file, a new log on the same fixed clock.
    const second = fakeStore();
    second.state = JSON.parse(await fs.readFile(file, "utf8"));
    const after = createChangeLog(second, { clock: clockFunction(fixedClock()) });
    assert.equal(stampOf(after.token()), stampOf(old), "the fixed clock gives both logs one epoch");
    second.commit(written(B));
    assert.throws(() => after.parse(old), expired);
    const current = after.token();
    assert.deepEqual(after.parse(current), { revision: 2 });
  });

  it("releases its committed-event subscription on close", () => {
    const store = fakeStore();
    const log = createChangeLog(store, { clock: CLOCK });
    assert.equal(store.subscribers(), 1);
    log.close();
    log.close();
    assert.equal(store.subscribers(), 0);
  });
});
