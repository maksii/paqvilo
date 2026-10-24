// Git source control messages (the Git integration API and the Web API ConnectToGit, DisconnectFromGit, CommitToGit,
// RefreshChangesFromGit, PullChangesFromGit(Async), ExportSolutionFromGit(Async), PreValidateGitComponents and
// ValidateSourceControlConnection). Unbound actions, registered through registerAddon (dataverse-addon-common.mjs).
//
// The remote is a local directory the project sets (settings.gitRemoteDirectory). No network, no git binary:
//   <dir>/<Organization>/<Project>/<Repository>/refs/<branch>  the head commit id (empty: no commit yet; missing: no branch)
//   <dir>/<Organization>/<Project>/<Repository>/objects/<id>.json  one commit: { parent, message, author, time, solutions }
//     where solutions is { <uniquename>: { unmanaged, managed } } (base64 zips). New ids use SHA-256 of that JSON;
//     existing SHA-1 ids remain readable. These local objects are not native Git objects.
// Export and import reuse the ExportSolution and ImportSolution handlers (dataverse-solutions.mjs), found in api.registry at
// call time, so that module is not edited.
//
// Tables: sourcecontrolconfiguration (one row per repository), sourcecontrolbranchconfiguration (one row per connected
// solution; name is the solution's unique name, a guess), sourcecontrolcomponent (pending Push, Pull and Conflict rows).
// A component row carries its solution in solutionuniquename, a field that is not a native column.
// Guesses: the undocumented messages and HTTP statuses, the Type value of CommitToGit, the branch row's name,
// the action and componenttype values of the pending rows (action 1 Push, 2 Pull, 3 Conflict; solution componenttype 7).
// ponytail: the remote side compares whole solutions (one Solution row), not components.
// ponytail: refresh treats every member as changed when the local export differs from the synced commit, not per modification time.
// ponytail: pull does not remove membership of components absent from the remote zip (needs the zip's component list).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DataError } from "./data-error.mjs";
import { argsOf, registerAddon } from "./dataverse-addon-common.mjs";
import { componentsOf } from "./dataverse-solution-messages.mjs";
import { requireMetadataPrivilege } from "./dataverse-metadata-relationships.mjs";

const CONNECTED = 0, DISCONNECTED = 1;
const ACTION = { Push: 1, Pull: 2, Conflict: 3 };
const SOLUTION_TYPE = 7; // componenttype of a solution row (a guess)
const SYNC = { Connected: 3, Committed: 4 }; // solution.sourcecontrolsyncstatus (a guess)
const FORBIDDEN_BRANCH_TEXT = [" ", "~", "^", ":", "?", "*", "[", "\\", ".."];
const PULL_PARAMETERS = [["SolutionUniqueName", "Edm.String"], ["AdditionalParameters", "mscrm.PullChangesFromGitParameters"]];

const lower = (value) => String(value ?? "").toLowerCase();
const stamp = (api) => new Date(api.clock?.() ?? Date.now()).toISOString();
const rowsOf = (api, table) => api.store.state.tables[table] ?? [];
const tableOf = (api, table) => (api.store.state.tables[table] ??= []);
const findRow = (api, table, key, id) => rowsOf(api, table).find((row) => row[key] === id);
const write = (api, fn) => api.change(() => api.store.transact(fn, { isolated: true }));
const gitError = (message, status, code, innerCode) => new DataError(message, status, code, { innerCode });
const noResource = () => gitError("Git resource does not exist or do not have permissions for the operation attempted.", 400, "InvalidRequest", "0x80098001"); // status is a guess
const handlerOf = (api, name) => api.registry.find({ name, kind: "action", binding: "unbound" });

// Remote paths. A repository segment must be one plain name (the values come from the request).
function remoteOf(api, config) {
  const root = api.settings.gitRemoteDirectory;
  const segments = [config?.organizationname, config?.projectname, config?.repositoryname];
  if (!root || segments.some((s) => !s || s === "." || s === ".." || /[\\/]/.test(s))) throw noResource();
  return path.join(root, ...segments);
}
const refFile = (repo, branch) => {
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (typeof branch !== "string" || !branch || path.isAbsolute(branch) || /[\\\u0000-\u001f]/.test(branch)) throw noResource();
  const root = path.resolve(repo, "refs"), file = path.resolve(root, branch), relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw noResource();
  return file;
};
const commitFile = (repo, id) => {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(id))) throw noResource();
  return path.join(repo, "objects", `${id}.json`);
};

