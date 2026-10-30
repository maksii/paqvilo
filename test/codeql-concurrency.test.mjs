import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDirSync } from './fixture.mjs';
import {
  codeqlGate,
  codeqlLanguages,
  securitySuite,
  ensureCodeqlBundle,
  publishSarifCache,
} from '../scripts/codeql.mjs';

const gate = () => Promise.withResolvers();
function directory(t) {
  const root = tempDirSync('paq-codeql-concurrent-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function analysis(checkout, tag, { created = () => {}, findings = [] } = {}) {
  const commands = [],
    reports = [];
  const options = {
    checkout,
    executable: async () => path.join(checkout, 'tools', 'codeql', 'codeql'),
    dismissals: () => new Set(),
    log: () => {},
    report: (text) => reports.push(text),
    snapshot: (source) => {
      fs.writeFileSync(path.join(source, 'snapshot.txt'), tag);
      return `invented-index-${tag}`;
    },
    execute: async (_command, args, options) => {
      commands.push(args);
      const database = args[2],
        language = path.basename(database).slice(3);
      if (args[1] === 'create') {
        assert.equal(fs.readFileSync(path.join(options.cwd, 'snapshot.txt'), 'utf8'), tag);
        fs.mkdirSync(database, { recursive: true });
        fs.writeFileSync(path.join(database, 'owner.txt'), tag);
        await created(language, database);
      } else {
        assert.equal(
          fs.readFileSync(path.join(database, 'owner.txt'), 'utf8'),
          tag,
          'A concurrent invocation must not remove or replace this database',
        );
        assert.equal(args[3], securitySuite(language));
        assert.ok(args.includes(`--sarif-category=/language:${language}`));
        const output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
        fs.writeFileSync(output, JSON.stringify({ runs: [{ results: language === 'csharp' ? findings : [] }] }));
      }
      return '';
    },
  };
  return { run: () => codeqlGate(options), commands, reports };
}

test('concurrent CodeQL stage drivers keep both source/database/SARIF sets across legacy work cleanup', async (t) => {
  const root = directory(t),
    ready = gate(),
    resume = gate();
  const legacy = path.join(root, '.paqvilo', 'ci', 'codeql');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'prior'), 'legacy output');
  const first = analysis(root, 'first', {
    created: async (language) => {
      if (language === 'csharp') {
        ready.resolve();
        await resume.promise;
      }
    },
  });
  const running = first.run();
  await Promise.race([
    ready.promise,
    running.then(() => {
      throw new Error('First analysis missed its stage gate');
    }),
  ]);
  let second;
  try {
    // The older, independent CLI resets this exact directory before analysis.
    fs.rmSync(legacy, { recursive: true });
    second = await analysis(root, 'second').run();
  } finally {
    resume.resolve();
  }
  const completed = await running;
  assert.notEqual(completed.work, second.work);
  for (const [result, tag] of [
    [completed, 'first'],
    [second, 'second'],
  ]) {
    assert.equal(path.basename(path.dirname(result.work)), 'codeql-runs');
    assert.equal(fs.readFileSync(path.join(result.work, 'source', 'snapshot.txt'), 'utf8'), tag);
    const report = JSON.parse(fs.readFileSync(path.join(result.work, 'report.json'), 'utf8'));
    assert.equal(report.status, 'complete');
    assert.equal(report.sourceTree, `invented-index-${tag}`);
    assert.deepEqual(report.languages, ['actions', 'csharp', 'javascript-typescript']);
    assert.deepEqual(
      report.analyses.map((item) => item.language),
      codeqlLanguages(),
    );
    for (const item of report.analyses) {
      assert.equal(item.status, 'complete');
      assert.equal(item.suite, securitySuite(item.language));
      assert.ok(fs.existsSync(path.join(result.work, item.database, 'owner.txt')));
      assert.ok(fs.existsSync(path.join(result.work, item.sarif)));
    }
  }
  assert.equal(first.commands.filter((args) => args[1] === 'analyze').length, 3);
});

test('CodeQL findings fail after all language configurations and retain their exact run evidence', async (t) => {
  const root = directory(t);
  const driver = analysis(root, 'failure', {
    findings: [
      {
        ruleId: 'cs/invented',
        message: { text: 'Invented finding' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'invented.cs' }, region: { startLine: 7 } } }],
      },
    ],
  });
  await assert.rejects(driver.run(), /CodeQL reports 1 finding.*CodeQL evidence:/);
  assert.equal(driver.commands.filter((args) => args[1] === 'analyze').length, 3);
  assert.deepEqual(driver.reports, ['invented.cs:7: cs/invented: Invented finding']);
  const parent = path.join(root, '.paqvilo', 'ci', 'codeql-runs'),
    work = path.join(parent, fs.readdirSync(parent)[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.analyses.length, 3);
  assert.ok(manifest.analyses.every((entry) => entry.status === 'complete'));
  assert.ok(fs.existsSync(path.join(work, 'csharp.sarif')));
});

