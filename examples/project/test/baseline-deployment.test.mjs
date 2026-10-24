import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Read the ordinary ZIP directory produced by PAC; never execute a deployment command.
function archiveEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'deployment archive has a ZIP directory');
  const count = bytes.readUInt16LE(end + 10),
    entries = new Map();
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'ZIP directory entry');
    const method = bytes.readUInt16LE(cursor + 10),
      size = bytes.readUInt32LE(cursor + 20),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extraLength = bytes.readUInt16LE(cursor + 30),
      commentLength = bytes.readUInt16LE(cursor + 32),
      offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50, 'ZIP local entry');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28),
      compressed = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'supported deployment ZIP compression');
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('prepared deployment contains the current portal components and plugin assembly', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url)),
    solution = path.join(project, 'solution');
  const entries = archiveEntries(await fs.readFile(path.join(project, 'deployment/PaqviloDemoSample.zip')));
  let checked = 0;
  for (const folder of ['powerpagecomponents', 'PluginAssemblies']) {
    for (const entry of await fs.readdir(path.join(solution, folder), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || (folder === 'PluginAssemblies' && !entry.name.endsWith('.dll'))) continue;
      const file = path.join(entry.parentPath, entry.name),
        relative = path.relative(solution, file).split(path.sep).join('/');
      assert.ok(entries.has(relative), 'deployment contains ' + relative);
      const packed = entries.get(relative),
        source = await fs.readFile(file);
      // Git's canonical text checkout and PAC's Windows archive can differ only in newline style.
      if (entry.name.endsWith('.dll')) assert.deepEqual(packed, source, 'repack deployment after changing ' + relative);
      else
        assert.equal(
          packed.toString('utf8').replaceAll('\r\n', '\n'),
          source.toString('utf8').replaceAll('\r\n', '\n'),
          'repack deployment after changing ' + relative,
        );
      checked++;
    }
  }
  assert.ok(checked > 100, 'the check covers the exported component tree and assembly');
});
