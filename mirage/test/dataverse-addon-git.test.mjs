// Git source control messages (lib/dataverse-addon-git.mjs) over the Web API, with a temporary directory as the Git remote
// (no git binary).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { makeTemporaryDirectorySync } from '../testing/owned-fixture.mjs';
import { signedInRequester } from './support/web-api.mjs';

const APP_ID = '77777777-7777-4777-8777-777777777777';
const SOLUTION = 'new_samplesolution';
const PUBLISHER = 'new_samplepublisher';
const ORG = 'contoso',
  PROJECT = 'widgets',
  REPO = 'sample',
  BRANCH = 'main';

let counter = 0;
// One loopback server with a System Administrator application user. gitRemoteDirectory is optional.
async function startServer({ gitRemoteDirectory } = {}) {
  const secretVariable = `PAQVILO_ADDON_GIT_TEST_SECRET_${++counter}`;
  process.env[secretVariable] = 'test-secret-value';
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Git test app',
        secretEnvironmentVariable: secretVariable,
        roles: ['System Administrator'],
      },
    ],
    gitRemoteDirectory,
  });
  const captured = {};
  const capture = {
    name: 'dataverse-addon-git-test-capture',
    install(api) {
      captured.api = api;
    },
  };
  const server = await startDataverseApi({ store, settings, extensions: [...EXTENSIONS, capture], log: () => {} });
  const request = await signedInRequester(server, APP_ID, process.env[secretVariable]);
  return {
    server,
    store,
    api: captured.api,
    request,
    close: async () => {
      delete process.env[secretVariable];
      await server.close();
    },
  };
}

const rowsOf = (store, table) => store.state.tables[table] ?? [];
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

// A remote with the branch in place and no commit yet (an empty refs file).
function remoteWithBranch(root, branch = BRANCH) {
  const refs = path.join(root, ORG, PROJECT, REPO, 'refs');
  mkdirSync(refs, { recursive: true });
  writeFileSync(path.join(refs, branch), '');
  return root;
}
// A second commit that another user pushed: the head commit with a different message, written as a loose object.
function pushedElsewhere(root, message) {
  const repo = path.join(root, ORG, PROJECT, REPO);
  const head = readFileSync(path.join(repo, 'refs', BRANCH), 'utf8').trim();
  const base = head
    ? JSON.parse(readFileSync(path.join(repo, 'objects', `${head}.json`), 'utf8'))
    : { solutions: {}, time: null, author: null };
  const commit = { ...base, parent: head || null, message };
  const json = JSON.stringify(commit);
  const id = sha1(json);
  mkdirSync(path.join(repo, 'objects'), { recursive: true });
  writeFileSync(path.join(repo, 'objects', `${id}.json`), json);
  writeFileSync(path.join(repo, 'refs', BRANCH), id);
  return id;
}

// Creates the solution through the Web API (a publisher and an empty solution), as the other solution tests do.
async function createSolution(source) {
  const publisher = await source.request('POST', '/publishers', {
    uniquename: PUBLISHER,
    friendlyname: 'Sample Publisher',
    customizationprefix: 'new',
    customizationoptionvalueprefix: 10000,
  });
  assert.equal(publisher.status, 204, JSON.stringify(publisher.json));
  const created = await source.request('POST', '/solutions', {
    uniquename: SOLUTION,
    friendlyname: 'Sample Solution',
    version: '1.0.0.0',
    'publisherid@odata.bind': `/publishers(${(await source.request('GET', `/publishers?$select=publisherid&$filter=uniquename eq '${PUBLISHER}'`)).json.value[0].publisherid})`,
  });
  assert.equal(created.status, 204, JSON.stringify(created.json));
}

const connectBody = (overrides = {}) => ({
  Organization: ORG,
  Project: PROJECT,
  Repository: REPO,
  Branch: BRANCH,
  SolutionUniqueName: SOLUTION,
  GitFolder: 'src',
  ConnectionType: 0,
  GitProvider: 1,
  ...overrides,
});

