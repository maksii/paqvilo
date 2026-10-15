/*
 * Mirage local stand-in for the platform calendar list client (Areas/EntityList/js/
 * entitylist-calendar.js with calendar.min.js). It reads the same markup contract
 * (div.entitylist[data-view=calendar] data-calendar-*), requests the event feed with the same
 * from/to (UTC, local period boundaries) and search parameters, and renders a plain
 * year/month/week/day view. A captured platform asset replaces this file when present.
 */
(function () {
  "use strict";
  var languages = function () { return window.calendar_languages || {}; };
  var esc = function (value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var iso = function (date) { return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate()) + "T" + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds()) + "Z"; };
  var VIEWS = ["year", "month", "week", "day"];

  function range(view, day, firstDay) {
    var y = day.getFullYear(), m = day.getMonth(), d = day.getDate();
    if (view === "year") return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
    if (view === "month") return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    if (view === "week") {
      var start = (day.getDay() - (firstDay === 1 ? 1 : 0) + 7) % 7;
      return [new Date(y, m, d - start), new Date(y, m, d - start + 7)];
    }
    return [new Date(y, m, d), new Date(y, m, d + 1)];
  }

  function load(url, done) {
    var request = new XMLHttpRequest();
    request.open("GET", url);
    request.setRequestHeader("Accept", "application/json, text/javascript, */*; q=0.01");
    request.setRequestHeader("X-Requested-With", "XMLHttpRequest");
    request.onload = function () {
      var json = null;
      try { json = JSON.parse(request.responseText); } catch (e) { json = null; }
      done(json && json.success ? json.result || [] : [], json && !json.success ? json.error || "" : null);
    };
    request.onerror = function () { done([], "Error completing request."); };
    request.send();
  }

  function Calendar(element) {
    this.element = element;
    this.url = element.getAttribute("data-calendar-url");
    this.downloadUrl = element.getAttribute("data-calendar-download-url");
    this.view = VIEWS.indexOf(element.getAttribute("data-calendar-initial-view")) >= 0 ? element.getAttribute("data-calendar-initial-view") : "month";
    var initial = element.getAttribute("data-calendar-initial-date") || "now";
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(initial);
    this.day = parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date();
    var lang = (element.closest("[lang]") || document.documentElement).getAttribute("lang") || "en-US";
    this.text = languages()[lang] || languages()["en-US"] || {};
    this.firstDay = this.text.first_day || 2;
    this.render();
  }

  Calendar.prototype.title = function () {
    var t = this.text, day = this.day;
    var month = t["m" + day.getMonth()] || day.toLocaleString(undefined, { month: "long" });
    if (this.view === "year") return String(day.getFullYear());
    if (this.view === "month") return month + " " + day.getFullYear();
    if (this.view === "week") return range("week", day, this.firstDay)[0].toDateString();
    return (t["d" + day.getDay()] || "") + " " + day.getDate() + " " + month + ", " + day.getFullYear();
  };

  Calendar.prototype.render = function () {
    var self = this, bounds = range(this.view, this.day, this.firstDay);
    var url = this.url + (this.url.indexOf("?") < 0 ? "?" : "&") + "from=" + encodeURIComponent(iso(bounds[0])) + "&to=" + encodeURIComponent(iso(bounds[1]));
    var search = this.element.querySelector(".entitylist-search .query");
    if (search && search.value) url += "&search=" + encodeURIComponent(search.value);
    load(url, function (events, error) { self.draw(bounds, events, error); });
  };

  Calendar.prototype.draw = function (bounds, events, error) {
    var self = this, view = this.element.querySelector(".view") || this.element;
    var nav = ["prev", "today", "next"].map(function (where) { return '<button type="button" class="btn btn-default btn-secondary" data-calendar-nav="' + where + '">' + esc(where === "today" ? "Today" : where === "prev" ? "<<" : ">>") + "</button>"; }).join("");
    var views = VIEWS.map(function (name) { return '<button type="button" class="btn btn-default btn-secondary' + (name === self.view ? " active" : "") + '" data-calendar-view="' + name + '">' + esc(name.charAt(0).toUpperCase() + name.slice(1)) + "</button>"; }).join("");
    var days = {};
    events.forEach(function (event) {
      var start = new Date(Number(event.start));
      var key = self.view === "year" ? start.getMonth() : start.toDateString();
      (days[key] = days[key] || []).push(event);
    });
    var item = function (event) { return '<li><a href="' + esc(event.url || "#") + '" data-event-id="' + esc(event.id) + '" class="' + esc(event["class"] || "") + '">' + esc(event.title) + "</a></li>"; };
    var body = "";
    if (this.view === "year") {
      for (var m = 0; m < 12; m++) body += '<div class="cal-year-month"><span class="cal-month-name">' + esc(this.text["m" + m] || m + 1) + '</span><span class="badge">' + (days[m] || []).length + "</span></div>";
    } else {
      for (var d = new Date(bounds[0]); d < bounds[1]; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        var list = days[d.toDateString()] || [];
        if (this.view === "month" || list.length || this.view === "day") body += '<div class="cal-day" data-cal-date="' + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + '"><span class="cal-day-number">' + d.getDate() + "</span><ul>" + list.map(item).join("") + "</ul></div>";
      }
      if (!events.length && this.view === "day") body += '<p class="no-events">' + esc(this.text.no_events_in_day || "") + "</p>";
    }
    view.innerHTML = '<div class="calendar-header"><div class="btn-group calendar-nav">' + nav + '</div><h3 class="calendar-title">' + esc(this.title()) + '</h3><div class="btn-group calendar-views">' + views + "</div>" +
      (this.downloadUrl ? '<div class="calendar-downloads"><a role="button" href="' + esc(this.downloadUrl + "?from=" + encodeURIComponent(iso(bounds[0])) + "&to=" + encodeURIComponent(iso(bounds[1]))) + '">iCalendar</a></div>' : "") +
      '</div><div class="calendar-error alert alert-danger"' + (error ? "" : ' style="display: none;"') + '><span class="message">' + esc(error || "") + '</span></div><div class="calendar cal-' + this.view + '">' + body + "</div>";
    Array.prototype.forEach.call(view.querySelectorAll("[data-calendar-nav]"), function (button) {
      button.addEventListener("click", function () { self.navigate(button.getAttribute("data-calendar-nav")); });
    });
    Array.prototype.forEach.call(view.querySelectorAll("[data-calendar-view]"), function (button) {
      button.addEventListener("click", function () { self.view = button.getAttribute("data-calendar-view"); self.render(); });
    });
  };

  Calendar.prototype.navigate = function (where) {
    var d = this.day, step = where === "next" ? 1 : -1;
    if (where === "today") this.day = new Date();
    else if (this.view === "year") this.day = new Date(d.getFullYear() + step, d.getMonth(), 1);
    else if (this.view === "month") this.day = new Date(d.getFullYear(), d.getMonth() + step, 1);
    else this.day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step * (this.view === "week" ? 7 : 1));
    this.render();
  };

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll('.entitylist[data-view="calendar"]'), function (element) {
      if (!element.__ppCalendar) element.__ppCalendar = new Calendar(element);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
