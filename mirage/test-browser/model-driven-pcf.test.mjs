import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

// A compiled standard control: the same public lifecycle a PAC bundle exports.
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
    if (req.url === '/bundle.js') {
      scripts++;
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle);
      return;
    }
    if (req.url === '/registered.js' || req.url === '/namespace.js') {
      scripts++;
      res.setHeader('content-type', 'text/javascript');
      res.end(
        bundle +
          (req.url === '/registered.js'
            ? ';ComponentFramework.registerControl("Invented.Input",InventedExports.Input);'
            : ';window.Invented={Input:InventedExports.Input};'),
      );
      return;
    }
    // UMD stand-ins for project-supplied platform libraries and a virtual component bundle.
    if (req.url === '/react.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('window.React={createElement:(type,props)=>({type,props})};');
      return;
    }
    if (req.url === '/reactdom.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(
        'window.ReactDOM={render(view,node){node.textContent="virtual:"+view.props.value;window.renders=(window.renders||0)+1;},unmountComponentAtNode(node){node.textContent="";window.unmounts=(window.unmounts||0)+1;}};',
      );
      return;
    }
    if (req.url === '/virtual.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(
        'ComponentFramework.registerControl("Invented.Virtual",class{init(context,notify,state,container){window.virtualInit=arguments.length;}updateView(context){window.virtualSettings=context.userSettings;return React.createElement("span",{value:context.parameters.value.raw});}destroy(){}});',
      );
      return;
    }
    if (req.url === '/slow.js') {
      setTimeout(() => {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle);
      }, 50);
      return;
    }
    if (req.url.startsWith('/assets/')) {
      const name = req.url.slice('/assets/'.length);
      if (
        ![
          'pcf-runtime.mjs',
          'controls.mjs',
          'choice-control.mjs',
          'lookup-control.mjs',
          'date-control.mjs',
          'duration-control.mjs',
          'control-descriptors.mjs',
          'icons.mjs',
        ].includes(name)
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/javascript');
      res.end(await fs.readFile(new URL(`../lib/model-driven/${name}`, import.meta.url)));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head></head><body><main></main></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.lifecycle = [];
    window.changes = 0;
    window.render = (await import('/assets/controls.mjs')).renderControl;
    window.field = { name: 'x_name', label: 'Name', type: 'text', maxLength: 20 };
    window.extensions = {
      trusted: true,
      pcf: {
        controls: [
          {
            name: 'publisher.InventedInput',
            constructor: 'Invented.Input',
            controlType: 'standard',
            properties: [
              { name: 'value', ofType: 'SingleLine.Text', usage: 'bound' },
              { name: 'prefix', ofType: 'Whole.None', usage: 'input' },
            ],
            resources: { code: ['/bundle.js'], exports: ['InventedExports'] },
          },
        ],
      },
    };
    window.options = {
      pcf: { name: 'publisher.InventedInput', bindings: { value: { field: 'x_name' }, prefix: { value: '3' } } },
      clientExtensions: window.extensions,
    };
    window.mount = async (options) => {
      window.control = window.render(window.field, 'Initial', options ?? window.options);
      document.querySelector('main').append(window.control.element);
      window.control.element.addEventListener('input', () => window.changes++);
      await window.control.ready;
    };
  });
  return { page, errors, scriptCount: () => scripts };
}

test('trusted standard PCF uses compiled exports, typed context, dirty outputs and deterministic cleanup', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.Input{width:20px}';
    document.head.append(style);
  });
  await page.evaluate(() => window.mount());
  assert.deepEqual(
    await page
      .locator('.model-driven-pcf')
      .evaluate((element) =>
        ['customControl', 'Invented', 'Input', 'Invented.Input'].map((name) => element.classList.contains(name)),
      ),
    [true, true, true, true],
  );
  assert.ok(
    await page.locator('.model-driven-pcf').evaluate((element) => element.getBoundingClientRect().width > 100),
    'native host width must fill the field when a constructor class has checkbox-sized CSS',
  );
  await page.getByLabel('PCF value').fill('Changed');
  assert.equal(await page.evaluate(() => window.control.read()), 'Changed');
  assert.equal(await page.evaluate(() => window.changes > 0), true);
  assert.equal(await page.evaluate(() => window.control.supported), true);
  assert.equal(await page.evaluate(() => window.control.element.dataset.pcfState), 'ready');
  assert.equal(await page.evaluate(() => window.pcfContext.parameters.prefix.raw), 3);
  assert.equal(await page.evaluate(() => window.pcfContext.parameters.value.attributes.LogicalName), 'x_name');
  await page.evaluate(() => window.control.setValue('Script value'));
  await page.waitForFunction(() => document.querySelector('input').value === 'Script value');
  await page.evaluate(() => window.control.setDisabled(true));
  await page
    .getByLabel('PCF value')
    .isDisabled()
    .then((value) => assert.equal(value, true));
  assert.equal(await page.evaluate(() => window.control.element.inert), true);
  assert.equal(await page.evaluate(() => window.control.element.getAttribute('aria-disabled')), 'true');
  // A component ignoring isControlDisabled cannot mutate the bound host value.
  await page.evaluate(() => {
    document.querySelector('input').value = 'Bypass';
    document.querySelector('input').dispatchEvent(new Event('input'));
  });
  assert.equal(await page.evaluate(() => window.control.read()), 'Script value');
  await page.evaluate(() => {
    window.control.destroy();
    window.control.destroy();
  });
  assert.equal(await page.evaluate(() => window.lifecycle.filter((event) => event === 'destroy').length), 1);
  assert.equal(await page.locator('input').count(), 0);
  await page.evaluate(() => window.mount());
  assert.equal(scriptCount(), 1); // Constructor resources load once; each form owns its instance.
  assert.deepEqual(errors, []);
});

