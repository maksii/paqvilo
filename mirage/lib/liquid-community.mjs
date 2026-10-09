// Power Pages `polls` and `ads` Liquid objects over exported adx_poll*/adx_ad* records.
//
// Mirrors Adxstudio PollsDrop/PollPlacementsDrop/PollPlacementDrop/PollDrop/PollOptionDrop and
// AdsDrop/AdPlacementsDrop/AdPlacementDrop/AdDrop/AdImageDrop (Web/Mvc/Liquid) with the record
// selection of Cms/PollDataAdapter.cs and Cms/AdDataAdapter.cs:
// - objects[key]: a GUID key selects by primary id, any other key by exact adx_name;
// - polls and placements must be active (statecode 0); polls also need
//   releasedate <= now + 1 day and expirationdate >= now (missing dates count as now);
// - ads must be active, unexpired and visible through their publishing state;
// - URLs are the Cms area routes (CmsAreaRegistration.cs): /_services/polls/{website}/...,
//   /_services/ads/{website}/...; route values outside the template become query parameters.
// Poll submissions are runtime data, so has_user_voted is false and user_selected_option nil.
import { LiquidDrop, LIQUID_PROPERTIES } from "./liquid-engine.mjs";
import { NetDecimal, decimalDivide, decimalMultiply, parseNetDate } from "./liquid-dotnet.mjs";

const GUID_KEY = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const IMPORTER_KEYS = new Set(["kind", "id", "name", "statecode"]);
const ENTITY_DROP_PROPERTIES = ["id", "logical_name", "logicalname", "url"];

const fieldOf = (record, name) => record?.[`adx_${name}`] ?? record?.[`mspp_${name}`] ?? record?.[name];
const guidOf = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const isActive = (record) => Number(record?.statecode ?? fieldOf(record, "statecode") ?? 0) === 0;
const displayOrder = (record) => {
  const value = Number(fieldOf(record, "displayorder"));
  return fieldOf(record, "displayorder") == null || Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
};
const dateOf = (value) => (value == null || value === "" ? null : (parseNetDate(value) ?? null));
const idList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(guidOf).filter(Boolean);
/** Text attributes exported as YAML booleans/numbers keep their Dataverse string form. */
const text = (value) => (value == null ? null : typeof value === "boolean" ? (value ? "True" : "False") : String(value));
/** VirtualPathUtility.ToAbsolute for app-relative (~/) values on a root-hosted site. */
const absolute = (value) => {
  const url = text(value);
  if (!url) return null;
  if (url === "~") return "/";
  return url.startsWith("~/") ? url.slice(1) : url;
};

/** EntityDrop: Dataverse attributes (exact names) plus case-insensitive drop properties. */
function entityDrop(record, logicalName, properties) {
  const drop = {};
  for (const [key, value] of Object.entries(record ?? {}))
    if (!key.startsWith("_") && !IMPORTER_KEYS.has(key)) drop[key] = value;
  drop.id = guidOf(record?.id);
  drop.logical_name = logicalName;
  Object.assign(drop, properties);
  Object.defineProperty(drop, LIQUID_PROPERTIES, {
    value: new Set([...ENTITY_DROP_PROPERTIES, ...Object.keys(properties)]),
  });
  return drop;
}

function selectBy(records, key, accept) {
  if (key == null) return null;
  const name = String(key);
  if (!name) return null;
  if (GUID_KEY.test(name)) return records.find((record) => guidOf(record.id) === guidOf(name) && accept(record)) ?? null;
  return records.find((record) => text(fieldOf(record, "name")) === name && accept(record)) ?? null;
}

class KeyedDrop extends LiquidDrop {
  constructor(select, properties = {}) {
    super();
    this.select = select;
    this.properties = properties;
  }
  liquidGet(key) {
    const property = Object.keys(this.properties).find((name) => name === String(key).toLowerCase());
    if (property) return this.properties[property];
    return this.select(key);
  }
}