// The head commit id: undefined when the branch does not exist, null when it has no commit yet.
function headOf(repo, branch) {
  if (!existsSync(refFile(repo, branch))) return undefined;
  return readFileSync(refFile(repo, branch), "utf8").trim() || null;
}
function setHead(repo, branch, id) {
  mkdirSync(path.dirname(refFile(repo, branch)), { recursive: true });
  writeFileSync(refFile(repo, branch), id ?? "");
}
const readCommit = (repo, id) => JSON.parse(readFileSync(commitFile(repo, id), "utf8"));
function writeCommit(repo, commit) {
  const json = JSON.stringify(commit);
  const id = createHash("sha256").update(json).digest("hex");
  mkdirSync(path.join(repo, "objects"), { recursive: true });
  writeFileSync(commitFile(repo, id), json);
  return id;
}

// The branch must exist; returns its head (see headOf) and the commit at that head.
function commitOf(repo, branch) {
  const head = headOf(repo, branch);
  if (head === undefined) throw noResource();
  return { head, commit: head ? readCommit(repo, head) : null };
}
const zipsOf = (commit, name) => Object.entries(commit?.solutions ?? {}).find(([key]) => lower(key) === lower(name))?.[1];

// The connected branch row of a solution, its configuration and its remote directory.
function connectionOf(api, solutionName) {
  const branch = rowsOf(api, "sourcecontrolbranchconfiguration").find((b) => lower(b.name) === lower(solutionName) && b.statuscode === CONNECTED);
  if (!branch) throw gitError(`The solution ${solutionName} is not connected to Git.`, 400, "InvalidRequest"); // native message not known
  const config = findRow(api, "sourcecontrolconfiguration", "sourcecontrolconfigurationid", branch.sourcecontrolconfigurationid);
  return { branch, repo: remoteOf(api, config) };
}

function solutionOf(api, name) {
  const row = rowsOf(api, "solution").find((s) => lower(s.uniquename) === lower(name) && s.parentsolutionid == null);
  if (!row) throw new DataError(`Solution with UniqueName '${name}' does not exist.`, 404, "NotFound"); // native message not known
  return row;
}

// Local zips of a solution, from the ExportSolution handler.
function exportZips(c, api, name) {
  const exportOne = (managed) => handlerOf(api, "ExportSolution").handle({ ...c, body: { SolutionName: name, Managed: managed } }).body.ExportSolutionFile;
  return { unmanaged: exportOne(false), managed: exportOne(true) };
}

// The remote zip of a commit's solution, for ImportSolution (it overwrites the unmanaged solution).
async function importZip(c, api, zip) {
  await handlerOf(api, "ImportSolution").handle({ ...c, body: { CustomizationFile: zip, OverwriteUnmanagedCustomizations: true } });
}

const gitRow = (solutionuniquename, componenttype, name, action) => ({
  sourcecontrolcomponentid: randomUUID(), componenttype, componentdisplayname: name, name, action, useraction: null,
  componenttypename: null, sourcecontrolcomponentpayloadid: null, partitionid: null, ttlinseconds: null, solutionuniquename,
});
const removeRows = (api, table, predicate) => {
  const list = tableOf(api, table);
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) list.splice(i, 1);
};

// The remote commit a pull applies: the head of the branch, and the solution's zip in it.
function pullOf(api, name) {
  const { branch, repo } = connectionOf(api, name);
  const { head, commit } = commitOf(repo, branch.branchname);
  const zips = zipsOf(commit, name);
  if (!zips) throw new DataError(`The branch has no commit of solution ${name}.`, 404, "NotFound"); // native message not known
  return { branchId: branch.sourcecontrolbranchconfigurationid, head, zips };
}