test('PCF date-only raw values preserve local calendar dates and choices expose exported formatted labels', async (t) => {
  const { page, errors } = await fixture(t);
  const values = await page.evaluate(async () => {
    const definition = structuredClone(window.extensions.pcf.controls[0]);
    definition.properties = [{ name: 'value', ofType: 'DateAndTime.DateOnly', usage: 'bound' }];
    window.control = window.render(
      { ...window.field, type: 'date', format: 'dateonly', dateTimeBehavior: 'DateOnly' },
      '2026-06-15',
      { ...window.options, clientExtensions: { trusted: true, pcf: { controls: [definition] } } },
    );
    document.querySelector('main').append(window.control.element);
    await window.control.ready;
    const date = window.pcfContext.parameters.value.raw,
      calendar = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()];
    window.control.destroy();
    definition.properties = [{ name: 'value', ofType: 'OptionSet', usage: 'bound' }];
    window.control = window.render(
      { ...window.field, type: 'number', options: [{ value: 7, label: 'Exported label' }] },
      7,
      { ...window.options, clientExtensions: { trusted: true, pcf: { controls: [definition] } } },
    );
    document.querySelector('main').append(window.control.element);
    await window.control.ready;
    return { calendar, formatted: window.pcfContext.parameters.value.formatted };
  });
  assert.deepEqual(values, { calendar: [2026, 6, 15, 0], formatted: 'Exported label' });
  assert.deepEqual(errors, []);
});

test('namespace and registerControl compiled exports use the same bounded standard host', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  for (const file of ['namespace', 'registered']) {
    await page.evaluate(async (file) => {
      document.querySelector('main').replaceChildren();
      await window.mount({
        ...window.options,
        clientExtensions: {
          trusted: true,
          pcf: { controls: [{ ...window.extensions.pcf.controls[0], resources: { code: [`/${file}.js`] } }] },
        },
      });
      window.control.destroy();
      delete window.Invented;
    }, file);
  }
  assert.equal(await page.evaluate(() => window.lifecycle.filter((event) => event === 'init').length), 2);
  assert.equal(scriptCount(), 2);
  assert.deepEqual(errors, []);
});

test('PCF unsupported features, property types, missing bindings and incompatible columns fail before code runs', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  for (const [kind, reason] of [
    ['feature', /host features that are not implemented locally: Device\.captureImage/],
    ['type', /Lookup\.Simple/],
    ['required', /required PCF property missing has no exported binding/],
    ['column', /incompatible with column x_name/],
  ]) {
    await page.evaluate(async (kind) => {
      document.querySelector('main').replaceChildren();
      const definition = structuredClone(window.extensions.pcf.controls[0]);
      if (kind === 'feature') definition.features = [{ name: 'Device.captureImage', required: 'true' }];
      if (kind === 'type') definition.properties[0].ofType = 'Lookup.Simple';
      if (kind === 'required')
        definition.properties.push({ name: 'missing', ofType: 'SingleLine.Text', usage: 'input', required: 'true' });
      const currentField = kind === 'column' ? { ...window.field, type: 'number' } : window.field;
      window.control = window.render(currentField, 'Initial', {
        ...window.options,
        clientExtensions: { trusted: true, pcf: { controls: [definition] } },
      });
      document.querySelector('main').append(window.control.element);
      await window.control.ready;
    }, kind);
    assert.equal(await page.evaluate(() => window.control.supported), false, kind);
    assert.match(await page.locator('main').innerText(), reason);
  }
  assert.equal(scriptCount(), 0);
  assert.deepEqual(errors, []);
});

