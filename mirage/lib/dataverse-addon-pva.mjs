// Copilot Studio (Pva*) bots and Teams chat linking: the 20 messages of the native base-environment $metadata (add-on family F7)
// that are not on the flows module. Registered through registerAddon or registerInternalMessage (dataverse-addon-common.mjs).
// Contract: the Web API reference pages of each message, read 2026-10-20 (where Learn gives one).
// The C messages (Learn: "For internal use only.") answer the not-simulated default unless a store-backed behaviour is given; the
// others answer featureNotEnabled(). A trusted pack's dataverseMessages handler replaces any of them.
// unverified: the sharing role mapping (1 is Read, Write and Share, else Read), the ShareOrUnshare value, the bot list format,
// the snapshot id, and the shared workspace response.
// Bot publishing and the chat service require trusted pack handlers.
import { createHash, randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { argsOf, featureNotEnabled, idOf, registerAddon, registerInternalMessage } from "./dataverse-addon-common.mjs";
import { contextUrl } from "./dataverse-odata.mjs";
import { ACCESS_RIGHTS, grantAccess, revokeAccess } from "./dataverse-security.mjs";

const key = (value) => String(value ?? "").toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const invalid = (message) => new DataError(message, 400, "InvalidRequest", { innerCode: "0x80040203" }); // unverified: message
const notFound = (logical, id) => new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, "NotFound", { innerCode: "0x80040217" });
const SHARING_OWNER = ACCESS_RIGHTS.Read | ACCESS_RIGHTS.Write | ACCESS_RIGHTS.Share; // unverified: SharingRoleType 1
const plain = (entry) => Object.fromEntries(Object.entries(entry ?? {}).filter(([name]) => !name.startsWith("@")));

// name: [spec] pairs, in the order of the brief. bound(...) and unbound(...) build a registerAddon spec.
const unbound = (name, kind, params, out = {}) => ({ name, kind, binding: "unbound", signature: { params, ...out } });
const bound = (name, kind, entity, params, out = {}) => ({ name, kind, binding: "entity", entity, signature: { params, ...out } });
const CRM = "mscrm.crmbaseentity";
const USERS = `Collection(${CRM})`;

// C messages (internal-only, GC policy) with their store-backed behaviour where the brief gives one.
const INTERNAL = [
  unbound("GetEntityLinkChatConfig", "action", [["RegardingEntityName", "Edm.String"]], { returns: CRM }),
  unbound("GetLinkedChats", "action", [["RegardingEntity", CRM]], { response: [["LinkedChatDetails", "Edm.String"]] }),
  unbound("JoinLinkedChat", "action", [["UserId", "Edm.Guid"], ["TeamsChatId", "Edm.String"], ["RegardingEntity", CRM]]),
  bound("PvaAuthorize", "action", "bot", [["Users", USERS], ["SharingRoleType", "Edm.Int32"], ["ShareOrUnshare", "Edm.Boolean"]]),
  bound("PvaCreateBotComponents", "action", "bot", [["BotComponents", USERS]]),
  bound("PvaCreateContentSnapshot", "action", "bot", [], { response: [["SnapshotId", "Edm.String"]] }),
  bound("PvaDeleteBot", "action", "bot", []),
  bound("PvaGetDirectLineEndpoint", "action", "bot", [], { response: [["Endpoint", "Edm.String"]] }),
  unbound("PvaGetFeatureControlSet", "action", [], { response: [["FeatureControlSet", "Edm.String"]] }),
  unbound("PvaGetMaxDatabaseVersion", "action", [], { response: [["VersionInfo", "Edm.String"]] }),
  unbound("PvaGetUserBots", "action", [["RoleType", "Edm.Int32"]], { response: [["Bots", "Edm.String"]] }),
  bound("PvaProvision", "action", "bot", []),
  bound("PvaPublish", "action", "bot", [], { response: [["PublishedBotContentId", "Edm.String"]] }),
  bound("PvaPublishStatus", "action", "bot", [["PublishBotJob", "Edm.String"]], { returns: CRM }),
  bound("PvaShareConnection", "action", "connectionreference", []),
  unbound("PvaStartConversation", "action", [["Version", "Edm.String"], ["Request", CRM]], { returns: CRM }),
];

// A messages: a store-backed behaviour where given, else featureNotEnabled().
const ACTIVE = [
  bound("PvaComponentCollectionAuthorize", "action", "botcomponentcollection", [["Users", USERS], ["SharingRoleType", "Edm.Int32"], ["ShareOrUnshare", "Edm.Boolean"]]),
  bound("PvaDeleteBotComponentCollection", "action", "botcomponentcollection", []),
  unbound("GetOrCreateSharedWorkspace", "action", [["customclaims", CRM], ["target", "mscrm.sharedworkspace"]], { returns: "mscrm.sharedworkspace" }),
  unbound("SyncCopresenceState", "action", [["ResourceId", "Edm.String"], ["ResourceType", "Edm.String"], ["UserConnectionDetails", "Edm.String"]], { response: [["CopresenceInfo", "Edm.String"]] }),
];

