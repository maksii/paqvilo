// Publish only typed diagnostics from owned loopback verify fixtures, before their temporary state is removed.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const reportName = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-ppv[a-f0-9]{8}\.json$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const text = (value) =>
  String(value ?? '')
    .slice(0, 4000)
    .replace(/https?:\/\/[^\s"<>]+/g, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return '[URL omitted]';
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|password|authorization|cookie|secret|nonce|state)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
const fields = (input, allowed) =>
  Object.fromEntries(
    allowed
      .filter((key) => input?.[key] === null || ['string', 'number', 'boolean'].includes(typeof input?.[key]))
      .map((key) => [key, typeof input[key] === 'string' ? text(input[key]) : input[key]]),
  );
function ordinaryBytes(file, parent, maximum = Number.MAX_SAFE_INTEGER) {
  // Open once before checking the entry, then read only that descriptor. Nonblocking opens also let a substituted
  // FIFO be rejected by fstat instead of waiting for a writer; O_NOFOLLOW rejects leaf symlinks where supported.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const ordinary = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n;
    const sameFile = (entry) => entry.dev === opened.dev && entry.ino === opened.ino;
    const confined = () => {
      const leaf = fs.lstatSync(file, { bigint: true });
      return (
        ordinary(leaf) &&
        sameFile(leaf) &&
        fs.realpathSync.native(path.dirname(file)) === parent &&
        path.relative(parent, fs.realpathSync.native(file)) === path.basename(file)
      );
    };
    if (!ordinary(opened) || opened.size > BigInt(maximum) || !confined())
      throw new Error('Verify evidence is not an owned ordinary file');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      !ordinary(after) ||
      !sameFile(after) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size ||
      !confined()
    )
      throw new Error('Verify evidence changed while reading');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function preserveVerifyFixtureEvidence({ fixtureRoot, outputRoot }) {
  const root = fs.realpathSync.native(fixtureRoot);
  const source = path.join(root, 'state', 'verify');
  if (!fs.existsSync(source)) return [];
  const sourceEntry = fs.lstatSync(source);
  if (
    !sourceEntry.isDirectory() ||
    sourceEntry.isSymbolicLink() ||
    path.relative(root, fs.realpathSync.native(source)) !== path.join('state', 'verify')
  )
    throw new Error('Verify evidence escaped its fixture');
  const files = [];
  for (const name of fs.readdirSync(source).filter((name) => reportName.test(name))) {
    const bytes = ordinaryBytes(path.join(source, name), source);
    let report;
    try {
      report = JSON.parse(bytes);
    } catch {
      // Parser errors can include rejected report bytes; expose only this controlled diagnostic.
      throw new Error('Malformed owned verification diagnostic');
    }
    let url;
    try {
      url = new URL(report.url);
    } catch {
      throw new Error('Invalid loopback verification location');
    }
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !['classic', 'enhanced'].includes(report.site) ||
      report.environment !== 'loopback-only'
    )
      throw new Error('Only synthetic loopback verify evidence can be published');
    const id = randomUUID().replaceAll('-', '');
    const folder = path.join(outputRoot, 'verify-fixtures');
    fs.mkdirSync(folder, { recursive: true });
    const diagnostic = {
      synthetic: true,
      kind: 'verify-fixture',
      schemaVersion: 1,
      ...fields(report, ['site', 'environment', 'coverage', 'passed', 'error', 'errorCode']),
      url: url.origin + url.pathname,
      checks: (report.checks ?? []).map((check) => fields(check, ['name', 'ok', 'detail'])),
      diagnostics: {},
      cleanup: fields(report.cleanup, ['kept', 'temporarySourceRemoved']),
    };
    for (const category of ['problems', 'notes', 'needsDeploy']) {
      diagnostic.diagnostics[category] = {};
      for (const phase of ['baseline', 'afterEdits']) {
        const snapshot = report.diagnostics?.[phase];
        diagnostic.diagnostics[category][phase] = (snapshot?.[category] ?? [])
          .slice(0, 200)
          .map((entry) =>
            fields(
              entry,
              category === 'problems'
                ? ['type', 'text', 'count', 'rel', 'where', 'status', 'line', 'col']
                : ['rel', 'reason'],
            ),
          );
      }
    }
    const image = path.join(source, name.replace(/\.json$/, '.png'));
    if (report.passed === false && fs.existsSync(image)) {
      const bytes = ordinaryBytes(image, source);
      if (!bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('Verify evidence screenshot is not a PNG');
      const imageName = `${id}-failure.png`;
      fs.writeFileSync(path.join(folder, imageName), bytes, { flag: 'wx', mode: 0o600 });
      diagnostic.screenshot = imageName;
      files.push(path.join(folder, imageName));
    }
    const diagnosticFile = path.join(folder, `${id}-diagnostic.json`);
    fs.writeFileSync(diagnosticFile, JSON.stringify(diagnostic, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    files.push(diagnosticFile);
  }
  return files;
}

/** A timeout can settle its verification body after the after hook; keep that fixture for post-child recovery. */
export function finalizeVerifyFixtureEvidence(options, signal) {
  const files = preserveVerifyFixtureEvidence(options);
  return { files, canRemove: files.length > 0 && !signal?.aborted };
}

export { ordinaryBytes as readOwnedFixtureBytes, text as redactFixtureText };
