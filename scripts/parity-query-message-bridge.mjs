// Qualification-time verification of source-bound query message bridges.
// All witness paths are read only under the explicitly approved evidence root.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parseXmlDocument } from '../mirage/lib/fetchxml-engine.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => hash(JSON.stringify(value));
const fail = () => {
  throw Object.assign(new Error('invalid-query-message-bridge'), { qualificationCode: 'invalid-query-message-bridge' });
};
const check = (value) => {
  if (!value) fail();
};
// The shared XML parser does not reject duplicate attributes or nested comment
// openers. Reject those here before using its tree for evidence verification.
export function parseEvidenceCsdl(source) {
  let at = 0;
  while (at < source.length) {
    const start = source.indexOf('<', at);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      check(end >= 0 && !source.slice(start + 4, end).includes('--'));
      at = end + 3;
      continue;
    }
    if (source.startsWith('<?', start)) {
      const end = source.indexOf('?>', start + 2);
      check(end >= 0);
      at = end + 2;
      continue;
    }
    // CSDL evidence does not need declarations, entity expansion, or CDATA.
    check(!source.startsWith('<!', start));
    let end = start + 1,
      quote = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        check(char !== '<');
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else check(char !== '<');
    }
    check(end < source.length && !quote);
    const tag = source.slice(start + 1, end);
    if (!tag.startsWith('/')) {
      const name = /^[\w:.-]+/u.exec(tag);
      check(name);
      let pos = name[0].length;
      const seen = new Set(),
        attribute = /([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/uy;
      while (pos < tag.length) {
        const beforeWhitespace = pos;
        while (pos < tag.length && /\s/u.test(tag[pos])) pos++;
        if (pos === tag.length || (tag[pos] === '/' && pos === tag.length - 1)) break;
        check(pos > beforeWhitespace);
        attribute.lastIndex = pos;
        const match = attribute.exec(tag);
        check(match && !seen.has(match[1]));
        seen.add(match[1]);
        pos = attribute.lastIndex;
      }
    }
    at = end + 1;
  }
  try {
    return parseXmlDocument(source, { root: 'edmx:Edmx' });
  } catch {
    fail();
  }
}
const csdlCache = new WeakMap();
function parsedCsdl(authority) {
  check(Array.isArray(authority.csdl) && authority.csdl.length === 2);
  const old = csdlCache.get(authority);
  if (old && old.sources.length === authority.csdl.length && old.sources.every((xml, i) => xml === authority.csdl[i]))
    return old.documents;
  const sources = [...authority.csdl],
    documents = sources.map(parseEvidenceCsdl);
  csdlCache.set(authority, { sources, documents });
  return documents;
}
function zipEntry(archive, wanted) {
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--)
    if (archive.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  check(end >= 0 && archive.readUInt16LE(end + 4) === 0 && archive.readUInt16LE(end + 6) === 0);
  const count = archive.readUInt16LE(end + 10);
  let position = archive.readUInt32LE(end + 16),
    found = null;
  check(count > 0 && count < 4096);
  for (let i = 0; i < count; i++) {
    check(position + 46 <= archive.length && archive.readUInt32LE(position) === 0x02014b50);
    const flags = archive.readUInt16LE(position + 8),
      method = archive.readUInt16LE(position + 10),
      compressed = archive.readUInt32LE(position + 20),
      size = archive.readUInt32LE(position + 24),
      names = archive.readUInt16LE(position + 28),
      extra = archive.readUInt16LE(position + 30),
      comment = archive.readUInt16LE(position + 32),
      offset = archive.readUInt32LE(position + 42);
    check(position + 46 + names + extra + comment <= archive.length);
    const name = archive.subarray(position + 46, position + 46 + names).toString('utf8');
    if (name === wanted) {
      check(
        !found &&
          !(flags & 1) &&
          [0, 8].includes(method) &&
          size < 30_000_000 &&
          offset + 30 <= archive.length &&
          archive.readUInt32LE(offset) === 0x04034b50,
      );
      const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
      check(start + compressed <= archive.length);
      const data = archive.subarray(start, start + compressed);
      found = method === 8 ? inflateRawSync(data, { maxOutputLength: 30_000_000 }) : data;
      check(found.length === size);
    }
    position += 46 + names + extra + comment;
  }
  check(found);
  return hash(found);
}
export function verifyQueryMessageBridge({ evidenceRoot, witness, capsule, expectedSourceSha256 }) {
  check(evidenceRoot && witness && typeof witness.indexPath === 'string' && /^[a-f0-9]{64}$/u.test(witness.sha256));
  const root = fs.realpathSync(evidenceRoot);
  function read(file) {
    const absolute = path.resolve(root, file),
      resolved = fs.realpathSync(absolute),
      relative = path.relative(root, resolved);
    check(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    return fs.readFileSync(resolved);
  }
  const indexBytes = read(witness.indexPath);
  check(hash(indexBytes) === witness.sha256);
  const index = JSON.parse(indexBytes),
    readRef = (ref) => {
      check(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256));
      const bytes = read(ref.path);
      check(hash(bytes) === ref.sha256);
      return bytes;
    };
  check(
    index.schemaVersion === 1 &&
      index.signatureVerified === false &&
      index.packages?.length === 2 &&
      index.namespaces?.length === 2,
  );
  const packages = new Map();
  for (const pkg of index.packages) {
    check(
      /^Microsoft\.OData\.(Core|Edm)$/u.test(pkg.name) &&
        pkg.version === '8.3.0' &&
        !packages.has(pkg.name) &&
        pkg.publisherArchiveUrl ===
          `https://api.nuget.org/v3-flatcontainer/${pkg.name.toLowerCase()}/${pkg.version}/${pkg.name.toLowerCase()}.${pkg.version}.nupkg` &&
        pkg.signatureVerified === false,
    );
    const archive = readRef(pkg.archive),
      extracted = readRef(pkg.extractedDll);
    check(
      zipEntry(archive, `lib/net8.0/${pkg.name}.dll`) === hash(extracted) &&
        hash(extracted) === pkg.extractedDll.sha256,
    );
    packages.set(pkg.name, pkg);
  }
  const sources = new Map();
  for (const namespace of index.namespaces) {
    check(
      ['original-input', 'adapted-input'].includes(namespace.name) &&
        !sources.has(namespace.name) &&
        namespace.runs?.length === 2,
    );
    const receipt = JSON.parse(readRef(namespace.receipt));
    check(
      namespace.receipt.sha256 ===
        (namespace.name === 'original-input' ? capsule.source.originalSdkSha256 : capsule.source.adaptedSdkSha256) &&
        json(receipt.inputs) === json(receipt.postRunInputs) &&
        receipt.runs?.length === 2,
    );
    for (const key of ['producer', 'project', 'input', 'binary', 'launcher']) readRef(namespace[key]);
    const expected =
      namespace.name === 'original-input'
        ? { producer: 'source', project: 'project', input: 'cases', binary: 'executable' }
        : { producer: 'program', project: 'project', input: 'input', binary: 'executable' };
    for (const [key, receiptKey] of Object.entries(expected))
      check(namespace[key].sha256 === receipt.inputs[receiptKey]);
    const results = [];
    for (let i = 0; i < 2; i++) {
      const run = namespace.runs[i],
        recorded = receipt.runs[i],
        stdout = readRef(run.stdout),
        stderr = readRef(run.stderr).toString('utf8'),
        parsed = JSON.parse(stdout);
      check(
        run.exitCode === 0 &&
          run.signal === null &&
          run.linuxPid > 0 &&
          run.launcherPid > 0 &&
          run.linuxPid === recorded.linuxPid &&
          run.launcherPid === recorded.launcherPid &&
          run.startedAtUtc === recorded.startedAtUtc &&
          run.endedAtUtc === recorded.endedAtUtc &&
          run.stdout.sha256 === recorded.stdoutSha256 &&
          run.stderr.sha256 === recorded.stderrSha256 &&
          stderr.includes(`HOST_PID=${run.linuxPid}`) &&
          /Uid:\s+65534\s+65534\s+65534\s+65534/u.test(stderr) &&
          ['CapEff', 'CapPrm', 'CapAmb'].every((key) => new RegExp(`${key}:\\s+0000000000000000`, 'u').test(stderr)) &&
          Array.isArray(parsed.results),
      );
      for (const pkg of packages.values()) {
        const recordedAssembly = run.assemblies?.find((item) => item.name === pkg.name),
          actual = parsed.assemblies?.find((item) => item.name === pkg.name);
        check(
          recordedAssembly &&
            actual &&
            recordedAssembly.mvid === pkg.mvid &&
            actual.mvid === pkg.mvid &&
            actual.sha256 === pkg.extractedDll.sha256 &&
            recordedAssembly.loaded.sha256 === pkg.extractedDll.sha256 &&
            hash(readRef(recordedAssembly.loaded)) === pkg.extractedDll.sha256,
        );
      }
      results.push(parsed.results);
    }
    check(
      namespace.runs[0].linuxPid !== namespace.runs[1].linuxPid &&
        namespace.runs[0].launcherPid !== namespace.runs[1].launcherPid,
    );
    sources.set(namespace.name, results);
  }
  const cert = JSON.parse(readRef(index.parents.prospectiveCertificate)),
    bridge = JSON.parse(readRef(index.parents.rawBridge));
  const map = JSON.parse(readRef(index.parents.independentSourceMap));
  readRef(index.parents.frozenReview);
  readRef(index.parents.coordinates);
  readRef(index.parents.priorArchiveVerification);
  check(
    index.parents.prospectiveCertificate.sha256 === capsule.source.certificateSha256 &&
      index.parents.frozenReview.sha256 === capsule.source.reviewSha256 &&
      index.parents.rawBridge.sha256 === capsule.source.comparisonSha256 &&
      cert.sourceSha256 === expectedSourceSha256 &&
      bridge.source?.baselineSha256 === expectedSourceSha256 &&
      bridge.source.currentSha256 === capsule.source.currentSha256 &&
      bridge.source.casesAstSha256 === capsule.source.casesAstSha256 &&
      map.baselineSourceSha256 === expectedSourceSha256 &&
      map.all63TuplesEqual === true,
  );
  check(bridge.native?.length === 2);
  const csdl = bridge.native.map((capture) => readRef(capture.csdl).toString('utf8'));
  return {
    authoritySha256: witness.sha256,
    certificate: cert,
    bridge,
    independentMap: map,
    original: sources.get('original-input'),
    adapted: sources.get('adapted-input'),
    csdl,
    readRef,
  };
}
export function verifyQueryMessageBridgeCase(authority, capsule, index, expected, sourceTypes) {
  const certified = authority.certificate.cases.filter((item) => item.caseIndex === index),
    mapped = authority.independentMap.cases.filter((item) => item.caseIndex === index);
  const comparison = authority.bridge.comparisons.filter((item) => item.caseIndex === index);
  check(certified.length === 1 && mapped.length === 1 && comparison.length === 1);
  const cert = certified[0],
    map = mapped[0],
    bridge = comparison[0],
    source = cert.source,
    candidate = cert.candidate;
  check(
    source.option === expected.option &&
      source.value === expected.value &&
      source.expectedStatus === expected.status &&
      source.expectedMessage === expected.message &&
      map.sourceTupleSha256 === json([expected.option, expected.value, expected.status, expected.message]) &&
      hash(expected.value) === map.sourceValueSha256 &&
      bridge.source?.option === expected.option &&
      bridge.source.value === expected.value &&
      bridge.source.status === expected.status &&
      bridge.source.message === expected.message,
  );
  const entries = capsule.captures.map((capture) => capture.cases.filter((entry) => entry.caseIndex === index));
  check(entries.length === 2 && entries.every((items) => items.length === 1));
  const [first, second] = entries.map((items) => items[0]),
    roles = first.sourceRoles;
  check(
    json(roles) === json(second.sourceRoles) &&
      roles.mappedOption === expected.option &&
      roles.mappedValue === candidate.value &&
      json(roles.replacements) === json(candidate.replacements) &&
      json(roles.offsetEvidence) === json(cert.offsetEvidence) &&
      Array.isArray(roles.offsetEvidence) &&
      roles.offsetEvidence.length === 1 &&
      roles.replacements.length > 0,
  );
  let cursor = 0,
    reconstructed = '',
    delta = 0;
  for (const replacement of roles.replacements) {
    check(
      Number.isInteger(replacement.start) &&
        Number.isInteger(replacement.end) &&
        replacement.start >= cursor &&
        replacement.end > replacement.start &&
        expected.value.slice(replacement.start, replacement.end) === replacement.original &&
        typeof replacement.native === 'string' &&
        replacement.native.length &&
        /^Edm\.[A-Za-z0-9]+$/u.test(replacement.type) &&
        sourceTypes[replacement.original] === replacement.type,
    );
    reconstructed += expected.value.slice(cursor, replacement.start) + replacement.native;
    cursor = replacement.end;
  }
  reconstructed += expected.value.slice(cursor);
  check(reconstructed === roles.mappedValue && hash(reconstructed) === map.adaptedValueSha256);
  const entitySet = candidate.relativePath.split('?')[0],
    selectedKey = new URLSearchParams(candidate.query).get('$select');
  check(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entitySet) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(selectedKey ?? ''));
  for (const document of parsedCsdl(authority)) {
    const children = (node, name) => node.children.filter((child) => child.name === name),
      data = children(document, 'edmx:DataServices');
    check(
      document.attrs['xmlns:edmx'] === 'http://docs.oasis-open.org/odata/ns/edmx' &&
        data.length === 1 &&
        !Object.hasOwn(data[0].attrs, 'xmlns:edmx'),
    );
    const schemas = children(data[0], 'Schema').filter(
      (node) => node.attrs.xmlns === 'http://docs.oasis-open.org/odata/ns/edm',
    );
    const sets = schemas.flatMap((schema) =>
      children(schema, 'EntityContainer').flatMap((container) =>
        children(container, 'EntitySet')
          .filter((item) => item.attrs.Name === entitySet)
          .map((item) => ({ item, container })),
      ),
    );
    const inEdmNamespace = (node) => !Object.hasOwn(node.attrs, 'xmlns');
    check(
      sets.length === 1 &&
        inEdmNamespace(sets[0].container) &&
        inEdmNamespace(sets[0].item) &&
        /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(sets[0].item.attrs.EntityType),
    );
    const fullType = sets[0].item.attrs.EntityType,
      schemasForType = schemas.filter((schema) => fullType.startsWith(schema.attrs.Namespace + '.'));
    check(schemasForType.length === 1);
    const schema = schemasForType[0],
      entityName = fullType.slice(schema.attrs.Namespace.length + 1),
      entities = children(schema, 'EntityType').filter((item) => item.attrs.Name === entityName);
    check(entities.length === 1 && inEdmNamespace(entities[0]));
    const entity = entities[0],
      keys = children(entity, 'Key'),
      properties = children(entity, 'Property');
    check(keys.length === 1 && inEdmNamespace(keys[0]));
    const keyRefs = children(keys[0], 'PropertyRef');
    check(keyRefs.length === 1 && inEdmNamespace(keyRefs[0]) && keyRefs[0].attrs.Name === selectedKey);
    for (const replacement of roles.replacements) {
      const matching = properties.filter((item) => item.attrs.Name === replacement.native);
      check(matching.length === 1 && inEdmNamespace(matching[0]) && matching[0].attrs.Type === replacement.type);
    }
    const keyProperties = properties.filter((item) => item.attrs.Name === selectedKey);
    check(keyProperties.length === 1 && inEdmNamespace(keyProperties[0]) && keyProperties[0].attrs.Type === 'Edm.Guid');
  }
  const offset = roles.offsetEvidence[0];
  for (const replacement of roles.replacements) {
    check(!(replacement.start < offset.originalOffset && offset.originalOffset < replacement.end));
    if (replacement.end <= offset.originalOffset) delta += replacement.native.length - replacement.original.length;
  }
  check(
    Number.isInteger(offset.originalOffset) &&
      offset.originalOffset >= 0 &&
      offset.originalOffset <= expected.value.length &&
      offset.proposedNativeOffset === offset.originalOffset + delta &&
      offset.sourceLength === expected.value.length &&
      offset.nativeLength === roles.mappedValue.length &&
      offset.originalCharacter === (expected.value[offset.originalOffset] ?? null) &&
      offset.nativeCharacter === (roles.mappedValue[offset.proposedNativeOffset] ?? null) &&
      offset.originalAtEnd === (offset.originalOffset === expected.value.length) &&
      offset.nativeAtEnd === (offset.proposedNativeOffset === roles.mappedValue.length) &&
      offset.originalCharacter === offset.nativeCharacter &&
      offset.originalAtEnd === offset.nativeAtEnd &&
      map.sourceOffset === offset.originalOffset &&
      map.adaptedOffset === offset.proposedNativeOffset,
  );
  const unique = (text, from, to) => {
    check(text.split(from).length === 2);
    return text.replace(from, to);
  };
  let predicted = unique(expected.message, `'${expected.value}'`, `'${roles.mappedValue}'`);
  const oldMarker = predicted.includes(`position ${offset.originalOffset}`)
    ? `position ${offset.originalOffset}`
    : `at '${offset.originalOffset}'`;
  const newMarker = oldMarker.startsWith('position ')
    ? `position ${offset.proposedNativeOffset}`
    : `at '${offset.proposedNativeOffset}'`;
  predicted = unique(predicted, oldMarker, newMarker);
  check(
    predicted === cert.predictedMessage &&
      predicted === first.predictedNativeMessage &&
      predicted === second.predictedNativeMessage &&
      hash(expected.message) === map.originalMessageSha256 &&
      hash(predicted) === map.adaptedMessageSha256 &&
      json(map.roles) ===
        json(roles.replacements.map((item) => ({ source: item.original, native: item.native, type: item.type }))),
  );
  for (let run = 0; run < 2; run++) {
    const original = authority.original[run].filter((item) => item.index === index + 1),
      adapted = authority.adapted[run].filter((item) => item.index === index);
    check(
      original.length === 1 &&
        adapted.length === 1 &&
        original[0].option === expected.option &&
        original[0].value === expected.value &&
        original[0].outcome === 'exception' &&
        original[0].exceptionType === 'Microsoft.OData.ODataException' &&
        original[0].message === expected.message &&
        adapted[0].option === expected.option &&
        adapted[0].value === roles.mappedValue &&
        adapted[0].outcome === 'exception' &&
        adapted[0].exceptionType === 'Microsoft.OData.ODataException' &&
        adapted[0].message === predicted &&
        first.originalSdkMessages[run] === original[0].message &&
        first.adaptedSdkMessages[run] === adapted[0].message,
    );
    const native = authority.bridge.native[run],
      record = native.rows.filter((item) => item.caseIndex === index),
      capture = capsule.captures[run];
    check(
      record.length === 1 &&
        native.receipt.sha256 === capture.runSha256 &&
        native.provenance.sha256 === capture.provenanceSha256 &&
        native.metadata.sha256 === capture.metadataSha256 &&
        native.csdl.sha256 === capture.csdlSha256,
    );
    authority.readRef(native.receipt);
    authority.readRef(native.provenance);
    authority.readRef(native.metadata);
    authority.readRef(native.csdl);
    const request = JSON.parse(authority.readRef(record[0].request)),
      response = JSON.parse(authority.readRef(record[0].response));
    const params = new URLSearchParams(request.sourceQuery);
    check(
      request.caseIndex === index &&
        request.method === 'GET' &&
        request.relativePath === candidate.relativePath &&
        request.sourceQuery === candidate.query &&
        [...params].length === 2 &&
        params.get('$select') === selectedKey &&
        params.get(roles.mappedOption) === roles.mappedValue &&
        record[0].request.sha256 === capture.cases.find((item) => item.caseIndex === index).requestSha256 &&
        record[0].response.sha256 === capture.cases.find((item) => item.caseIndex === index).responseBodySha256 &&
        record[0].truncated === false &&
        record[0].status === expected.status &&
        response.error?.code === record[0].code &&
        response.error.message === predicted &&
        record[0].message === predicted &&
        capture.cases.find((item) => item.caseIndex === index).facts.message === predicted,
    );
  }
  return true;
}
