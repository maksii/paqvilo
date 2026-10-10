/*
 * Local compatibility runtime for the managed Power Pages entity grid, lookup
 * modal, subgrid, associate dialog and notes controls. It binds the
 * server-rendered native markup (div.entity-grid[data-view-layouts], .entity-lookup,
 * .entity-associate, .entity-notes) and uses the native JSON services under
 * /_services/... with the __RequestVerificationToken header. Requests are sent
 * through jQuery.ajax/XMLHttpRequest because authored scripts observe them there.
 * Events: "loaded" (bubbling, after rows render), "refresh" and "metafilter".
 */
(() => {
  "use strict";
  if (window.__ppNativeGridRuntime) return;
  window.__ppNativeGridRuntime = true;

  // Only a real jQuery (jQuery.fn.jquery is its version) carries the native grid events.
  const jq = () => (typeof window.jQuery?.fn?.jquery === "string" ? window.jQuery : null);
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plain = (html) => {
    const div = document.createElement("div");
    div.innerHTML = String(html ?? "");
    return div.textContent.trim();
  };
  const ResourceManager = () => window.ResourceManager || {};
  const resource = (key, fallback) => ResourceManager()[key] || fallback;

  // ---- events --------------------------------------------------------------
  function trigger(element, name, extra) {
    const $ = jq();
    if ($) $(element).trigger(name, extra === undefined ? [] : [extra]);
    else element.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: extra }));
  }
  // The platform bundle binds grid controls with jQuery: a page's jQuery .trigger("click"),
  // which dispatches no native click on links, reaches them as well as a user's click.
  function onClick(element, handler) {
    const $ = jq();
    if ($) $(element).on("click", handler);
    else element.addEventListener("click", handler);
  }
  function on(element, name, handler) {
    const $ = jq();
    if ($) $(element).on(name, handler);
    // Without jQuery, trigger() dispatches the full Bootstrap-style name (show.bs.modal).
    else element.addEventListener(name, (event) => handler(event, event.detail));
  }
  // Native row action menus use position: fixed. This local adapter places them
  // when the dropdown opens, including when authored page layouts constrain the viewport:
  // - below its button when it fits, otherwise above or bounded to the visible viewport;
  // - left-to-right: left-aligned unless it would overflow the window;
  // - right-to-left: right-aligned;
  // - the toggle's aria-expanded follows the menu;
  // - Tab closes it, Up and Down move between its items, and scrolling the window closes it.
  function bindActionMenu(container) {
    if (!container) return;
    const menu = container.querySelector(".dropdown-menu");
    const sizing = menu && Object.fromEntries(["maxHeight", "maxWidth", "minWidth", "overflowY", "overflowX", "boxSizing"].map((key) => [key, menu.style[key]]));
    on(container, "show.bs.dropdown", () => {
      container.querySelector(".aria-exp")?.setAttribute("aria-expanded", "true");
      if (!menu) return;
      const rect = container.getBoundingClientRect();
      // Measure the menu as displayed: it opens right after this event.
      const previous = menu.style.display;
      Object.assign(menu.style, sizing);
      menu.style.display = "block";
      const viewport = window.visualViewport;
      const edge = document.documentElement.clientWidth || window.innerWidth;
      const gap = 4;
      const leftEdge = (viewport?.offsetLeft || 0) + gap;
      const topEdge = (viewport?.offsetTop || 0) + gap;
      const rightEdge = leftEdge + (viewport?.width || edge) - gap * 2;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - gap * 2;
      const style = getComputedStyle(menu);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      const marginLeft = parseFloat(style.marginLeft) || 0;
      const marginRight = parseFloat(style.marginRight) || 0;
      const maxHeight = Math.max(1, bottomEdge - topEdge);
      const maxWidth = Math.max(1, rightEdge - leftEdge);
      if (menu.offsetHeight > maxHeight) {
        menu.style.boxSizing = "border-box";
        menu.style.maxHeight = `${maxHeight}px`;
        menu.style.overflowY = "auto";
      }
      if (menu.offsetWidth > maxWidth) {
        menu.style.boxSizing = "border-box";
        menu.style.minWidth = "0";
        menu.style.maxWidth = `${maxWidth}px`;
        menu.style.overflowX = "auto";
      }
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const below = rect.bottom + marginTop;
      const above = rect.top - height - marginBottom;
      const top = below + height > bottomEdge && rect.top - topEdge > bottomEdge - rect.bottom ? above : below;
      menu.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height)) - marginTop}px`;
      const rtl = document.documentElement.getAttribute("dir") === "rtl";
      let left = rtl ? rect.right - width - marginRight : rect.left + marginLeft;
      if (!rtl && left + width > rightEdge) left = rect.right - width - marginRight;
      if (rtl && left < leftEdge) left = rect.left + marginLeft;
      left = Math.max(leftEdge, Math.min(left, rightEdge - width));
      menu.style.left = rtl ? "auto" : `${left - marginLeft}px`;
      menu.style.right = rtl ? `${edge - left - width - marginRight}px` : "auto";
      menu.style.display = previous;
      container.__ppMenuScrollPosition = { x: window.scrollX, y: window.scrollY };
    });
    on(container, "hide.bs.dropdown", () => container.querySelector(".aria-exp")?.setAttribute("aria-expanded", "false"));
    container.addEventListener("keydown", (event) => {
      const key = event.key;
      if (key === "Tab") {
        trigger(container, "hide.bs.dropdown");
        container.classList.remove("open", "show");
      }
      if (key !== "ArrowDown" && key !== "ArrowUp") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const items = [...container.querySelectorAll(".dropdown-menu li:not(.disabled) a")].filter((item) => item.getClientRects().length);
      if (!items.length) return;
      let index = items.indexOf(event.target);
      if (key === "ArrowUp" && index > 0) index--;
      if (key === "ArrowDown" && index < items.length - 1) index++;
      items[Math.max(index, 0)].focus();
    });
  }
  function closeActionMenus(event) {
    for (const open of document.querySelectorAll(".entity-grid .dropdown.action.open")) {
      // A browser can dispatch an already-queued scroll after the click that
      // opens a menu. Smooth scrolling can also finish one CSS pixel away from
      // the measured position. Keep that rounding drift without resetting the
      // baseline, so cumulative movement still closes it. Resize always closes.
      const position = open.__ppMenuScrollPosition;
      if (event?.type === 'scroll' && position && Math.abs(position.x - window.scrollX) <= 1 && Math.abs(position.y - window.scrollY) <= 1) continue;
      trigger(open, "hide.bs.dropdown");
      open.classList.remove("open");
    }
  }
  window.addEventListener("scroll", closeActionMenus, { passive: true });
  window.addEventListener("resize", closeActionMenus, { passive: true });

  // ---- token and transport ------------------------------------------------
  function token() {
    return new Promise((resolve, reject) => {
      const shell = window.shell;
      if (shell && typeof shell.getTokenDeferred === "function") {
        const deferred = shell.getTokenDeferred();
        if (deferred && typeof deferred.done === "function") {
          deferred.done(resolve);
          if (typeof deferred.fail === "function") deferred.fail(reject);
          return;
        }
        if (deferred && typeof deferred.then === "function") return deferred.then(resolve, reject);
      }
      const input = document.querySelector('#antiforgerytoken input[name="__RequestVerificationToken"]');
      if (input) return resolve(input.value);
      reject(new Error("The anti-forgery token is unavailable."));
    });
  }
  function errorOf(xhr, thrown) {
    let message = thrown || "Error completing request.";
    try {
      if (/json/i.test(xhr?.getResponseHeader?.("content-type") || "")) {
        const body = JSON.parse(xhr.responseText);
        message = body?.InnerError?.Message || body?.Message || body?.error?.message || message;
      } else if (xhr?.statusText) message = xhr.statusText;
    } catch {
      /* keep the transport message */
    }
    const error = new Error(message);
    error.status = xhr?.status;
    return error;
  }
  /** POST JSON with the native headers; json=true parses the reply. */
  function post(url, body, { json = true } = {}) {
    return token().then(
      (value) =>
        new Promise((resolve, reject) => {
          const $ = jq();
          const headers = { __RequestVerificationToken: value };
          if ($ && $.ajax) {
            $.ajax({
              type: "POST",
              url,
              data: JSON.stringify(body),
              contentType: "application/json; charset=utf-8",
              dataType: json ? "json" : undefined,
              headers,
              cache: false,
            })
              .done((data) => resolve(data))
              .fail((xhr, _status, thrown) => reject(errorOf(xhr, thrown)));
            return;
          }
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url);
          xhr.setRequestHeader("Content-Type", "application/json; charset=utf-8");
          xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
          xhr.setRequestHeader("__RequestVerificationToken", value);
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              if (!json || !xhr.responseText) return resolve(null);
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch (error) {
                reject(error);
              }
            } else reject(errorOf(xhr, xhr.statusText));
          };
          xhr.onerror = () => reject(errorOf(xhr, "Network error"));
          xhr.send(JSON.stringify(body));
        }),
    );
  }

  // ---- bootstrap modal (native Bootstrap when present) ----------------------
  function showModal(modal) {
    const $ = jq();
    if ($ && $.fn.modal) {
      // Bootstrap 3 leaves aria-hidden alone; the platform's grids, lookups and notes mark
      // their dialog exposed on show.bs.modal and hidden again once it is hidden.
      $(modal)
        .off(".simModalAria")
        .on("show.bs.modal.simModalAria", () => modal.setAttribute("aria-hidden", "false"))
        .on("hidden.bs.modal.simModalAria", () => modal.setAttribute("aria-hidden", "true"));
      return void $(modal).modal("show");
    }
    trigger(modal, "show.bs.modal");
    modal.hidden = false;
    modal.style.display = "block";
    modal.classList.add("in", "show");
    modal.setAttribute("aria-hidden", "false");
    modal.setAttribute("aria-modal", "true");
    document.body.classList.add("modal-open");
    trigger(modal, "shown.bs.modal");
  }
  function hideModal(modal) {
    const $ = jq();
    if ($ && $.fn.modal) return void $(modal).modal("hide");
    if (!modal.classList.contains("in")) return;
    trigger(modal, "hide.bs.modal");
    modal.style.display = "none";
    modal.classList.remove("in", "show");
    modal.setAttribute("aria-hidden", "true");
    modal.removeAttribute("aria-modal");
    if (!document.querySelector(".modal.in")) document.body.classList.remove("modal-open");
    trigger(modal, "hidden.bs.modal");
  }
  document.addEventListener("click", (event) => {
    const $ = jq();
    if ($ && $.fn.modal) return;
    const dismiss = event.target.closest('[data-dismiss="modal"]');
    if (dismiss) {
      const modal = dismiss.closest(".modal");
      if (modal) hideModal(modal);
    }
  });

  // ---- notifications ------------------------------------------------------------
  function notify(grid, message, kind = "error") {
    const host = document.querySelector("#content-container, .page-heading") || grid.parentElement || document.body;
    let box = host.querySelector(":scope > .notifications");
    if (!box) {
      box = document.createElement("div");
      box.className = "notifications";
      host.prepend(box);
    }
    const alert = document.createElement("div");
    alert.className = kind === "error" ? "notification alert alert-danger error alert-dismissible" : "notification alert alert-success success alert-dismissible";
    alert.setAttribute("role", "alert");
    alert.innerHTML = `<button type="button" class="close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">&times;</span></button>${kind === "error" ? "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> " : ""}${esc(message)}`;
    alert.querySelector(".close").addEventListener("click", () => alert.remove());
    box.append(alert);
    if (kind !== "error") setTimeout(() => alert.remove(), 5000);
  }

  // ---- layouts ------------------------------------------------------------------
  function parseLayouts(value) {
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      try {
        return JSON.parse(decodeURIComponent(escape(atob(value))));
      } catch {
        return [];
      }
    }
  }
  const withQuery = (url, params) => {
    const target = new URL(url, location.href);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") target.searchParams.append(key, value);
    return target.origin === location.origin ? target.pathname + target.search : target.href;
  };

  // ---- grid ---------------------------------------------------------------------------
  const ACTION = { Details: 1, Edit: 2, Insert: 3, Delete: 4, Associate: 5, Disassociate: 6, Workflow: 7, Download: 8, Deactivate: 17, Activate: 18 };

  class EntityGrid {
    constructor(element) {
      this.element = element;
      element.__ppEntityGrid = this;
      const $ = jq();
      const data = (name) => element.getAttribute(`data-${name}`);
      this.layouts = parseLayouts(data("view-layouts"));
      this.getUrl = data("get-url");
      this.updateUrl = data("update-url");
      this.deferLoading = data("defer-loading") === "true";
      this.enableActions = data("enable-actions") === "true";
      this.selectMode = data("select-mode") || "None";
      this.gridClass = data("grid-class") || "";
      this.widthStyle = data("column-width-style") || "Percent";
      this.selectedView = data("selected-view");
      this.reference = { entity: data("ref-entity"), id: data("ref-id"), rel: data("ref-rel"), role: data("ref-rel-role") };
      this.state = { page: 1, pages: 1, pageSize: null, sort: null, filter: null, metaFilter: null, selected: null, loading: null };
      if ($) {
        $(element).data("entityGrid", this);
        $(element).data("totalRecordCount", 0);
      }
      on(element, "refresh", (event) => {
        if (event.target !== element) return;
        this.load(this.state.page || 1);
      });
      on(element, "metafilter", (event, metaFilter) => {
        if (event.target !== element) return;
        this.state.metaFilter = typeof metaFilter === "string" ? metaFilter : null;
        this.state.page = 1;
        this.load(1);
      });
      const initialFilter = new URLSearchParams(location.search).get(this.layout?.Configuration?.FilterSettings?.FilterQueryStringParameterName || "mf");
      if (initialFilter) this.state.metaFilter = initialFilter;
      this.render(!this.deferLoading);
    }

    get layout() {
      return (
        this.layouts.find((layout) => this.selectedView && String(layout.Id).toLowerCase().includes(String(this.selectedView).toLowerCase())) ??
        this.layouts[0]
      );
    }
    get config() {
      return this.layout?.Configuration ?? {};
    }
    child(selector) {
      return [...this.element.children].find((node) => node.matches(selector));
    }

    render(load) {
      const layout = this.layout;
      if (!layout) {
        this.showMessage(".view-error");
        return;
      }
      this.renderToolbar();
      this.renderTable();
      if (load) this.load(1);
    }

    renderToolbar() {
      this.child(".view-toolbar")?.remove();
      const config = this.config;
      const toolbar = document.createElement("div");
      toolbar.className = "view-toolbar grid-actions clearfix";
      if (this.layouts.length > 1) {
        const select = document.createElement("ul");
        select.className = "view-select nav nav-pills pull-left";
        const current = this.layout;
        const name = current.Configuration?.ViewDisplayName || current.ViewName;
        select.innerHTML = `<li class="dropdown"><a class="selected-view dropdown-toggle" data-toggle="dropdown" href="#" role="button" title="${esc(name)}" aria-label="${esc(name)}"><span class="fa fa-list" aria-hidden="true"></span><span class="title"> ${esc(name)}</span><span class="caret" aria-hidden="true"></span></a><ul class="dropdown-menu" role="menu">${this.layouts
          .map(
            (layout) =>
              `<li role="none"${layout === current ? ' class="active"' : ""}><a href="#" role="menuitem" data-view-id="${esc(layout.Id)}" aria-label="${esc(layout.Configuration?.ViewDisplayName || layout.ViewName)}">${esc(layout.Configuration?.ViewDisplayName || layout.ViewName)}</a></li>`,
          )
          .join("")}</ul></li>`;
        onClick(select, (event) => {
          const item = event.target.closest("[data-view-id]");
          if (item) {
            event.preventDefault();
            this.changeView(item.getAttribute("data-view-id"));
            return;
          }
          const toggle = event.target.closest(".dropdown-toggle");
          if (toggle && !(jq() && jq().fn.dropdown)) {
            event.preventDefault();
            toggle.parentElement.classList.toggle("open");
          }
        });
        toolbar.append(select);
      }
      const actions = document.createElement("div");
      actions.className = "pull-right toolbar-actions";
      const search = config.Search;
      if (search?.Enabled) {
        const group = document.createElement("div");
        group.className = "input-group pull-left view-search entitylist-search";
        group.setAttribute("role", "none");
        group.innerHTML = `<input placeholder="${esc(search.PlaceholderText || "Search")}" title="${esc(search.TooltipText || "")}" aria-label="${esc(search.TooltipText || search.PlaceholderText || "Search")}" class="query form-control"><div class="input-group-btn" role="presentation"><button type="button" aria-label="${esc(resource("Search_Results", "Search Results"))}" title="${esc(resource("Search_Results", "Search Results"))}" class="btn btn-default btn-hg">${search.ButtonLabel || "<span class='sr-only'>Search Results</span><span class='fa fa-search'></span>"}</button></div>`;
        const input = group.querySelector("input");
        const searchValue = new URLSearchParams(location.search).get(search.SearchQueryStringParameterName || "query");
        if (searchValue && !this.isLookup) input.value = searchValue;
        group.querySelector("button").addEventListener("click", () => this.load(1));
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.load(1);
          }
        });
        actions.append(group);
      }
      if (this.enableActions)
        for (const action of config.ViewActionLinks ?? []) {
          if (!action.Enabled) continue;
          if (action.Type === ACTION.Insert) actions.append(this.createActionElement(action));
          else if (action.Type === ACTION.Associate) {
            const link = document.createElement("a");
            link.href = "#";
            link.className = "btn btn-info pull-right action";
            link.setAttribute("role", "button");
            link.setAttribute("tabindex", "0");
            link.title = action.Tooltip || plain(action.Label);
            link.innerHTML = action.Label;
            onClick(link, (event) => {
              event.preventDefault();
              const modal = this.element.querySelector(".associate-lookup .modal-associate");
              if (modal) showModal(modal);
            });
            const group = document.createElement("div");
            group.className = "input-group pull-left";
            group.append(link);
            actions.append(group);
          } else if (action.Type === ACTION.Download) {
            const group = document.createElement("div");
            group.className = "input-group pull-left";
            const link = document.createElement("a");
            link.href = "#";
            link.className = "entitylist-download btn btn-info pull-right action";
            link.title = action.Tooltip || plain(action.Label);
            link.innerHTML = action.Label;
            onClick(link, (event) => {
              event.preventDefault();
              this.download(action, link);
            });
            group.append(link);
            actions.append(group);
          }
        }
      if (actions.children.length) toolbar.append(actions);
      if (toolbar.children.length) this.element.prepend(toolbar);
    }

    createActionElement(action) {
      const group = document.createElement("div");
      group.className = "input-group pull-left";
      const link = document.createElement("a");
      const inactive = this.parentInactive();
      let href = "#";
      if ((action.Target === 1 || action.Target === 2) && action.URL?.PathWithQueryString)
        href = this.withReference(action.URL.PathWithQueryString);
      link.href = href;
      link.className = "btn btn-primary pull-right action create-action";
      link.title = action.Tooltip || plain(action.Label) || "Create";
      link.setAttribute("tabindex", "0");
      link.setAttribute("role", "button");
      link.innerHTML = action.Label;
      if (href !== "#" && window.parent !== window) link.target = "_top";
      if (action.Target === 0 && action.EntityForm) {
        const modal = this.child(".modal-form-insert");
        if (modal) this.bindFormModal(modal, link);
        onClick(link, (event) => {
          event.preventDefault();
          if (!modal) return;
          const frame = modal.querySelector("iframe");
          const page = frame.getAttribute("data-page");
          this.openFormModal(modal, this.withReference(withQuery(page, { entityformid: action.EntityForm.Id, languagecode: this.config.LanguageCode || 1033 })));
        });
      }
      if (inactive) group.hidden = true;
      group.append(link);
      return group;
    }

    parentInactive() {
      const state = this.element.closest(".entity-form")?.querySelector(":scope > input[type=hidden][id$='_EntityState']");
      return Boolean(state && state.value !== "" && state.value !== "0");
    }

    withReference(url) {
      const { entity, id, rel, role } = this.reference;
      if (!entity || !id || !rel) return url;
      return withQuery(url, { refentity: entity, refid: id, refrel: rel, refrelrole: role || undefined });
    }

    bindFormModal(modal, focusTarget) {
      const $ = jq();
      const reset = () => {
        modal.setAttribute("aria-hidden", "true");
        const frame = modal.querySelector("iframe");
        if (frame) frame.setAttribute("src", "");
        if (focusTarget && focusTarget.isConnected) focusTarget.focus();
      };
      if ($) $(modal).off("hidden.bs.modal.entitygrid").on("hidden.bs.modal.entitygrid", reset);
      else modal.addEventListener("hidden.bs.modal", reset);
    }

    openFormModal(modal, src) {
      const frame = modal.querySelector("iframe");
      const loading = modal.querySelector(".form-loading");
      if (loading) loading.style.display = "";
      frame.onload = () => {
        if (loading) loading.style.display = "none";
        try {
          const form = frame.contentDocument?.getElementById("EntityFormControl");
          if (form) form.style.display = "";
        } catch {
          /* cross-origin frames are not inspected */
        }
      };
      frame.setAttribute("src", src);
      modal.setAttribute("aria-hidden", "false");
      showModal(modal);
    }

    renderTable() {
      const container = this.child(".view-grid");
      if (!container) return;
      const layout = this.layout;
      const table = document.createElement("table");
      table.setAttribute("aria-relevant", "additions");
      table.className = `table${this.gridClass ? " " + this.gridClass : ""} table-fluid${this.selectMode !== "None" ? " table-hover" : ""}`;
      const head = document.createElement("thead");
      const row = document.createElement("tr");
      const sortParts = String(this.state.sort ?? layout.SortExpression ?? "").split(",").map((part) => part.trim().split(/\s+/));
      for (const column of layout.Columns ?? []) {
        const th = document.createElement("th");
        th.setAttribute("scope", "col");
        th.style.width = this.widthStyle === "Pixels" ? `${column.Width}px` : `${column.WidthAsPercent}%`;
        const name = column.Name ?? column.LogicalName;
        if (column.Type === 1 || column.Type === 2 || column.SortDisabled) {
          th.className = "sort-disabled";
          if (column.Type === 1) {
            th.setAttribute("aria-label", "Select");
            th.setAttribute("data-th", name);
          } else if (column.Type === 2) {
            th.setAttribute("aria-label", "Actions");
            th.setAttribute("data-th", name);
          }
          th.innerHTML = name;
        } else {
          const sorted = sortParts.find((part) => part[0] === column.LogicalName);
          th.className = "sort-enabled";
          const ascending = sorted && !/desc/i.test(sorted[1] ?? "");
          if (sorted) {
            th.classList.add("sort", ascending ? "sort-asc" : "sort-desc");
            th.setAttribute("aria-sort", ascending ? "ascending" : "descending");
          }
          const userSorted = this.state.sort != null;
          const hint = sorted ? (userSorted ? (ascending ? "Sort_Descending_Order" : "Sort_Ascending_Order") : "Sort_Ascending_Order") : "Sort_Descending_Order";
          th.innerHTML = `<a href="#" role="button" aria-label="${esc(plain(name))}" tabindex="0">${name}${sorted ? ` <span class="fa ${ascending ? "fa-arrow-up" : "fa-arrow-down"}" aria-hidden="true"></span>` : ""}<span class="sr-only sort-hint">. ${esc(resource(hint, hint === "Sort_Descending_Order" ? "sort descending" : "sort ascending"))}</span></a>`;
          onClick(th.querySelector("a"), (event) => {
            event.preventDefault();
            if (this.state.loading) return;
            const direction = sorted && ascending ? "DESC" : "ASC";
            this.state.sort = `${column.LogicalName} ${direction}`;
            this.renderTable();
            this.load(1);
          });
        }
        row.append(th);
      }
      head.append(row);
      table.append(head, document.createElement("tbody"));
      container.replaceChildren(table);
    }

    showMessage(selector) {
      for (const name of [".view-empty", ".view-access-denied", ".view-error", ".view-loading"]) {
        const node = this.child(name);
        if (node) node.style.display = name === selector ? "block" : "none";
      }
    }

    requestBody(page) {
      const layout = this.layout;
      const search = this.child(".view-toolbar")?.querySelector(".view-search input.query");
      const pageSize = this.state.pageSize ?? layout.Configuration?.PageSize ?? 10;
      const body = {
        base64SecureConfiguration: layout.Base64SecureConfiguration,
        sortExpression: this.state.sort ?? layout.SortExpression ?? "",
        search: search ? search.value : null,
        page,
        pageSize,
        pagingCookie: "",
        filter: this.state.filter,
        metaFilter: this.state.metaFilter,
        nlSearchFilter: "",
        timezoneOffset: new Date().getTimezoneOffset(),
        customParameters: [],
      };
      const form = this.element.closest(".entity-form");
      if (form) {
        body.entityName = form.querySelector(":scope > input[type=hidden][id$='_EntityName']")?.value;
        body.entityId = form.querySelector(":scope > input[type=hidden][id$='_EntityID']")?.value;
      }
      return body;
    }

    load(page = 1) {
      if (!this.layout) return Promise.resolve();
      if (!this.layout.Base64SecureConfiguration) {
        this.showMessage(".view-error");
        return Promise.resolve();
      }
      const body = this.requestBody(page);
      this.state.page = page;
      this.showMessage(".view-loading");
      for (const link of this.element.querySelectorAll(".view-grid th a")) link.style.pointerEvents = "none";
      const request = (this.state.loading = post(this.getUrl, body));
      return request
        .then((data) => {
          if (request !== this.state.loading) return;
          this.showMessage(null);
          if (!data || data.AccessDenied) {
            this.child(".view-access-denied").style.display = data?.AccessDenied ? "block" : "none";
            if (!data?.AccessDenied) this.child(".view-empty").style.display = "block";
            this.renderRows({ Records: [] });
            trigger(this.element, "loaded");
            return;
          }
          if (data.CreateActionMetadata?.Disabled)
            for (const link of this.element.querySelectorAll(".create-action")) {
              link.title = data.CreateActionMetadata.DisabledMessage || link.title;
              onClick(link, (event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
                alert(data.CreateActionMetadata.DisabledMessage || "");
              });
            }
          this.data = data;
          const $ = jq();
          if ($) $(this.element).data("totalRecordCount", data.ItemCount);
          this.renderRows(data);
          if (!data.Records?.length) this.child(".view-empty").style.display = "block";
          this.renderPagination(data);
          trigger(this.element, "loaded");
        })
        .catch((error) => {
          if (request !== this.state.loading) return;
          this.showMessage(".view-error");
          const details = this.child(".view-error")?.querySelector(".details");
          if (details) details.textContent = error.message;
          console.error(error);
        })
        .finally(() => {
          if (request === this.state.loading) this.state.loading = null;
          for (const link of this.element.querySelectorAll(".view-grid th a")) link.style.pointerEvents = "";
        });
    }

    primaryName(record) {
      const primary = record.Attributes?.find((attribute) => attribute.AttributeMetadata?.IsPrimaryName && attribute.AttributeMetadata?.EntityLogicalName === record.EntityName);
      if (primary) return primary.DisplayValue ?? primary.FormattedValue ?? "";
      const first = this.layout.Columns.find((column) => column.Type === 0);
      const attribute = record.Attributes?.find((candidate) => candidate.Name === first?.LogicalName);
      return attribute?.DisplayValue ?? attribute?.FormattedValue ?? "";
    }

    cellValue(attribute) {
      if (!attribute) return "";
      return attribute.Value !== null && typeof attribute.Value === "object" ? JSON.stringify(attribute.Value) : attribute.Value ?? "";
    }

    cellContent(attribute) {
      if (!attribute) return "";
      const display = attribute.DisplayValue ?? attribute.FormattedValue ?? "";
      if (attribute.Type === "System.DateTime" && attribute.Value) {
        const iso = typeof attribute.DisplayValue === "string" ? attribute.DisplayValue : "";
        return `<time datetime="${esc(iso)}">${esc(attribute.FormattedValue ?? iso)}</time>`;
      }
      const format = attribute.AttributeMetadata?.Format;
      if (attribute.Type === "System.String" && display) {
        if (format === 0) return `<a href="mailto:${esc(display)}">${esc(display)}</a>`;
        if (format === 3) return `<a href="${esc(/^https?:/i.test(display) ? display : "http://" + display)}" target="_blank">${esc(display)}</a>`;
      }
      return esc(display);
    }

    actionUrl(action, record) {
      if (!action.URL?.PathWithQueryString) return null;
      return withQuery(action.URL.PathWithQueryString, { [action.QueryStringIdParameterName || "id"]: record.Id });
    }

    renderRows(data) {
      const table = this.child(".view-grid")?.querySelector("table");
      if (!table) return;
      const tbody = table.tBodies[0];
      tbody.replaceChildren();
      tbody.setAttribute("style", "");
      if (this.selectMode === "Single") tbody.setAttribute("role", "radiogroup");
      const config = this.config;
      const details = this.enableActions ? (config.ItemActionLinks ?? []).find((action) => action.Type === ACTION.Details && action.Enabled) ?? (config.DetailsActionLink?.Enabled ? config.DetailsActionLink : null) : null;
      const disabled = new Set((data.DisabledItemActionLinks ?? []).map((item) => `${String(item.EntityId).toLowerCase()}|${String(item.LinkUniqueId).toLowerCase()}`));
      let firstData = true;
      for (const record of data.Records ?? []) {
        const tr = document.createElement("tr");
        const name = this.primaryName(record);
        tr.setAttribute("data-id", record.Id);
        tr.setAttribute("data-entity", record.EntityName);
        tr.setAttribute("data-name", name);
        firstData = true;
        for (const column of this.layout.Columns ?? []) {
          const td = document.createElement("td");
          if (column.Type === 1) {
            td.setAttribute("data-th", "Select");
            td.setAttribute("aria-label", "");
            td.innerHTML = `<span class="fa fa-fw" role="checkbox" aria-label="${esc(name)}" title="${esc(name)}" tabindex="0" aria-checked="false"></span>`;
          } else if (column.Type === 2) {
            td.setAttribute("aria-label", "action menu");
            const items = this.itemActions(record, disabled);
            if (items.length) {
              td.innerHTML = `<div class="dropdown action"><button class="btn btn-default btn-xs aria-exp" data-toggle="dropdown" aria-expanded="false" aria-label="action menu" title="action menu" type="button"><span class="fa fa-chevron-circle-down fa-fw" aria-hidden="true"></span></button><ul class="dropdown-menu" role="menu" style="position: fixed;"></ul></div>`;
              const menu = td.querySelector("ul");
              bindActionMenu(td.querySelector(".dropdown.action"));
              items.forEach((item, index) => {
                item.setAttribute("aria-setsize", String(items.length));
                item.setAttribute("aria-posinset", String(index + 1));
                const li = document.createElement("li");
                li.setAttribute("role", "none");
                li.append(item);
                menu.append(li);
              });
            }
          } else {
            const attribute = record.Attributes?.find((candidate) => candidate.Name === column.LogicalName);
            td.setAttribute("data-type", attribute?.Type ?? "");
            td.setAttribute("data-attribute", column.LogicalName);
            td.setAttribute("data-value", this.cellValue(attribute));
            td.setAttribute("data-th", plain(column.Name));
            td.setAttribute("aria-label", attribute?.FormattedValue ?? attribute?.DisplayValue ?? "");
            let content = this.cellContent(attribute);
            if (firstData && details) {
              const url = details.Target === 0 ? "#" : this.actionUrl(details, record) ?? "#";
              content = `<a href="${esc(url)}" class="details-link has-tooltip${details.Target === 0 ? " launch-modal" : ""}" data-toggle="tooltip" title="${esc(details.Tooltip || plain(details.Label))}"${details.Target === 0 && details.EntityForm ? ` data-entityformid="${esc(details.EntityForm.Id)}"` : ""}${url !== "#" && window.parent !== window ? ' target="_top"' : ""}>${attribute?.DisplayValue != null ? esc(attribute.DisplayValue) : content}</a>`;
            }
            td.innerHTML = content;
            firstData = false;
          }
          tr.append(td);
        }
        if (this.selectMode !== "None") this.bindSelection(tr);
        tbody.append(tr);
      }
      this.bindRowActions(tbody);
      if (this.selectMode === "Single") {
        const selected = String(this.state.selected ?? "").toLowerCase();
        const match = [...tbody.rows].find((tr) => tr.getAttribute("data-id") === selected);
        if (match) this.toggleRow(match, true);
      }
      const announcer = this.element.querySelector(":scope > .sr-only[id^='SearchCountText']");
      if (announcer) announcer.textContent = `${data.ItemCount ?? (data.Records ?? []).length} records found`;
    }

    itemActions(record, disabled) {
      if (!this.enableActions) return [];
      const items = [];
      for (const action of this.config.ItemActionLinks ?? []) {
        if (!action.Enabled) continue;
        if (disabled.has(`${String(record.Id).toLowerCase()}|${String(action.FilterCriteriaId).toLowerCase()}`)) continue;
        const link = document.createElement("a");
        link.setAttribute("role", "menuitem");
        link.setAttribute("tabindex", "-1");
        link.innerHTML = action.Label;
        link.title = action.Tooltip || plain(action.Label);
        link.href = "#";
        const formTarget = action.Target === 0 && action.EntityForm;
        switch (action.Type) {
          case ACTION.Details:
            if (!record.CanRead) continue;
            link.className = `details-link${formTarget ? " launch-modal" : ""}`;
            break;
          case ACTION.Edit:
            if (!record.CanWrite) continue;
            link.className = `edit-link${formTarget ? " launch-modal" : ""}`;
            break;
          case ACTION.Delete:
            if (!record.CanDelete) continue;
            link.className = "delete-link";
            break;
          case ACTION.Disassociate:
            if (!record.CanAppend && !record.CanWrite) continue;
            link.className = "disassociate-link";
            break;
          case ACTION.Workflow:
            link.className = "workflow-link";
            break;
          case ACTION.Deactivate:
            if (!record.CanWrite || record.StateCode !== 0) continue;
            link.className = "deactivate-link";
            break;
          case ACTION.Activate:
            if (!record.CanWrite || record.StateCode !== 1) continue;
            link.className = "activate-link";
            break;
          default:
            continue;
        }
        if (formTarget && (action.Type === ACTION.Details || action.Type === ACTION.Edit)) link.setAttribute("data-entityformid", action.EntityForm.Id);
        else if (action.Type === ACTION.Details || action.Type === ACTION.Edit) {
          const url = this.actionUrl(action, record);
          if (url) {
            link.href = url;
            if (window.parent !== window) link.target = "_top";
          }
        }
        link.__ppAction = action;
        items.push(link);
      }
      return items;
    }

    bindRowActions(tbody) {
      // Refresh replaces rows but retains the tbody. Bind the delegated handler
      // once so a saved modal cannot make the next toggle open and immediately close.
      if (tbody.__ppRowActionsBound) return;
      tbody.__ppRowActionsBound = true;
      tbody.addEventListener("click", (event) => {
        const link = event.target.closest("a.details-link, a.edit-link, a.delete-link, a.disassociate-link, a.workflow-link, a.deactivate-link, a.activate-link");
        if (!link || !tbody.contains(link)) {
          const toggle = event.target.closest('[data-toggle="dropdown"]');
          if (toggle && tbody.contains(toggle) && !(jq() && jq().fn.dropdown)) {
            event.preventDefault();
            const container = toggle.parentElement;
            const opening = !container.classList.contains("open");
            trigger(container, opening ? "show.bs.dropdown" : "hide.bs.dropdown");
            container.classList.toggle("open", opening);
            toggle.setAttribute("aria-expanded", opening ? "true" : "false");
          }
          return;
        }
        const tr = link.closest("tr");
        const record = this.data?.Records?.find((candidate) => candidate.Id === tr?.getAttribute("data-id"));
        if (!record) return;
        let action = link.__ppAction;
        if (!action && link.classList.contains("details-link"))
          action = (this.config.ItemActionLinks ?? []).find((candidate) => candidate.Type === ACTION.Details) ?? this.config.DetailsActionLink;
        if (!action) return;
        if ((action.Type === ACTION.Details || action.Type === ACTION.Edit) && !link.classList.contains("launch-modal")) return;
        if (event.defaultPrevented) return;
        event.preventDefault();
        this.runAction(action, record, link);
      });
    }

    runAction(action, record, link) {
      const config = this.config;
      switch (action.Type) {
        case ACTION.Details:
        case ACTION.Edit: {
          const modal = this.child(action.Type === ACTION.Edit ? ".modal-form-edit" : ".modal-form-details");
          if (!modal || !action.EntityForm) return;
          this.bindFormModal(modal, link);
          const page = modal.querySelector("iframe").getAttribute("data-page");
          this.openFormModal(modal, this.withReference(withQuery(page, { id: record.Id, entityformid: action.EntityForm.Id, languagecode: config.LanguageCode || 1033 })));
          return;
        }
        case ACTION.Delete:
          return this.confirmAndRun(".modal-delete", action, () =>
            post(`/_services/entity-grid-delete/${this.websiteId()}`, { LogicalName: record.EntityName, Id: record.Id, base64SecureConfiguration: this.layout.Base64SecureConfiguration }, { json: false }),
          { lastRow: true });
        case ACTION.Disassociate:
          return this.confirmAndRun(".modal-disassociate", action, () =>
            post(`/_services/entity-grid-disassociate/${this.websiteId()}`, {
              target: { LogicalName: this.reference.entity, Id: this.reference.id },
              RelatedEntities: [{ LogicalName: record.EntityName, Id: record.Id }],
              Relationship: { SchemaName: this.reference.rel, ...(this.reference.role ? { PrimaryEntityRole: this.reference.role === "Referenced" ? 1 : 0 } : {}) },
            }, { json: false }),
          { force: action.ShowModal === 1 });
        case ACTION.Deactivate:
        case ACTION.Activate:
          return this.confirmAndRun(action.Type === ACTION.Deactivate ? ".modal-deactivate" : ".modal-activate", action, () =>
            post(`/_services/${action.Type === ACTION.Deactivate ? "action-deactivate" : "action-activate"}/${this.websiteId()}`, { LogicalName: record.EntityName, Id: record.Id }, { json: false }),
          { force: action.ShowModal === 1 });
        case ACTION.Workflow:
          return this.confirmAndRun(".modal-run-workflow", action, () =>
            post(`/_services/execute-workflow/${this.websiteId()}`, { workflow: { LogicalName: "workflow", Id: action.Workflow?.Id }, entity: { LogicalName: record.EntityName, Id: record.Id } }, { json: false }),
          { force: action.ShowModal === 1 });
        default:
      }
    }

    websiteId() {
      // The portal scope segment of the grid data URL (the website id).
      const match = /\/_services\/[^/]+\/([^/?#]+)/i.exec(this.getUrl || "");
      return match ? match[1] : "";
    }

    confirmAndRun(selector, action, request, { lastRow = false, force = true } = {}) {
      const modal = this.child(selector);
      const run = () => {
        const primary = modal?.querySelector(".modal-footer button.primary");
        if (primary) {
          primary.disabled = true;
          primary.insertAdjacentHTML("afterbegin", "<span class='fa fa-spinner fa-spin' aria-hidden='true'></span> ");
        }
        return request()
          .then(() => {
            if (modal) hideModal(modal);
            if (lastRow && this.child(".view-grid")?.querySelectorAll("tbody tr").length === 1 && this.state.page > 1) this.state.page -= 1;
            if (action.SuccessMessage) notify(this.element, action.SuccessMessage, "success");
            this.complete(action);
          })
          .catch((error) => {
            if (modal) hideModal(modal);
            notify(this.element, error.message);
          })
          .finally(() => {
            if (primary) {
              primary.disabled = false;
              primary.querySelector(".fa-spinner")?.remove();
            }
          });
      };
      if (!modal || !force) return run();
      const body = modal.querySelector(".modal-body");
      if (body && action.Confirmation) body.innerHTML = action.Confirmation;
      const primary = modal.querySelector(".modal-footer button.primary");
      if (primary) {
        const replacement = primary.cloneNode(true);
        primary.replaceWith(replacement);
        replacement.addEventListener("click", run);
      }
      showModal(modal);
    }

    complete(action) {
      if ((action.OnComplete === 1 || action.OnComplete === 2) && action.RedirectUrl) {
        (window.parent !== window ? window.parent : window).location.replace(action.RedirectUrl);
        return;
      }
      trigger(this.element, "refresh");
    }

    bindSelection(tr) {
      tr.tabIndex = 0;
      tr.setAttribute("role", this.selectMode === "Single" ? "radio" : "checkbox");
      tr.setAttribute("aria-checked", "false");
      const toggle = (event) => {
        if (event.target.closest("a, button, input")) return;
        this.toggleRow(tr);
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.toggleRow(tr);
        }
      });
    }

    toggleRow(tr, force) {
      const select = force ?? !tr.classList.contains("selected");
      if (this.selectMode === "Single" && select)
        for (const other of tr.parentElement.rows) if (other !== tr) this.setRowSelected(other, false);
      this.setRowSelected(tr, select);
      trigger(this.element, "selected", { id: tr.getAttribute("data-id"), selected: select });
    }

    setRowSelected(tr, selected) {
      tr.classList.toggle("selected", selected);
      tr.classList.toggle("info", selected);
      tr.setAttribute("aria-checked", selected ? "true" : "false");
      const box = tr.querySelector('td[data-th="Select"] span[role="checkbox"]');
      if (box) {
        box.classList.toggle("fa-check", selected);
        box.setAttribute("aria-checked", selected ? "true" : "false");
      }
    }

    selectedRows() {
      return [...(this.child(".view-grid")?.querySelectorAll("tbody tr.selected") ?? [])];
    }

    renderPagination(data) {
      const pagination = this.child(".view-pagination");
      const grid = this.child(".view-grid");
      if (!pagination) return;
      const $ = jq();
      const pageSize = data.PageSize;
      const pages = data.PageCount;
      const current = data.PageNumber;
      this.state.pages = pages;
      this.state.pageSize = pageSize;
      if ($) $(pagination).data({ pagesize: pageSize, pages, "current-page": current, count: data.ItemCount });
      if (data.ItemCount === -1) {
        if (current === 1 && !data.MoreRecords) {
          pagination.style.display = "none";
          grid?.classList.remove("has-pagination");
          return;
        }
        pagination.innerHTML = `<ul class="pagination"><li${current > 1 ? "" : ' class="disabled"'}><a href="#" data-page="${current - 1}" aria-label="Previous page" role="button"${current > 1 ? "" : ' aria-disabled="true"'}>&lt;</a></li><li class="active"><span>${current}</span></li><li${data.MoreRecords ? "" : ' class="disabled"'}><a href="#" data-page="${current + 1}" aria-label="Next page" role="button"${data.MoreRecords ? "" : ' aria-disabled="true"'}>&gt;</a></li></ul>`;
      } else {
        if (!(pages > 1)) {
          pagination.style.display = "none";
          pagination.replaceChildren();
          grid?.classList.remove("has-pagination");
          return;
        }
        const span = 8;
        let start = Math.max(1, current - Math.floor(span / 2));
        const end = Math.min(pages, start + span - 1);
        start = Math.max(1, end - span + 1);
        const item = (page, label, { active = false, disabled = false, aria, className } = {}) =>
          `<li${active ? ' class="active"' : disabled ? ' class="disabled"' : ""}><a${disabled ? "" : ' href="#"'}${aria ? ` aria-label="${esc(aria)}"` : ""} data-page="${page}" role="button"${active ? ' aria-current="page"' : ""}${disabled ? ' aria-disabled="true"' : ""}${className ? ` class="${className}"` : ""}>${esc(label)}</a></li>`;
        const parts = [
          item(current > 1 ? current - 1 : 0, resource("Pagination_Previous_Page", "Previous"), { disabled: current <= 1, aria: "Previous page", className: "entity-pager-prev-link" }),
        ];
        if (start > 1) {
          parts.push(item(1, "1", { aria: "page 1" }));
          if (start > 2) parts.push(item("..", "..", { disabled: true, aria: "Load more pages" }));
        }
        for (let page = start; page <= end; page++) parts.push(item(page, String(page), { active: page === current, aria: page === current ? null : `page ${page}` }));
        if (end < pages) {
          if (end < pages - 1) parts.push(item("..", "..", { disabled: true, aria: "Load more pages" }));
          parts.push(item(pages, String(pages), { aria: `page ${pages}` }));
        }
        parts.push(item(current < pages ? current + 1 : 0, resource("Pagination_Next_Page", "Next"), { disabled: current >= pages, aria: "Next page", className: "entity-pager-next-link" }));
        pagination.innerHTML = `<div class="jquery-bootstrap-pagination"><ul class="pagination">${parts.join("")}</ul></div>`;
      }
      pagination.style.display = "";
      grid?.classList.add("has-pagination");
      pagination.onclick = (event) => {
        const link = event.target.closest("a[data-page]");
        if (!link || !pagination.contains(link)) return;
        event.preventDefault();
        const li = link.parentElement;
        if (li.classList.contains("disabled") || li.classList.contains("active")) return;
        const page = Number(link.getAttribute("data-page"));
        if (!Number.isFinite(page) || page < 1) return;
        this.load(page);
      };
    }

    changeView(id) {
      this.selectedView = id;
      this.element.setAttribute("data-selected-view", id);
      this.state.sort = null;
      this.state.page = 1;
      this.render(true);
    }

    download(action, link) {
      link.classList.add("disabled");
      post(action.URL?.Path || `/_services/download-as-excel/${this.websiteId()}`, {
        viewName: this.layout.ViewName,
        columns: this.layout.Columns,
        base64SecureConfiguration: this.layout.Base64SecureConfiguration,
        sortExpression: this.state.sort ?? this.layout.SortExpression,
        search: this.child(".view-toolbar")?.querySelector(".view-search input.query")?.value ?? null,
        filter: this.state.filter,
        metaFilter: this.state.metaFilter,
        page: this.state.page,
        pageSize: this.state.pageSize,
        timezoneOffset: new Date().getTimezoneOffset(),
      })
        .then((result) => {
          if (result?.sessionKey) window.location = `${action.URL?.Path || `/_services/download-as-excel/${this.websiteId()}`}?key=${encodeURIComponent(result.sessionKey)}`;
        })
        .catch((error) => notify(this.element, error.message))
        .finally(() => link.classList.remove("disabled"));
    }
  }

  // ---- lookup modal -------------------------------------------------------------
  function initLookup(container) {
    if (container.__ppLookup) return;
    container.__ppLookup = true;
    const field = container.getAttribute("data-lookup-datafieldname");
    const modal = container.querySelector(":scope > .modal-lookup, :scope > section.modal");
    const gridElement = modal?.querySelector(".entity-grid");
    if (!field || !modal || !gridElement) return;
    const grid = gridElement.__ppEntityGrid ?? new EntityGrid(gridElement);
    grid.isLookup = true;
    const id = () => document.getElementById(field);
    const nameInput = () => document.getElementById(`${field}_name`);
    const entityInput = () => document.getElementById(`${field}_entityname`);
    const control = container.closest(".control") || id()?.closest(".control") || document;
    const clearButton = () => control.querySelector(".clearlookupfield");
    const primary = modal.querySelector(".modal-footer button.primary");
    const remove = modal.querySelector(".modal-footer .remove-value");
    const sync = () => {
      const hasValue = Boolean(id()?.value);
      const clear = clearButton();
      if (clear) clear.style.display = hasValue ? "" : "none";
      if (remove) remove.disabled = !hasValue;
    };
    const setValue = (value, name, entity) => {
      const input = id();
      if (!input) return;
      if (nameInput()) nameInput().value = name;
      if (entityInput()) entityInput().value = entity;
      input.value = value;
      const $ = jq();
      if ($) $(input).trigger("change");
      else input.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof window.setIsDirty === "function") window.setIsDirty(field);
      sync();
    };
    const clear = () => {
      setValue("", "", "");
      hideModal(modal);
    };
    control.querySelector(".launchentitylookup")?.addEventListener("click", (event) => {
      event.preventDefault();
      grid.state.page = 1;
      showModal(modal);
    });
    clearButton()?.addEventListener("click", (event) => {
      event.preventDefault();
      setValue("", "", "");
    });
    nameInput()?.addEventListener("keydown", (event) => {
      if ((event.key === "Backspace" || event.key === "Delete") && id()?.value && !nameInput().disabled) {
        event.preventDefault();
        setValue("", "", "");
      }
    });
    on(modal, "show.bs.modal", (event) => {
      if (event.target !== modal) return;
      grid.state.selected = id()?.value || null;
      if (primary) primary.disabled = true;
      sync();
      trigger(gridElement, "refresh");
    });
    on(modal, "hidden.bs.modal", (event) => {
      if (event.target !== modal) return;
      const query = gridElement.querySelector(".view-search input.query");
      if (query) query.value = "";
      for (const tr of grid.selectedRows()) grid.setRowSelected(tr, false);
    });
    on(gridElement, "selected", () => {
      if (primary) primary.disabled = !grid.selectedRows().length;
    });
    on(gridElement, "loaded", (event) => {
      if (event.target !== gridElement) return;
      if (primary) primary.disabled = !grid.selectedRows().length;
    });
    primary?.addEventListener("click", (event) => {
      event.preventDefault();
      const row = grid.selectedRows()[0];
      if (!row) return;
      setValue(row.getAttribute("data-id"), row.getAttribute("data-name"), row.getAttribute("data-entity"));
      hideModal(modal);
      nameInput()?.focus();
    });
    remove?.addEventListener("click", (event) => {
      event.preventDefault();
      clear();
    });
    const createButton = modal.querySelector(".modal-footer .new-value");
    const createModal = container.querySelector(".modal-lookup-create-form");
    if (createButton && createModal) {
      createButton.addEventListener("click", (event) => {
        event.preventDefault();
        const frame = createModal.querySelector("iframe");
        const page = frame.getAttribute("data-page");
        const listener = (message) => {
          if (message.origin !== location.origin) return;
          let data = message.data;
          try {
            data = typeof data === "string" ? JSON.parse(data) : data;
          } catch {
            return;
          }
          if (data?.type !== "Success") return;
          window.removeEventListener("message", listener);
          hideModal(createModal);
          grid.state.selected = data.id;
          trigger(gridElement, "refresh");
        };
        window.addEventListener("message", listener);
        grid.openFormModal(createModal, withQuery(page, { lookup: "true", entityformid: container.getAttribute("data-lookup-reference_entityformid"), languagecode: container.getAttribute("data-languagecode") || 1033 }));
      });
    }
    sync();
  }

  // ---- associate dialog ---------------------------------------------------------
  function initAssociate(container) {
    if (container.__ppAssociate) return;
    container.__ppAssociate = true;
    const modal = container.querySelector(".modal-associate");
    const gridElement = modal?.querySelector(".entity-grid");
    if (!modal || !gridElement) return;
    const grid = gridElement.__ppEntityGrid ?? new EntityGrid(gridElement);
    const selected = modal.querySelector(".selected-records");
    const parent = container.closest(".entity-grid.subgrid") || container.parentElement.closest(".entity-grid");
    let succeeded = false;
    const syncSelection = () => {
      selected.replaceChildren(
        ...grid.selectedRows().map((tr) => {
          const item = document.createElement("div");
          item.className = "item pull-left btn btn-default";
          item.setAttribute("data-entity", tr.getAttribute("data-entity"));
          item.setAttribute("data-id", tr.getAttribute("data-id"));
          item.setAttribute("data-name", tr.getAttribute("data-name"));
          item.innerHTML = `<span class="name">${esc(tr.getAttribute("data-name"))}</span><span class="remove"><span class="fa fa-times" aria-hidden="true"></span></span>`;
          item.querySelector(".remove").addEventListener("click", () => {
            grid.setRowSelected(tr, false);
            syncSelection();
          });
          return item;
        }),
      );
    };
    on(gridElement, "selected", syncSelection);
    on(modal, "show.bs.modal", (event) => {
      if (event.target !== modal) return;
      succeeded = false;
      selected.replaceChildren();
      modal.querySelector(".modal-body > .alert")?.remove();
      trigger(gridElement, "refresh");
    });
    on(modal, "hidden.bs.modal", (event) => {
      if (event.target !== modal || !succeeded) return;
      if (parent) trigger(parent, "refresh");
    });
    modal.querySelector(".modal-footer .btn-primary")?.addEventListener("click", (event) => {
      event.preventDefault();
      let payload;
      try {
        payload = JSON.parse(container.getAttribute("data-associate") || "{}");
      } catch {
        payload = {};
      }
      payload.RelatedEntities = grid.selectedRows().map((tr) => ({ LogicalName: tr.getAttribute("data-entity"), Id: tr.getAttribute("data-id"), Name: tr.getAttribute("data-name") }));
      if (!payload.RelatedEntities.length) return;
      post(container.getAttribute("data-url"), payload, { json: false })
        .then(() => {
          succeeded = true;
          hideModal(modal);
        })
        .catch((error) => {
          modal.querySelector(".modal-body > .alert")?.remove();
          modal.querySelector(".modal-body").insertAdjacentHTML("afterbegin", `<div class="alert alert-block alert-danger error clearfix"><p><span class='fa fa-exclamation-triangle' aria-hidden='true'></span> ${esc(error.message)}</p></div>`);
        });
    });
  }

  // ---- notes ----------------------------------------------------------------------
  function initNotes(container) {
    if (container.__ppNotes) return;
    container.__ppNotes = true;
    const regarding = (() => {
      try {
        return JSON.parse(container.getAttribute("data-target") || "{}");
      } catch {
        return {};
      }
    })();
    const list = container.querySelector(".notes");
    const state = { page: 1 };
    const show = (selector) => {
      for (const name of [".notes-empty", ".notes-access-denied", ".notes-error", ".notes-loading"]) {
        const node = container.querySelector(name);
        if (node) node.style.display = name === selector ? "block" : "none";
      }
    };
    const load = (page = 1) => {
      state.page = page;
      show(".notes-loading");
      return post(container.getAttribute("data-url-get"), { regarding: { LogicalName: regarding.LogicalName, Id: regarding.Id }, orders: JSON.parse(container.getAttribute("data-orders") || "[]"), page, pageSize: Number(container.getAttribute("data-pagesize")) || 10 })
        .then((data) => {
          show(data.Records?.length ? null : ".notes-empty");
          list.innerHTML = (data.Records ?? [])
            .map(
              (note) =>
                `<div class="note" data-id="${esc(note.Id)}" data-canedit="${note.CanWrite}" data-candelete="${note.CanDelete}" data-unformattedtext="${esc(note.UnformattedText)}" data-isprivate="${note.IsPrivate}" data-hasattachment="${note.HasAttachment}" data-attachmentfilename="${esc(note.AttachmentFileName ?? "")}" data-attachmentfilesize="${esc(note.AttachmentSizeDisplay ?? "")}" data-attachmenturl="${esc(note.AttachmentUrl ?? "")}"><div class="row"><div class="col-sm-3 metadata"><div class="postedon"><abbr class="timeago" title="${esc(note.CreatedOnDisplay ?? "")}">${esc(note.CreatedOnDisplay ?? "")}</abbr></div><div class="createdby text-muted">${esc(note.PostedByName ?? "")}</div>${note.IsPrivate ? '<div class="label label-warning">Private</div>' : ""}</div><div class="col-sm-9 content">${note.DisplayToolbar ? `<div class="toolbar dropdown pull-right"><a href="#" class="edit-link" title="Edit">Edit</a> <a href="#" class="delete-link" title="Delete">Delete</a></div>` : ""}<div class="text">${note.Text ?? ""}</div>${note.HasAttachment ? `<div class="attachment alert alert-block alert-info clearfix"><div class="link pull-left"><a href="${esc(note.AttachmentUrl)}?t=${Date.now()}"><span class="fa fa-file" aria-hidden="true"></span> ${esc(note.AttachmentFileName)} (${esc(note.AttachmentSizeDisplay)})</a></div></div>` : ""}</div></div></div>`,
            )
            .join("");
          trigger(container, "loaded");
        })
        .catch((error) => {
          show(".notes-error");
          const details = container.querySelector(".notes-error .details");
          if (details) details.textContent = error.message;
        });
    };
    const readFile = (input) =>
      new Promise((resolve, reject) => {
        const file = input?.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, type: file.type, content: String(reader.result).replace(/^data:[^,]*,/, "") });
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    const dialog = (selector) => container.querySelector(selector) || document.querySelector(selector);
    const submit = (modal, url, extra) =>
      readFile(modal.querySelector('input[type="file"]')).then((file) =>
        post(url, { ...extra, text: modal.querySelector('textarea[name="text"]')?.value ?? "", isPrivate: modal.querySelector('input[name="isPrivate"]')?.checked ?? false, file }, { json: true })
          .then(() => {
            hideModal(modal);
            load(state.page);
          })
          .catch((error) => {
            modal.querySelector(".modal-body > .alert")?.remove();
            modal.querySelector(".modal-body").insertAdjacentHTML("afterbegin", `<div class="alert alert-block alert-danger error">${esc(error.message)}</div>`);
          }),
      );
    container.querySelector(".addnote")?.addEventListener("click", (event) => {
      event.preventDefault();
      const modal = dialog(".modal-addnote");
      if (!modal) return;
      modal.querySelector("textarea")?.value && (modal.querySelector("textarea").value = "");
      const primary = modal.querySelector(".modal-footer .primary");
      const replacement = primary.cloneNode(true);
      primary.replaceWith(replacement);
      replacement.addEventListener("click", () => submit(modal, container.getAttribute("data-url-add"), { regardingEntityLogicalName: regarding.LogicalName, regardingEntityId: regarding.Id }));
      showModal(modal);
    });
    list?.addEventListener("click", (event) => {
      const link = event.target.closest(".edit-link, .delete-link");
      if (!link) return;
      event.preventDefault();
      const note = link.closest(".note");
      const id = note.getAttribute("data-id");
      if (link.classList.contains("delete-link")) {
        const modal = dialog(".modal-deletenote");
        const run = () => post(container.getAttribute("data-url-delete"), { id }, { json: true }).then(() => { if (modal) hideModal(modal); load(state.page); }).catch((error) => notify(container, error.message));
        if (!modal) return run();
        const primary = modal.querySelector(".modal-footer .primary");
        const replacement = primary.cloneNode(true);
        primary.replaceWith(replacement);
        replacement.addEventListener("click", run);
        showModal(modal);
        return;
      }
      const modal = dialog(".modal-editnote");
      if (!modal) return;
      const textarea = modal.querySelector('textarea[name="text"]');
      if (textarea) textarea.value = note.getAttribute("data-unformattedtext");
      const primary = modal.querySelector(".modal-footer .primary");
      const replacement = primary.cloneNode(true);
      primary.replaceWith(replacement);
      replacement.addEventListener("click", () => submit(modal, container.getAttribute("data-url-edit"), { id }));
      showModal(modal);
    });
    on(container, "refresh", (event, page) => {
      if (event.target === container) load(Number(page) || state.page);
    });
    load(1);
  }

  // ---- metadata filter apply (serialized-query) -----------------------------------
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-serialized-query]");
    if (!button) return;
    const list = button.closest(".entitylist");
    const target = document.querySelector(button.getAttribute("data-target"));
    if (!target) return;
    event.preventDefault();
    const parameters = new URLSearchParams();
    for (const input of target.querySelectorAll("input, select")) {
      if (!input.name || input.disabled) continue;
      if ((input.type === "checkbox" || input.type === "radio") && !input.checked) continue;
      if (input.value !== "") parameters.append(input.name, input.value);
    }
    const serialized = parameters.toString();
    const grid = list?.querySelector(".entity-grid");
    if (grid) {
      trigger(grid, "metafilter", serialized);
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set(button.getAttribute("data-serialized-query"), serialized);
    location.assign(url.href);
  });

  // ---- modal form completion ------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data !== "Success") return;
    for (const element of document.querySelectorAll(".entity-grid")) {
      const grid = element.__ppEntityGrid;
      if (!grid || !grid.enableActions) continue;
      const open = [...element.children].filter((child) => child.matches(".modal-form") && child.classList.contains("in"));
      const frames = [...element.querySelectorAll(":scope > .modal-form iframe")];
      if (!open.length && !frames.some((frame) => frame.contentWindow === event.source)) continue;
      for (const modal of open) hideModal(modal);
      trigger(element, "refresh");
    }
  });

  // ---- initialisation -------------------------------------------------------------------
  function initialise(root = document) {
    for (const element of root.querySelectorAll(".entity-grid")) {
      if (element.__ppEntityGrid) continue;
      if (element.closest(".entity-lookup, .entity-associate")) continue;
      new EntityGrid(element);
    }
    for (const lookup of root.querySelectorAll(".entity-lookup")) initLookup(lookup);
    for (const associate of root.querySelectorAll(".entity-associate")) initAssociate(associate);
    for (const notes of root.querySelectorAll(".entity-notes")) initNotes(notes);
  }
  window.__portalSimulation = window.__portalSimulation || {};
  window.__portalSimulation.nativeGrid = { initialise, EntityGrid };
  const start = () => {
    const $ = jq();
    if ($) $(() => initialise());
    else initialise();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
