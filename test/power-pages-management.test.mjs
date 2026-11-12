// @test-kind contract: Power Pages management wraps the PAC power-pages commands with a designed executable contract and projects only bounded site metadata
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPowerPagesSites, readPowerPagesSite, setPowerPagesSiteVisibility } from 'paqvilo/dataverse';
const id = '10000000-0000-4000-8000-000000000001',
  record = '20000000-0000-4000-8000-000000000001';
const row = {
  id,
  websiteRecordId: record,
  websiteUrl: 'https://demo.example.invalid',
  siteVisibility: 'private',
  name: 'Demo',
  type: 'Trial',
  status: 'OperationComplete',
  clientSecret: 'WITHHELD',
  settings: { token: 'WITHHELD' },
};
test('Power Pages management uses explicit shell-free commands and projects only site metadata', async () => {
  const calls = [],
    options = {
      environment: 'https://tenant.example.invalid',
      executable: 'C:/CLI/pac.exe',
      run: async (program, args, settings) => {
        calls.push({ program, args, settings });
        return {
          stdout: 'CLI banner\n' + JSON.stringify(args.includes('get-websites') ? { value: [row] } : row),
          stderr: 'WITHHELD',
        };
      },
    };
  const sites = await readPowerPagesSites(options);
  assert.equal(sites[0].websiteRecordId, record);
  assert.equal(sites[0].clientSecret, undefined);
  assert.equal(sites[0].settings, undefined);
  assert.equal((await readPowerPagesSite({ ...options, id })).id, id);
  const changed = await setPowerPagesSiteVisibility({ ...options, id, visibility: 'public' });
  assert.equal(changed.commandCompleted, true);
  assert.equal(changed.readbackVerified, false);
  assert.deepEqual(calls[2].args, [
    'power-pages',
    'update-site-visibility',
    '--environment',
    'https://tenant.example.invalid',
    '--id',
    id,
    '--site-visibility',
    'public',
  ]);
  assert.ok(
    calls.every(
      (call) => call.settings.shell === false && call.settings.windowsHide === true && call.settings.timeout <= 120000,
    ),
  );
});
// @test-kind security: transport and response output that may hold secrets is withheld
test('Power Pages management rejects malformed targets and withholds transport/response output', async () => {
  let called = false;
  const options = {
    environment: 'https://tenant.example.invalid',
    run: async () => {
      called = true;
      return { stdout: JSON.stringify(row) };
    },
  };
  for (const value of [
    'http://tenant.example.invalid',
    'https://tenant.example.invalid/?token=x',
    'https://user:pass@tenant.example.invalid',
    'https://tenant.example.invalid/path',
  ])
    await assert.rejects(readPowerPagesSites({ ...options, environment: value }), /explicit environment/);
  await assert.rejects(readPowerPagesSite({ ...options, id: id + ' & command' }), /explicit management/);
  await assert.rejects(
    setPowerPagesSiteVisibility({ ...options, id, visibility: 'public & command' }),
    /private\/public/,
  );
  await assert.rejects(readPowerPagesSites({ ...options, executable: 'pac.cmd' }), /without a command shell/);
  assert.equal(called, false);
  await assert.rejects(
    readPowerPagesSites({
      ...options,
      run: async () => {
        throw new Error('WITHHELD_SECRET');
      },
    }),
    (error) => error.code === 'POWER_PAGES_MANAGEMENT_FAILED' && !error.message.includes('WITHHELD_SECRET'),
  );
  await assert.rejects(
    readPowerPagesSites({ ...options, run: async () => ({ exitCode: 1, stderr: 'HTTP 400 WITHHELD_SECRET' }) }),
    (error) => error.status === 400 && error.exitCode === 1 && !error.message.includes('WITHHELD_SECRET'),
  );
  await assert.rejects(
    readPowerPagesSite({ ...options, id, run: async () => ({ stdout: JSON.stringify({ ...row, id: record }) }) }),
    /different site/,
  );
  await assert.rejects(
    readPowerPagesSites({ ...options, run: async () => ({ stdout: 'WITHHELD_SECRET' }) }),
    (error) => !error.message.includes('WITHHELD_SECRET'),
  );
  await assert.rejects(
    readPowerPagesSites({ ...options, run: async () => ({ stdout: JSON.stringify({ value: [row, row] }) }) }),
    /repeats/,
  );
  await assert.rejects(
    readPowerPagesSites({
      ...options,
      run: async () => ({ stdout: JSON.stringify({ value: [{ ...row, name: { secret: 'WITHHELD_SECRET' } }] }) }),
    }),
    /bounded scalar/,
  );
});

