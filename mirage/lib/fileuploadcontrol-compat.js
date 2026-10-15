/*
 * Local equivalent of the platform's /xrm-adx/js/fileuploadcontrol.js (the attach-file control
 * of basic and multistep forms): the Upload button opens the file chooser and the chosen files
 * are listed in the control's file-info area. The platform uploads each file in chunks before
 * the submit; locally the files stay in the input and post with the form (multipart), which the
 * form service saves as annotations.
 * ponytail: no chunked upload service; add when a scenario captures the upload requests.
 */
(() => {
  "use strict";
  if (window.selectAttachment) return;
  const byId = (id) => document.getElementById(id);
  const sizeText = (size) =>
    size >= 1024 * 1024 * 1024 ? (size / (1024 * 1024 * 1024)).toFixed(1) + " GB" : size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + " MB" : size >= 1024 ? (size / 1024).toFixed(1) + " KB" : size + " bytes";
  const chosen = [];
  window.selectAttachment = function () {
    byId("AttachFile")?.click();
    byId("UploadButton")?.blur();
  };
  window.chooseAttachment = function () {
    const input = byId("AttachFile");
    const info = byId("newdivforfileinfo");
    if (!input || !info) return;
    const max = Number(byId("AttachFile_HiddenField_MaxFile")?.value) || 1;
    for (const file of input.files ?? []) {
      if (chosen.length >= max) break;
      chosen.push(file);
      const item = document.createElement("div");
      item.className = "custom-button";
      const name = document.createElement("div");
      name.className = "filename";
      name.tabIndex = 0;
      name.title = `${file.name} (${sizeText(file.size)})`;
      name.textContent = name.title;
      item.append(name);
      info.append(item);
    }
    // The required validator reads the annotation ids the platform fills after its uploads.
    const ids = byId("AttachFile_HiddenField_AnnotationIds");
    if (ids) ids.value = chosen.map((file) => file.name).join(",");
    const button = byId("UploadButton");
    if (button && chosen.length >= max) button.disabled = true;
  };
  const hide = (selector) => { const node = document.querySelector(selector); if (node) node.style.display = "none"; };
  window.genericcloseAlert = () => hide(".errordiv.generic");
  window.deletecloseAlert = () => hide(".errordiv.deletefail");
  window.closeModalForFileSize = () => hide("#ModalToShowErrorForFileSize");
  window.closeModalForFileLimit = () => hide("#ModalToShowErrorForFileLimit");
  window.closeModalForFileType = () => hide("#ModalToShowErrorForFileType");
})();
