// Relative-date surface used by the platform's postpreform and moment locale bundles.
(function ($) {
  if (!$ || $.timeago) return;
  const parse = (value) => {
    if (value instanceof Date) return value;
    const dateValue = typeof value === 'number' ? value : String(value).trim();
    return new Date(dateValue);
  };
  const strings = {
    prefixAgo: null,
    prefixFromNow: null,
    suffixAgo: 'ago',
    suffixFromNow: 'from now',
    inPast: 'any moment now',
    seconds: 'less than a minute',
    minute: 'about a minute',
    minutes: '%d minutes',
    hour: 'about an hour',
    hours: 'about %d hours',
    day: 'a day',
    days: '%d days',
    month: 'about a month',
    months: '%d months',
    year: 'about a year',
    years: '%d years',
    wordSeparator: ' ',
    numbers: [],
  };
  const timeago = (value) =>
    timeago.inWords(Date.now() - (value?.nodeType ? timeago.datetime(value) : parse(value)).getTime());
  timeago.settings = {
    refreshMillis: 60000,
    allowPast: true,
    allowFuture: false,
    localeTitle: false,
    cutoff: 0,
    autoDispose: true,
    strings,
  };
  timeago.parse = parse;
  timeago.datetime = (element) => parse(element.getAttribute(timeago.isTime(element) ? 'datetime' : 'title'));
  timeago.isTime = (element) => element.tagName?.toLowerCase() === 'time';
  const wordsFor = (seconds, minutes, hours, days, years) => {
    let key, n;
    if (seconds < 45) [key, n] = ['seconds', Math.round(seconds)];
    else if (seconds < 90) [key, n] = ['minute', 1];
    else if (minutes < 45) [key, n] = ['minutes', Math.round(minutes)];
    else if (minutes < 90) [key, n] = ['hour', 1];
    else if (hours < 24) [key, n] = ['hours', Math.round(hours)];
    else if (hours < 42) [key, n] = ['day', 1];
    else if (days < 30) [key, n] = ['days', Math.round(days)];
    else if (days < 45) [key, n] = ['month', 1];
    else if (days < 365) [key, n] = ['months', Math.round(days / 30)];
    else if (years < 1.5) [key, n] = ['year', 1];
    else [key, n] = ['years', Math.round(years)];
    return [key, n];
  };
  timeago.inWords = (distance) => {
    if (!timeago.settings.allowPast && !timeago.settings.allowFuture)
      throw new Error('timeago allowPast and allowFuture settings cannot both be false.');
    if (!timeago.settings.allowPast && distance >= 0) return timeago.settings.strings.inPast;
    const s = timeago.settings.strings,
      seconds = Math.abs(distance) / 1000,
      minutes = seconds / 60,
      hours = minutes / 60,
      days = hours / 24,
      years = days / 365;
    const [key, n] = wordsFor(seconds, minutes, hours, days, years);
    const text = String(typeof s[key] === 'function' ? s[key](n, distance) : (s[key] ?? strings[key])).replace(
      /%d/i,
      String(s.numbers?.[n] ?? n),
    );
    const future = distance < 0 && timeago.settings.allowFuture;
    return [future ? s.prefixFromNow : s.prefixAgo, text, future ? s.suffixFromNow : s.suffixAgo]
      .filter((value) => value != null && value !== '')
      .join(s.wordSeparator ?? ' ');
  };
  $.timeago = timeago;
  const timers = new WeakMap(),
    dates = new WeakMap();
  const dispose = (element) => {
    clearInterval(timers.get(element));
    timers.delete(element);
  };
  $.fn.timeago = function (action, value) {
    return this.each(function () {
      if (action === 'dispose') {
        dispose(this);
        return;
      }
      if (action && !['init', 'update', 'updateFromDOM'].includes(action))
        throw new Error('Unknown timeago function ' + action);
      const init = !action || action === 'init';
      if (init) dispose(this);
      if (action === 'update') dates.set(this, parse(value));
      if (action === 'updateFromDOM') dates.set(this, timeago.datetime(this));
      if (!dates.has(this)) {
        dates.set(this, timeago.datetime(this));
        const title = this.textContent.trim();
        if (title && !(timeago.isTime(this) && this.hasAttribute('title'))) this.setAttribute('title', title);
      }
      if (timeago.settings.localeTitle) this.setAttribute('title', dates.get(this).toLocaleString());
      const refresh = () => {
        if (timeago.settings.autoDispose && !this.isConnected) {
          dispose(this);
          return;
        }
        const date = dates.get(this),
          distance = Date.now() - date.getTime();
        if (Number.isNaN(distance)) return;
        this.textContent =
          !timeago.settings.cutoff || Math.abs(distance) < timeago.settings.cutoff
            ? timeago.inWords(distance)
            : this.getAttribute('title') || this.textContent;
      };
      refresh();
      if (init && timeago.settings.refreshMillis > 0)
        timers.set(this, setInterval(refresh, timeago.settings.refreshMillis));
    });
  };
  $(function () {
    $('abbr.timeago,time.timeago').timeago();
  });
})(globalThis.jQuery);
