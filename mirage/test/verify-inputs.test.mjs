// @test-kind contract: mirage verify names the option of a missing or malformed input before it parses anything
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyParity } from '../verify.mjs';

test('verifyParity names the missing --origin option instead of reporting an invalid URL', async () => {
  await assert.rejects(verifyParity({ localUrl: 'http://127.0.0.1:1', outputDir: 'x' }), /--origin is required/);
});

test('verifyParity names the option of a malformed URL input', async () => {
  await assert.rejects(
    verifyParity({
      localUrl: 'not a url',
      origin: 'https://portal.invalid',
      cdpUrl: 'http://127.0.0.1:9',
      outputDir: 'x',
    }),
    /--local must be an absolute URL/,
  );
});
