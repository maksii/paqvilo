// Opt-in portal drop behavior established by a site's reference observations.
// Without observations the DotLiquid object model applies. Missing service metadata,
// cache versions/timestamps and identity data are intentionally not fabricated.
import { LiquidDrop, LIQUID_HIDDEN, lookupMember } from "./liquid-engine.mjs";

function hideHostName(record) {
  if (!record || typeof record !== "object") return record;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  delete descriptors[LIQUID_HIDDEN];
  const copy = Object.create(Object.getPrototypeOf(record), descriptors);
  Object.defineProperty(copy, LIQUID_HIDDEN, {
    value: new Set([...(record[LIQUID_HIDDEN] ?? []), "name"]),
  });
  return copy;
}

class ObservedEntitySetDrop extends LiquidDrop {
  static netTypeName = "Adxstudio.Xrm.Web.Mvc.Liquid.EntitySetDrop";
  #delegate;
  constructor(delegate) {
    super();
    this.#delegate = delegate;
  }
  async liquidGet(key, context) {
    return (await lookupMember(this.#delegate, key, context)).value;
  }
}

class ObservedEntitiesDrop extends LiquidDrop {
  #delegate;
  #sets = new WeakMap();
  constructor(delegate) {
    super();
    this.#delegate = delegate;
  }
  async liquidGet(key, context) {
    const set = (await lookupMember(this.#delegate, key, context)).value;
    if (!set || typeof set !== "object") return set;
    if (!this.#sets.has(set)) this.#sets.set(set, new ObservedEntitySetDrop(set));
    return this.#sets.get(set);
  }
}

class ObservedSiteMapNodeDrop extends LiquidDrop {
  static netTypeName = "Adxstudio.Xrm.Web.Mvc.Liquid.SiteMapNodeDrop";
}

class ObservedSiteMapDrop extends LiquidDrop {
  #delegate;
  #missingNode = new ObservedSiteMapNodeDrop();
  constructor(delegate) {
    super();
    this.#delegate = delegate;
  }
  async liquidGet(key, context) {
    const value = (await lookupMember(this.#delegate, key, context)).value;
    // The two observed missing index keys yield a node drop, not nil. No wider
    // URL resolution or unobserved node properties are inferred from this probe.
    if (value == null && ["name", "code"].includes(String(key).toLowerCase())) return this.#missingNode;
    return value;
  }
}

class ObservedEventsDrop extends LiquidDrop {}

/**
 * Source-derived language content identity for Liquid member lookup. Host reads
 * keep the root navigation ID; every other member uses the standard guarded
 * lookup, including exact attributes, hidden properties and unsafe-key checks.
 * This does not infer page.entity or JSON serialization identity behavior.
 */
export function withLiquidIdentity(record, identity) {
  if (!record || typeof record !== "object" || typeof identity !== "string" || !identity) return record;
  const liquidGet = async (key, context) =>
    String(key).toLowerCase() === "id" ? identity : (await lookupMember(record, key, context)).value;
  return new Proxy(record, {
    get(target, key, receiver) {
      if (key === "liquidGet") return liquidGet;
      return Reflect.get(target, key, receiver);
    },
  });
}

/** Apply only observed drop members/types; source-derived identity is independent. */
export function applyObservedLiquidObjects(context, { mode = "dotliquid", pageIdentity = null } = {}) {
  if (!["dotliquid", "observed"].includes(mode)) throw new TypeError("Unknown Liquid object compatibility mode");
  if (mode === "dotliquid" && !pageIdentity) return context;
  const result = { ...context };
  if (mode === "observed") {
    result.website = hideHostName(context.website);
    result.user = hideHostName(context.user);
    if (context.entities) result.entities = new ObservedEntitiesDrop(context.entities);
    if (context.sitemap) result.sitemap = new ObservedSiteMapDrop(context.sitemap);
    // Presence and empty member probes were observed, not an events service.
    result.events = context.events ?? new ObservedEventsDrop();
  }
  if (pageIdentity) result.page = withLiquidIdentity(context.page, pageIdentity);
  return result;
}
