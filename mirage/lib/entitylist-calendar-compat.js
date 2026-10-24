/*
 * Mirage local stand-in for the platform calendar list client (Areas/EntityList/js/
 * entitylist-calendar.js with calendar.min.js). It reads the same markup contract
 * (div.entitylist[data-view=calendar] data-calendar-*), requests what the platform client requests
 * in the same order (the view template, the blockUI loading image, the event feed with from/to
 * (UTC, local period boundaries) and search, then the templates of the shown view) and renders the
 * platform calendar DOM from the local template equivalents (lib/entitylist-calendar-templates.mjs)
 * served at data-calendar-template-path.
 */
(function () {
  'use strict';
  if (window.__ppCalendarCompat) return;
  window.__ppCalendarCompat = true;
  var languages = function () {
    return window.calendar_languages || {};
  };
  var pad = function (n) {
    return (n < 10 ? '0' : '') + n;
  };
  var iso = function (date) {
    return (
      date.getUTCFullYear() +
      '-' +
      pad(date.getUTCMonth() + 1) +
      '-' +
      pad(date.getUTCDate()) +
      'T' +
      pad(date.getUTCHours()) +
      ':' +
      pad(date.getUTCMinutes()) +
      ':' +
      pad(date.getUTCSeconds()) +
      'Z'
    );
  };
  var DAY = 86400000;
  var VIEWS = ['year', 'month', 'week', 'day'];
  // The templates each view fetches after the event feed, in platform calendar order.
  var VIEW_TEMPLATES = {
    year: ['year', 'year-month', 'events-list'],
    month: ['month', 'month-day', 'events-list'],
    week: ['week', 'week-days'],
    day: ['day'],
  };
  var LOADING_IMAGE = '/Areas/EntityList/css/img/loading-bar.gif';
  var _ = {
    each: function (list, fn) {
      Array.prototype.forEach.call(list || [], fn);
    },
  };

  // Underscore-style templates: <% code %> and <%= value %> (not escaped, as _.template interpolates).
  function compile(source) {
    var code =
      "var __p='',__t;with(obj){__p+='" +
      source
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r?\n/g, '\\n')
        .replace(/<%=([\s\S]+?)%>/g, function (m, value) {
          return "'+((__t=(" + value.replace(/\\'/g, "'").replace(/\\n/g, '\n') + "))==null?'':__t)+'";
        })
        .replace(/<%([\s\S]+?)%>/g, function (m, statement) {
          return "';" + statement.replace(/\\'/g, "'").replace(/\\n/g, '\n') + ";__p+='";
        }) +
      "';}return __p;";
    var render = new Function('obj', '_', code);
    return function (data) {
      return render(data, _);
    };
  }

  // accept: the jQuery dataType the platform client asks with (html templates, json feed).
  function get(url, accept, done) {
    var request = new XMLHttpRequest();
    request.open('GET', url);
    request.setRequestHeader('Accept', accept);
    request.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    request.onload = function () {
      done(request.status >= 200 && request.status < 300 ? request.responseText : null);
    };
    request.onerror = function () {
      done(null);
    };
    request.send();
  }

  function range(view, day, mondayFirst) {
    var y = day.getFullYear(),
      m = day.getMonth(),
      d = day.getDate();
    if (view === 'year') return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
    if (view === 'month') return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    // The calendar's first_day 2 starts weeks on Sunday, 1 on Monday.
    var back = mondayFirst ? (day.getDay() + 6) % 7 : day.getDay();
    if (view === 'week') return [new Date(y, m, d - back), new Date(y, m, d - back + 7)];
    return [new Date(y, m, d), new Date(y, m, d + 1)];
  }

  function Calendar(element) {
    this.element = element;
    this.url = element.getAttribute('data-calendar-url');
    this.downloadUrl = element.getAttribute('data-calendar-download-url');
    this.path = element.getAttribute('data-calendar-template-path') || '/Areas/EntityList/tmpls/';
    this.view =
      VIEWS.indexOf(element.getAttribute('data-calendar-initial-view')) >= 0
        ? element.getAttribute('data-calendar-initial-view')
        : 'month';
    this._small_ = element.getAttribute('data-calendar-style') === 'list';
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(element.getAttribute('data-calendar-initial-date') || 'now');
    this.day = parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date();
    var lang = element.getAttribute('lang') || document.documentElement.getAttribute('lang') || 'en-US';
    this.locale = languages()[lang] || languages()['en-US'] || {};
    this.templates = {};
    var self = this;
    this.template('view', function () {
      // The platform blocks the list with a loading image (missing on the platform) before the feed request.
      var image = new Image();
      image.onload = image.onerror = function () {
        self.render();
      };
      image.src = LOADING_IMAGE;
    });
  }

  Calendar.prototype.template = function (name, done) {
    var self = this;
    if (this.templates[name]) return done();
    get(this.path + name + '.html', 'text/html, */*; q=0.01', function (source) {
      self.templates[name] = compile(source || '');
      done();
    });
  };
  Calendar.prototype.templatesFor = function (names, done) {
    var self = this;
    (function next(index) {
      if (index >= names.length) return done();
      self.template(names[index], function () {
        next(index + 1);
      });
    })(0);
  };

  // Dates: event times are UTC unless the feed asks for conversion (isconversionrequired).
  Calendar.prototype.moment = function (ms, event) {
    return this.local(new Date(Number(ms)), !(event && event.isconversionrequired === 'true'));
  };
  Calendar.prototype.local = function (date, utc) {
    var locale = this.locale;
    var part = function (name) {
      return date[(utc ? 'getUTC' : 'get') + name]();
    };
    return {
      day: function () {
        return part('Day');
      },
      sameDay: function (other) {
        return this.format('YYYY-M-D') === other.format('YYYY-M-D');
      },
      format: function (pattern) {
        var hours = part('Hours');
        return pattern.replace(/MMMM|YYYY|mm|D|M|h|A|a/g, function (token) {
          switch (token) {
            case 'MMMM':
              return locale['m' + part('Month')];
            case 'YYYY':
              return String(part('FullYear'));
            case 'mm':
              return pad(part('Minutes'));
            case 'D':
              return String(part('Date'));
            case 'M':
              return String(part('Month') + 1);
            case 'h':
              return String(hours % 12 || 12);
            case 'A':
              return hours < 12 ? 'AM' : 'PM';
            default:
              return hours < 12 ? 'am' : 'pm';
          }
        });
      },
    };
  };
  Calendar.prototype.ymd = function (date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  };
  Calendar.prototype.addDays = function (date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  };
  Calendar.prototype.between = function (start, end) {
    return this.events.filter(function (event) {
      return event.start != null && Number(event.start) < end && Number(event.end || event.start) >= start;
    });
  };
  Calendar.prototype._getDayClass = function (group, date) {
    var classes = [];
    if (date.toDateString() === new Date().toDateString()) classes.push('cal-day-today');
    if (date.getDay() === 0 || date.getDay() === 6) classes.push('cal-day-weekend');
    return classes.join(' ');
  };
  // A month cell: the platform calendar's _day (outside days keep their own month's date).
  Calendar.prototype._day = function (row, index) {
    var start = this.bounds[0];
    // first_day 2 (Sunday first) shifts by one more day than first_day 1 (Monday first).
    var offset = this.locale.first_day === 1 ? start.getDay() || 7 : start.getDay() + 1;
    var day = index - offset + 1;
    var date = new Date(start.getFullYear(), start.getMonth(), day);
    var inMonth = new Date(this.bounds[1].getTime() - 1).getDate();
    var cls = day > 0 ? 'cal-day-inmonth' : 'cal-day-outmonth';
    if (day + 1 > inMonth) this.stop_cycling = true;
    if (day > inMonth) {
      day -= inMonth;
      cls = 'cal-day-outmonth';
    }
    cls = (cls + ' ' + this._getDayClass('months', date)).trim();
    if (day <= 0) {
      day = new Date(start.getFullYear(), start.getMonth(), 0).getDate() - Math.abs(day);
      cls += ' cal-month-first-row';
    }
    var from = date.getTime();
    return this.templates['month-day']({
      cal: this,
      date: date,
      cls: cls,
      day: day,
      tooltip: '',
      data_day: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(day),
      start: from,
      end: from + DAY,
      events: this.between(from, from + DAY),
    });
  };
  Calendar.prototype._month = function (month) {
    var year = this.bounds[0].getFullYear(),
      from = new Date(year, month, 1).getTime(),
      to = new Date(year, month + 1, 1).getTime();
    return this.templates['year-month']({
      cal: this,
      month: month,
      month_name: this.locale['m' + month],
      data_day: year + '-' + pad(month + 1) + '-01',
      start: from,
      end: to,
      events: this.between(from, to),
    });
  };
  Calendar.prototype._week = function () {
    var start = this.bounds[0].getTime(),
      end = this.bounds[1].getTime();
    var events = this.between(start, end).map(function (event) {
      var startDay = new Date(Number(event.start)).getDay();
      var days = event.end - event.start <= DAY ? 1 : (event.end - event.start) / DAY;
      if (event.start < start) {
        days -= (start - event.start) / DAY;
        startDay = 0;
      }
      days = Math.ceil(days);
      if (startDay + days > 7) days = 7 - startDay;
      return Object.assign({}, event, { start_day: startDay, days: days });
    });
    return this.templates['week-days']({ cal: this, events: events });
  };

  Calendar.prototype.title = function () {
    var t = this.locale,
      start = this.bounds[0],
      format = function (pattern, values) {
        return String(pattern || '').replace(/\{(\d)\}/g, function (m, i) {
          return values[i];
        });
      };
    if (this.view === 'year') return format(t.title_year, [start.getFullYear()]);
    if (this.view === 'month') return format(t.title_month, [t['m' + start.getMonth()], start.getFullYear()]);
    if (this.view === 'week') {
      var first = new Date(start.getFullYear(), 0, 1);
      return format(t.title_week, [
        Math.ceil((Math.round((start - first) / DAY) + first.getDay()) / 7),
        start.getFullYear(),
      ]);
    }
    return format(t.title_day, [
      t['d' + start.getDay()],
      start.getDate(),
      t['m' + start.getMonth()],
      start.getFullYear(),
    ]);
  };

  Calendar.prototype.render = function () {
    var self = this;
    this.bounds = range(this.view, this.day, this.locale.first_day === 1);
    var url =
      this.url +
      (this.url.indexOf('?') < 0 ? '?' : '&') +
      'from=' +
      encodeURIComponent(iso(this.bounds[0])) +
      '&to=' +
      encodeURIComponent(iso(this.bounds[1]));
    var search = this.element.querySelector('.entitylist-search .query');
    if (search && search.value) url += '&search=' + encodeURIComponent(search.value);
    get(url, 'application/json, text/javascript, */*; q=0.01', function (text) {
      var json;
      try {
        json = JSON.parse(text);
      } catch (_e) {
        json = null;
      }
      self.events = json && json.success ? json.result || [] : [];
      self.error = !json ? 'Error completing request.' : json.success ? null : json.error || '';
      self.templatesFor((self._small_ ? ['view-event-list'] : []).concat(VIEW_TEMPLATES[self.view]), function () {
        self.draw();
      });
    });
  };

  Calendar.prototype.draw = function () {
    var self = this,
      element = this.element,
      view = element.querySelector('.view') || element;
    view.innerHTML = this.templates.view({ _small_: this._small_, cal: this });
    var title = this.title(),
      names = { year: 'year', month: 'month', week: 'week', day: 'day' };
    Array.prototype.forEach.call(
      view.querySelectorAll('[data-calendar-nav=prev], [data-calendar-nav=next]'),
      function (button) {
        var next = button.getAttribute('data-calendar-nav') === 'next';
        button.setAttribute('aria-label', next ? 'Next' : 'Previous');
        button.setAttribute('title', (next ? 'Next ' : 'Previous ') + names[self.view]);
      },
    );
    Array.prototype.forEach.call(view.querySelectorAll('[data-calendar-view]'), function (button) {
      var active = button.getAttribute('data-calendar-view') === self.view;
      if (active) button.classList.add('active');
      button.setAttribute('aria-label', button.textContent + (active ? ' Pressed' : ''));
    });
    view.querySelector('.calendar-title').textContent = title;
    var error = view.querySelector('.calendar-error');
    error.style.display = this.error ? 'block' : 'none';
    if (this.error) error.querySelector('.message').textContent = this.error;
    var calendar = view.querySelector('.calendar');
    calendar.classList.add('cal-context');
    if (this._small_) calendar.classList.add('calendar-small');
    calendar.style.width = '100%';
    this.stop_cycling = false;
    var start = this.bounds[0],
      end = this.bounds[1];
    var first = this.locale.first_day === 1 ? 1 : 0;
    var daysName = [0, 1, 2, 3, 4, 5, 6].map(function (i) {
      return self.locale['d' + ((i + first) % 7)];
    });
    calendar.innerHTML = this.templates[this.view]({
      cal: this,
      days_name: daysName,
      day: 1,
      start: start,
      events: this.between(start.getTime(), end.getTime()),
    });
    if (this._small_)
      view.querySelector('.event-list').innerHTML = this.templates['view-event-list']({
        cal: this,
        events: this.between(start.getTime(), end.getTime()),
      });
    var announcer = element.querySelector(':scope > .announce-calendar-title-sr-only');
    if (!announcer) {
      announcer = document.createElement('div');
      announcer.className = 'announce-calendar-title-sr-only';
      announcer.setAttribute('aria-live', 'assertive');
      announcer.setAttribute('role', 'alert');
      element.appendChild(announcer);
    }
    announcer.setAttribute('aria-label', title);
    // The platform unblocks the list (blockUI leaves position: static; zoom: 1 on it).
    element.style.position = 'static';
    element.style.zoom = '1';
    if (!this.bound) this.bind(view);
    this.bound = true;
  };

  Calendar.prototype.bind = function (view) {
    var self = this;
    view.addEventListener('click', function (event) {
      var nav = event.target.closest('[data-calendar-nav]'),
        change = event.target.closest('[data-calendar-view], [data-cal-view]'),
        download = event.target.closest('#DownloadTitleLink');
      if (nav) return self.navigate(nav.getAttribute('data-calendar-nav'));
      if (download && self.downloadUrl)
        return void (window.location =
          self.downloadUrl +
          '?from=' +
          encodeURIComponent(iso(self.bounds[0])) +
          '&to=' +
          encodeURIComponent(iso(self.bounds[1])));
      if (!change) return;
      event.preventDefault();
      var date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(change.getAttribute('data-cal-date') || '');
      if (date) self.day = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
      self.change(change.getAttribute('data-calendar-view') || change.getAttribute('data-cal-view'));
    });
  };
  Calendar.prototype.change = function (view) {
    if (VIEWS.indexOf(view) < 0) return;
    this.view = view;
    this.render();
  };
  Calendar.prototype.navigate = function (where) {
    var d = this.day,
      step = where === 'next' ? 1 : -1;
    if (where === 'today') this.day = new Date();
    else if (this.view === 'year') this.day = new Date(d.getFullYear() + step, d.getMonth(), 1);
    else if (this.view === 'month') this.day = new Date(d.getFullYear(), d.getMonth() + step, 1);
    else this.day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step * (this.view === 'week' ? 7 : 1));
    this.render();
  };

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll('.entitylist[data-view="calendar"]'), function (element) {
      if (!element.__ppCalendar) element.__ppCalendar = new Calendar(element);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
