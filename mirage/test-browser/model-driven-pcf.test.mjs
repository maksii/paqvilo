import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

// Invented compiled standard control: the same public lifecycle a PAC bundle exports.
const bundle = `var InventedExports; InventedExports = { Input: class {
  init(context, notify, state, container) { window.lifecycle.push('init'); this.context=context; window.pcfContext=context; this.notify=notify;
    this.input=document.createElement('input'); this.input.setAttribute('aria-label','PCF value');
    this.input.addEventListener('input',()=>{this.value=this.input.value;notify();});container.append(this.input);context.mode.trackContainerResize(true); }
  updateView(context) { window.lifecycle.push('update');this.context=context;this.value=context.parameters.value.raw;this.input.value=this.value??'';this.input.disabled=context.mode.isControlDisabled; }
  getOutputs() { window.lifecycle.push('outputs');return {value:this.value,undeclared:'ignored'}; }
  destroy() { window.lifecycle.push('destroy');this.input.remove(); }
} };`;

async function fixture(t) {
  let scripts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/bundle.js') { scripts++; res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
    if (req.url === '/registered.js' || req.url === '/namespace.js') { scripts++; res.setHeader('content-type', 'text/javascript'); res.end(bundle + (req.url === '/registered.js' ? ';ComponentFramework.registerControl("Invented.Input",InventedExports.Input);' : ';window.Invented={Input:InventedExports.Input};')); return; }
    if (req.url === '/slow.js') { setTimeout(() => { res.setHeader('content-type', 'text/javascript'); res.end(bundle); }, 50); return; }
    if (req.url.startsWith('/assets/')) {
      const name = req.url.slice('/assets/'.length);
      if (!['pcf-runtime.mjs', 'controls.mjs', 'control-descriptors.mjs', 'icons.mjs'].includes(name)) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'text/javascript'); res.end(await fs.readFile(new URL(`../lib/model-driven/${name}`, import.meta.url))); return;
    }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head></head><body><main></main></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.lifecycle = []; window.changes = 0;
    window.render = (await import('/assets/controls.mjs')).renderControl;
    window.field = { name: 'x_name', label: 'Name', type: 'text', maxLength: 20 };
    window.extensions = { trusted: true, pcf: { controls: [{ name: 'publisher.InventedInput', constructor: 'Invented.Input', controlType: 'standard', properties: [{ name: 'value', ofType: 'SingleLine.Text', usage: 'bound' }, { name: 'prefix', ofType: 'Whole.None', usage: 'input' }], resources: { code: ['/bundle.js'], exports: ['InventedExports'] } }] } };
    window.options = { pcf: { name: 'publisher.InventedInput', bindings: { value: { field: 'x_name' }, prefix: { value: '3' } } }, clientExtensions: window.extensions };
    window.mount = async options => { window.control = window.render(window.field, 'Initial', options??window.options); document.querySelector('main').append(window.control.element); window.control.element.addEventListener('input',()=>window.changes++); await window.control.ready; };
  });
  return { page, errors, scriptCount: () => scripts };
}

test('trusted standard PCF uses compiled exports, typed context, dirty outputs and deterministic cleanup', async t => {
  const { page, errors, scriptCount } = await fixture(t);
  await page.evaluate(() => mount());
  await page.getByLabel('PCF value').fill('Changed');
  assert.equal(await page.evaluate(() => control.read()), 'Changed');
  assert.equal(await page.evaluate(() => changes > 0), true);
  assert.equal(await page.evaluate(() => control.supported), true);
  assert.equal(await page.evaluate(() => control.element.dataset.pcfState), 'ready');
  assert.equal(await page.evaluate(() => pcfContext.parameters.prefix.raw), 3);
  assert.equal(await page.evaluate(() => pcfContext.parameters.value.attributes.LogicalName), 'x_name');
  await page.evaluate(() => control.setValue('Script value'));
  await page.waitForFunction(() => document.querySelector('input').value === 'Script value');
  await page.evaluate(() => control.setDisabled(true));
  await page.getByLabel('PCF value').isDisabled().then(value => assert.equal(value, true));
  assert.equal(await page.evaluate(() => control.element.inert), true);
  assert.equal(await page.evaluate(() => control.element.getAttribute('aria-disabled')), 'true');
  // A component ignoring isControlDisabled cannot mutate the bound host value.
  await page.evaluate(() => { document.querySelector('input').value='Bypass'; document.querySelector('input').dispatchEvent(new Event('input')); });
  assert.equal(await page.evaluate(() => control.read()), 'Script value');
  await page.evaluate(() => { control.destroy();control.destroy(); });
  assert.equal(await page.evaluate(() => lifecycle.filter(event=>event==='destroy').length), 1);
  assert.equal(await page.locator('input').count(), 0);
  await page.evaluate(() => mount());
  assert.equal(scriptCount(), 1); // Constructor resources load once; each form owns its instance.
  assert.deepEqual(errors, []);
});