test('cold CodeQL cache installation is exclusive and a warm bundle performs no shared writes', async (t) => {
  const cache = directory(t),
    executable = path.join(cache, 'codeql', 'tool'),
    started = gate(),
    resume = gate(),
    waiting = gate();
  let installations = 0;
  const install = async () => {
    installations++;
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'complete bundle bytes');
    started.resolve();
    await resume.promise;
  };
  const first = ensureCodeqlBundle({ cache, executable, digest: 'verified archive digest', install });
  await started.promise;
  const second = ensureCodeqlBundle({
    cache,
    executable,
    digest: 'verified archive digest',
    install,
    wait: async () => {
      waiting.resolve();
      await resume.promise;
    },
  });
  await waiting.promise;
  try {
    assert.equal(installations, 1);
    assert.equal(fs.existsSync(path.join(cache, '.complete')), false);
  } finally {
    resume.resolve();
  }
  assert.deepEqual(await Promise.all([first, second]), [executable, executable]);
  assert.equal(installations, 1);
  const witness = '{"type":"commonjs","witness":"warm cache is immutable"}';
  fs.writeFileSync(path.join(cache, 'package.json'), witness);
  await ensureCodeqlBundle({
    cache,
    executable,
    digest: 'verified archive digest',
    install: () => {
      throw new Error('Unexpected reinstall');
    },
  });
  assert.equal(fs.readFileSync(path.join(cache, 'package.json'), 'utf8'), witness);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'complete bundle bytes');
});

test('failed CodeQL installation publishes no completion and releases only its own installer lock', async (t) => {
  const cache = directory(t),
    executable = path.join(cache, 'tool');
  await assert.rejects(
    ensureCodeqlBundle({
      cache,
      executable,
      digest: 'digest',
      install: () => {
        throw new Error('Invented extraction failure');
      },
    }),
    /Invented extraction failure/,
  );
  assert.equal(fs.existsSync(path.join(cache, '.complete')), false);
  assert.equal(fs.existsSync(path.join(cache, '.install.lock')), false);
  await ensureCodeqlBundle({
    cache,
    executable,
    digest: 'digest',
    install: () => fs.writeFileSync(executable, 'recovered'),
  });
  assert.equal(fs.readFileSync(executable, 'utf8'), 'recovered');
});

test('an abandoned CodeQL installer is retained for inspection instead of deleting unqualified tool files', async (t) => {
  const cache = directory(t),
    lock = path.join(cache, '.install.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), 'unqualified installer');
  await assert.rejects(
    ensureCodeqlBundle({
      cache,
      executable: path.join(cache, 'tool'),
      digest: 'digest',
      timeoutMs: 0,
      install: () => {
        throw new Error('Must not enter an owned installer');
      },
    }),
    /inspect its installer/,
  );
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), 'unqualified installer');
});

test('a failed analysis stage retains its database and evidence without changing a concurrent completed run', async (t) => {
  const root = directory(t),
    ready = gate(),
    resume = gate();
  const first = analysis(root, 'failed-stage', {
    created: async (language) => {
      if (language === 'csharp') {
        ready.resolve();
        await resume.promise;
        throw new Error('Invented CSharp extraction failure');
      }
    },
  });
  const running = first.run();
  const failure = assert.rejects(running, /Invented CSharp extraction failure.*CodeQL evidence:/);
  await ready.promise;
  let second;
  try {
    second = await analysis(root, 'completed-stage').run();
  } finally {
    resume.resolve();
  }
  await failure;
  const parent = path.dirname(second.work),
    failed = fs
      .readdirSync(parent)
      .map((name) => path.join(parent, name))
      .find((work) => work !== second.work);
  const manifest = JSON.parse(fs.readFileSync(path.join(failed, 'report.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.deepEqual(manifest.languages, codeqlLanguages());
  assert.match(manifest.failure, /CSharp extraction failure/);
  assert.equal(fs.readFileSync(path.join(failed, 'db-csharp', 'owner.txt'), 'utf8'), 'failed-stage');
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.work, 'report.json'), 'utf8')).status, 'complete');
  assert.ok(fs.existsSync(path.join(second.work, 'javascript-typescript.sarif')));
});

test('shared dismissal SARIF publication keeps a complete old file visible until the atomic replacement', (t) => {
  const root = directory(t),
    file = path.join(root, 'analysis-1.sarif');
  const prior = JSON.stringify({ runs: [{ results: [], invocation: 'prior' }] });
  const next = JSON.stringify({ runs: [{ results: [], invocation: 'next' }] });
  fs.writeFileSync(file, prior);
  const rename = fs.renameSync;
  let observed;
  fs.renameSync = (source, destination) => {
    if (destination === file) observed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rename(source, destination);
  };
  try {
    publishSarifCache(file, next);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(observed, JSON.parse(prior));
  assert.equal(fs.readFileSync(file, 'utf8'), next);
  assert.throws(() => publishSarifCache(file, '{incomplete'), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), next);
  assert.deepEqual(fs.readdirSync(root), ['analysis-1.sarif']);
});
