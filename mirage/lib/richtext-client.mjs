/** Self-contained browser entry point, embedded with its settings by platform.mjs. */
export async function mountRichTextEditors(settings) {
  const base = '/webresources/msdyn_/RichTextEditorControl/';
  const state = (window.__portalSimulation ||= {});
  const loadJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Rich text configuration unavailable: ' + url + ' (' + response.status + ')');
    return response.json();
  };
  const loadEditor = () =>
    (state.richTextLibrary ||= new Promise((resolve, reject) => {
      if (window.CKEDITOR) return resolve(window.CKEDITOR);
      window.CKEDITOR_BASEPATH = base + 'libs/ckeditor_latest/';
      const script = document.createElement('script');
      script.src = window.CKEDITOR_BASEPATH + 'ckeditor.js';
      script.onload = () => resolve(window.CKEDITOR);
      script.onerror = () => reject(new Error('The managed rich text editor dependency is unavailable.'));
      document.head.append(script);
    }));
  const syncValue = (input, html, inputEvent = false) => {
    const encoded = JSON.stringify(html);
    if (input.value === encoded && input.getAttribute('value') === encoded) return false;
    input.value = encoded;
    if (input.getAttribute('value') !== encoded) input.setAttribute('value', encoded);
    if (inputEvent) input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const compatibilityEditor = async (id, input, container) => {
    const initial = document.getElementById(id + '_editor')?.value || '';
    const readOnly = container.dataset.readOnly === 'true';
    const toolbar = document.createElement('div');
    toolbar.className = 'sim-richtext-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Compatibility editor formatting');
    const frame = document.createElement('iframe');
    frame.className = 'cke_wysiwyg_frame';
    frame.title = 'Compatibility rich text editor';
    frame.setAttribute('aria-label', frame.title);
    frame.style.cssText = 'width:100%;min-height:12rem;border:1px solid #8a8886;background:#fff';
    const badge = document.createElement('span');
    badge.className = 'sim-compatibility-badge';
    badge.textContent = 'Compatibility editor';
    for (const [label, command] of [
      ['Bold', 'bold'],
      ['Italic', 'italic'],
      ['Underline', 'underline'],
      ['Bulleted list', 'insertUnorderedList'],
      ['Numbered list', 'insertOrderedList'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = readOnly;
      button.textContent = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        frame.contentDocument.execCommand(command, false, null);
        frame.contentWindow.focus();
      });
      toolbar.append(button);
    }
    // An about:blank load, including one delivered during authored DOM moves,
    // cannot establish readiness for the editor's replacement document.
    const loaded = new Promise((resolve) => {
      const currentDocumentLoaded = () => {
        if (frame.contentDocument?.URL !== 'about:srcdoc') return;
        frame.removeEventListener('load', currentDocumentLoaded);
        resolve();
      };
      frame.addEventListener('load', currentDocumentLoaded);
    });
    frame.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8"><style>body{font:inherit;margin:8px;min-height:10rem;outline:none}body:focus{outline:none}</style></head><body contenteditable="' +
      !readOnly +
      '" role="textbox" aria-label="Rich text content" aria-readonly="' +
      readOnly +
      '" aria-multiline="true"></body></html>';
    container.replaceChildren(badge, toolbar, frame);
    container.dataset.simEditorMode = 'compatibility';
    await loaded;
    let content = initial;
    const body = () => frame.contentDocument?.body;
    const listeners = new Map();
    const fire = (name, data = {}) => {
      for (const callback of listeners.get(name) || []) callback({ name, editor, ...data });
    };
    const getData = () => {
      const current = body(),
        html = current?.innerHTML ?? content;
      const blocks =
        'address,article,aside,blockquote,details,dialog,div,dl,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,main,menu,nav,ol,p,pre,section,table,ul';
      if (!html || current?.querySelector(blocks)) return html;
      return '<p>' + html + '</p>';
    };
    const sync = () => {
      content = body()?.innerHTML ?? content;
      if (syncValue(input, getData(), true)) fire('change');
    };
    const editor = {
      name: id + '_editor',
      config: {},
      on(name, callback) {
        const rows = listeners.get(name) || [];
        rows.push(callback);
        listeners.set(name, rows);
        return editor;
      },
      fire(name, data) {
        fire(name, data);
        return editor;
      },
      getData,
      setData(value, callback) {
        content = String(value ?? '');
        if (body()) body().innerHTML = content;
        sync();
        callback?.();
        return editor;
      },
      updateElement() {
        sync();
        return editor;
      },
      focus() {
        body()?.focus();
        return editor;
      },
      editable() {
        return body();
      },
      destroy() {
        frame.remove();
        toolbar.remove();
        badge.remove();
        delete window.CKEDITOR.instances[editor.name];
        return editor;
      },
    };
    window.CKEDITOR ||= {
      instances: {},
      replace() {
        throw new Error('Native CKEditor is unavailable in compatibility mode.');
      },
    };
    window.CKEDITOR.instances ||= {};
    window.CKEDITOR.instances[editor.name] = editor;
    const bind = () => {
      const current = body();
      if (frame.contentDocument?.URL !== 'about:srcdoc' || !current || current.__ppSimBound) return;
      current.__ppSimBound = true;
      if (current.innerHTML !== content) current.innerHTML = content;
      current.addEventListener('input', sync);
      current.addEventListener('blur', sync);
    };
    frame.addEventListener('load', bind);
    bind();
    queueMicrotask(() => {
      container.dataset.mounted = 'ready';
      container.dispatchEvent(
        new CustomEvent('sim:richtext-ready', { bubbles: true, detail: { field: id, mode: 'compatibility' } }),
      );
      fire('instanceReady');
    });
    console.info(
      'Local rich text compatibility editor active for ' + id + '; native CKEditor assets were not captured.',
    );
  };
  await Promise.all(
    Object.entries(settings).map(async ([id, configuration]) => {
      const input = document.getElementById(id);
      const container = document.querySelector('[data-sim-richtext-editor][data-field="' + id + '"]');
      if (!input || !container || container.dataset.mounted) return;
      container.dataset.mounted = 'loading';
      try {
        if (configuration.compatibility) return await compatibilityEditor(id, input, container);
        const [library, globalConfiguration, fieldConfiguration] = await Promise.all([
          loadEditor(),
          (state.richTextGlobalConfiguration ||= loadJson(base + 'RTEGlobalConfiguration.json')),
          configuration.configUrl ? loadJson(configuration.configUrl) : configuration.configuration,
        ]);
        library.timestamp = '';
        const editor = library.replace(id + '_editor', {
          ...globalConfiguration.defaultSupportedProps,
          ...fieldConfiguration.defaultSupportedProps,
          stylesSet: false,
          contentsCss: [base + 'libs/ckeditor_latest/contents.css'],
          language: document.documentElement.lang?.split('-')[0] || 'en',
          readOnly: container.dataset.readOnly === 'true',
        });
        const sync = () => syncValue(input, editor.getData());
        editor.on('change', sync);
        editor.on('instanceReady', () => {
          sync();
          container.dataset.mounted = 'ready';
          container.dispatchEvent(new CustomEvent('sim:richtext-ready', { bubbles: true, detail: { field: id } }));
        });
      } catch (error) {
        container.dataset.mounted = 'failed';
        const alert = container.querySelector('[data-sim-richtext-error]');
        alert.hidden = false;
        alert.textContent = error.message;
        console.error(error);
      }
    }),
  );
}
