// @test-kind contract: Paqvilo's Vite plug-in drops Vite's missing-source warnings only for node_modules files
import test from 'node:test';
import assert from 'node:assert/strict';
import { quietDependencySourcemaps } from '../lib/code-apps-vite.mjs';

const missing = (file) => `Sourcemap for "${file}" points to missing source files`;

function recordingLogger() {
  const calls = [];
  const logger = {
    warn: (message, options) => calls.push(['warn', message, options]),
    warnOnce: (message, options) => calls.push(['warnOnce', message, options]),
  };
  quietDependencySourcemaps(logger);
  return { logger, calls };
}

test('missing-source warnings for node_modules files are dropped on both logger methods', () => {
  const { logger, calls } = recordingLogger();
  const message = missing('/inv/app/node_modules/@invented/pkg/dist/a.js');
  logger.warn(message, { timestamp: true });
  logger.warnOnce(message);
  assert.deepEqual(calls, []);
});

test('a Windows node_modules path is dropped and so is a message wrapped in ANSI colour codes', () => {
  const { logger, calls } = recordingLogger();
  logger.warn(missing(String.raw`C:\inv\app\node_modules\@invented\pkg\dist\a.js`));
  logger.warnOnce(`\u001b[33m${missing('/inv/app/node_modules/@invented/pkg/dist/b.js')}\u001b[39m`);
  assert.deepEqual(calls, []);
});

test('a missing-source warning for the application source passes with its options object', () => {
  const { logger, calls } = recordingLogger();
  const options = { timestamp: true, clear: false };
  const message = missing('/inv/app/src/main.ts');
  logger.warn(message, options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], message);
  assert.equal(calls[0][2], options);
});

test('any other warning passes unchanged with its options', () => {
  const { logger, calls } = recordingLogger();
  const options = { timestamp: true };
  logger.warn('Some other warning in /inv/app/node_modules/@invented/pkg', options);
  logger.warnOnce('Plain warning');
  assert.deepEqual(calls, [
    ['warn', 'Some other warning in /inv/app/node_modules/@invented/pkg', options],
    ['warnOnce', 'Plain warning', undefined],
  ]);
});

test('a logger with only warn is wrapped without throwing', () => {
  const calls = [];
  const logger = { warn: (message) => calls.push(message) };
  quietDependencySourcemaps(logger);
  logger.warn(missing('/inv/app/node_modules/@invented/pkg/dist/a.js'));
  logger.warn('kept');
  assert.deepEqual(calls, ['kept']);
  assert.equal(logger.warnOnce, undefined);
});
