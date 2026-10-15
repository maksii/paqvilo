/*
 * Local equivalents of the platform calendar templates (/Areas/EntityList/tmpls/BootstrapV5/*.html,
 * underscore-style <% %> templates the calendar client fetches by name). They are written for
 * entitylist-calendar-compat.js, which supplies `cal` (locale, date formatting, the day/month/week
 * helpers) and `_` (each); the markup they render follows the platform calendar DOM (live evidence).
 */
const eventDate = `<% var start = cal.moment(event.start, event), end = event.end ? cal.moment(event.end, event) : null; %>`;
const eventRange = `<%= start.format('MMMM D, YYYY h:mm A') %><%= end && event.end > event.start ? ' &ndash; ' + (end.sameDay(start) ? end.format('h:mm A') : end.format('MMMM D, YYYY h:mm A')) : '' %>`;
const eventHref = `<%= event.url ? event.url : 'javascript:void(0)' %>`;
const calendarIcon = `<span class="label label-default <%= event['class'] %>"><span class="fa-solid fa-calendar-days" aria-hidden="true"></span></span>`;

export const CALENDAR_TEMPLATES = {
  view: `<div class="page-header"><div class="row">
<div class="col-sm-4 calendar-navs"><div class="btn-group"><button class="btn btn-default btn-sm" data-calendar-nav="prev">&lsaquo;</button><button class="btn btn-default btn-sm" data-calendar-nav="next">&rsaquo;</button></div><div class="btn-group"><button id="NavigateToToday" class="btn btn-default btn-sm" data-calendar-nav="today"></button></div></div>
<div class="col-sm-4 calendar-title-container"><h4 class="calendar-title"></h4></div>
<div class="col-sm-4 calendar-views"><div class="btn-group"><% _.each(['Year', 'Month', 'Week'], function (name) { %><button id="<%= name %>ViewToggleButton" class="btn btn-default btn-sm" data-calendar-view="<%= name.toLowerCase() %>"></button><% }) %></div><div class="btn-group calendar-downloads"><button id="DownloadTitleLink" type="button" class="btn btn-default btn-sm"><span class="fa fa-download" aria-hidden="true"></span></button></div></div>
</div></div>
<div class="calendar-error alert alert-block alert-danger"><p id="LoadingError" class="message"></p></div>
<% if (_small_) { %><div class="row"><div class="col-sm-6"><div class="event-list"></div></div><div class="col-sm-6"><div class="calendar"></div></div></div><% } else { %><div class="calendar"></div><% } %>`,

  "view-event-list": `<% if (events.length) { %><div class="cal-event-list list-group"><% _.each(events, function (event) { %>${eventDate}<% var dayName = cal.locale['d' + start.day()]; %>
<a class="list-group-item event-item" href="${eventHref}" data-event-id="<%= event.id %>" data-event-class="<%= event['class'] %>" aria-label="<%= event.title %>. <%= start.format('MMMM D, YYYY') %> at <%= start.format('h:mm A') %>. <%= dayName %>."><div class="media"><div class="float-start"><div class="media-object">${calendarIcon}</div></div><div class="media-body"><h4 class="list-group-item-heading" aria-hidden="true"><%= event.title %></h4><div class="list-group-item-text"><p class="calendar-event-datetime" aria-hidden="true">${eventRange}</p>
<% if (event.description) { %><div class="calendar-event-description list-group-item-text" aria-hidden="true"><%= event.description %></div><% } %>
<% if (event.location) { %><p class="calendar-event-datetime"> <span class="calendar-event-span">Location : </span><%= event.location %></p><% } %>
<% if (event.organizer) { %><p class="calendar-event-datetime"><span class="calendar-event-span">Organizer : </span><%= typeof event.organizer === 'string' ? event.organizer : event.organizer.name != null ? event.organizer.name : '' %></p><% } %>
</div></div></div></a><% }) %></div><% } %>`,

  month: `<div class="cal-row-fluid cal-row-head"><% _.each(days_name, function (name) { %><div class="cal-cell1"><%= name %></div><% }) %></div>
<div class="cal-month-box"><% for (var row = 0; row < 6 && !cal.stop_cycling; row++) { %><div class="cal-row-fluid cal-before-eventlist"><% for (var cell = 1; cell <= 7; cell++) { %><div class="cal-cell1 cal-cell" data-cal-row="-day<%= cell %>" tabindex="-1"><%= cal._day(row, day++) %></div><% } %></div><% } %></div>`,

  "month-day": `<% var dayName = cal.locale['d' + date.getDay()]; %><div class="cal-month-day <%= cls %> <%= events.length > 0 ? 'calendar-hasevents' : '' %>" aria-label="<%= dayName %> <%= cal.local(date).format('MMMM D, YYYY') %>"><span class="float-end" data-cal-date="<%= data_day %>" data-cal-view="day" data-bs-toggle="tooltip" title="<%= tooltip %>"><%= day %></span>
<% if (!cal._small_ && events.length > 0) { %><span class="badge badge-important"><%= events.length %></span><div class="events-list" data-cal-start="<%= start %>" data-cal-end="<%= end %>"><% _.each(events, function (event) { var at = cal.moment(event.start, event); %><a href="${eventHref}" data-event-id="<%= event.id %>" data-event-class="<%= event['class'] %>" class="label label-primary <%= event['class'] %>" aria-label="<%= event.title %>. <%= cal.local(date).format('MMMM D, YYYY') %> at <%= at.format('h:mma') %>. <%= dayName %>."><span aria-hidden="true"><%= at.format('h:mma') %>&nbsp;<%= event.title %></span></a><% }) %></div><% } %></div>`,

  "events-list": `<span id="cal-slide-tick" style="display: none;"></span><div id="cal-slide-content" class="cal-event-list"><div class="list-group"><% _.each(events, function (event) { %>${eventDate}<a class="list-group-item event-item" href="${eventHref}" data-event-id="<%= event.id %>" data-event-class="<%= event['class'] %>"><h5 class="list-group-item-heading">${calendarIcon}&nbsp; <%= event.title %> <small>${eventRange}</small></h5></a><% }) %></div></div>`,

  year: `<div class="cal-year-box"><% for (var row = 0; row < 3; row++) { %><div class="row row-fluid cal-before-eventlist"><% for (var cell = 1; cell <= 4; cell++) { %><div class="span3 col-md-3 cal-cell" data-cal-row="-month<%= cell %>"><%= cal._month(row * 4 + cell - 1) %></div><% } %></div><% } %></div>`,

  "year-month": `<span class="float-end" data-cal-date="<%= data_day %>" data-cal-view="month"><%= cal._small_ ? cal.locale['ms' + month] : month_name %></span>
<% if (events.length > 0) { %><small class="cal-events-num badge badge-important float-start"><%= events.length %></small><% if (!cal._small_) { %><div class="d-none events-list" data-cal-start="<%= start %>" data-cal-end="<%= end %>"><% _.each(events, function (event) { %><a href="${eventHref}" data-event-id="<%= event.id %>" data-event-class="<%= event['class'] %>" class="float-start event <%= event['class'] %> event<%= event.id %>" data-bs-toggle="tooltip" title="<%= event.title %>"></a><% }) %></div><% } %><% } %>`,

  week: `<div class="cal-week-box"><% for (var offset = 1; offset <= 6; offset++) { %><div class="cal-offset<%= offset %> cal-column"></div><% } %>
<div class="cal-row-fluid cal-row-head"><% _.each(days_name, function (name, index) { var date = cal.addDays(start, index); %><div class="cal-cell1 <%= cal._getDayClass('week', date) %>" data-bs-toggle="tooltip" title=""><%= name %><br><small><span data-cal-date="<%= cal.ymd(date) %>" data-cal-view="day"><%= date.getDate() %> <%= cal.locale['ms' + date.getMonth()] %></span></small></div><% }) %></div>
<hr><%= cal._week() %></div>`,

  "week-days": `<% _.each(events, function (event) { %><div class="cal-row-fluid"><div class="cal-cell<%= event.days %> cal-offset<%= event.start_day %> day-highlight dh-<%= event['class'] %>" data-event-class="<%= event['class'] %>"><a href="${eventHref}" aria-label="<%= event.title != null ? event.title : event.id %>" data-event-id="<%= event.id %>" class="cal-event-week event<%= event.id %>"><%= event.title %></a></div></div><% }) %>`,

  day: `<% if (!cal._small_) { %><% if (events.length > 0) { %><div class="cal-event-list list-group"><% _.each(events, function (event) { %>${eventDate}<a class="list-group-item event-item" href="${eventHref}" data-event-id="<%= event.id %>" data-event-class="<%= event['class'] %>"><div class="media"><div class="float-end"><div class="media-object">${calendarIcon}</div></div><div class="media-body"><h4 class="list-group-item-heading"><%= event.title %></h4><div class="list-group-item-text"><p class="calendar-event-datetime">${eventRange}</p><% if (event.description) { %><div class="calendar-event-description list-group-item-text"><%= event.description %></div><% } %></div></div></div></a><% }) %></div><% } else { %><p><%= cal.locale.no_events_in_day %></p><% } %><% } %>`,
};