function operations(api) {
  const { store } = api;
  const tableOf = (logical) => (store.state.tables[logical] ??= []);
  const rowOf = (logical, id) => tableOf(logical).find((row) => sameId(row[`${logical}id`], id)) ?? null;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const boundRow = (c, logical) => {
    const row = rowOf(logical, c.target?.id);
    if (!row) throw notFound(logical, c.target?.id);
    return row;
  };
  // Removes by primary key: a row read before the transaction is a copy of the state row, not the state row itself.
  const removeRow = (logical, row) => {
    const list = tableOf(logical);
    const index = list.findIndex((item) => sameId(item[`${logical}id`], row[`${logical}id`]));
    if (index >= 0) list.splice(index, 1);
  };

  // The bot's components: the rows whose parent is the bot.
  const componentsOf = (botId) => tableOf("botcomponent").filter((row) => sameId(row.parentbotid, botId));

  // Share (ShareOrUnshare true) or unshare the target with each systemuser in Users. Every user is checked before any write.
  async function authorize(c, logical) {
    const target = boundRow(c, logical);
    api.principals.authorize({ user: c.user, entity: logical, operation: "share", row: target, mapping: api.store.resolveMapping(logical) });
    const args = argsOf(c);
    const principals = (args.Users ?? []).map((user) => {
      const id = idOf(user);
      if (!id || !tableOf("systemuser").some((row) => sameId(row.systemuserid, id))) throw invalid("The user to share with does not exist.");
      return { id, logical_name: "systemuser" };
    });
    const mask = Number(args.SharingRoleType) === 1 ? SHARING_OWNER : ACCESS_RIGHTS.Read;
    const grant = args.ShareOrUnshare !== false;
    await api.change(() => {
      for (const principal of principals) {
        const share = { target: { logical, id: target[`${logical}id`] }, principal };
        if (grant) grantAccess(store, { ...share, mask });
        else revokeAccess(store, share);
      }
    });
    return undefined;
  }

  const handlers = {
    PvaAuthorize: (c) => authorize(c, "bot"),
    PvaComponentCollectionAuthorize: (c) => authorize(c, "botcomponentcollection"),

    PvaCreateBotComponents: async (c) => {
      const bot = boundRow(c, "bot");
      const entries = argsOf(c).BotComponents ?? [];
      if (!Array.isArray(entries)) throw invalid("BotComponents must be a collection.");
      await write(() => {
        for (const entry of entries) tableOf("botcomponent").push({ ...plain(entry), botcomponentid: randomUUID(), parentbotid: bot.botid });
      });
      return undefined;
    },

    PvaCreateContentSnapshot: async (c) => {
      const bot = boundRow(c, "bot");
      // unverified: the snapshot id is the sha1 of the bot's component rows.
      const SnapshotId = createHash("sha1").update(JSON.stringify(componentsOf(bot.botid))).digest("hex");
      return { SnapshotId };
    },

    PvaDeleteBot: async (c) => {
      const bot = boundRow(c, "bot");
      await write(() => {
        for (const component of componentsOf(bot.botid)) removeRow("botcomponent", component);
        removeRow("bot", bot);
      });
      return undefined;
    },

    PvaDeleteBotComponentCollection: async (c) => {
      const collection = boundRow(c, "botcomponentcollection");
      await write(() => {
        for (const component of tableOf("botcomponent").filter((row) => sameId(row.parentbotcomponentcollectionid, collection.botcomponentcollectionid))) {
          removeRow("botcomponent", component);
        }
        removeRow("botcomponentcollection", collection);
      });
      return undefined;
    },

    // The bots the caller owns, as a JSON list of { botid, name }. unverified: the list format and RoleType (ignored).
    PvaGetUserBots: async (c) => {
      const owner = c.user?.systemuserid;
      const bots = tableOf("bot").filter((row) => sameId(row.ownerid, owner)).map((row) => ({ botid: row.botid, name: row.name }));
      return { Bots: JSON.stringify(bots) };
    },

    // Find the workspace by its name, or create it. unverified: the matching rule and the new row's columns.
    GetOrCreateSharedWorkspace: async (c) => {
      const name = argsOf(c).target?.name;
      let row = tableOf("sharedworkspace").find((item) => key(item.name) === key(name));
      if (!row) {
        row = { sharedworkspaceid: randomUUID(), name, statecode: 0, statuscode: 1 };
        await write(() => tableOf("sharedworkspace").push(row));
      }
      return { "@odata.context": contextUrl(c.origin, c.version, "sharedworkspaces/$entity"), ...row };
    },
  };

  return { handlers };
}

export function install(api) {
  const { handlers } = operations(api);
  for (const spec of ACTIVE) registerAddon(api, { ...spec, handle: handlers[spec.name], fallback: featureNotEnabled });
  for (const spec of INTERNAL) {
    if (handlers[spec.name]) registerInternalMessage(api, { ...spec, handle: handlers[spec.name] });
    else registerInternalMessage(api, spec);
  }
}

export const EXTENSION = { name: "dataverse-addon-pva", install };
