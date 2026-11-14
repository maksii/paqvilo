/* global createGestureTrace -- served in front of this script by canvas-player.mjs (lib/trace-gesture.js) */
(() => {
  const body = document.body,
    app = body.dataset.app,
    token = body.dataset.csrf;
  const api = `/_apps/api/canvas/${encodeURIComponent(app)}`;
  const stage = document.querySelector('[data-testid="canvas-stage"]');
  const surface = document.querySelector('.canvas-surface');
  const status = document.querySelector('[data-testid="canvas-status"]');
  const inspector = document.querySelector('[data-testid="canvas-inspector"]');
  const start = document.querySelector('[data-testid="canvas-start"]');
  const restart = document.querySelector('[data-testid="canvas-restart"]');
  const resolution = document.querySelector('[data-testid="canvas-resolution"]');
  const notice = document.querySelector('[data-testid="canvas-notifications"]');
  let source,
    snapshot,
    pending = Promise.resolve(),
    timerClock = null,
    lastTick = null,
    preservedMedia = new Map(),
    usedMedia = new Set(),
    pendingMediaMoves = [],
    clockWanted = false,
    clockKey = null,
    clockOwned = false,
    clockAcquiring = false,
    releaseClock = null,
    lastScreen = null,
    canvasDisplayGeometry = null;
  start.disabled = true;
  resolution.disabled = true;
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = String(text);
    return el;
  };
  const valueText = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const accessibleLabel = (p) => valueText(p.AccessibleLabel).trim();
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const viewport = () =>
    resolution.value === 'browser'
      ? [Math.max(1, Math.min(8192, window.innerWidth)), Math.max(1, Math.min(8192, window.innerHeight))]
      : resolution.value.split('x').map(Number);
  const logicalViewport = () => {
    const [width, height] = viewport();
    const geometry = canvasDisplayGeometry?.(source?.app?.display, width, height);
    return geometry ? [geometry.logicalWidth, geometry.logicalHeight] : [width, height];
  };
  const MAX_SELECTED_IMAGE = 1024 * 1024;
  function rasterMime(bytes) {
    const b = [...bytes];
    if (b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => b[index] === value))
      return 'image/png';
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCodePoint(...b.slice(0, 6)))) return 'image/gif';
    if (
      b.length >= 12 &&
      String.fromCodePoint(...b.slice(0, 4)) === 'RIFF' &&
      String.fromCodePoint(...b.slice(8, 12)) === 'WEBP'
    )
      return 'image/webp';
    return null;
  }
  function safeImageData(value) {
    if (typeof value !== 'string') return false;
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(value);
    if (!match) return false;
    if (match[2].length > Math.ceil(MAX_SELECTED_IMAGE / 3) * 4) return false;
    if (match[2].length % 4 !== 0) return false;
    let padding = 0;
    if (match[2].endsWith('==')) padding = 2;
    else if (match[2].endsWith('=')) padding = 1;
    if ((match[2].length / 4) * 3 - padding > MAX_SELECTED_IMAGE) return false;
    try {
      const head = atob(match[2].slice(0, 16));
      return rasterMime(Uint8Array.from(head, (char) => char.codePointAt(0))) === match[1].toLowerCase();
    } catch {
      return false;
    }
  }
  // Every call joins the page's trace (canvas-player.mjs data-trace-id / data-trace-parent, docs/design/tracing.md),
  // except the source watch's revision polls (untraced), which would fill the page trace once a second.
  const gestureTrace = createGestureTrace();
  async function request(url, { untraced = false, ...options } = {}) {
    const page = { traceId: body.dataset.traceId, spanId: body.dataset.traceParent };
    const headers = untraced ? options.headers : { ...gestureTrace.headersFor(page), ...options.headers };
    const response = await fetch(url, { ...options, headers });
    gestureTrace.noteAnswer(response);
    const data = await response.json();
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
        body: JSON.stringify({ ...action, sourceRevision: source?.revision }),
      });
      snapshot = result.snapshot;
      announceNotices(action.action === 'start' || action.action === 'reset');
      render();
      if (result.errors?.length)
        status.textContent = result.errors.map((error) => error.message || error.kind).join('; ');
    } catch (error) {
      if (source && snapshot) render();
      status.textContent = error.message;
    }
  }
  function display(v) {
    if (v && typeof v === 'object')
      return valueText(v.Label ?? v.Value ?? v.value ?? v.Name ?? v.name ?? Object.values(v)[0]);
    return valueText(v);
  }
  function isSafeStyle(name, value) {
    return (
      (['color', 'background-color'].includes(name) &&
        /^(?:#[0-9a-f]{3,8}|[a-z]{1,20}|rgba?\([0-9.,%\s]+\))$/i.test(value)) ||
      (name === 'font-weight' && /^(?:normal|bold|[1-9]00)$/i.test(value)) ||
      (name === 'font-style' && /^(?:normal|italic)$/i.test(value)) ||
      (name === 'text-align' && /^(?:left|right|center|justify)$/i.test(value)) ||
      (name === 'text-decoration' && /^(?:none|underline|line-through)$/i.test(value)) ||
      (name === 'font-size' && /^(?:[1-9]\d?|100)(?:px|%)$/i.test(value))
    );
  }
  function safeStyles(token, styles) {
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(token);
    const safe = {};
    for (const declaration of (style?.[1] ?? style?.[2] ?? '').split(';')) {
      const [rawName, rawValue] = declaration.split(':');
      const name = rawName?.trim().toLowerCase(),
        value = rawValue?.trim();
      if (!value || /url|expression|@|[\\]/i.test(value)) continue;
      if (isSafeStyle(name, value)) safe[name] = value;
    }
    return styles.push(safe) - 1;
  }
  function skipBlockedHtmlTag(state, tag, closing) {
    if (!state.blockedTag) return false;
    if (closing && tag === state.blockedTag) state.blockedTag = null;
    return true;
  }
  function processSafeAllowedHtmlTag(token, state, tag, closing) {
    if (tag === 'img' && !closing) {
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token);
      const url = src && (src[1] ?? src[2] ?? src[3]);
      if (Object.values(state.source.assets || {}).includes(url)) {
        const index = state.images.push(url) - 1;
        state.normalized += `<span data-paq-image="${index}"></span>`;
      }
    } else if (state.allowed.has(tag)) {
      if (closing) state.normalized += `</${tag}>`;
      else {
        const index = safeStyles(token, state.styles);
        state.normalized += `<${tag} data-paq-style="${index}">`;
      }
    }
  }
  function processSafeHtmlTag(token, state) {
    const match = /^<\s*(?:(\/)\s*)?([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(token);
    if (!match) {
      if (!state.blockedTag) state.normalized += '&lt;';
      return true;
    }
    const closing = Boolean(match[1]),
      tag = match[2].toLowerCase();
    if (skipBlockedHtmlTag(state, tag, closing)) return true;
    if (state.blocked.has(tag)) {
      if (!closing) state.blockedTag = tag;
      return true;
    }
    processSafeAllowedHtmlTag(token, state, tag, closing);
    return false;
  }
  function* safeHtmlTokens(text) {
    let cursor = 0;
    const lastCommentEnd = text.lastIndexOf('-->');
    const lastTagEnd = text.lastIndexOf('>');
    while (cursor < text.length) {
      if (text[cursor] !== '<') {
        const next = text.indexOf('<', cursor);
        const end = next < 0 ? text.length : next;
        yield text.slice(cursor, end);
        cursor = end;
        continue;
      }
      if (text.startsWith('<!--', cursor) && cursor + 4 <= lastCommentEnd) {
        const end = text.indexOf('-->', cursor + 4) + 3;
        yield text.slice(cursor, end);
        cursor = end;
      } else if (cursor < lastTagEnd) {
        const end = text.indexOf('>', cursor + 1) + 1;
        yield text.slice(cursor, end);
        cursor = end;
      } else {
        yield '<';
        cursor++;
      }
    }
  }
  // Generate safe tags and numeric placeholders before DOMParser sees source, so parsing cannot fetch URLs.
  /* NOSONAR: single-pass routine, splitting it would change shared state */ function safeHtml(target, sourceText) {
    const state = {
      allowed: new Set([
        'p',
        'div',
        'span',
        'strong',
        'b',
        'em',
        'i',
        'u',
        'br',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ]),
      blocked: new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'video', 'audio']),
      source,
      blockedTag: null,
      normalized: '',
      images: [],
      styles: [],
    };
    /* NOSONAR */ for (const token of [...safeHtmlTokens(valueText(sourceText))]) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('<')) {
        if (processSafeHtmlTag(token, state)) continue;
      } else if (!state.blockedTag) state.normalized += token.replaceAll('>', '&gt;');
      if (state.normalized.length > 262144) break;
    }
    const parsed = new DOMParser().parseFromString(state.normalized, 'text/html');
    for (const element of parsed.body.querySelectorAll('[data-paq-style]')) {
      const style = state.styles[Number(element.getAttribute('data-paq-style'))] ?? {}; // NOSONAR: actual attributes exclude inherited dataset values
      for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value);
      delete element.dataset.paqStyle;
    }
    for (const placeholder of parsed.body.querySelectorAll('[data-paq-image]')) {
      const url = state.images[Number(placeholder.getAttribute('data-paq-image'))]; // NOSONAR: actual attributes exclude inherited dataset values
      if (!url) {
        placeholder.remove();
        continue;
      }
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      placeholder.replaceWith(image);
    }
    for (const child of parsed.body.childNodes) target.append(document.importNode(child, true));
  }
  const choices = (control, properties) =>
    control.options ??
    (Array.isArray(properties.Items)
      ? properties.Items.map((value, index) => ({ value, index, label: display(value) }))
      : []);
  function galleryRowElements(control, row, models) {
    const rowElements = new Map();
    for (const [name, props] of Object.entries(row.controls || {})) {
      const model = row.controlInfo?.[name] ?? models.find((c) => c.name === name) ?? {};
      const type = (model.control || model.type || '')
        .replace(/^(?:classic|modern)\//i, '')
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
        { ...model, name, kind: model.kind || aliases[type] || type, supported: true, properties: props },
        { item: row.index },
      );
      if (child) rowElements.set(name, child);
    }
    return rowElements;
  }
  function attachGalleryRow(control, row, rowEl, rowElements, models) {
    for (const [name, child] of rowElements) {
      const model = row.controlInfo?.[name] ?? models.find((c) => c.name === name);
      const parent = model?.parent === control.name ? rowEl : rowElements.get(model?.parent);
      if (parent) attach(parent, child);
    }
  }
  function layoutGalleryRow(row, rowElements, models) {
    for (const [name, child] of rowElements) {
      const props = row.controls[name];
      if (props)
        applyLayout(
          child,
          props,
          Object.entries(row.controls).map(([name, properties]) => ({ name, properties })),
          row.controlInfo?.[name] ?? models.find((model) => model.name === name),
        );
    }
  }
  function makeGalleryControl(control, p) {
    const el = node('div');
    el.classList.add('canvas-gallery');
    if (control.offset > 0) {
      const previous = node('button', 'Previous');
      previous.type = 'button';
      previous.addEventListener('click', () =>
        act({ action: 'gallery-window', control: control.name, offset: Math.max(0, control.offset - 50) }),
      );
      el.append(previous);
    }
    for (const row of control.items || []) {
      const rowEl = node('div');
      rowEl.className = 'canvas-row';
      rowEl.dataset.itemIndex = String(row.index);
      if (row.templateProperties?.TemplateFill)
        rowEl.style.backgroundColor = valueText(row.templateProperties.TemplateFill);
      rowEl.style.height = `${num(p.TemplateSize, 80)}px`;
      // Capture phase: the row selection is queued before a child's own OnSelect, which then reads the selected row.
      rowEl.addEventListener(
        'click',
        () => void act({ action: 'select', control: control.name, item: row.index }),
        true,
      );
      const models = (source.tree?.screens || source.screens || []).flatMap((s) => s.controls || []);
      const rowElements = galleryRowElements(control, row, models);
      attachGalleryRow(control, row, rowEl, rowElements, models);
      layoutGalleryRow(row, rowElements, models);
      el.append(rowEl);
    }
    if (control.hasMore) {
      const next = node('button', 'Next');
      next.type = 'button';
      next.addEventListener('click', () =>
        act({ action: 'gallery-window', control: control.name, offset: control.offset + 50 }),
      );
      el.append(next);
    }
    return el;
  }
  async function addMediaChange(input, control, scope) {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size < 1 || file.size > MAX_SELECTED_IMAGE || file.name.length > 255) {
      input.value = '';
      status.textContent = 'Choose an image no larger than 1 MiB.';
      return;
    }
    try {
      const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const mime = rasterMime(signature);
      if (!mime || file.type.toLowerCase() !== mime) {
        input.value = '';
        status.textContent = 'Choose a PNG, JPEG, GIF or WebP image with matching file content.';
        return;
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      if (!safeImageData(data)) throw new Error('The selected image is invalid.');
      await act({
        action: 'add-media',
        control: control.name,
        name: file.name,
        mime,
        data: data.slice(data.indexOf(',') + 1),
        ...scope,
      });
    } catch (error) {
      input.value = '';
      status.textContent = error.message;
    }
  }
  function makeImageControl(control, scope, p, disabled, url) {
    const el = node('img');
    el.src = url;
    el.alt = accessibleLabel(p);
    if (
      !disabled &&
      (control.behaviours?.includes('OnSelect') ||
        source.formulas?.some((row) => row.owner.endsWith(`.${control.name}`) && row.property === 'OnSelect'))
    ) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.addEventListener('click', () => act({ action: 'select', control: control.name, ...scope }));
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          el.click();
        }
      });
    }
    return el;
  }
  function bindMediaEvents(el, control, scope, p) {
    for (const [nativeEvent, event] of [
      ['play', 'play'],
      ['pause', 'pause'],
      ['ended', 'end'],
      ['seeked', 'seek'],
    ])
      el.addEventListener(nativeEvent, async () => {
        if (!el.isConnected) return;
        await act({
          action: 'media',
          control: control.name,
          event,
          ...(event === 'seek' ? { time: el.currentTime } : {}),
          ...scope,
        });
        if (event === 'end' && p.Loop === true && el.isConnected)
          el.play().catch(() => {
            status.textContent = `${control.name}: browser blocked playback; use the media controls.`;
          });
      });
  }
  function makeAudioVideoControl(control, scope, p, kind, disabled, url) {
    const mediaKey = `${control.name}:${scope.item ?? ''}`;
    const existing = preservedMedia.get(mediaKey);
    const el =
      existing && existing.tagName.toLowerCase() === kind && existing.getAttribute('src') === url
        ? existing
        : node(kind);
    if (el === existing) usedMedia.add(mediaKey);
    else {
      el.src = url;
      if (p.AutoStart === true && !disabled)
        requestAnimationFrame(() => {
          if (el.isConnected)
            el.play().catch(() => {
              status.textContent = `${control.name}: browser blocked automatic playback; use the media controls.`;
            });
        });
    }
    el.dataset.mediaKey = mediaKey;
    el.controls = !disabled;
    if (el !== existing) bindMediaEvents(el, control, scope, p);
    return el;
  }
  function makeMediaControl(control, scope, p, kind, disabled) {
    const media = kind === 'image' ? p.Image : p.Media;
    const url =
      Object.values(source.assets || {}).find((asset) => asset === media) ??
      (kind === 'image' && safeImageData(media) ? media : null);
    if (!url) {
      const el = node('div', `${control.name}: media is unavailable or outside the local app assets`);
      el.classList.add('unsupported');
      return el;
    }
    if (kind === 'image') return makeImageControl(control, scope, p, disabled, url);
    return makeAudioVideoControl(control, scope, p, kind, disabled, url);
  }
  function makeLabelControl(control, scope, p, kind, disabled) {
    const icons = {
      Add: '+',
      Cancel: '×',
      Check: '✓',
      Edit: '✎',
      Home: '⌂',
      Refresh: '↻',
      Search: '⌕',
      Settings: '⚙',
      ChevronLeft: '‹',
      ChevronRight: '›',
      ChevronUp: '⌃',
      ChevronDown: '⌄',
    };
    const icon = valueText(p.Icon).split('.').pop();
    const el = node('div', kind === 'icon' ? icons[icon] || icon : p.Text);
    const selectable =
      control.behaviours?.includes('OnSelect') ||
      source.formulas?.some((row) => row.owner.endsWith(`.${control.name}`) && row.property === 'OnSelect');
    if (selectable && !disabled) {
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.addEventListener('click', () => act({ action: 'select', control: control.name, ...scope }));
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          el.click();
        }
      });
    }
    return el;
  }
  function makeRadioControl(control, scope, p, disabled) {
    const el = node('div');
    el.setAttribute('role', 'radiogroup');
    const items = choices(control, p);
    items.forEach(({ value: item, index, label: text }) => {
      const label = node('label'),
        radio = node('input');
      radio.type = 'radio';
      radio.name = `${control.name}-${scope.item ?? 'root'}`;
      radio.disabled = disabled;
      radio.checked = JSON.stringify(item) === JSON.stringify(p.Selected);
      radio.addEventListener('change', () => {
        if (radio.checked) void act({ action: 'input', control: control.name, value: index, ...scope });
      });
      label.append(radio, document.createTextNode(valueText(text)));
      el.append(label);
    });
    return el;
  }
  function makeSelectControl(control, scope, p, kind, disabled) {
    const items = choices(control, p);
    const select = node('select');
    select.disabled = disabled;
    let selectedItems;
    if (kind === 'combobox') selectedItems = Array.isArray(p.SelectedItems) ? p.SelectedItems : [];
    else selectedItems = [p.Selected];
    select.multiple = kind === 'combobox' && p.SelectMultiple !== false;
    items.forEach(({ value: item, index, label }) => {
      const option = node('option', label);
      option.value = String(index);
      option.selected = selectedItems.some((selected) => JSON.stringify(item) === JSON.stringify(selected));
      select.append(option);
    });
    select.addEventListener('change', () =>
      act({
        action: 'input',
        control: control.name,
        value:
          kind === 'combobox' ? [...select.selectedOptions].map((item) => Number(item.value)) : Number(select.value),
        ...scope,
      }),
    );
    if (kind !== 'combobox') return select;
    const el = node('div');
    el.classList.add('canvas-combobox');
    if (p.IsSearchable !== false) {
      const search = node('input');
      search.type = 'search';
      search.value = valueText(p.SearchText);
      search.disabled = disabled;
      search.setAttribute('aria-label', accessibleLabel(p) || 'Search');
      const filter = () => {
        for (const option of select.options)
          option.hidden = !option.textContent.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
      };
      search.addEventListener('input', () => {
        filter();
        void act({ action: 'search', control: control.name, value: search.value, ...scope });
      });
      filter();
      el.append(search);
    }
    el.append(select);
    return el;
  }
  function makeCodeComponentControl(control, scope, p, kind, gap) {
    if (!globalThis.paqviloCanvasPcf) {
      const el = node(
        'div',
        `${control.name}: ${gap?.reason || (control.type || kind || 'unsupported') + ' is not rendered'}`,
      );
      el.classList.add('unsupported');
      return el;
    }
    const descriptor = control.codeComponent ?? source.codeComponents?.[control.name];
    if (descriptor?.admitted)
      return globalThis.paqviloCanvasPcf.mount(`${control.name}:${scope.item ?? ''}`, descriptor, p, (values, event) =>
        act(
          event
            ? { action: 'codecomponent-event', control: control.name, event, ...scope }
            : { action: 'codecomponent', control: control.name, values, ...scope },
        ),
      );
    const el = node('div', `${control.name}: code component is not admitted`);
    el.classList.add('unsupported');
    return el;
  }
  function makeTextInputControl(control, scope, p, kind, displayMode) {
    const mode = valueText(p.Type ?? p.Mode).toLowerCase();
    const el = node(kind === 'textinput' && mode.includes('multiline') ? 'textarea' : 'input');
    if (el.tagName === 'INPUT')
      if (kind === 'datepicker') el.type = 'date';
      else if (mode.includes('password')) el.type = 'password';
      else el.type = 'text';
    const hint = p.Placeholder ?? p.HintText;
    if (kind === 'textinput' && hint != null) el.placeholder = valueText(hint);
    if (kind === 'textinput' && Number.isInteger(p.MaxLength) && p.MaxLength >= 0) el.maxLength = p.MaxLength;
    el.value = valueText(p.Text ?? p.SelectedDate ?? p.Default);
    if (kind === 'datepicker') el.value = valueText(p.SelectedDate).slice(0, 10);
    el.disabled = /disabled/i.test(displayMode);
    el.readOnly = /view/i.test(displayMode);
    if (kind === 'textinput') bindTextInputOutput(el, control, scope, p);
    else
      el.addEventListener('change', () => act({ action: 'input', control: control.name, value: el.value, ...scope }));
    return el;
  }
  // The text input's TriggerOutput formula decides when typing reaches the app: on each keystroke (the default), after
  // half a second (Delayed, or DelayOutput true) or never before the commit (FocusOut). A commit runs OnChange.
  function textInputTrigger(formula) {
    if (/FocusOut/.test(formula)) return 'focusout';
    return /Delayed/.test(formula) ? 'delayed' : 'keypress';
  }
  function bindTextInputOutput(el, control, scope, p) {
    const formula =
      source.formulas?.find((row) => row.owner.endsWith(`.${control.name}`) && row.property === 'TriggerOutput')
        ?.text ?? '';
    const trigger = textInputTrigger(formula);
    const delay = p.DelayOutput === true || trigger === 'delayed' ? 500 : 0;
    let timer = null;
    // The text the app holds for this element: the value it was built with, then each value sent (dataset.sent, read by
    // prepareRenderStage). Typed text that equals it is already in the app, so a re-render keeps the app's value.
    el.dataset.sent = el.value;
    const sendText = () => {
      timer = null;
      const value = el.value;
      el.dataset.sent = value;
      void act({ action: 'text', control: control.name, value, ...scope });
    };
    el.addEventListener('input', () => {
      el.dataset.dirty = 'true';
      if (trigger === 'focusout') return;
      clearTimeout(timer);
      timer = null;
      if (delay) timer = setTimeout(sendText, delay);
      else sendText();
    });
    // A commit runs OnChange once for the typing since the last commit. The dirty mark is kept on the element and carried
    // to a re-rendered input (prepareRenderStage), because the app already holds the typed value by then.
    const commit = () => {
      if (el.dataset.rerendering || el.dataset.dirty !== 'true') return;
      el.dataset.dirty = '';
      clearTimeout(timer);
      timer = null;
      el.dataset.sent = el.value;
      void act({ action: 'input', control: control.name, value: el.value, ...scope });
    };
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
  }
  function makeNumericControl(control, scope, p, kind, disabled) {
    const el = node('input');
    el.type = kind === 'slider' ? 'range' : 'number';
    el.value = valueText(p.Value ?? p.Default ?? 0);
    el.disabled = disabled;
    if (p.Min != null) el.min = String(p.Min);
    if (p.Max != null) el.max = String(p.Max);
    if (p.Step != null) el.step = String(p.Step);
    el.addEventListener('change', () =>
      act({ action: 'input', control: control.name, value: Number(el.value), ...scope }),
    );
    return el;
  }
  function styleControlBorders(el, p) {
    if (p.BorderRadius != null) el.style.borderRadius = `${Math.max(0, num(p.BorderRadius, 0))}px`;
    if (p.BorderColor) el.style.borderColor = valueText(p.BorderColor);
    if (p.BorderThickness != null) {
      el.style.borderStyle = 'solid';
      el.style.borderWidth = `${Math.max(0, num(p.BorderThickness, 0))}px`;
    }
    if (p.RadiusTopLeft != null) el.style.borderTopLeftRadius = `${Math.max(0, num(p.RadiusTopLeft, 0))}px`;
    if (p.RadiusTopRight != null) el.style.borderTopRightRadius = `${Math.max(0, num(p.RadiusTopRight, 0))}px`;
    if (p.RadiusBottomLeft != null) el.style.borderBottomLeftRadius = `${Math.max(0, num(p.RadiusBottomLeft, 0))}px`;
    if (p.RadiusBottomRight != null) el.style.borderBottomRightRadius = `${Math.max(0, num(p.RadiusBottomRight, 0))}px`;
  }
  function styleControlText(el, p) {
    if (p.Align) {
      const align = valueText(p.Align).split('.').pop().toLowerCase();
      if (['left', 'center', 'right', 'justify'].includes(align)) el.style.textAlign = align;
    }
    if ((p.FontWeight ?? p.Weight) && /bold/i.test(valueText(p.FontWeight ?? p.Weight))) el.style.fontWeight = 'bold';
    if ((p.Italic ?? p.FontItalic) === true) el.style.fontStyle = 'italic';
    if ((p.Underline ?? p.FontUnderline) === true) el.style.textDecoration = 'underline';
  }
  // AccessibleLabel names the control. Images take their name from alt, containers and galleries have none, and a check
  // box without a label is named by its text. A graphic without a name is hidden unless it can be selected (role button).
  const UNNAMED_KINDS = new Set(['image', 'container', 'form', 'formviewer', 'card', 'gallery', 'addmedia']);
  const HIDDEN_WITHOUT_NAME = new Set(['icon', 'rectangle', 'circle', 'image']);
  function styleControl(el, control, p, kind) {
    el.dataset.control = control.name;
    el.classList.add('canvas-control');
    const name =
      accessibleLabel(p) || (kind === 'checkbox' || kind === 'toggle' ? valueText(p.Text || p.Label).trim() : '');
    if (name && !UNNAMED_KINDS.has(kind)) el.setAttribute('aria-label', name);
    else el.removeAttribute('aria-label');
    if (!name && HIDDEN_WITHOUT_NAME.has(kind) && el.getAttribute('role') !== 'button')
      el.setAttribute('aria-hidden', 'true');
    el.style.left = `${num(p.X, 0)}px`;
    el.style.top = `${num(p.Y, 0)}px`;
    el.style.width = `${num(p.Width, 160)}px`;
    el.style.height = `${num(p.Height, 40)}px`;
    if (p.Color ?? p.FontColor) el.style.color = valueText(p.Color ?? p.FontColor);
    if (p.Fill) el.style.backgroundColor = valueText(p.Fill);
    if (p.Size ?? p.FontSize) el.style.fontSize = `${num(p.Size ?? p.FontSize, 14)}px`;
    styleControlBorders(el, p);
    styleControlText(el, p);
    return el;
  }
  function makeControl(control, scope) {
    const p = control.properties || {};
    if (p.Visible === false) return null;
    const gap = source.rendering?.gaps?.find((item) => item.name === control.name);
    const kind = gap && !gap.renderable ? null : control.kind,
      displayMode = valueText(p.DisplayMode),
      disabled = /disabled|view/i.test(displayMode);
    let el;
    switch (kind) {
      case 'label':
      case 'icon': {
        el = makeLabelControl(control, scope, p, kind, disabled);
        break;
      }
      case 'button': {
        el = node('button', p.Text || control.name);
        el.type = 'button';
        el.disabled = disabled;
        el.addEventListener('click', () => act({ action: 'select', control: control.name, ...scope }));
        break;
      }
      case 'textinput':
      case 'datepicker': {
        el = makeTextInputControl(control, scope, p, kind, displayMode);
        break;
      }
      case 'checkbox':
      case 'toggle': {
        el = node('input');
        el.type = 'checkbox';
        el.checked = (p.Value ?? p.Checked) === true;
        el.disabled = disabled;
        el.addEventListener('change', () =>
          act({ action: 'input', control: control.name, value: el.checked, ...scope }),
        );
        break;
      }
      case 'radio': {
        el = makeRadioControl(control, scope, p, disabled);
        break;
      }
      case 'dropdown':
      case 'combobox': {
        el = makeSelectControl(control, scope, p, kind, disabled);
        break;
      }
      case 'addmedia': {
        el = node('label');
        el.classList.add('canvas-addmedia');
        const text = node('span', p.FileName ? p.ChangePictureText || 'Change picture' : p.Text || 'Add picture');
        const input = node('input');
        input.type = 'file';
        input.accept = 'image/png,image/jpeg,image/gif,image/webp';
        input.disabled = disabled;
        if (accessibleLabel(p)) input.setAttribute('aria-label', accessibleLabel(p));
        input.addEventListener('change', addMediaChange.bind(null, input, control, scope));
        el.append(text, input);
        break;
      }
      case 'slider':
      case 'numberinput': {
        el = makeNumericControl(control, scope, p, kind, disabled);
        break;
      }
      case 'rectangle':
      case 'circle': {
        el = node('div');
        if (kind === 'circle') el.style.borderRadius = '50%';
        break;
      }
      case 'htmlviewer': {
        el = node('div');
        safeHtml(el, p.HtmlText);
        break;
      }
      case 'progress': {
        el = node('progress');
        el.max = num(p.Max, 100);
        el.value = num(p.Value, 0);
        break;
      }
      case 'spinner': {
        el = node('div', p.Label || p.Text || 'Loading');
        el.setAttribute('role', 'status');
        break;
      }
      case 'timer': {
        el = node('button', p.Text || `${num(p.Value, 0)} / ${num(p.Duration, 60000)}`);
        el.type = 'button';
        el.disabled = disabled;
        el.addEventListener('click', () => act({ action: 'select', control: control.name, ...scope }));
        break;
      }
      case 'codecomponent': {
        el = makeCodeComponentControl(control, scope, p, kind, gap);
        break;
      }
      case 'image':
      case 'audio':
      case 'video': {
        el = makeMediaControl(control, scope, p, kind, disabled);
        break;
      }
      case 'gallery': {
        el = makeGalleryControl(control, p);
        break;
      }
      case 'container':
      case 'form':
      case 'formviewer':
      case 'card': {
        el = node('div');
        el.classList.add('canvas-container');
        break;
      }
      default: {
        el = node(
          'div',
          `${control.name}: ${gap?.reason || (control.type || kind || 'unsupported') + ' is not rendered'}`,
        );
        el.classList.add('unsupported');
      }
    }
    return styleControl(el, control, p, kind);
  }
  function attach(parent, child) {
    if (child.parentNode === parent) return;
    if (child.dataset.mediaKey && usedMedia.has(child.dataset.mediaKey) && child.isConnected && !parent.isConnected) {
      const placeholder = node('div');
      placeholder.dataset.control = child.dataset.control;
      placeholder.style.cssText = child.style.cssText;
      parent.append(placeholder);
      pendingMediaMoves.push({ child, placeholder });
      return;
    }
    if (child.isConnected && parent.isConnected && typeof parent.moveBefore === 'function')
      parent.moveBefore(child, null);
    else parent.append(child);
  }
  function applyLayoutChild(el, child, controls, p, align) {
    child.style.position = 'relative';
    child.style.left = 'auto';
    child.style.top = 'auto';
    const childControl = controls.find((item) => item.name === child.dataset.control);
    const childProperties = childControl?.properties ?? {};
    const requestedAlign = valueText(childProperties.AlignInContainer).split('.').pop().toLowerCase();
    const effectiveAlign =
      requestedAlign && requestedAlign !== 'setbycontainer' ? align(requestedAlign) : align(p.LayoutAlignItems);
    if (effectiveAlign) child.style.alignSelf = effectiveAlign;
    if (effectiveAlign === 'stretch') {
      if (el.style.flexDirection === 'row') child.style.height = 'auto';
      else child.style.width = 'auto';
    }
    if (childProperties.LayoutMinWidth != null)
      child.style.minWidth = `${Math.max(0, num(childProperties.LayoutMinWidth, 0))}px`;
    if (childProperties.LayoutMinHeight != null)
      child.style.minHeight = `${Math.max(0, num(childProperties.LayoutMinHeight, 0))}px`;
    const portions = num(childProperties.FillPortions, 0);
    if (portions > 0) child.style.flex = `${portions} 1 0`;
  }
  function applyLayout(el, p, controls, model = {}) {
    const sourceType = valueText(model.variant ?? model.type ?? model.control);
    let inferred = null;
    if (/horizontalAutoLayoutContainer/i.test(sourceType)) inferred = 'Horizontal';
    else if (/verticalAutoLayoutContainer/i.test(sourceType)) inferred = 'Vertical';
    const direction = p.LayoutDirection || inferred;
    if (!el || !direction) return;
    el.style.display = 'flex';
    el.style.flexDirection = /horizontal/i.test(valueText(direction)) ? 'row' : 'column';
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
    for (const child of el.children) applyLayoutChild(el, child, controls, p, align);
  }
  function section(title, data) {
    const details = node('details');
    const summary = node('summary', title);
    const pre = node('pre', JSON.stringify(data, null, 2));
    details.append(summary, pre);
    return details;
  }
  function prepareRenderStage() {
    const active = stage.contains(document.activeElement) ? document.activeElement : null;
    const focusedControl = active?.closest('[data-control]')?.dataset.control;
    const focusedSearch = active?.type === 'search';
    // What the user typed is kept across the re-render that a pending text action causes.
    const typed =
      active &&
      (active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' && ['text', 'search', 'password'].includes(active.type)))
        ? {
            value: active.value,
            start: active.selectionStart,
            end: active.selectionEnd,
            dirty: active.dataset.dirty === 'true',
            sent: active.dataset.sent,
          }
        : null;
    const item = active?.closest('[data-item-index]')?.dataset.itemIndex ?? null;
    // Removing a focused input can fire its change event in some browsers; that is not a commit by the user.
    if (active) active.dataset.rerendering = 'true';
    const canMove = typeof stage.moveBefore === 'function';
    const media = [...stage.querySelectorAll('audio[data-media-key], video[data-media-key]')].filter(
      (el) => canMove || el.parentNode === stage,
    );
    preservedMedia = new Map(media.map((el) => [el.dataset.mediaKey, el]));
    usedMedia = new Set();
    pendingMediaMoves = [];
    for (const el of media) if (el.parentNode !== stage) stage.moveBefore(el, null);
    for (const child of [...stage.children]) if (!media.includes(child)) child.remove(); // NOSONAR: snapshot copy guards against mutation while iterating
    inspector.replaceChildren(node('h2', 'Inspector'));
    return { focusedControl, focusedSearch, typed, item };
  }
  function buildCanvasControls(screen) {
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
      attach(parent || stage, el);
    }
    restorePendingMediaMoves();
    removeUnusedMedia();
    return elements;
  }
  function restorePendingMediaMoves() {
    for (const { child, placeholder } of pendingMediaMoves) {
      if (!placeholder.isConnected) {
        child.remove();
        continue;
      }
      child.style.cssText = placeholder.style.cssText;
      if (typeof placeholder.parentNode.moveBefore === 'function')
        placeholder.parentNode.moveBefore(child, placeholder);
      else placeholder.parentNode.insertBefore(child, placeholder);
      placeholder.remove();
    }
  }
  function removeUnusedMedia() {
    for (const [key, el] of preservedMedia) if (!usedMedia.has(key)) el.remove();
  }
  function snapshotErrorText(error) {
    return `${error.code || error.kind || 'Error'}: ${error.message || ''} ${error.file || error.source || ''}${error.line ? ':' + error.line : ''}`;
  }
  function diagnosticText(diagnostic) {
    return `${diagnostic.code || 'Diagnostic'}: ${diagnostic.message || ''} ${diagnostic.source || ''}${diagnostic.line ? ':' + diagnostic.line : ''}`;
  }
  function appendCanvasDiagnostics(geometry) {
    if (source.app?.displayEvidence) inspector.append(node('p', `Display observation: ${source.app.displayEvidence}`));
    if (geometry?.incomplete) inspector.append(node('p', 'Scale to fit needs observed design width and height.'));
    inspector.append(
      node(
        'p',
        'Browser developer tools are available. Power Fx stepping is not supported. Unsupported controls and source gaps are listed below. Layout and styling are approximations.',
      ),
    );
    for (const gap of source.rendering?.gaps || snapshot.unsupported || [])
      inspector.append(node('p', `${gap.screen}.${gap.name}: ${gap.control}: ${gap.reason}`));
    for (const error of snapshot.errors || []) inspector.append(node('p', snapshotErrorText(error)));
    for (const diagnostic of [...(snapshot.diagnostics || []), ...(source.assetDiagnostics || [])])
      inspector.append(node('p', diagnosticText(diagnostic)));
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
  function restoreCanvasFocus(focus) {
    if (!focus.focusedControl) return;
    const candidate = [...stage.querySelectorAll('[data-control]')].find(
      (element) =>
        element.dataset.control === focus.focusedControl &&
        (element.closest('[data-item-index]')?.dataset.itemIndex ?? null) === focus.item,
    );
    const target = focus.focusedSearch ? candidate?.querySelector('input[type="search"]') : candidate;
    if (target?.isConnected && !target.disabled) {
      target.focus();
      const typed = focus.typed;
      // Typed text the app has not received is written back; text already sent leaves the app's value in place.
      if (typed && typed.value !== typed.sent && target.value !== typed.value) target.value = typed.value;
      if (typed?.dirty) target.dataset.dirty = 'true';
      if (typed && target.setSelectionRange) {
        const end = target.value.length;
        target.setSelectionRange(Math.min(typed.start, end), Math.min(typed.end, end));
      }
    }
  }
  function updateCanvasTransition(screen) {
    if (!lastScreen || screen?.name === lastScreen) return;
    stage.classList.remove('canvas-transition-fade', 'canvas-transition-cover', 'canvas-transition-uncover');
    const transition = valueText(snapshot.transition).split('.').pop().toLowerCase();
    let effect = null;
    if (transition === 'fade') effect = 'fade';
    else if (transition.startsWith('cover')) effect = 'cover';
    else if (transition.startsWith('uncover')) effect = 'uncover';
    if (effect) stage.classList.add(`canvas-transition-${effect}`);
  }
  function noticeElement(item) {
    const kind = valueText(item.type).split('.').pop().toLowerCase();
    const el = node('div');
    el.className = 'canvas-notice';
    el.setAttribute('role', ['error', 'warning'].includes(kind) ? 'alert' : 'status');
    el.append(node('span', item.message));
    const close = node('button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss notification');
    el.append(close);
    return el;
  }
  // Banners by notification id; dismissed ids are kept per app and session in sessionStorage (storage can be unavailable).
  const shownNotices = new Map();
  const dismissedKey = () => `paqvilo-canvas-dismissed:${app}:${snapshot?.clockKey ?? ''}`;
  function dismissedNotices() {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(dismissedKey()) ?? '[]'));
    } catch {
      return new Set();
    }
  }
  function rememberDismissed(id) {
    try {
      sessionStorage.setItem(dismissedKey(), JSON.stringify([...dismissedNotices(), id]));
    } catch {
      // Unavailable storage: the banner stays dismissed for this page only.
    }
  }
  // Milliseconds a notification has left, measured on the server's clock (snapshot.now); Infinity when its Timeout is 0.
  const noticeRemaining = (item) => (item.timeout === 0 ? Infinity : item.timeout - (snapshot.now - item.createdAt));
  function removeNotice(id) {
    const shown = shownNotices.get(id);
    if (!shown) return;
    clearTimeout(shown.timer);
    shown.el.remove();
    shownNotices.delete(id);
  }
  function dismissNotice(id) {
    removeNotice(id);
    rememberDismissed(id);
  }
  function showNotice(item, remaining) {
    const el = noticeElement(item);
    const entry = { el, timer: null };
    el.querySelector('button').addEventListener('click', () => dismissNotice(item.id));
    if (Number.isFinite(remaining)) armNoticeTimer(item.id, entry, remaining);
    shownNotices.set(item.id, entry);
    notice.append(el);
  }
  // A browser fires a delay above 2,147,483,647 ms at once, so a longer wait is armed in steps of that size.
  function armNoticeTimer(id, entry, remaining) {
    const maxDelay = 2147483647;
    const step = Math.min(remaining, maxDelay);
    entry.timer = setTimeout(() => {
      if (step < remaining) armNoticeTimer(id, entry, remaining - step);
      else removeNotice(id);
    }, step);
  }
  // The snapshot keeps every notification for the inspector. A banner is kept by id: a shown one keeps its timer, a
  // dismissed one stays hidden, and a timed one shows for the time left, so a reload neither restarts it nor shows an
  // expired one. A start or reset clears the banners first.
  function announceNotices(fresh) {
    if (fresh) {
      const shown = [...shownNotices.keys()];
      for (const id of shown) removeNotice(id);
      notice.replaceChildren();
    }
    const dismissed = dismissedNotices();
    for (const item of snapshot.notifications ?? []) {
      if (shownNotices.has(item.id) || dismissed.has(item.id)) continue;
      const remaining = noticeRemaining(item);
      if (remaining > 0) showNotice(item, remaining);
    }
  }
  function applyScreenLayouts(screen, elements) {
    for (const control of screen?.controls || [])
      if (control.kind === 'container')
        applyLayout(elements.get(control.name), control.properties || {}, screen.controls, control);
  }
  // Viewer zoom: scales the drawn stage to the space beside the inspector. Formulas still see the chosen resolution.
  function fitStage() {
    const zoom = document.querySelector('[data-testid="canvas-zoom"]');
    const scroller = document.querySelector('.stage-scroll');
    const fit = document.querySelector('.canvas-fit');
    const w = Number.parseFloat(surface.style.width),
      h = Number.parseFloat(surface.style.height);
    // Not (w > 0 and h > 0): a NaN size is not positive, so it also stops here.
    if (!(w > 0 && h > 0)) return;
    // A hidden pane has no width: fitting to it would scale the stage to zero, so the current transform stays.
    if (scroller.clientWidth === 0) return;
    const s =
      zoom.value === 'fit'
        ? Math.min(
            1,
            scroller.clientWidth / w,
            Math.max(120, window.innerHeight - scroller.getBoundingClientRect().top - 16) / h,
          )
        : 1;
    surface.style.transformOrigin = 'top left';
    surface.style.transform = s < 1 ? `scale(${s})` : '';
    fit.style.width = `${w * s}px`;
    fit.style.height = `${h * s}px`;
  }
  // Before Start the stage is drawn at the chosen resolution, as a resolution change before Start draws it.
  function sizeIdleStage() {
    const [width, height] = logicalViewport();
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    surface.style.width = `${width}px`;
    surface.style.height = `${height}px`;
    fitStage();
  }
  function render() {
    globalThis.paqviloCanvasPcf?.begin();
    const focus = prepareRenderStage();
    restart.hidden = !(snapshot && snapshot.started !== false);
    if (!snapshot || snapshot.started === false) {
      for (const el of preservedMedia.values()) el.remove();
      status.textContent = 'The app has not been started. Start runs its OnStart formula.';
      sizeIdleStage();
      globalThis.paqviloCanvasPcf?.end();
      return;
    }
    status.textContent = `Current screen: ${snapshot.currentScreen || 'none'}`;
    const screen = snapshot.screens.find((s) => s.current);
    updateCanvasTransition(screen);
    lastScreen = screen?.name ?? null;
    const width = num(screen?.properties?.Width, snapshot.viewport?.width || viewport()[0]),
      height = num(screen?.properties?.Height, snapshot.viewport?.height || viewport()[1]);
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    const [physicalWidth, physicalHeight] = viewport();
    const geometry = canvasDisplayGeometry?.(source.app?.display, physicalWidth, physicalHeight);
    if (geometry?.scaling) {
      surface.style.width = `${physicalWidth}px`;
      surface.style.height = `${physicalHeight}px`;
      stage.style.transformOrigin = 'top left';
      stage.style.transform = `translate(${geometry.offsetX}px, ${geometry.offsetY}px) scale(${geometry.scaleX}, ${geometry.scaleY})`;
    } else {
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
      stage.style.transform = '';
    }
    stage.style.backgroundColor = valueText(screen?.properties?.Fill);
    const elements = buildCanvasControls(screen);
    globalThis.paqviloCanvasPcf?.end();
    applyScreenLayouts(screen, elements);
    appendCanvasDiagnostics(geometry);
    restoreCanvasFocus(focus);
    fitStage();
    syncClock(
      screen?.controls.some((control) => control.kind === 'timer' && control.properties?.Running === true),
      snapshot.clockKey,
    );
  }
  function syncClock(running, key) {
    clockWanted = Boolean(running && key);
    if (!clockWanted || (clockKey && clockKey !== key)) {
      clearTimeout(timerClock);
      timerClock = null;
      lastTick = null;
      releaseClock?.();
      releaseClock = null;
      clockOwned = false;
      stage.dataset.clockOwned = 'false';
      clockKey = null;
      if (!clockWanted) return;
    }
    clockKey = key;
    if (!navigator.locks) {
      status.textContent = 'Timer clock requires browser Web Locks to avoid duplicate ticks.';
      return;
    }
    if (!clockOwned) {
      if (clockAcquiring || timerClock) return;
      clockAcquiring = true;
      navigator.locks
        .request(`paqvilo-canvas-clock:${key}`, { ifAvailable: true }, async (lock) => {
          clockAcquiring = false;
          if (!clockWanted || key !== clockKey) return;
          if (!lock) {
            timerClock = setTimeout(() => {
              timerClock = null;
              syncClock(clockWanted, clockKey);
            }, 1000);
            return;
          }
          clockOwned = true;
          stage.dataset.clockOwned = 'true';
          lastTick = performance.now();
          syncClock(true, key);
          await new Promise((resolve) => {
            releaseClock = resolve;
          });
        })
        .catch(() => {
          clockAcquiring = false;
          status.textContent = 'Timer clock could not acquire browser ownership.';
        });
      return;
    }
    if (!timerClock)
      timerClock = setTimeout(async () => {
        timerClock = null;
        const now = performance.now(),
          elapsed = Math.min(60000, Math.max(1, Math.floor(now - lastTick)));
        lastTick = now;
        await act({ action: 'tick', milliseconds: elapsed });
      }, 1000);
  }

  stage.addEventListener('animationend', () =>
    stage.classList.remove('canvas-transition-fade', 'canvas-transition-cover', 'canvas-transition-uncover'),
  );
  // A running instance is reset first, so its OnStart runs again; start then launches it as a first start does.
  async function launch() {
    const [width, height] = logicalViewport();
    if (snapshot && snapshot.started !== false) await act({ action: 'reset', viewport: { width, height } });
    await act({ action: 'start', viewport: { width, height } });
    const [desiredWidth, desiredHeight] = logicalViewport();
    if (
      snapshot &&
      snapshot.started !== false &&
      (snapshot.viewport?.width !== desiredWidth || snapshot.viewport?.height !== desiredHeight)
    )
      await act({ action: 'resize', width: desiredWidth, height: desiredHeight });
  }
  start.addEventListener('click', launch);
  restart.addEventListener('click', launch);
  resolution.addEventListener('change', () => {
    const [width, height] = logicalViewport();
    if (snapshot && snapshot.started !== false) void act({ action: 'resize', width, height });
    else sizeIdleStage();
  });
  document.querySelector('[data-testid="canvas-zoom"]').addEventListener('change', fitStage);
  // Deferred to a frame: fitStage changes the scroller's content height, which would end the observer loop undelivered.
  new ResizeObserver(() => requestAnimationFrame(fitStage)).observe(document.querySelector('.stage-scroll'));
  window.addEventListener('resize', fitStage);
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (resolution.value !== 'browser') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const [width, height] = logicalViewport();
      if (snapshot && snapshot.started !== false) void act({ action: 'resize', width, height });
    }, 80);
  });
  let watchTimer = null,
    watchAbort = null,
    watchStopped = false;
  const watchKey = `paqvilo-canvas-source-updated:${app}`;
  function scheduleWatch(delay = 1000) {
    if (
      watchStopped ||
      document.hidden ||
      !source?.watch ||
      typeof source.revision !== 'string' ||
      watchTimer ||
      watchAbort
    )
      return;
    watchTimer = setTimeout(checkRevision, delay);
  }
  async function checkRevision() {
    watchTimer = null;
    if (watchStopped || document.hidden || watchAbort) return;
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    watchAbort = controller;
    try {
      const result = await request(`/_apps/canvas/api/${encodeURIComponent(app)}?revision=1`, {
        signal: controller.signal,
        untraced: true,
      });
      if (typeof result.revision !== 'string') throw new Error('Source revision is unavailable.');
      if (result.revision !== source.revision) {
        try {
          sessionStorage.setItem(watchKey, '1');
        } catch {
          /* storage may be unavailable */
        }
        watchStopped = true;
        location.reload();
        return;
      }
    } catch (error) {
      if (timedOut) status.textContent = 'Source watch: revision request timed out.';
      else if (!controller.signal.aborted) status.textContent = `Source watch: ${error.message}`;
    } finally {
      clearTimeout(deadline);
      if (watchAbort === controller) watchAbort = null;
      scheduleWatch();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(watchTimer);
      watchTimer = null;
      watchAbort?.abort();
    } else scheduleWatch(0);
  });
  window.addEventListener('pagehide', () => {
    watchStopped = true;
    clearTimeout(watchTimer);
    watchAbort?.abort();
    clearTimeout(timerClock);
    releaseClock?.();
  });
  Promise.all([request(`/_apps/canvas/api/${encodeURIComponent(app)}`), request(api)])
    .then(async ([inventory, state]) => {
      if (inventory.app?.display) {
        ({ canvasDisplayGeometry } = await import('./canvas-display.mjs'));
      }
      if (Object.keys(inventory.codeComponents ?? {}).length) {
        await import('./canvas-pcf-client.js');
      }
      source = inventory;
      snapshot = state;
      announceNotices(false);
      if (state.viewport && !inventory.app?.display?.scaleToFit && !inventory.app?.display?.lockOrientation) {
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
      try {
        if (sessionStorage.getItem(watchKey)) {
          sessionStorage.removeItem(watchKey);
          status.textContent = 'Source updated. Start the app again.';
        }
      } catch {
        /* storage may be unavailable */
      }
      scheduleWatch();
    })
    .catch((error) => {
      status.textContent = error.message;
    });
})();
