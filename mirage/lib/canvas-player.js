(() => {
  const body = document.body,
    app = body.dataset.app,
    token = body.dataset.csrf;
  const api = `/_apps/api/canvas/${encodeURIComponent(app)}`;
  const stage = document.querySelector('[data-testid="canvas-stage"]');
  const status = document.querySelector('[data-testid="canvas-status"]');
  const inspector = document.querySelector('[data-testid="canvas-inspector"]');
  const start = document.querySelector('[data-testid="canvas-start"]');
  const resolution = document.querySelector('[data-testid="canvas-resolution"]');
  let source,
    snapshot,
    pending = Promise.resolve();
  start.disabled = true;
  resolution.disabled = true;
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    return el;
  };
  const valueText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  async function request(url, options) {
    const response = await fetch(url, options),
      data = await response.json();
    if (!response.ok && !data.snapshot)
      throw new Error(
        data.error?.message || data.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`,
      );
    return data;
  }
  function act(action) {
    pending = pending.then(() => execute(action));
    return pending;
  }
  async function execute(action) {
    try {
      const result = await request(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': token },
        body: JSON.stringify(action),
      });
      snapshot = result.snapshot;
      render();
      if (result.errors?.length)
        status.textContent = result.errors.map((error) => error.message || error.kind).join('; ');
    } catch (error) {
      if (source && snapshot) render();
      status.textContent = error.message;
    }
  }
  function display(v) {
    if (v && typeof v === 'object') return valueText(v.Value ?? v.value ?? v.Name ?? v.name ?? Object.values(v)[0]);
    return valueText(v);
  }
  function makeControl(control, scope) {
    const p = control.properties || {};
    if (p.Visible === false) return null;
    const gap = source.rendering?.gaps?.find((item) => item.name === control.name);
    const kind = gap ? null : control.kind,
      disabled = /disabled|view/i.test(valueText(p.DisplayMode));
    let el;
    if (kind === 'label') el = node('div', p.Text);
    else if (kind === 'button') {
      el = node('button', p.Text || control.name);
      el.type = 'button';
      el.disabled = disabled;
      el.addEventListener('click', () => act({ action: 'select', control: control.name, ...scope }));
    } else if (kind === 'textinput' || kind === 'datepicker') {
      el = node('input');
      el.type = kind === 'datepicker' ? 'date' : 'text';
      el.value = valueText(p.Text ?? p.SelectedDate ?? p.Default);
      if (kind === 'datepicker') el.value = valueText(p.SelectedDate).slice(0, 10);
      el.disabled = disabled;
      el.addEventListener('change', () => act({ action: 'input', control: control.name, value: el.value, ...scope }));
    } else if (kind === 'checkbox' || kind === 'toggle') {
      el = node('input');
      el.type = 'checkbox';
      el.checked = p.Value === true;
      el.disabled = disabled;
      el.addEventListener('change', () => act({ action: 'input', control: control.name, value: el.checked, ...scope }));
    } else if (kind === 'dropdown' || kind === 'combobox') {
      el = node('select');
      el.disabled = disabled;
      const items = Array.isArray(p.Items) ? p.Items : [];
      items.forEach((item, i) => {
        const option = node('option', display(item));
        option.value = String(i);
        el.append(option);
      });
      const selected = items.findIndex((item) => JSON.stringify(item) === JSON.stringify(p.Selected));
      if (selected >= 0) el.value = String(selected);
      el.addEventListener('change', () =>
        act({ action: 'input', control: control.name, value: Number(el.value), ...scope }),
      );
    } else if (kind === 'gallery') {
      el = node('div');
      el.classList.add('canvas-gallery');
      for (const row of control.items || []) {
        const rowEl = node('div');
        rowEl.className = 'canvas-row';
        rowEl.dataset.itemIndex = String(row.index);
        rowEl.style.height = `${num(p.TemplateSize, 80)}px`;
        rowEl.addEventListener('click', (event) => {
          if (event.target === rowEl) act({ action: 'select', control: control.name, item: row.index });
        });
        const models = (source.tree?.screens || source.screens || []).flatMap((s) => s.controls || []);
        const rowElements = new Map();
        for (const [name, props] of Object.entries(row.controls || {})) {
          const model = models.find((c) => c.name === name) || {};
          const type = (model.control || '')
            .replace(/^classic\//i, '')
            .split('@')[0]
            .toLowerCase();
          const aliases = {
            text: source.app?.format === 'fx.yaml' ? 'textinput' : 'label',
            toggleswitch: 'toggle',
            groupcontainer: 'container',
            typeddatacard: 'card',
            datacard: 'card',
          };
          const child = makeControl(
            { name, kind: aliases[type] || type, supported: true, properties: props },
            { item: row.index },
          );
          if (child) rowElements.set(name, child);
        }
        for (const [name, child] of rowElements) {
          const model = models.find((c) => c.name === name);
          const parent = model?.parent === control.name ? rowEl : rowElements.get(model?.parent);
          if (parent) parent.append(child);
        }
        el.append(rowEl);
      }
    } else if (['container', 'form', 'formviewer', 'card'].includes(kind)) {
      el = node('div');
      el.classList.add('canvas-container');
    } else {
      el = node('div', `${control.name}: ${gap?.reason || `${control.type || kind || 'unsupported'} is not rendered`}`);
      el.classList.add('unsupported');
    }
    el.dataset.control = control.name;
    el.classList.add('canvas-control');
    el.setAttribute('aria-label', control.name);
    el.style.left = `${num(p.X, 0)}px`;
    el.style.top = `${num(p.Y, 0)}px`;
    el.style.width = `${num(p.Width, 160)}px`;
    el.style.height = `${num(p.Height, 40)}px`;
    if (p.Color) el.style.color = valueText(p.Color);
    if (p.Fill) el.style.backgroundColor = valueText(p.Fill);
    if (p.Size) el.style.fontSize = `${num(p.Size, 14)}px`;
    return el;
  }
  function section(title, data) {
    const details = node('details');
    const summary = node('summary', title);
    const pre = node('pre', JSON.stringify(data, null, 2));
    details.append(summary, pre);
    return details;
  }
  function render() {
    stage.replaceChildren();
    inspector.replaceChildren(node('h2', 'Inspector'));
    if (!snapshot || snapshot.started === false) {
      status.textContent = 'The app has not been started. Start runs its OnStart formula.';
      return;
    }
    status.textContent = `Current screen: ${snapshot.currentScreen || 'none'}`;
    const screen = snapshot.screens.find((s) => s.current);
    const width = num(screen?.properties?.Width, snapshot.viewport?.width || Number(resolution.value.split('x')[0])),
      height = num(screen?.properties?.Height, snapshot.viewport?.height || Number(resolution.value.split('x')[1]));
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.backgroundColor = valueText(screen?.properties?.Fill);
    const elements = new Map();
    for (const control of screen?.controls || []) {
      const el = makeControl(control, {});
      if (el) elements.set(control.name, el);
    }
    for (const control of screen?.controls || []) {
      const el = elements.get(control.name);
      if (!el) continue;
      const parent = elements.get(control.parent);
      if (control.parent && !parent) continue;
      (parent || stage).append(el);
    }
    for (const control of screen?.controls || []) {
      if (control.kind !== 'container') continue;
      const el = elements.get(control.name),
        p = control.properties || {};
      if (!el || !p.LayoutDirection) continue;
      el.style.display = 'flex';
      el.style.flexDirection = /horizontal/i.test(valueText(p.LayoutDirection)) ? 'row' : 'column';
      el.style.gap = `${num(p.LayoutGap, 0)}px`;
      const align = (v) =>
        ({
          start: 'flex-start',
          end: 'flex-end',
          center: 'center',
          spacebetween: 'space-between',
          spacearound: 'space-around',
          stretch: 'stretch',
        })[valueText(v).split('.').pop().toLowerCase()] || '';
      el.style.justifyContent = align(p.LayoutJustifyContent);
      el.style.alignItems = align(p.LayoutAlignItems);
      el.style.padding = `${num(p.PaddingTop, 0)}px ${num(p.PaddingRight, 0)}px ${num(p.PaddingBottom, 0)}px ${num(p.PaddingLeft, 0)}px`;
      for (const child of el.children) {
        child.style.position = 'relative';
        child.style.left = 'auto';
        child.style.top = 'auto';
        const childControl = (screen.controls || []).find((item) => item.name === child.dataset.control);
        const portions = num(childControl?.properties?.FillPortions, 0);
        if (portions > 0) child.style.flex = `${portions} 1 0`;
      }
    }
    inspector.append(
      node(
        'p',
        'Browser developer tools are available. Power Fx stepping is not supported. Images, media, components, modern controls and unsupported controls are not rendered. Layout and styling are approximations; automatic layout inside gallery rows is not supported.',
      ),
    );
    for (const gap of source.rendering?.gaps || snapshot.unsupported || [])
      inspector.append(node('p', `${gap.screen}.${gap.name}: ${gap.control} is not rendered`));
    for (const error of snapshot.errors || [])
      inspector.append(
        node(
          'p',
          `${error.code || error.kind || 'Error'}: ${error.message || ''} ${error.file || error.source || ''}${error.line ? ':' + error.line : ''}`,
        ),
      );
    for (const diagnostic of snapshot.diagnostics || [])
      inspector.append(
        node(
          'p',
          `${diagnostic.code || 'Diagnostic'}: ${diagnostic.message || ''} ${diagnostic.source || ''}${diagnostic.line ? ':' + diagnostic.line : ''}`,
        ),
      );
    for (const name of [
      'variables',
      'context',
      'collections',
      'dataSources',
      'forms',
      'notifications',
      'errors',
      'diagnostics',
      'unsupported',
      'log',
    ])
      inspector.append(section(name, snapshot[name]));
    inspector.append(section('Source formulas (file and line)', source.formulas || []));
  }
  start.addEventListener('click', async () => {
    const [width, height] = resolution.value.split('x').map(Number);
    await act({ action: 'start', viewport: { width, height } });
    const [desiredWidth, desiredHeight] = resolution.value.split('x').map(Number);
    if (
      snapshot &&
      snapshot.started !== false &&
      (snapshot.viewport?.width !== desiredWidth || snapshot.viewport?.height !== desiredHeight)
    )
      await act({ action: 'resize', width: desiredWidth, height: desiredHeight });
  });
  resolution.addEventListener('change', () => {
    const [width, height] = resolution.value.split('x').map(Number);
    if (snapshot && snapshot.started !== false) act({ action: 'resize', width, height });
    else {
      stage.style.width = `${width}px`;
      stage.style.height = `${height}px`;
    }
  });
  Promise.all([request(`/_apps/canvas/api/${encodeURIComponent(app)}`), request(api)])
    .then(([inventory, state]) => {
      source = inventory;
      snapshot = state;
      if (state.viewport) {
        const { width, height } = state.viewport;
        const selected = `${width}x${height}`;
        if (![...resolution.options].some((option) => option.value === selected)) {
          const option = node('option', `${width} × ${height}`);
          option.value = selected;
          resolution.append(option);
        }
        resolution.value = selected;
      }
      start.disabled = false;
      resolution.disabled = false;
      render();
    })
    .catch((error) => {
      status.textContent = error.message;
    });
})();