test('an absent PAC executable is reported by its option and variable, and launcher names are accepted', async () => {
  const programs = [],
    environment = 'https://tenant.example.invalid',
    listing = async (program) => {
      programs.push(program);
      return { stdout: JSON.stringify({ value: [row] }) };
    };
  await assert.rejects(
    readPowerPagesSites({
      environment,
      executable: 'C:/CLI/pac.exe',
      run: async () => {
        throw Object.assign(new Error('spawn pac ENOENT WITHHELD_SECRET'), { code: 'ENOENT' });
      },
    }),
    (error) =>
      error.code === 'POWER_PAGES_PAC_MISSING' &&
      /pass executable or set PAQVILO_PAC_EXECUTABLE/.test(error.message) &&
      !error.message.includes('WITHHELD_SECRET'),
  );
  assert.equal(
    (await readPowerPagesSites({ environment, executable: 'C:\\x\\pac.launcher.exe', run: listing })).length,
    1,
  );
  assert.equal(programs.at(-1), 'C:\\x\\pac.launcher.exe');
  const previous = process.env.PAQVILO_PAC_EXECUTABLE;
  process.env.PAQVILO_PAC_EXECUTABLE = 'C:\\x\\pac.exe';
  try {
    await readPowerPagesSites({ environment, run: listing });
  } finally {
    if (previous === undefined) delete process.env.PAQVILO_PAC_EXECUTABLE;
    else process.env.PAQVILO_PAC_EXECUTABLE = previous;
  }
  assert.equal(programs.at(-1), 'C:\\x\\pac.exe');
  let reached = false;
  for (const executable of ['pac.cmd', 'cmd.exe', 'C:/x/pac.exe & calc'])
    await assert.rejects(
      readPowerPagesSites({
        environment,
        executable,
        run: async () => {
          reached = true;
          return { stdout: '[]' };
        },
      }),
      /without a command shell/,
      executable,
    );
  assert.equal(reached, false);
});

test('site inventory projects bounded trial and data-model metadata and withholds every other field', async () => {
  const siteWith = async (fields) => {
    const [site] = await readPowerPagesSites({
      environment: 'https://tenant.example.invalid',
      executable: 'C:/CLI/pac.exe',
      run: async () => ({ stdout: JSON.stringify({ value: [{ ...row, ...fields }] }) }),
    });
    return site;
  };
  const site = await siteWith({ trialExpiringInDays: 3, dataModel: 'Standard', apiKey: 'WITHHELD' });
  assert.equal(site.trialExpiringInDays, 3);
  assert.equal(site.dataModel, 'Standard');
  assert.equal(site.apiKey, undefined);
  assert.equal((await siteWith({ trialExpiringInDays: 0 })).trialExpiringInDays, 0);
  for (const value of ['3', -1, 1e12, 1.5, null]) {
    assert.equal((await siteWith({ trialExpiringInDays: value })).trialExpiringInDays, null, String(value));
  }
  assert.equal((await siteWith({ dataModel: 'x'.repeat(64) })).dataModel, 'x'.repeat(64));
  assert.equal((await siteWith({ dataModel: 'x'.repeat(65) })).dataModel, null);
  assert.equal((await siteWith({ dataModel: 7 })).dataModel, null);
  const absent = await siteWith({});
  assert.deepEqual([absent.trialExpiringInDays, absent.dataModel], [null, null]);
});

test('without an explicit executable, a missing PAC is reported with its code and cause', async (t) => {
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-no-pac-'));
  t.after(() => fs.rmSync(emptyDirectory, { recursive: true, force: true }));
  const saved = { PATH: process.env.PATH, PAQVILO_PAC_EXECUTABLE: process.env.PAQVILO_PAC_EXECUTABLE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.PAQVILO_PAC_EXECUTABLE;
  process.env.PATH = emptyDirectory;
  await assert.rejects(
    readPowerPagesSites({
      environment: 'https://tenant.example.invalid',
      run: async () => {
        throw new Error('PAC must not be started when it cannot be found');
      },
    }),
    (error) => error.code === 'POWER_PAGES_PAC_MISSING' && error.cause instanceof Error,
  );
});
