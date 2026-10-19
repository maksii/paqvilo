// Change log for Dataverse change tracking (Prefer: odata.track-changes and $deltatoken).
// Committed store events become per-table entries keyed by the store revision the commit produced;
// a delta token names a revision, and a delta read answers with everything logged after it.
// A token's stamp is the log's epoch, so a token from another log (a restart, a reset) is expired, not replayed.
// ponytail: in-memory ring, so a token outlives the process only as an "expired" answer; persist the log if that matters.
// ponytail: epochs are whole seconds, made distinct within a process; a restart in the same wall-clock second as the old log aliases its tokens.
import { DataError } from "./data-error.mjs";

const DEFAULT_LIMIT = 10000;
const EXPIRED_MESSAGE = "Version stamp associated with the client has expired. Please perform a full sync.";
const pad = (n) => String(n).padStart(2, "0");
const lower = (value) => String(value ?? "").toLowerCase();
let lastEpoch = 0;

/** Dataverse-style stamp inside the token: MM/dd/yyyy HH:mm:ss (UTC). */
function stamp(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Dataverse escapes only a few characters in the token and keeps lowercase hex. */
export function encodeDeltaToken(token) {
  return encodeURIComponent(token).replace(/!/g, "%21").replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/** ExpiredVersionStamp (0x80044352): the answer for a token this log cannot continue from. */
export function expiredVersionStamp() {
  return new DataError(EXPIRED_MESSAGE, 400, "InvalidRequest", { innerCode: "0x80044352" });
}

// Each log takes an epoch later than any earlier log in this process.
const nextEpoch = (clock) => (lastEpoch = Math.max(Math.floor(clock() / 1000), lastEpoch + 1));

export function createChangeLog(store, { limit = DEFAULT_LIMIT, clock = () => Date.now() } = {}) {
  const entries = [];
  // Tokens below this revision lack entries (trimmed away), so they are expired.
  let expiredBelow = 0;
  let epoch = nextEpoch(clock);
  const epochStamp = () => stamp(epoch * 1000);
  const idOf = (entity, row) => {
    try {
      return lower(row?.[store.resolveMapping(entity).idColumn]);
    } catch {
      return "";
    }
  };
  const unsubscribe = store.addCommittedEvents((events) => {
    const revision = store.revision;
    for (const event of events) {
      const id = idOf(event.entity, event.row);
      if (id) entries.push({ revision, entity: lower(event.entity), id, deleted: event.operation === "delete" });
    }
    if (entries.length > limit) {
      const dropped = entries.splice(0, entries.length - limit);
      expiredBelow = Math.max(expiredBelow, dropped.at(-1).revision);
    }
  });

  return {
    /** Token for the current store revision and this log's epoch. */
    token: () => `${store.revision}!${epochStamp()}`,

    /**
     * { revision } for a token this log issued. null for text that is not token-shaped; an ExpiredVersionStamp
     * error for a token from another epoch, a revision ahead of the store, or one below the log's floor.
     */
    parse(text) {
      const match = /^(\d+)!(.*)$/.exec(String(text ?? ""));
      if (!match) return null;
      const revision = Number(match[1]);
      if (!Number.isSafeInteger(revision)) return null;
      if (match[2] !== epochStamp() || revision > store.revision || revision < expiredBelow) throw expiredVersionStamp();
      return { revision };
    },

    /** Changed and deleted row ids for `entity` after `revision`; a deleted row never appears in both. */
    async since(entity, revision) {
      await store.flushCommittedEvents?.();
      if (revision < expiredBelow) throw expiredVersionStamp();
      const changed = new Set(), deleted = new Set();
      for (const entry of entries) {
        if (entry.revision <= revision || entry.entity !== lower(entity)) continue;
        if (entry.deleted) {
          changed.delete(entry.id);
          deleted.add(entry.id);
        } else {
          deleted.delete(entry.id);
          changed.add(entry.id);
        }
      }
      return { changed: [...changed], deleted: [...deleted] };
    },

    /** Drops the entries logged after `revision`, for a changeset rolled back to it. Flush committed events first. */
    rewind(revision) {
      const at = entries.findIndex((entry) => entry.revision > revision);
      if (at !== -1) entries.splice(at);
    },

    /** Expires every token issued so far, for a full store reset. */
    reset() {
      entries.length = 0;
      expiredBelow = store.revision;
      epoch = nextEpoch(clock);
    },

    close: unsubscribe,
  };
}
