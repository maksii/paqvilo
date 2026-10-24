import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
test('the legacy standalone chrome stylesheet retains the independently served accessibility/offline utilities', async () => {
  const [combined, utilities] = await Promise.all(
    ['platform-chrome.css', 'platform-chrome-utilities.css'].map((name) =>
      fs.readFile(new URL(`../lib/${name}`, import.meta.url), 'utf8'),
    ),
  );
  // Intentional distribution duplication keeps both classic asset URLs self-contained.
  assert.ok(combined.startsWith(utilities.trimEnd() + '\n'));
  assert.match(utilities, /\.sr-only\s*\{/);
  assert.match(utilities, /#offlineNotificationBar\s*\{/);
});