test('PCF optional Web API uses the configured local staff adapter and unsupported helpers reject explicitly', async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() =>
    window.mount({
      ...window.options,
      webAPI: () => ({ retrieveRecord: async (entity, id) => ({ entity, id, value: 'local' }) }),
    }),
  );
  assert.deepEqual(await page.evaluate(() => window.pcfContext.webAPI.retrieveRecord('x_item', 'invented')), {
    entity: 'x_item',
    id: 'invented',
    value: 'local',
  });
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.pcfContext.webAPI.execute({});
      } catch (error) {
        return error.message;
      }
    }),
    /not supported/,
  );
  assert.match(
    await page.evaluate(() => {
      try {
        window.pcfContext.utils.hasEntityPrivilege('x_item', 1);
      } catch (error) {
        return error.message;
      }
    }),
    /not supported/,
  );
  await page.evaluate(() => window.control.destroy());
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.pcfContext.webAPI.retrieveRecord('x_item', 'invented');
      } catch (error) {
        return error.message;
      }
    }),
    /not supported/,
  );
  assert.deepEqual(errors, []);
});

test('required PCF WebAPI feature admits the configured staff adapter and rejects missing or unsupported host features', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  await page.evaluate(async () => {
    const definition = structuredClone(window.extensions.pcf.controls[0]);
    definition.features = [{ name: 'WebAPI', required: 'true' }];
    window.requiredOptions = {
      ...window.options,
      clientExtensions: { trusted: true, pcf: { controls: [definition] } },
    };
    await window.mount(window.requiredOptions);
  });
  assert.equal(await page.evaluate(() => window.control.supported), false);
  assert.equal(scriptCount(), 0);
  await page.evaluate(async () => {
    window.control.destroy();
    window.webApiCalls = [];
    await window.mount({
      ...window.requiredOptions,
      webAPI: () => ({
        retrieveMultipleRecords: async (...args) => {
          window.webApiCalls.push(args);
          return { entities: [{ x_name: 'Local only' }] };
        },
      }),
    });
  });
  assert.equal(await page.evaluate(() => window.control.supported), true);
  assert.deepEqual(
    await page.evaluate(() =>
      window.pcfContext.webAPI.retrieveMultipleRecords('x_item', '?$select=x_name&$filter=x_quantity gt 1'),
    ),
    { entities: [{ x_name: 'Local only' }] },
  );
  assert.deepEqual(await page.evaluate(() => window.webApiCalls), [
    ['x_item', '?$select=x_name&$filter=x_quantity gt 1'],
  ]);
  await page.evaluate(() => window.control.destroy());
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.pcfContext.webAPI.retrieveMultipleRecords('x_item');
      } catch (error) {
        return error.message;
      }
    }),
    /not supported/,
  );
  assert.deepEqual(errors, []);
});

test('PCF trust, unsupported contracts and remote URLs fail visibly without executing code', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  await page.evaluate(() =>
    window.mount({ ...window.options, clientExtensions: { ...window.extensions, trusted: false } }),
  );
  assert.match(await page.locator('main').innerText(), /Trust local Solution code/);
  assert.equal(await page.evaluate(() => window.control.supported), false);
  assert.equal(scriptCount(), 0);
  await page.evaluate(() => {
    document.querySelector('main').replaceChildren();
    return window.mount({
      ...window.options,
      clientExtensions: {
        trusted: true,
        pcf: { controls: [{ ...window.extensions.pcf.controls[0], controlType: 'virtual' }] },
      },
    });
  });
  assert.match(await page.locator('main').innerText(), /requires platform libraries/);
  await page.evaluate(() => {
    document.querySelector('main').replaceChildren();
    return window.mount({
      ...window.options,
      clientExtensions: {
        trusted: true,
        pcf: {
          controls: [
            { ...window.extensions.pcf.controls[0], resources: { code: ['https://example.invalid/control.js'] } },
          ],
        },
      },
    });
  });
  assert.match(await page.locator('main').innerText(), /local Mirage origin/);
  assert.equal(scriptCount(), 0);
  assert.deepEqual(errors, []);
});

test('invalid PCF output preserves the column and destroys the failing component', async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => window.mount());
  await page.getByLabel('PCF value').fill('This exceeds the maximum field length');
  assert.equal(await page.evaluate(() => window.control.read()), 'Initial');
  assert.equal(await page.evaluate(() => window.control.supported), false);
  assert.match(await page.locator('main').innerText(), /exceeds the column length/);
  assert.equal(await page.evaluate(() => window.lifecycle.filter((event) => event === 'destroy').length), 1);
  assert.deepEqual(errors, []);
});