describe('git source control messages', () => {
  let root;
  before(() => {
    root = makeTemporaryDirectorySync(path.join(tmpdir(), 'paqvilo-addon-git-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('no remote directory answers 0x80098001', async () => {
    const source = await startServer();
    try {
      await createSolution(source);
      const response = await source.request('POST', '/ConnectToGit', connectBody());
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, '0x80098001');
    } finally {
      await source.close();
    }
  });

  it('connect requires an existing branch', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'connect-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      const missing = await source.request('POST', '/ConnectToGit', connectBody({ Branch: 'absent' }));
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, '0x80098001');
      const connected = await source.request('POST', '/ConnectToGit', connectBody());
      assert.equal(connected.status, 204, JSON.stringify(connected.json));
    } finally {
      await source.close();
    }
  });

  it('connect writes configuration and branch rows', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'rows-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      assert.equal((await source.request('POST', '/ConnectToGit', connectBody())).status, 204);
      const [config] = rowsOf(source.store, 'sourcecontrolconfiguration');
      assert.equal(config.organizationname, ORG);
      assert.equal(config.repositoryname, REPO);
      const [branch] = rowsOf(source.store, 'sourcecontrolbranchconfiguration');
      assert.equal(branch.branchname, BRANCH);
      assert.equal(branch.rootfolderpath, 'src');
      assert.equal(branch.statuscode, 0);
      assert.equal(branch.sourcecontrolconfigurationid, config.sourcecontrolconfigurationid);
      const solution = rowsOf(source.store, 'solution').find((s) => s.uniquename === SOLUTION);
      assert.equal(solution.enabledforsourcecontrolintegration, true);
    } finally {
      await source.close();
    }
  });

  it('commit writes a deterministic commit id', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'commit-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      const first = await source.request('POST', '/CommitToGit', {
        CommitMessage: 'first',
        SolutionUniqueName: SOLUTION,
      });
      assert.equal(first.status, 200, JSON.stringify(first.json));
      const repo = path.join(dir, ORG, PROJECT, REPO);
      const stored = readFileSync(path.join(repo, 'objects', `${first.json.CommitId}.json`), 'utf8');
      assert.equal(createHash('sha256').update(stored).digest('hex'), first.json.CommitId);
      assert.equal(readFileSync(path.join(repo, 'refs', BRANCH), 'utf8'), first.json.CommitId);
      assert.equal(JSON.parse(stored).parent, null);
      const second = await source.request('POST', '/CommitToGit', {
        CommitMessage: 'second',
        SolutionUniqueName: SOLUTION,
      });
      assert.equal(
        JSON.parse(readFileSync(path.join(repo, 'objects', `${second.json.CommitId}.json`), 'utf8')).parent,
        first.json.CommitId,
      );
    } finally {
      await source.close();
    }
  });

  it('commit refuses an out-of-sync branch', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'sync-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      pushedElsewhere(dir, 'not ours');
      const response = await source.request('POST', '/CommitToGit', {
        CommitMessage: 'late',
        SolutionUniqueName: SOLUTION,
      });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, '0x80098010');
    } finally {
      await source.close();
    }
  });

  it('refresh lists push, pull and conflict', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'refresh-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      await source.request('POST', '/CommitToGit', { CommitMessage: 'base', SolutionUniqueName: SOLUTION });
      const rows = () => rowsOf(source.store, 'sourcecontrolcomponent').map((r) => [r.componenttype, r.action]);
      const refresh = () =>
        source.request('POST', '/RefreshChangesFromGit', {
          SolutionUniqueName: SOLUTION,
          LastRefreshTime: new Date().toISOString(),
        });

      // Unchanged since the commit: no rows (the export is byte-stable, so the zips compare equal).
      assert.equal((await refresh()).status, 204);
      assert.deepEqual(rows(), []);

      // Local change only: a Push row for the solution (7 is the solution componenttype).
      const solution = rowsOf(source.store, 'solution').find((s) => s.uniquename === SOLUTION);
      await source.api.change(() =>
        source.api.store.transact(() => {
          solution.version = '2.0.0.0';
        }),
      );
      assert.equal((await refresh()).status, 204);
      assert.deepEqual(rows(), [[7, 1]]);

      // Local and remote changes: Conflict.
      pushedElsewhere(dir, 'pushed elsewhere');
      assert.equal((await refresh()).status, 204);
      assert.deepEqual(rows(), [[7, 3]]);
    } finally {
      await source.close();
    }
  });

  it('pull imports the remote zip', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'pull-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      const committed = await source.request('POST', '/CommitToGit', {
        CommitMessage: 'base',
        SolutionUniqueName: SOLUTION,
      });
      const solution = rowsOf(source.store, 'solution').find((s) => s.uniquename === SOLUTION);
      await source.api.change(() =>
        source.api.store.transact(() => {
          solution.version = '2.0.0.0';
        }),
      );
      const pulled = await source.request('POST', '/PullChangesFromGit', { SolutionUniqueName: SOLUTION });
      assert.equal(pulled.status, 204, JSON.stringify(pulled.json));
      assert.equal(rowsOf(source.store, 'solution').find((s) => s.uniquename === SOLUTION).version, '1.0.0.0');
      const branch = rowsOf(source.store, 'sourcecontrolbranchconfiguration')[0];
      assert.equal(branch.branchsyncedcommitid, committed.json.CommitId);
    } finally {
      await source.close();
    }
  });

  it('export from git returns the zip and commit id', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'export-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      const committed = await source.request('POST', '/CommitToGit', {
        CommitMessage: 'base',
        SolutionUniqueName: SOLUTION,
      });
      const response = await source.request('POST', '/ExportSolutionFromGit', {
        SolutionName: SOLUTION,
        Managed: false,
        ReleaseBranch: BRANCH,
        IsLiteExport: false,
      });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.CommitId, committed.json.CommitId);
      const commit = JSON.parse(
        readFileSync(path.join(dir, ORG, PROJECT, REPO, 'objects', `${committed.json.CommitId}.json`), 'utf8'),
      );
      assert.equal(response.json.SolutionZip, commit.solutions[SOLUTION].unmanaged);
    } finally {
      await source.close();
    }
  });

  it('export release branches and stored branch heads cannot escape the configured local remote', async () => {
    const dir = remoteWithBranch(makeTemporaryDirectorySync(path.join(root, 'confined-')));
    const source = await startServer({ gitRemoteDirectory: dir });
    try {
      await createSolution(source);
      await source.request('POST', '/ConnectToGit', connectBody());
      for (const ReleaseBranch of ['../objects', '../../outside', '/outside', '..\\outside'])
        assert.equal(
          (
            await source.request('POST', '/ExportSolutionFromGit', {
              SolutionName: SOLUTION,
              Managed: false,
              ReleaseBranch,
            })
          ).status,
          400,
        );
      // A ref is a commit hash, not an arbitrary filename in the object store.
      writeFileSync(path.join(dir, ORG, PROJECT, REPO, 'refs', BRANCH), '../outside');
      assert.equal(
        (await source.request('POST', '/ExportSolutionFromGit', { SolutionName: SOLUTION, Managed: false })).status,
        400,
      );
    } finally {
      await source.close();
    }
  });
});
