import test from "node:test";
import assert from "node:assert/strict";
import {
  observedHeaderNotifications,
  reconcileHeaderNotifications,
} from "../lib/header-notification-capture.mjs";
const source =
  '<header><ul><li class="dropdown userProfileHolder"><a>Local Person</a></li></ul></header>';
const native =
  '<header><ul><li class="dropdown userProfileHolder"><a href="#"><svg width="14" height="16" viewBox="0 0 14 16"><path d="M1 1"/></svg><span class="notificationsCount" style="font-size:12px">3</span></a><ul class="dropdown-menu alerts-dropdown"><li>PRIVATE NATIVE CONTENT</li></ul></li><li class="dropdown userProfileHolder">PRIVATE PERSON</li></ul></header>';
test("source-bound static notification presentation renders only local records and counts", () => {
  const profile = observedHeaderNotifications(native, {
    headerSource: source,
    origin: "https://portal.example",
  });
  assert.doesNotMatch(profile.markup, /PRIVATE|>3</);
  const result = reconcileHeaderNotifications(source, source, profile, {
    notifications: [
      { notificationText: "Synthetic alert", severity: "warning" },
      {
        notificationText: "<script>private</script>",
        severity: "info",
        visible: false,
      },
    ],
  });
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.match(result.html, /Synthetic alert/);
  assert.doesNotMatch(result.html, /private|PRIVATE/);
  assert.match(result.html, /Local Person/);
  assert.equal(
    reconcileHeaderNotifications(source, source + " ", profile).diagnostic.code,
    "HEADER_NOTIFICATION_SOURCE_CHANGED",
  );
  assert.equal(
    reconcileHeaderNotifications(source, source, profile, {
      origin: "https://other.example",
    }).diagnostic.code,
    "HEADER_NOTIFICATION_ORIGIN_CHANGED",
  );
  assert.throws(
    () =>
      reconcileHeaderNotifications(source, source, {
        ...profile,
        markup: profile.markup + " ",
      }),
    /integrity/,
  );
  assert.equal(
    reconcileHeaderNotifications("<header>Anonymous</header>", source, profile)
      .html,
    "<header>Anonymous</header>",
  );
  assert.equal(
    reconcileHeaderNotifications(result.html, source, profile, {
      notifications: [],
    }).html,
    result.html,
  );
});
test("notification capture rejects unsafe graphics and style values, and missing widgets remain absent", () => {
  assert.equal(
    observedHeaderNotifications(source, { headerSource: source }),
    undefined,
  );
  assert.throws(() =>
    observedHeaderNotifications(
      native.replace('<path d="M1 1"/>', "<script>bad</script>"),
      { headerSource: source },
    ),
  );
  assert.throws(() =>
    observedHeaderNotifications(
      native.replace("font-size:12px", "background:url(https://evil.example)"),
      { headerSource: source },
    ),
  );
});
test("observed menu layout and blank severity templates preserve local text without native descriptions", () => {
  const item =
    '<li><div class="alert alert-warning"><button type="button" class="close notification-close" data-dismiss="alert" aria-label="Close"><span aria-hidden="true">×</span></button><div class="title"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M1 1"/></svg><p class="description">PRIVATE NATIVE MESSAGE</p></div></div></li>';
  const html =
    "<style>.alerts-dropdown {left:-230px;width:500px;padding:10px !important;}</style>" +
    native.replace("<li>PRIVATE NATIVE CONTENT</li>", item);
  const profile = observedHeaderNotifications(html, {
    headerSource: source,
    origin: "https://portal.example",
  });
  assert.equal(profile.itemTemplates.length, 1);
  assert.doesNotMatch(JSON.stringify(profile), /PRIVATE/);
  assert.match(profile.markup, /width:500px/);
  const result = reconcileHeaderNotifications(source, source, profile, {
    notifications: [
      {
        severity: "warning",
        notificationText: "<b>Local & safe</b>",
        showCloseButton: false,
      },
    ],
  });
  assert.match(result.html, />&lt;b&gt;Local &amp; safe&lt;\/b&gt;<\/p>/);
  assert.match(result.html, /display:none/);
  assert.match(result.html, /viewBox="0 0 20 20"/);
  assert.doesNotMatch(result.html, /<b>|PRIVATE/);
  const changed = {
    ...profile,
    itemTemplates: [
      {
        ...profile.itemTemplates[0],
        markup: profile.itemTemplates[0].markup + " ",
      },
    ],
  };
  assert.throws(
    () => reconcileHeaderNotifications(source, source, changed),
    /integrity/,
  );
  assert.throws(() =>
    observedHeaderNotifications(html.replace("left:-230px", "position:fixed"), {
      headerSource: source,
    }),
  );
});

test("notification counts follow visible rows and literal text remains safely escaped", () => {
  const profile = observedHeaderNotifications(native, { headerSource: source, origin: "https://portal.example" });
  const literal = '<b>Literal</b> 100% %2F || & <script>alert("x")</script>';
  const result = reconcileHeaderNotifications(source, source, profile, { notifications: [
    { visible: false, severity: "danger", notificationText: "Hidden notice" },
    { visible: true, severity: "info", notificationText: literal },
  ] });
  assert.match(result.html, /notificationsCount[^>]*>1</);
  assert.match(result.html, /&lt;b&gt;Literal&lt;\/b&gt; 100% %2F \|\| &amp; &lt;script&gt;alert\("x"\)&lt;\/script&gt;/);
  assert.doesNotMatch(result.html, /Hidden notice|<script>|<b>/);
  const allHidden = reconcileHeaderNotifications(source, source, profile, { notifications: [
    { visible: false, severity: "info", notificationText: "Hidden notice" },
  ] });
  assert.match(allHidden.html, /notificationsCount[^>]*>0</);
  assert.doesNotMatch(allHidden.html, /Hidden notice|class="description"/);
});