test('a disposed form cannot initialize a component after asynchronous resources finish', async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => {
    const delayed = {
      ...window.extensions,
      pcf: {
        controls: [
          { ...window.extensions.pcf.controls[0], resources: { code: ['/slow.js'], exports: ['InventedExports'] } },
        ],
      },
    };
    window.control = window.render(window.field, 'Initial', { ...window.options, clientExtensions: delayed });
    document.querySelector('main').append(window.control.element);
    window.control.destroy();
    await window.control.ready;
  });
  assert.deepEqual(await page.evaluate(() => window.lifecycle), []);
  assert.equal(await page.locator('input').count(), 0);
  assert.deepEqual(errors, []);
});

test('disposal stops later PCF resource loads and retained contexts cannot restart resize observers', async (t) => {
  const { page, errors, scriptCount } = await fixture(t);
  let requested, release;
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  const resumed = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/slow.css', async (route) => {
    requested();
    await resumed;
    await route.fulfill({ status: 200, contentType: 'text/css', body: '.invented{}' });
  });
  await page.evaluate(() => {
    const delayed = {
      ...window.extensions,
      pcf: {
        controls: [
          {
            ...window.extensions.pcf.controls[0],
            resources: { css: ['/slow.css'], code: ['/bundle.js'], exports: ['InventedExports'] },
          },
        ],
      },
    };
    window.control = window.render(window.field, 'Initial', { ...window.options, clientExtensions: delayed });
    document.querySelector('main').append(window.control.element);
  });
  await started;
  await page.evaluate(() => window.control.destroy());
  release();
  await page.evaluate(() => window.control.ready);
  assert.equal(scriptCount(), 0, 'leaving during CSS loading must not execute the next component script');
  assert.deepEqual(await page.evaluate(() => window.lifecycle), []);
  const observers = await page.evaluate(async () => {
    window.observerCreates = 0;
    window.observerDisconnects = 0;
    window.ResizeObserver = class {
      constructor() {
        window.observerCreates++;
      }
      observe() {}
      disconnect() {
        window.observerDisconnects++;
      }
    };
    await window.mount();
    window.control.destroy();
    window.pcfContext.mode.trackContainerResize(true);
    return { created: window.observerCreates, disconnected: window.observerDisconnects };
  });
  assert.deepEqual(observers, { created: 1, disconnected: 1 });
  assert.deepEqual(errors, []);
});

