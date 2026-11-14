// @test-kind contract: the local Xrm batch transport preserves multipart framing, status, headers and complete response bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchResponses } from '../lib/model-driven/client-runtime.mjs';

const responsePart = (boundary, response) =>
  `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${response}\r\n`;

test('batch responses retain ordered success and error payloads with case-insensitive headers', () => {
  const body =
    responsePart('outer', 'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-Test: first\r\n\r\n{"id":1}') +
    responsePart('outer', 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":"invalid"}') +
    '--outer--';
  assert.deepEqual(batchResponses(body, 'outer'), [
    {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'x-test': 'first' },
      body: '{"id":1}',
    },
    {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
      body: '{"error":"invalid"}',
    },
  ]);
});

test('nested change-set responses use their declared boundary without splitting other body text', () => {
  const payload = 'first\n--unrelated\nlast';
  const body =
    '--outer\r\nContent-Type: multipart/mixed; boundary="nested"\r\n\r\n' +
    responsePart('nested', 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n' + payload) +
    '--nested--\r\n--outer--';
  assert.deepEqual(batchResponses(body, 'outer'), [
    { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: payload },
  ]);
});

test('large embedded headers and bodies are scanned completely without ambiguous wildcard matching', () => {
  const header = 'a'.repeat(131072),
    payload = 'body\r\n'.repeat(32768) + 'end';
  const body = responsePart('outer', `HTTP/1.1 200 OK\r\nX-Long: ${header}\r\n\r\n${payload}`) + '--outer--';
  assert.deepEqual(batchResponses(body, 'outer'), [
    { status: 200, statusText: 'OK', headers: { 'x-long': header }, body: payload },
  ]);
});

test('malformed embedded status lines are rejected without consuming a later response', () => {
  const body =
    responsePart('outer', 'HTTP/2 200 OK\r\nX-Test: invalid\r\n\r\nignored') +
    responsePart('outer', 'HTTP/1.1 204 No Content\r\nX-Test: valid\r\n\r\n') +
    '--outer--';
  assert.deepEqual(batchResponses(body, 'outer'), [
    { status: 204, statusText: 'No Content', headers: { 'x-test': 'valid' }, body: '' },
  ]);
});