async function applyPull(c, api, name, pull) {
  await importZip(c, api, pull.zips.unmanaged);
  await write(api, () => {
    Object.assign(findRow(api, "sourcecontrolbranchconfiguration", "sourcecontrolbranchconfigurationid", pull.branchId), {
      branchsyncedcommitid: pull.head, branchsyncedtime: stamp(api),
    });
    removeRows(api, "sourcecontrolcomponent", (r) => r.solutionuniquename === name && r.action === ACTION.Pull);
  });
}

// The zip a git export returns: the release branch's head, else the connected branch's head.
function exportFromGit(api, a) {
  const { branch, repo } = connectionOf(api, a.SolutionName);
  const { head, commit } = commitOf(repo, a.ReleaseBranch || branch.branchname);
  const zips = zipsOf(commit, a.SolutionName);
  if (!zips) throw new DataError(`The branch has no commit of solution ${a.SolutionName}.`, 404, "NotFound"); // native message not known
  return { file: a.Managed ? zips.managed : zips.unmanaged, commitId: head };
}

export function installGit(api) {
  const importPriv = (c) => requireMetadataPrivilege(api, c, "prvImportCustomization", "solution");
  const exportPriv = (c) => requireMetadataPrivilege(api, c, "prvExportCustomization", "solution");
  const op = (spec) => registerAddon(api, { kind: "action", binding: "unbound", fallback: noResource, ...spec });

  op({
    name: "ConnectToGit",
    signature: {
      params: [
        ["GitHubAppConfigId", "mscrm.githubappconfig"], ["Organization", "Edm.String"], ["ConnectionType", "Edm.Int32"],
        ["UpstreamBranch", "Edm.String"], ["GitHubConnectionId", "Edm.String"], ["Branch", "Edm.String"], ["Repository", "Edm.String"],
        ["Project", "Edm.String"], ["GitHubPAT", "Edm.String"], ["SolutionUniqueName", "Edm.String"], ["RootFolder", "Edm.String"],
        ["GitProvider", "Edm.Int32"], ["GitFolder", "Edm.String"], ["EnterpriseSubdomain", "Edm.String"],
      ],
    },
    handle: async (c) => {
      importPriv(c);
      const a = argsOf(c);
      if (!a.GitFolder || !a.Branch) throw gitError("GitFolder and Branch are required.", 400, "InvalidRequest", "0x80040203"); // native message not known
      const forbidden = FORBIDDEN_BRANCH_TEXT.find((text) => a.Branch.includes(text));
      if (forbidden !== undefined) throw gitError(`Invalid git branch name. Branch name cannot contain ${forbidden}.`, 400, "InvalidRequest", "0x80098011"); // native message not known
      if (a.SolutionUniqueName) solutionOf(api, a.SolutionUniqueName);
      // A follow-up solution passes no repository and inherits the first connection's configuration.
      const configs = rowsOf(api, "sourcecontrolconfiguration");
      const named = a.Organization && a.Project && a.Repository;
      const config = named
        ? configs.find((r) => lower(r.organizationname) === lower(a.Organization) && lower(r.projectname) === lower(a.Project) && lower(r.repositoryname) === lower(a.Repository))
          ?? { sourcecontrolconfigurationid: randomUUID(), organizationname: a.Organization, projectname: a.Project, repositoryname: a.Repository, gitprovider: a.GitProvider ?? null, name: a.Repository, partitionid: null, ttlinseconds: null }
        : configs[0];
      if (!config) throw noResource();
      const { head } = commitOf(remoteOf(api, config), a.Branch); // the branch must already exist
      const name = a.SolutionUniqueName ?? null;
      const rootfolderpath = [a.RootFolder, a.GitFolder].filter(Boolean).join("/");
      await write(api, () => {
        const list = tableOf(api, "sourcecontrolconfiguration");
        if (!list.includes(config)) list.push(config);
        const branches = tableOf(api, "sourcecontrolbranchconfiguration");
        let branch = branches.find((b) => lower(b.name) === lower(name));
        if (!branch) branches.push(branch = { sourcecontrolbranchconfigurationid: randomUUID(), partitionid: null, ttlinseconds: null });
        Object.assign(branch, {
          name, branchname: a.Branch, upstreambranchname: a.UpstreamBranch || a.Branch, rootfolderpath, statuscode: CONNECTED,
          sourcecontrolconfigurationid: config.sourcecontrolconfigurationid, branchsyncedcommitid: head, branchsyncedtime: stamp(api),
        });
        if (name) Object.assign(solutionOf(api, name), { enabledforsourcecontrolintegration: true, sourcecontrolsyncstatus: SYNC.Connected });
      });
    },
  });

  op({
    name: "DisconnectFromGit",
    signature: { params: [["SolutionUniqueName", "Edm.String"]], response: [["Response", "Edm.String"]] },
    handle: async (c) => {
      importPriv(c);
      const name = argsOf(c).SolutionUniqueName;
      await write(api, () => {
        for (const b of tableOf(api, "sourcecontrolbranchconfiguration")) if (!name || lower(b.name) === lower(name)) b.statuscode = DISCONNECTED;
      });
      return undefined; // 204, as the documented sample; the CSDL response type is a guess
    },
  });

  op({
    name: "CommitToGit",
    signature: { params: [["CommitMessage", "Edm.String"], ["SolutionUniqueName", "Edm.String"]], response: [["Type", "Edm.Int32"], ["CommitId", "Edm.String"]] },
    handle: async (c) => {
      exportPriv(c);
      const a = argsOf(c);
      const solution = solutionOf(api, a.SolutionUniqueName);
      const { branch, repo } = connectionOf(api, a.SolutionUniqueName);
      const { head } = commitOf(repo, branch.branchname);
      if ((head ?? null) !== (branch.branchsyncedcommitid ?? null)) {
        throw gitError("The branch has been updated by another user. Please sync the environment with Git and try again.", 400, "InvalidRequest", "0x80098010"); // status is a guess
      }
      const parent = head ? readCommit(repo, head) : null;
      const zips = exportZips(c, api, solution.uniquename);
      const id = writeCommit(repo, {
        parent: head, message: a.CommitMessage, author: c.caller?.systemuserid ?? null, time: stamp(api),
        solutions: { ...(parent?.solutions ?? {}), [solution.uniquename]: zips },
      });
      setHead(repo, branch.branchname, id);
      await write(api, () => {
        Object.assign(findRow(api, "sourcecontrolbranchconfiguration", "sourcecontrolbranchconfigurationid", branch.sourcecontrolbranchconfigurationid), {
          branchsyncedcommitid: id, branchsyncedtime: stamp(api),
        });
        Object.assign(findRow(api, "solution", "solutionid", solution.solutionid), { sourcecontrolsyncstatus: SYNC.Committed });
        removeRows(api, "sourcecontrolcomponent", (r) => r.solutionuniquename === solution.uniquename && r.action === ACTION.Push);
      });
      return { Type: 0, CommitId: id }; // Type is a guess
    },
  });

  op({
    name: "RefreshChangesFromGit",
    signature: { params: [["SolutionUniqueName", "Edm.String"], ["LastRefreshTime", "Edm.String"]] },
    handle: async (c) => {
      exportPriv(c);
      const a = argsOf(c);
      const solution = solutionOf(api, a.SolutionUniqueName);
      const { branch, repo } = connectionOf(api, a.SolutionUniqueName);
      const { head } = commitOf(repo, branch.branchname);
      const remoteChanged = (head ?? null) !== (branch.branchsyncedcommitid ?? null);
      const syncedZips = branch.branchsyncedcommitid ? zipsOf(readCommit(repo, branch.branchsyncedcommitid), solution.uniquename) : undefined;
      const localChanged = exportZips(c, api, solution.uniquename).unmanaged !== syncedZips?.unmanaged;
      const members = new Set(rowsOf(api, "solutioncomponent").filter((r) => lower(r.solutionid) === lower(solution.solutionid)).map((r) => lower(r.objectid)));
      const rows = [];
      if (localChanged) for (const m of componentsOf(api.store.state).filter((m) => members.has(lower(m.id)))) rows.push(gitRow(solution.uniquename, m.type, m.name ?? m.logical, ACTION.Push));
      if (localChanged || remoteChanged) {
        rows.push(gitRow(solution.uniquename, SOLUTION_TYPE, solution.uniquename, localChanged && remoteChanged ? ACTION.Conflict : localChanged ? ACTION.Push : ACTION.Pull));
      }
      await write(api, () => {
        removeRows(api, "sourcecontrolcomponent", (r) => r.solutionuniquename === solution.uniquename);
        tableOf(api, "sourcecontrolcomponent").push(...rows);
      });
    },
  });

  op({
    name: "PullChangesFromGit",
    csdl: `<ComplexType Name="PullChangesFromGitParameters"><Property Name="DeleteDeletedComponents" Type="Edm.Boolean" /></ComplexType>
<Action Name="PullChangesFromGit"><Parameter Name="SolutionUniqueName" Type="Edm.String" /><Parameter Name="AdditionalParameters" Type="mscrm.PullChangesFromGitParameters" /></Action>`,
    handle: async (c) => {
      importPriv(c);
      const name = argsOf(c).SolutionUniqueName;
      await applyPull(c, api, name, pullOf(api, name));
    },
  });

  op({
    name: "PullChangesFromGitAsync",
    signature: { params: PULL_PARAMETERS, response: [["AsyncOperationId", "Edm.Guid"]] },
    handle: async (c) => {
      importPriv(c);
      const name = argsOf(c).SolutionUniqueName;
      const pull = pullOf(api, name);
      const asyncId = await api.systemJob({ name: `Pull ${name} from Git`, operationtype: null, callerId: c.caller.systemuserid }, () => applyPull(c, api, name, pull));
      return { AsyncOperationId: asyncId }; // the asyncoperation operationtype is a guess
    },
  });

  op({
    name: "ExportSolutionFromGit",
    signature: {
      params: [["SolutionName", "Edm.String"], ["Managed", "Edm.Boolean"], ["ReleaseBranch", "Edm.String"], ["IsLiteExport", "Edm.Boolean"]],
      response: [["SolutionZip", "Edm.Binary"], ["CommitId", "Edm.String"]],
    },
    handle: (c) => {
      exportPriv(c);
      const { file, commitId } = exportFromGit(api, argsOf(c));
      return { SolutionZip: file, CommitId: commitId };
    },
  });

  op({
    name: "ExportSolutionFromGitAsync",
    signature: { params: [["SolutionName", "Edm.String"], ["Managed", "Edm.Boolean"], ["ReleaseBranch", "Edm.String"]], response: [["AsyncOperationId", "Edm.Guid"], ["ExportJobId", "Edm.Guid"]] },
    handle: async (c) => {
      exportPriv(c);
      const a = argsOf(c);
      const { file } = exportFromGit(api, a);
      const exportJobId = randomUUID();
      const asyncId = await api.systemJob({ name: `Export ${a.SolutionName} from Git`, operationtype: null, callerId: c.caller.systemuserid }, () => write(api, () => {
        ((api.store.state.dataverse ??= {}).exportJobs ??= {})[lower(exportJobId)] = { solutionName: a.SolutionName, managed: a.Managed === true, file };
      }));
      return { AsyncOperationId: asyncId, ExportJobId: exportJobId };
    },
  });

  op({
    name: "PreValidateGitComponents",
    signature: { params: [["SolutionUniqueName", "Edm.String"], ["IsRetriableOnly", "Edm.Boolean"]], response: [["ValidationMessages", "Edm.String"]] },
    handle: (c) => {
      exportPriv(c);
      solutionOf(api, argsOf(c).SolutionUniqueName);
      return { ValidationMessages: "[]" }; // no validation rules are simulated
    },
  });

  op({
    name: "ValidateSourceControlConnection",
    signature: { params: [], response: [["IsValid", "Edm.Boolean"]] },
    handle: () => ({
      IsValid: rowsOf(api, "sourcecontrolbranchconfiguration").some((b) => {
        if (b.statuscode !== CONNECTED) return false;
        const config = findRow(api, "sourcecontrolconfiguration", "sourcecontrolconfigurationid", b.sourcecontrolconfigurationid);
        try {
          return headOf(remoteOf(api, config), b.branchname) !== undefined;
        } catch {
          return false;
        }
      }),
    }),
  });
}

export const EXTENSION = { name: "dataverse-addon-git", install: installGit };
