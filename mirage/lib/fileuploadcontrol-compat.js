/*
 * Local equivalent of the platform's /xrm-adx/js/fileuploadcontrol.js (the attach-file control
 * of basic and multistep forms): the Upload button opens the file chooser and the chosen files
 * are listed in the control's file-info area. Each chosen file goes through the platform's file
 * API at once: POST /_api/file/InitializeFileUpload/note
 * (the token, the file's name, size and type, the control's instance id as form session) answers an
 * annotation id and a continuation token, then PUT /_api/file/UploadFileBlock/note sends the
 * bytes. The postback carries the ids in AttachFile_HiddenField_AnnotationIds (a JSON array) and
 * an empty file input; the form service saves the staged files as annotations.
 * One block per file stays within the local 8 MiB request and file bounds.
 */
(() => {
  'use strict';
  if (window.selectAttachment) return;
  const byId = (id) => document.getElementById(id);
  const sizeText = (size) =>
    size >= 1024 * 1024 * 1024
      ? (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
      : size >= 1024 * 1024
        ? (size / (1024 * 1024)).toFixed(1) + ' MB'
        : size >= 1024
          ? (size / 1024).toFixed(1) + ' KB'
          : size + ' bytes';
  const chosen = [];
  const uploaded = [];
  let retainedCount = 0,
    restored = false;
  const restore = () => {
    const ids = byId('AttachFile_HiddenField_AnnotationIds');
    if (restored || !ids) return;
    restored = true;
    let retained = [];
    try {
      retained = JSON.parse(ids.value || '[]');
    } catch {
      /* Ignore malformed local presentation state. */
    }
    if (Array.isArray(retained)) uploaded.push(...retained.filter((id) => typeof id === 'string'));
    retainedCount = uploaded.length;
    if (retainedCount >= (Number(byId('AttachFile_HiddenField_MaxFile')?.value) || 1)) {
      const button = byId('UploadButton');
      if (button) button.disabled = true;
    }
  };
  const value = (suffix) => byId(`AttachFile${suffix}`)?.value ?? '';
  const token = () =>
    new Promise((resolve, reject) => {
      const deferred = window.shell?.getTokenDeferred?.();
      if (deferred?.done) deferred.done(resolve).fail(reject);
      else resolve(document.querySelector('#antiforgerytoken input[name="__RequestVerificationToken"]')?.value ?? '');
    });
  const send = (method, url, headers, body) =>
    new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open(method, url);
      for (const [name, header] of Object.entries(headers)) request.setRequestHeader(name, header);
      request.onload = () => (request.status >= 200 && request.status < 300 ? resolve(request) : reject(request));
      request.onerror = () => reject(request);
      request.send(body);
    });
  const upload = async (file) => {
    const verification = await token();
    const common = { formId: value('_HiddenField_FormID'), formType: value('_HiddenField_FormType') };
    const headers = {
      __RequestVerificationToken: verification,
      'Content-Type': file.type || 'application/octet-stream',
      'x-ms-file-name': file.name,
      'x-ms-file-type': file.type,
      'x-ms-form-session-id': value('_HiddenField_InstanceId'),
      'X-Requested-With': 'XMLHttpRequest',
    };
    const started = await send(
      'POST',
      `/_api/file/InitializeFileUpload/note?${new URLSearchParams({ ...common, regardingId: value('_HiddenField_RegardingId') })}`,
      { ...headers, 'x-ms-file-size': String(file.size) },
      null,
    );
    const { AnnotationId, FileContinuationToken } = JSON.parse(started.responseText);
    await send(
      'PUT',
      `/_api/file/UploadFileBlock/note?${new URLSearchParams({ chunkSize: String(file.size), fileSize: String(file.size), ...common, noteId: AnnotationId, offset: '0' })}`,
      { ...headers, 'x-ms-file-continuation-token': FileContinuationToken },
      file,
    );
    return AnnotationId;
  };
  // Pending uploads; a postback started meanwhile waits for them (window.__ppAttachUploads).
  let pending = 0;
  window.__ppAttachUploads = Promise.resolve();
  for (const name of ['WebForm_DoPostBackWithOptions', '__doPostBack']) {
    const original = window[name];
    if (typeof original !== 'function' || original.__ppAttachWait) continue;
    const wrapped = function (...args) {
      if (!pending) return original.apply(this, args);
      window.__ppAttachUploads.finally(() => original.apply(this, args));
    };
    wrapped.__ppAttachWait = true;
    window[name] = wrapped;
  }
  window.selectAttachment = function () {
    byId('AttachFile')?.click();
    byId('UploadButton')?.blur();
  };
  window.chooseAttachment = function () {
    restore();
    const input = byId('AttachFile');
    const info = byId('newdivforfileinfo');
    if (!input || !info) return;
    const max = Number(byId('AttachFile_HiddenField_MaxFile')?.value) || 1;
    for (const file of input.files ?? []) {
      if (retainedCount + chosen.length >= max) break;
      chosen.push(file);
      const item = document.createElement('div');
      item.className = 'custom-button';
      const name = document.createElement('div');
      name.className = 'filename';
      name.tabIndex = 0;
      name.title = `${file.name} (${sizeText(file.size)})`;
      name.textContent = name.title;
      item.append(name);
      info.append(item);
    }
    // The required validator reads the annotation ids the uploads return; the file input is
    // emptied so the postback carries the ids only.
    const ids = byId('AttachFile_HiddenField_AnnotationIds');
    const files = [...(input.files ?? [])].filter((file) => chosen.includes(file));
    pending += 1;
    window.__ppAttachUploads = Promise.all(files.map(upload))
      .finally(() => {
        pending -= 1;
      })
      .then(
        (annotationIds) => {
          uploaded.push(...annotationIds);
          if (ids) ids.value = JSON.stringify(uploaded);
          input.value = '';
        },
        () => {
          const error = document.querySelector('.errordiv.generic');
          if (error) error.style.display = '';
        },
      );
    const button = byId('UploadButton');
    if (button && retainedCount + chosen.length >= max) button.disabled = true;
  };
  // Platform scripts can load before the form's controls exist.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore, { once: true });
  else restore();
  const hide = (selector) => {
    const node = document.querySelector(selector);
    if (node) node.style.display = 'none';
  };
  window.genericcloseAlert = () => hide('.errordiv.generic');
  window.deletecloseAlert = () => hide('.errordiv.deletefail');
  window.closeModalForFileSize = () => hide('#ModalToShowErrorForFileSize');
  window.closeModalForFileLimit = () => hide('#ModalToShowErrorForFileLimit');
  window.closeModalForFileType = () => hide('#ModalToShowErrorForFileType');
})();