/** Build the `polls` object for a render (now is the render's UTC time). */
export function createPollsDrop(portal, { now = new Date() } = {}) {
  const records = portal.records ?? [];
  const website = guidOf(portal.website?.id);
  const polls = records.filter((record) => record.kind === "poll");
  const placements = records.filter((record) => record.kind === "pollplacement");
  const options = records.filter((record) => record.kind === "polloption");
  const time = now instanceof Date ? now.getTime() : Date.parse(now);
  const inWindow = (record) => {
    const release = dateOf(fieldOf(record, "releasedate"))?.getTime() ?? time;
    const expiration = dateOf(fieldOf(record, "expirationdate"))?.getTime() ?? time;
    return release <= time + 86_400_000 && expiration >= time;
  };
  const pollAccepted = (record) => isActive(record) && inWindow(record);
  const pollDrop = (record) => {
    const id = guidOf(record.id);
    // Options follow adx_displayorder (reference-portal lists "Yes" (1) before "No" (2) where the export lists
    // No first); options without a display order keep the export order after the ordered ones.
    const related = options
      .filter((option) => guidOf(fieldOf(option, "pollid")) === id)
      .sort((a, b) => displayOrder(a) - displayOrder(b));
    const votes = related.reduce((sum, option) => sum + (Number(fieldOf(option, "votes")) || 0), 0);
    const optionDrops = related.map((option) => {
      const optionVotes = Number(fieldOf(option, "votes")) || 0;
      return entityDrop(option, "adx_polloption", {
        answer: text(fieldOf(option, "answer")),
        votes: optionVotes,
        percentage: votes > 0 ? decimalMultiply(decimalDivide(NetDecimal.from(optionVotes), NetDecimal.from(votes)), NetDecimal.from(100)) : NetDecimal.from(0),
      });
    });
    return entityDrop(record, "adx_poll", {
      name: text(fieldOf(record, "name")),
      question: text(fieldOf(record, "question")),
      submit_button_label: text(fieldOf(record, "submitbuttonlabel")),
      has_user_voted: false,
      options: optionDrops,
      user_selected_option: null,
      votes,
      poll_url: `/_services/polls/${website}/${id}`,
      submit_url: `/_services/polls/${website}/SubmitPoll?id=${id}`,
    });
  };
  const placementDrop = (record) => {
    const id = guidOf(record.id);
    const linked = idList(fieldOf(record, "pollplacement_poll"));
    return entityDrop(record, "adx_pollplacement", {
      name: text(fieldOf(record, "name")),
      polls: polls.filter((poll) => linked.includes(guidOf(poll.id)) && inWindow(poll) && isActive(poll)).map(pollDrop),
      placement_url: `/_services/polls/${website}/placements/${id}`,
      random_url: `/_services/polls/${website}/placements/${id}/random`,
      submit_url: `/_services/polls/${website}/SubmitPoll?id=${id}`,
    });
  };
  const placementsDrop = new KeyedDrop((key) => {
    const record = selectBy(placements, key, isActive);
    return record ? placementDrop(record) : null;
  });
  return new KeyedDrop(
    (key) => {
      const record = selectBy(polls, key, pollAccepted);
      return record ? pollDrop(record) : null;
    },
    { placements: placementsDrop },
  );
}

/** Build the `ads` object for a render. */
export function createAdsDrop(portal, { now = new Date(), previewUnpublished = false } = {}) {
  const records = portal.records ?? [];
  const website = guidOf(portal.website?.id);
  const ads = records.filter((record) => record.kind === "ad");
  const placements = records.filter((record) => record.kind === "adplacement");
  const states = new Map((portal.publishingStates ?? []).map((state) => [guidOf(state.id), state]));
  const time = now instanceof Date ? now.getTime() : Date.parse(now);
  // PublishingStateAccessProvider: records in a hidden state need preview permission.
  const published = (record) => {
    const state = states.get(guidOf(fieldOf(record, "publishingstateid")));
    return !state || state.isVisible || previewUnpublished;
  };
  const adActive = (record) => {
    const expiration = dateOf(fieldOf(record, "expirationdate"))?.getTime();
    return isActive(record) && (expiration == null || expiration > time);
  };
  const adAccepted = (record) => adActive(record) && published(record);
  const adDrop = (record) => {
    const id = guidOf(record.id);
    const height = fieldOf(record, "imageheight");
    const width = fieldOf(record, "imagewidth");
    const image = {
      alternate_text: text(fieldOf(record, "imagealttext")),
      height: height == null ? null : Number(height),
      url: absolute(fieldOf(record, "image")),
      width: width == null ? null : Number(width),
    };
    Object.defineProperty(image, LIQUID_PROPERTIES, { value: new Set(Object.keys(image)) });
    return entityDrop(record, "adx_ad", {
      copy: text(fieldOf(record, "copy")),
      image,
      name: text(fieldOf(record, "name")),
      open_in_new_window: fieldOf(record, "openinnewwindow") === true || String(fieldOf(record, "openinnewwindow")).toLowerCase() === "true",
      redirect_url: absolute(fieldOf(record, "url")),
      title: text(fieldOf(record, "title")),
      ad_url: `/_services/ads/${website}/${id}`,
    });
  };
  const placementDrop = (record) => {
    const id = guidOf(record.id);
    const linked = idList(fieldOf(record, "adplacement_ad"));
    return entityDrop(record, "adx_adplacement", {
      name: text(fieldOf(record, "name")),
      ads: ads.filter((ad) => linked.includes(guidOf(ad.id)) && adAccepted(ad)).map(adDrop),
      placement_url: `/_services/ads/${website}/placements/${id}`,
      random_url: `/_services/ads/${website}/placements/${id}/random`,
    });
  };
  // AdDataAdapter.IsActive (statecode 0 and not expired) also selects ad placements.
  const placementsDrop = new KeyedDrop((key) => {
    const record = selectBy(placements, key, adActive);
    return record ? placementDrop(record) : null;
  });
  return new KeyedDrop(
    (key) => {
      const record = selectBy(ads, key, adAccepted);
      return record ? adDrop(record) : null;
    },
    { placements: placementsDrop },
  );
}