test('namespace and registerControl compiled exports use the same bounded standard host', async t => {
  const { page, errors, scriptCount } = await fixture(t);
  for (const file of ['namespace', 'registered']) {
    await page.evaluate(async file => {
      document.querySelector('main').replaceChildren();
      await mount({ ...options, clientExtensions: { trusted: true, pcf: { controls: [{ ...extensions.pcf.controls[0], resources: { code: [`/${file}.js`] } }] } } });
      control.destroy(); delete window.Invented;
    }, file);
  }
  assert.equal(await page.evaluate(() => lifecycle.filter(event=>event==='init').length), 2);
  assert.equal(scriptCount(), 2); assert.deepEqual(errors, []);
});

test('PCF unsupported features, property types, missing bindings and incompatible columns fail before code runs', async t => {
  const { page, errors, scriptCount } = await fixture(t);
  for (const kind of ['feature', 'type', 'required', 'column']) {
    await page.evaluate(async kind => {
      document.querySelector('main').replaceChildren();
      const definition = structuredClone(extensions.pcf.controls[0]);
      if (kind === 'feature') definition.features = [{ name: 'Device.captureImage', required: 'true' }];
      if (kind === 'type') definition.properties[0].ofType = 'Lookup.Simple';
      if (kind === 'required') definition.properties.push({ name: 'missing', ofType: 'SingleLine.Text', usage: 'input', required: 'true' });
      const currentField = kind === 'column' ? { ...field, type: 'number' } : field;
      control = render(currentField, 'Initial', { ...options, clientExtensions: { trusted: true, pcf: { controls: [definition] } } });
      document.querySelector('main').append(control.element); await control.ready;
    }, kind);
    assert.equal(await page.evaluate(() => control.supported), false);
    assert.ok((await page.locator('main').innerText()).length > 10);
  }
  assert.equal(scriptCount(), 0); assert.deepEqual(errors, []);
});

test('PCF optional Web API uses the configured local staff adapter and unsupported helpers reject explicitly', async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => mount({ ...options, webAPI: () => ({ retrieveRecord: async (entity, id) => ({ entity, id, value: 'local' }) }) }));
  assert.deepEqual(await page.evaluate(() => pcfContext.webAPI.retrieveRecord('x_item', 'invented')), { entity: 'x_item', id: 'invented', value: 'local' });
  assert.match(await page.evaluate(async () => { try { await pcfContext.webAPI.execute({}); } catch (error) { return error.message; } }), /not supported/);
  assert.match(await page.evaluate(() => { try { pcfContext.utils.hasEntityPrivilege('x_item', 1); } catch (error) { return error.message; } }), /not supported/);
  await page.evaluate(() => control.destroy());
  assert.match(await page.evaluate(async () => { try { await pcfContext.webAPI.retrieveRecord('x_item', 'invented'); } catch (error) { return error.message; } }), /not supported/);
  assert.deepEqual(errors, []);
});

