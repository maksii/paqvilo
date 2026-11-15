import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { control, startCanvasPlayer } from './support/canvas-player-page.mjs';

const APP_PATH = (app) => `/_apps/api/canvas/${app}`;

// Serves an invented app whose text input Search filters a gallery and whose OnChange sets a flag shown by a label.
// The clock is paused once the app has started, so the test advances delayed output explicitly.
async function playerPage(t, { textInput = {}, clock = false, extra = [] } = {}) {
  const files = {
    'Src/App.pa.yaml': stringify({
      App: {
        Properties: {
          OnStart: '=ClearCollect(rows, {name: "Alpha"}, {name: "Beta"}); Set(typed, false)',
          StartScreen: '=Home',
        },
      },
    }),
    'Src/Home.pa.yaml': stringify({
      Screens: {
        Home: {
          Children: [
            control('Search', 'Classic/TextInput@2.3.2', {
              Default: '=""',
              OnChange: '=Set(typed, true)',
              X: '=20',
              Y: '=20',
              Width: '=200',
              Height: '=40',
              ...textInput,
            }),
            control(
              'Rows',
              'Gallery@2.15.0',
              {
                Items: '=Filter(rows, StartsWith(name, Search.Text))',
                X: '=20',
                Y: '=80',
                Width: '=300',
                Height: '=200',
                TemplateSize: '=40',
              },
              [
                control('Name', 'Label@2.5.1', {
                  Text: '=ThisItem.name',
                  X: '=0',
                  Y: '=0',
                  Width: '=200',
                  Height: '=40',
                }),
              ],
            ),
            control('Flag', 'Label@2.5.1', {
              Text: '=If(typed, "changed", "idle")',
              X: '=20',
              Y: '=300',
              Width: '=200',
              Height: '=40',
            }),
            ...extra,
          ],
        },
      },
    }),
  };
  const { app, page } = await startCanvasPlayer(t, {
    files,
    viewport: { width: 1280, height: 900 },
    readyControl: 'Flag',
  });
  const path = APP_PATH(app.uniqueName);
  const actionIs = (name) => (response) =>
    response.url().endsWith(path) &&
    response.request().method() === 'POST' &&
    response.request().postDataJSON()?.action === name;
  if (clock) {
    const base = new Date('2030-01-01T00:00:00Z');
    await page.clock.install({ time: base });
    await page.clock.pauseAt(new Date(base.getTime() + 1000));
  }
  return { page, path, actionIs };
}

// Microsoft Learn: https://learn.microsoft.com/power-apps/guidance/coding-guidelines/code-optimization
// @test-kind compatibility: Microsoft Learn code-optimization: with DelayOutput false a gallery filters as soon as text is typed
test('a gallery filters as soon as text is typed, and OnChange runs when the input is committed', async (t) => {
  const { page, actionIs } = await playerPage(t);
  const rows = page.locator('[data-control="Rows"] [data-item-index]');
  await page.locator('[data-control="Search"]').pressSequentially('be');
  await page.waitForFunction(() => document.querySelectorAll('[data-control="Rows"] [data-item-index]').length === 1);
  assert.match(await rows.first().innerText(), /Beta/);
  assert.equal(await page.locator('[data-control="Flag"]').innerText(), 'idle');
  const committed = page.waitForResponse(actionIs('input'));
  await page.keyboard.press('Tab');
  assert.equal((await committed).ok(), true);
  await page.waitForFunction(() => document.querySelector('[data-control="Flag"]')?.textContent === 'changed');
});

// Types 'be' with the given text input properties and checks that the text is registered only once half a second has
// passed on the paused clock.
async function registersAfterHalfSecond(t, textInput) {
  const { page, path } = await playerPage(t, { clock: true, textInput });
  const sent = [];
  page.on('request', (request) => {
    if (request.url().endsWith(path) && request.method() === 'POST' && request.postDataJSON()?.action === 'text')
      sent.push(request.postDataJSON().value);
  });
  await page.locator('[data-control="Search"]').pressSequentially('be');
  await page.clock.runFor(499);
  assert.deepEqual(sent, []);
  const registered = page.waitForResponse(
    (response) => response.url().endsWith(path) && response.request().postDataJSON()?.action === 'text',
  );
  await page.clock.runFor(1);
  assert.equal((await registered).ok(), true);
  assert.deepEqual(sent, ['be']);
}

// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-text-input
// @test-kind compatibility: Microsoft Learn control-text-input: DelayOutput registers input after half a second
test('DelayOutput registers the typed text once half a second has passed', async (t) => {
  await registersAfterHalfSecond(t, { DelayOutput: '=true' });
});

// Microsoft Learn: https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/modern-controls/modern-control-text-input
// @test-kind unproven: local approximation: TriggerOutput Delayed uses the same half second
test('TriggerOutput Delayed registers the typed text after the same half second', async (t) => {
  await registersAfterHalfSecond(t, { TriggerOutput: '=TriggerOutput.Delayed' });
});

// The button's script click keeps the focus in the input, as an app's own reset does while the user is typing. The app
// already holds the text that was sent, so the rebuilt input shows the app's empty value and typing goes on from it.
// @test-kind contract: the app's value wins over text that was already sent
test("the app's value wins over text that was already sent, and typing continues", async (t) => {
  const { page, actionIs } = await playerPage(t, {
    extra: [
      control('Clear', 'Classic/Button@2.2.0', {
        Text: '="Clear"',
        OnSelect: '=Reset(Search)',
        X: '=20',
        Y: '=360',
        Width: '=200',
        Height: '=40',
      }),
    ],
  });
  const search = page.locator('[data-control="Search"]');
  const sentText = (value) => (response) =>
    actionIs('text')(response) && response.request().postDataJSON()?.value === value;
  const typed = page.waitForResponse(sentText('ab'));
  await search.pressSequentially('ab');
  assert.equal((await typed).ok(), true);
  const before = await search.elementHandle();
  const reset = page.waitForResponse(actionIs('select'));
  await page.locator('[data-control="Clear"]').evaluate((button) => button.click());
  assert.equal((await reset).ok(), true);
  await page.waitForFunction((old) => !old.isConnected, before);
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.control), 'Search');
  const next = page.waitForResponse(sentText('c'));
  await search.pressSequentially('c');
  assert.equal((await next).ok(), true);
  assert.equal(await search.inputValue(), 'c');
});
