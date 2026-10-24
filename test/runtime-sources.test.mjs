import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { annotateRuntimeSources } from '../lense/runtime-sources.mjs';

test('large repeated source evidence resolves paths by file, not by occurrence', () => {
  const sourceDir = path.resolve('invented-portal'),
    solution = path.resolve('invented-solution');
  const names = [path.join(sourceDir, 'page.html'), path.join(solution, 'Entity.xml')];
  const report = {
    rows: Array.from({ length: 10000 }, (_, index) => ({ sourceFile: names[index % 2], sourceFiles: names })),
  };
  let calls = 0;
  const files = annotateRuntimeSources(report, {
    sourceDir,
    roots: [sourceDir, solution],
    realpath: (file) => {
      calls++;
      return file;
    },
  });
  assert.equal(calls, 2, 'repeated hints must not repeat filesystem resolution');
  assert.equal(files.size, 2);
  assert.equal(report.rows[0].ref, 'page.html');
  assert.equal(report.rows[1].ref, '@invented-solution/Entity.xml');
  assert.equal(report.rows[9999].sourceRefs[0].path, names[0]);
});

test('source resolution is fresh on each report and cannot widen trusted roots', () => {
  const sourceDir = path.resolve('invented-portal'),
    inside = path.join(sourceDir, 'page.html'),
    outside = path.resolve('elsewhere', 'private.html');
  let target = inside,
    calls = 0;
  const options = {
    sourceDir,
    roots: [sourceDir],
    realpath: () => {
      calls++;
      return target;
    },
  };
  assert.equal(annotateRuntimeSources({ sourceFile: inside }, options).size, 1);
  target = outside;
  const next = { sourceFile: inside };
  assert.equal(annotateRuntimeSources(next, options).size, 0);
  assert.equal(next.ref, undefined);
  assert.equal(calls, 2, 'a previous report cannot cache a replaced source identity');
  assert.equal(annotateRuntimeSources({ sourceFile: inside }, { ...options, roots: [] }).size, 0);
});

test('separate same-named Solution roots retain unambiguous source references', () => {
  const sourceDir = path.resolve('portal'),
    first = path.resolve('one', 'shared'),
    second = path.resolve('two', 'shared');
  const report = { rows: [first, second].map((root) => ({ sourceFile: path.join(root, 'Entity.xml') })) };
  const files = annotateRuntimeSources(report, {
    sourceDir,
    roots: [sourceDir, first, second],
    realpath: (file) => file,
  });
  assert.deepEqual([...files.keys()], ['@shared/Entity.xml', '@shared~2/Entity.xml']);
});
