import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { control, startCanvasPlayer } from './support/canvas-player-page.mjs';

const LOGO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=',
  'base64',
);

// Serves the invented app on a loopback port and opens its page in a browser that closes with the test.
async function playerPage(t) {
  const files = {
    'Assets/Logo.png': LOGO,
    'Src/App.pa.yaml': stringify({ App: { Properties: { StartScreen: '=Home' } } }),
    'Src/Home.pa.yaml': stringify({
      Screens: {
        Home: {
          Children: [
            control('MarkDoneButton', 'Classic/Button@2.2.0', {
              Text: '="Mark done"',
              X: '=20',
              Y: '=20',
              Width: '=160',
              Height: '=40',
            }),
            control('CompleteButton', 'Classic/Button@2.2.0', {
              Text: '="Complete"',
              AccessibleLabel: '="Complete task"',
              X: '=20',
              Y: '=70',
              Width: '=160',
              Height: '=40',
            }),
            control('LogoView', 'Image@2.0', {
              Image: '=Logo',
              X: '=20',
              Y: '=120',
              Width: '=60',
              Height: '=60',
            }),
            control('HomeIcon', 'Icon@1.0.0', {
              Icon: '=Icon.Home',
              X: '=100',
              Y: '=120',
              Width: '=40',
              Height: '=40',
            }),
            control('SettingsIcon', 'Icon@1.0.0', {
              Icon: '=Icon.Settings',
              OnSelect: '=Set(settingsOpened, true)',
              X: '=150',
              Y: '=120',
              Width: '=40',
              Height: '=40',
            }),
            control('MailCheck', 'Classic/CheckBox@2.1.0', {
              Text: '="Email me"',
              Default: '=false',
              X: '=20',
              Y: '=200',
              Width: '=160',
              Height: '=40',
            }),
          ],
        },
      },
    }),
  };
  const { page } = await startCanvasPlayer(t, {
    files,
    viewport: { width: 1280, height: 900 },
    readyControl: 'MailCheck',
  });
  return page;
}

// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/properties-accessibility
// @test-kind compatibility: Microsoft Learn properties-accessibility: AccessibleLabel names a control for screen readers
test('a button without AccessibleLabel is named by its text and one with AccessibleLabel by that label', async (t) => {
  const page = await playerPage(t);
  const markDone = page.locator('[data-control="MarkDoneButton"]');
  assert.equal(await markDone.getAttribute('aria-label'), null);
  assert.equal(
    await page.getByRole('button', { name: 'Mark done', exact: true }).getAttribute('data-control'),
    'MarkDoneButton',
  );
  assert.equal(await page.locator('[data-control="CompleteButton"]').getAttribute('aria-label'), 'Complete task');
  assert.equal(
    await page.getByRole('button', { name: 'Complete task', exact: true }).getAttribute('data-control'),
    'CompleteButton',
  );
});

// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-image
// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-shapes-icons
// @test-kind compatibility: Microsoft Learn properties-accessibility and control-shapes-icons: a graphic with an empty AccessibleLabel is hidden unless it can be selected
test('an image without AccessibleLabel is decorative, and an unselectable icon is hidden while a selectable one stays exposed', async (t) => {
  const page = await playerPage(t);
  assert.equal(await page.locator('img[data-control="LogoView"]').getAttribute('alt'), '');
  assert.equal(await page.locator('[data-control="HomeIcon"]').getAttribute('aria-hidden'), 'true');
  const settings = page.locator('[data-control="SettingsIcon"]');
  assert.equal(await settings.getAttribute('aria-hidden'), null);
  assert.equal(await settings.getAttribute('role'), 'button');
});

// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-check-box
// @test-kind unproven: local approximation: a check box is named by its text
test('a check box without AccessibleLabel is named by its text', async (t) => {
  const page = await playerPage(t);
  const check = page.getByRole('checkbox', { name: 'Email me', exact: true });
  assert.equal(await check.getAttribute('data-control'), 'MailCheck');
  assert.equal(await check.isChecked(), false);
});
