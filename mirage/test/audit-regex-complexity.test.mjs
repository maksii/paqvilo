// @test-kind security: audit output must redact credentials while handling long untrusted identifier runs in linear time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditText } from '../lib/audit-log.mjs';

test('audit redacts prefixed secret keys and keeps original surrounding text', () => {
  assert.equal(
    auditText('before my-client-secret="sensitive value" after'),
    'before my-client-secret=[redacted] after',
  );
  assert.equal(auditText('pretoken:abc password=def'), 'pretoken:[redacted] password=[redacted]');
  assert.equal(auditText('longidentifier with no credential'), 'longidentifier with no credential');
});

test('audit handles long identifiers with and without a secret suffix', () => {
  const prefix = 'x'.repeat(100_000);
  assert.equal(auditText(prefix, 200_000), prefix);
  assert.equal(auditText(`${prefix}token=hidden`, 200_000), `${prefix}token=[redacted]`);
});

test('audit completes on 2 MiB of unterminated secret candidates and of unclosed condition tags', () => {
  const secrets = auditText('password="x <condition attribute="password"><value>y '.repeat(35_000));
  assert.ok(secrets.startsWith('password=[redacted]'));
  assert.equal(
    auditText('<condition '.repeat(200_000) + '>'),
    auditText(('<condition '.repeat(200_000) + '>').slice(0, 12_000)),
  );
  assert.ok(auditText('token="'.repeat(300_000)).length <= 12_000);
});

test('audit completes on 2 MiB of unterminated values inside a secret condition', () => {
  const values = auditText(`<condition attribute="password">${'value="x value=\'y '.repeat(120_000)}`);
  assert.ok(values.startsWith('<condition attribute="password">value="[redacted]"'));
  assert.ok(values.length <= 12_000);
});
