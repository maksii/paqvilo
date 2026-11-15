import fs from 'node:fs/promises';

const controlsDocument = await fs.readFile(new URL('./fixtures/native-controls.html', import.meta.url), 'utf8');

/** Load real controls and CSS without booting a shell that the control-only test immediately removes. */
export async function prepareNativeControls(page, origin) {
  const url = origin + '/native-controls-fixture';
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: controlsDocument }));
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.mirageControlsState === 'ready');
}
