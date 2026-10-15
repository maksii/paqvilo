/*
 * Local equivalent of the hosted PCF host for MultiSelectPicklist columns
 * (MscrmControls.MultiSelectPicklist.UpdMSPicklistControl): the server renders the host
 * (PcfControl_<id>, the PcfControlConfig_<field> span and an empty <field>_ControlView), and
 * this runtime fills the view with the control's DOM as the hosted bundle leaves it on first
 * load (live evidence: empty insert, populated edit, read-only form). The hosted bundle's
 * instance counter is 1. Part of the app bundle equivalent; idempotent.
 */
(() => {
  "use strict";
  if (window.__ppMultiSelectHost) return;
  window.__ppMultiSelectHost = true;
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const label = (option) => option.Label?.UserLocalizedLabel?.Label ?? option.Label?.LocalizedLabels?.[0]?.Label ?? String(option.Value);
  const render = (context, values) => {
    const id = context.ControlId;
    const name = context.ControlProperties?.value_DisplayName ?? id;
    const options = (context.ControlProperties?.value_Options ?? []).map((option, index) => ({ value: String(option.Value), label: label(option), index: index + 1 }));
    const selected = options.filter((option) => values.includes(option.value));
    const text = selected.map((option) => option.label).join(", ");
    const off = Boolean(context.IsDisabled);
    const selectedItems = selected
      .map((option) => `<li class="msos-selected-display-item msos-visible" name="${escape(id)}-selected-item-${option.index}" aria-describedby="${escape(id)}_selecteditems_instructions" id="${escape(id)}-selected-item-${option.index}" tabindex="-1" title="" data-value="${escape(option.value)}" aria-label="${escape(`${option.label} for ${name}`)}"><span class="msos-selected-display-item-text">${escape(option.label)}</span><button class="msos-quick-delete" tabindex="-1" name="${escape(id)}-selected-item-delete-${option.index}" aria-label="${escape(`Remove ${option.label}`)}"><span class="msos-glyph"></span></button></li>`)
      .join("");
    // The option boxes are checked by property, not attribute (live DOM).
    const optionItems = options
      .map((option) => { const on = values.includes(option.value); return `<li class="msos-option${on ? " msos-option-selected" : ""}" role="option"${on ? ' aria-selected="true"' : ""}><label name="${escape(id)}msos-label" class="msos-label" title="${escape(option.label)}"><input type="checkbox" id="${escape(id)}_item${option.index}" class="msos-checkbox" name="character" tabindex="-1" aria-label="${escape(option.label)}" value="${escape(option.value)}"><div class="msos-label-text msos-optionitem-text" aria-hidden="true">${escape(option.label)}</div></label></li>`; })
      .join("");
    const a11y = off ? "" : `<div class="msos-alert-text" aria-live="assertive" aria-atomic="true" aria-relevant="additions"></div><div class="msos-a11y" aria-hidden="true" id="${escape(id)}_selecteditems_instructions">Use the arrow keys to navigate through the list of currently selected items. Press delete or backspace to deselect an item. For touch devices, use swipe and touch gestures to explore the list.</div><div class="msos-a11y" aria-hidden="true" id="${escape(id)}_combobox_instructions">Use the arrow keys to navigate through the list of items. Press space to select or deselect an item. For touch devices, use swipe and touch gestures to explore this list.</div>`;
    const viewMode = `<div class="msos-viewmode-container" id="${escape(id)}_viewmodecontainer"><div class="msos-viewmode-content"><div class="msos-viewmode-text" title="${escape(text || "---")}">${escape(text || "---")}</div></div><div class="msos-viewmode-button-container msos-hidden"><button class="msos-viewmode-button" aria-controls="${escape(id)}_viewmodecontainer" aria-expanded="false" aria-label="Expand or collapse selected content" type="button"><span class="msos-glyph"></span></button></div></div>`;
    const strip = `<div class="msos-selecteditems-container"${text ? ` title="${escape(text)}"` : ""} tabindex="0"><ul class="msos-selecteditems msos-current-selection-normal" tabindex="-1" aria-label="${escape(`Selected values for ${name}`)}">${selectedItems}</ul><div class="msos-selecteditems-toggle-container"><button class="msos-selecteditems-toggle msos-invisible" tabindex="-1" aria-hidden="true" type="button">+{0}</button></div></div>`;
    const inner = `<div class="msos-inner-container" role="combobox" aria-haspopup="true" aria-expanded="false" aria-label="${escape(name)}" aria-controls="${escape(id)}_i"><div class="msos-filter-container"><div class="msos-input-container"><input id="${escape(id)}_ledit" type="text" class="msos-input" placeholder="Select or search options" aria-label="${escape(text ? `${name}. Selected: ${text}` : name)}" aria-autocomplete="list" aria-describedby="${escape(id)}_combobox_instructions"></div><div class="msos-caret-container"><button class="msos-caret-button" tabindex="-1" aria-label="Toggle menu" type="button"><span class="msos-glyph"></span></button></div></div><div class="msos-selection-container"><div class="msos-action-buttons"><label name="${escape(id)}msos-label" class="msos-label msos-selectall msos-option"><input type="checkbox" class="msos-checkbox" id="${escape(id)}_selectAll" tabindex="-1" aria-label="${escape(`Select all ${options.length} items`)}"><div class="msos-label-text" aria-hidden="true"><div class="msos-optionitem-text">Select all</div><div id="${escape(id)}msos-no-of-Items" class="msos-itemcount-text">${options.length} items</div></div></label></div><div id="${escape(id)}_no-results" class="msos-no-results msos-hidden">No entries found</div><ul class="msos-selected-items msos-selection" role="listbox" tabindex="-1" aria-multiselectable="true" aria-labelledby="${escape(id)}msos-no-of-Items">${optionItems}</ul></div></div>`;
    const container = `<div id="${escape(id)}_i" class="msos-container${off ? " msos-disabled" : values.length ? "" : " msos-none-selected"}">${a11y}${viewMode}${strip}${inner}</div>`;
    const control = `<div class="customControl MscrmControls MultiSelectPicklist.UpdMSPicklistControl ${escape(context.ControlName)}" data-id="UpdMSPicklistControl_container" style="width: 100%;">${container}<select id="${escape(id)}_0" multiple="multiple" style="display: none;"></select></div>`;
    return `<div role="presentation" class="a flexbox"><div id="UpdMSPicklistControlshadow" style="display: none;"></div><div id="UpdMSPicklistControl1_outer" role="presentation" class="a flexbox"><div id="UpdMSPicklistControl" role="presentation" class="a flexbox"><div id="closeButtonContainer|UpdMSPicklistControl" role="presentation" class="b "><button id="closeButton|UpdMSPicklistControl" aria-label="Close Fullscreen Control button" title="Close Fullscreen Control button" tabindex="-1" type="button" class="c d e f g h i j k l m n flexbox"><div role="presentation" class="o p e f q r i j k l m flexbox">╳</div></button></div><div role="presentation" class="b "></div>${control}</div></div></div>`;
  };
  const mount = () => {
    for (const config of document.querySelectorAll("span[id^='PcfControlConfig_'][pcf-controlcontext]")) {
      let context;
      try { context = JSON.parse(config.getAttribute("pcf-controlcontext")); } catch { continue; }
      if (context?.ControlName !== "MscrmControls.MultiSelectPicklist.UpdMSPicklistControl") continue;
      const view = document.getElementById(context.UniqueId);
      if (!view || view.childElementCount) continue;
      const hidden = document.getElementById(context.PcfControlHiddenValueId ?? context.ControlId);
      let values = [];
      try { values = hidden?.value ? JSON.parse(hidden.value).map((item) => String(item && typeof item === "object" ? item.Value : item)) : []; } catch { values = String(hidden?.value ?? "").split(",").filter(Boolean); }
      view.innerHTML = render(context, values);
      for (const box of view.querySelectorAll(".msos-selection input[type='checkbox']")) box.checked = values.includes(box.value);
      // The host expands the value to the selected options' metadata and, when editing, marks the
      // host dirty (live DOM).
      const metadata = (context.ControlProperties?.value_Options ?? []).filter((option) => values.includes(String(option.Value)));
      if (hidden && metadata.length) hidden.setAttribute("value", JSON.stringify(metadata));
      if (values.length && config.parentElement?.parentElement?.hasAttribute("onchange")) config.parentElement.parentElement.classList.add("dirty");
    }
  };
  window.__ppMultiSelectHost = { render, mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
