// @test-kind observation: a browser registers, signs in, confirms its address and completes email two-factor sign-in through the local account pages with the platform's control names and redirects (hosted session F4 AUTH-04g, two agreeing runs: accounts-{a,b}-register, accounts-a-mfaenable+mfa, accounts-b-confirm+cookies+reset+mfaenable+mfa and digest-F4.json in the hosted-f4 evidence folder)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { initialState, simulator } from '../test/support/external-sign-in.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('a browser uses the local account pages through registration, confirmation and two-factor sign-in', async (t) => {
  const settings = [
    ['Authentication/Registration/CaptchaEnabled', 'false'],
    ['Authentication/Registration/TwoFactorEnabled', 'true'],
  ];
  const { app, csrf } = await simulator(t, settings, initialState(), { identityProvider: { localAccounts: true } });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  ownedFixture(t).add(() => context.close());
  await context.route('**/*', (route) =>
    route.request().url().startsWith(app.url) || route.request().url().startsWith(app.adminOrigin)
      ? route.continue()
      : route.abort(),
  );
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  const contactId = async () => (await (await tab.request.get(app.url + '/_sim/api/session')).json()).contactId;
  const mail = async (kind) =>
    (
      await (
        await tab.request.get(app.adminOrigin + '/_sim/api/local-accounts/messages', {
          headers: { 'x-sim-csrf': csrf },
        })
      ).json()
    ).items.find((item) => item.kind === kind);
  const password = 'Fixture-browser-61';

  await tab.goto(app.url + '/Account/Login/Register');
  await tab.locator('#EmailTextBox').fill('browser-user@example.test');
  await tab.locator('#UserNameTextBox').fill('browser-user');
  await tab.locator('#PasswordTextBox').fill(password);
  await tab.locator('#ConfirmPasswordTextBox').fill(password);
  await Promise.all([tab.waitForURL(app.url + '/'), tab.getByRole('button', { name: 'Register' }).click()]);
  const id = await contactId();
  assert.ok(id, 'registration signs in at once');
  assert.equal(await mail('confirm'), undefined, 'registration sends no email');

  // The profile's "Confirm Email" posts PostConfirmEmailRequest with the form token in a header.
  await tab.goto(app.url + '/Account/Manage/ConfirmEmailRequest');
  await tab.goto(app.url + '/Account/Manage/ChangePassword');
  const token = await tab.locator('input[name=__RequestVerificationToken]').inputValue();
  // The account pages allow no scripts: the request comes from a site page, as the profile page sends it.
  await tab.goto(app.url + '/');
  const posted = await tab.evaluate(
    async (value) =>
      (
        await fetch('/Account/Manage/PostConfirmEmailRequest', {
          method: 'POST',
          headers: { __RequestVerificationToken: value },
        })
      ).status,
    token,
  );
  assert.equal(posted, 200);
  await tab.goto(app.url + (await mail('confirm')).url);
  assert.equal(new URL(tab.url()).search, '?Message=ConfirmEmailSuccess');

  await tab.goto(app.url + '/Account/Manage/ChangeTwoFactor');
  assert.match(await tab.locator('main').innerText(), /Enable Two-factor authentication is currently disabled\./);
  await Promise.all([
    tab.waitForURL(app.url + '/?Message=EnableTwoFactorSuccess'),
    tab.getByRole('button', { name: 'Enable' }).click(),
  ]);

  await tab.goto(app.url + '/Account/Login/LogOff');
  assert.equal(await contactId(), null);
  const signIn = async () => {
    await tab.goto(app.url + '/Account/Login/Login');
    await tab.locator('#Username').fill('browser-user');
    await tab.locator('#PasswordValue').fill(password);
    await tab.getByRole('button', { name: 'Sign in' }).click();
  };
  await signIn();
  await tab.waitForURL(app.url + '/Account/Login/VerifyCode?Provider=EmailCode&RememberMe=False');
  assert.equal(await contactId(), null);
  await tab.locator('#Code').fill((await mail('mfa')).code);
  await tab.locator('#RememberBrowser').check();
  await Promise.all([tab.waitForURL(app.url + '/'), tab.getByRole('button', { name: 'Verify' }).click()]);
  assert.equal(await contactId(), id);

  await tab.goto(app.url + '/Account/Login/LogOff');
  await signIn();
  await tab.waitForURL(app.url + '/');
  assert.equal(await contactId(), id, 'the remembered browser skips the code');
  assert.deepEqual(errors, []);
});