test('PCF trust, unsupported contracts and remote URLs fail visibly without executing code', async t => {
  const { page, errors, scriptCount } = await fixture(t);
  await page.evaluate(() => mount({ ...options, clientExtensions: { ...extensions, trusted: false } }));
  assert.match(await page.locator('main').innerText(), /Trust local Solution code/);
  assert.equal(await page.evaluate(() => control.supported), false);
  assert.equal(scriptCount(), 0);
  await page.evaluate(() => { document.querySelector('main').replaceChildren(); return mount({ ...options, clientExtensions: { trusted: true, pcf: { controls: [{ ...extensions.pcf.controls[0], controlType: 'virtual' }] } } }); });
  assert.match(await page.locator('main').innerText(), /Only standard scalar/);
  await page.evaluate(() => { document.querySelector('main').replaceChildren(); return mount({ ...options, clientExtensions: { trusted: true, pcf: { controls: [{ ...extensions.pcf.controls[0], resources: { code: ['https://example.invalid/control.js'] } }] } } }); });
  assert.match(await page.locator('main').innerText(), /local Mirage origin/);
  assert.equal(scriptCount(), 0);
  assert.deepEqual(errors, []);
});

test('invalid PCF output preserves the column and destroys the failing component', async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => mount());
  await page.getByLabel('PCF value').fill('This exceeds the maximum field length');
  assert.equal(await page.evaluate(() => control.read()), 'Initial');
  assert.equal(await page.evaluate(() => control.supported), false);
  assert.match(await page.locator('main').innerText(), /exceeds the column length/);
  assert.equal(await page.evaluate(() => lifecycle.filter(event=>event==='destroy').length), 1);
  assert.deepEqual(errors, []);
});

test('a disposed form cannot initialize a component after asynchronous resources finish', async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const delayed = { ...extensions, pcf: { controls: [{ ...extensions.pcf.controls[0], resources: { code: ['/slow.js'], exports: ['InventedExports'] } }] } };
    control = render(field, 'Initial', { ...options, clientExtensions: delayed }); document.querySelector('main').append(control.element); control.destroy(); await control.ready;
  });
  assert.deepEqual(await page.evaluate(() => lifecycle), []);
  assert.equal(await page.locator('input').count(), 0);
  assert.deepEqual(errors, []);
});

test('an exported Solution PCF edits and saves through the actual model-driven shell', async t => {
  const source = await modelDrivenFixture(t); await source.sim.close();
  const controlDir = path.join(source.solutionDir, 'Controls', 'publisher.InventedInput'); await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(path.join(controlDir, 'ControlManifest.xml'), '<manifest><control namespace="Invented" constructor="Input" version="1.0.0" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>');
  await fs.writeFile(path.join(controlDir, 'ControlManifest.xml.data.xml'), '<CustomControl><Name>publisher.InventedInput</Name></CustomControl>');
  await fs.writeFile(path.join(controlDir, 'bundle.js'), bundle.replaceAll("window.lifecycle.push", "(window.lifecycle??=[]).push"));
  const formFile = path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8')).replace('<control datafieldname="x_name"/>', '<control id="x_name" uniqueid="pcf-name" datafieldname="x_name"/>').replace('</form>', '<controlDescriptions><controlDescription forControl="pcf-name"><customControl name="publisher.InventedInput" formFactor="0"><parameters><value type="SingleLine.Text">x_name</value></parameters></customControl></controlDescription></controlDescriptions></form>');
  await fs.writeFile(formFile, xml);
  const sim = await source.start({ modelDriven: { trustedExtensions: true } }); t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  await page.getByLabel('PCF value').waitFor();
  assert.equal(await page.getByLabel('PCF value').inputValue(), 'Copper');
  await page.getByLabel('PCF value').fill('PCF updated');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  try { await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'PCF updated' || !document.querySelector('#notice')?.hidden, null, { timeout: 5000 }); }
  catch (error) { assert.fail(`${error.message}\n${await page.locator('body').innerText()}\n${JSON.stringify(errors)}\n${JSON.stringify(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>({name:input.name,value:input.value,valid:input.validity.valid,message:input.validationMessage}))))}`); }
  const saved = await page.request.get(`${origin}/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  assert.equal((await saved.json()).row.x_name, 'PCF updated');
  await page.reload(); await page.getByLabel('PCF value').waitFor();
  assert.equal(await page.getByLabel('PCF value').inputValue(), 'PCF updated');
  assert.deepEqual(errors, []);
});