test('an exported Solution PCF edits and saves through the actual model-driven shell', async (t) => {
  const source = await modelDrivenFixture(t);
  await source.sim.close();
  const controlDir = path.join(source.solutionDir, 'Controls', 'publisher.InventedInput');
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(
    path.join(controlDir, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Input" version="1.0.0" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
  );
  await fs.writeFile(
    path.join(controlDir, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>publisher.InventedInput</Name></CustomControl>',
  );
  await fs.writeFile(
    path.join(controlDir, 'bundle.js'),
    bundle
      .replaceAll('window.lifecycle.push', '(window.lifecycle??=[]).push')
      .replace(
        'container.append(this.input);',
        'container.append(this.input); var checkbox=document.createElement("input"); checkbox.type="checkbox"; checkbox.setAttribute("aria-label","PCF checkbox"); checkbox.style.width="20px"; checkbox.style.height="20px"; container.append(checkbox);',
      ),
  );
  const formFile = path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8'))
    .replace('<control datafieldname="x_name"/>', '<control id="x_name" uniqueid="pcf-name" datafieldname="x_name"/>')
    .replace(
      '</form>',
      '<controlDescriptions><controlDescription forControl="pcf-name"><customControl name="publisher.InventedInput" formFactor="0"><parameters><value type="SingleLine.Text">x_name</value></parameters></customControl></controlDescription></controlDescriptions></form>',
    );
  await fs.writeFile(formFile, xml);
  const sim = await source.start({ modelDriven: { trustedExtensions: true } });
  t.after(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  await page.getByLabel('PCF value').waitFor();
  assert.equal(await page.getByLabel('PCF value').inputValue(), 'Copper');
  assert.deepEqual(
    await page.getByLabel('PCF checkbox').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.width, rect.height];
    }),
    [20, 20],
    'shell field styles must not override a component checkbox',
  );
  await page.getByLabel('PCF checkbox').focus();
  assert.notEqual(
    await page.getByLabel('PCF checkbox').evaluate((element) => getComputedStyle(element).outlineColor),
    'rgb(0, 120, 212)',
    'the shell focus rule must not restyle component inputs',
  );
  const session = await (await page.request.get(origin + '/_sim/api/dataverse/session')).json();
  assert.deepEqual(
    await page.evaluate(() => ({
      id: window.pcfContext.userSettings.userId,
      name: window.pcfContext.userSettings.userName,
    })),
    { id: session.current.principalId, name: session.current.name },
  );
  await page.getByLabel('PCF value').fill('PCF updated');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  try {
    await page.waitForFunction(
      () => document.querySelector('h1')?.textContent === 'PCF updated' || !document.querySelector('#notice')?.hidden,
      null,
      { timeout: 5000 },
    );
  } catch (error) {
    assert.fail(
      `${error.message}\n${await page.locator('body').innerText()}\n${JSON.stringify(errors)}\n${JSON.stringify(await page.locator('input').evaluateAll((inputs) => inputs.map((input) => ({ name: input.name, value: input.value, valid: input.validity.valid, message: input.validationMessage }))))}`,
    );
  }
  const saved = await page.request.get(`${origin}/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  assert.equal((await saved.json()).row.x_name, 'PCF updated');
  await page.reload();
  await page.getByLabel('PCF value').waitFor();
  assert.equal(await page.getByLabel('PCF value').inputValue(), 'PCF updated');
  const created = await page.request.post(origin + '/_sim/api/dataverse/users', {
    headers: { 'x-sim-csrf': sim.state().csrf },
    data: {
      fullname: 'Invented component staff',
      domainname: 'component-staff@example.test',
      roles: ['System Administrator'],
    },
  });
  assert.equal(created.status(), 201);
  const staff = await created.json();
  await page.getByRole('button', { name: 'Staff profile', exact: true }).click();
  await page.getByLabel('Organization staff', { exact: true }).selectOption(staff.systemuserid);
  await page.getByRole('button', { name: 'Use identity', exact: true }).click();
  await page.waitForFunction((id) => window.pcfContext?.userSettings.userId === id, staff.systemuserid);
  assert.deepEqual(
    await page.evaluate(() => ({
      id: window.pcfContext.userSettings.userId,
      name: window.pcfContext.userSettings.userName,
    })),
    { id: staff.systemuserid, name: 'Invented component staff' },
  );
  assert.deepEqual(errors, []);
});

test('a virtual PCF mounts through project-supplied React platform libraries and is refused without them', async (t) => {
  const { page, errors } = await fixture(t);
  const virtual = {
    name: 'publisher.InventedVirtual',
    constructor: 'Invented.Virtual',
    controlType: 'virtual',
    libraries: [{ name: 'React', version: '16.14.0' }],
    properties: [{ name: 'value', ofType: 'SingleLine.Text', usage: 'bound' }],
    resources: { code: ['/virtual.js'] },
  };
  const platformLibraries = [
    { name: 'React', version: '16.14.0', url: '/react.js' },
    { name: 'ReactDOM', version: '16.14.0', url: '/reactdom.js' },
  ];
  await page.evaluate(
    (virtual) =>
      window.mount({
        pcf: { name: virtual.name, bindings: { value: { field: 'x_name' } } },
        clientExtensions: { trusted: true, pcf: { controls: [virtual] } },
      }),
    virtual,
  );
  assert.match(
    await page.locator('main').innerText(),
    /requires platform libraries \(React 16\.14\.0\)\. Supply React@16\.14\.0\.js, ReactDOM@16\.14\.0\.js/,
  );
  await page.evaluate(
    ([virtual, platformLibraries]) => {
      document.querySelector('main').replaceChildren();
      return window.mount({
        pcf: { name: virtual.name, bindings: { value: { field: 'x_name' } } },
        clientExtensions: { trusted: true, pcf: { controls: [virtual], platformLibraries } },
      });
    },
    [virtual, platformLibraries],
  );
  assert.equal(await page.locator('.model-driven-pcf').textContent(), 'virtual:Initial');
  assert.equal(await page.evaluate(() => window.virtualInit), 3, 'a virtual component gets no container');
  assert.deepEqual(
    await page.evaluate(() => [window.virtualSettings.languageId, window.virtualSettings.securityRoles]),
    [1033, []],
  );
  await page.evaluate(() => window.control.setValue('Changed'));
  await page.waitForFunction(() => document.querySelector('.model-driven-pcf').textContent === 'virtual:Changed');
  await page.evaluate(() => window.control.destroy());
  assert.equal(await page.evaluate(() => window.unmounts), 1);
  assert.deepEqual(errors, []);
});
