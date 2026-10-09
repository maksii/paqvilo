import test from "node:test";
import assert from "node:assert/strict";
import { notificationVisibility } from "../lib/notification-visibility.mjs";
test("exported audience, URL and user checks preserve hidden query rows for the notification count", () => {
  const rows = [
    { audience: "1", url: "", webRoleName: "", contactId: "" },
    { audience: "3", url: "", webRoleName: "", contactId: "other" },
    {
      audience: "2",
      url: "/Applications",
      webRoleName: "Applicant",
      contactId: "other",
    },
    { audience: "1", url: "/", webRoleName: "", contactId: "" },
    {
      audience: "1",
      url: "",
      webRoleName: "",
      contactId: "current",
      dismissed: true,
    },
    { audience: "9", url: "", webRoleName: "", contactId: "" },
  ];
  const result = notificationVisibility(rows, {
    pathname: "/Applications/",
    user: { id: "current", roles: ["Applicant Manager"] },
  });
  assert.equal(result.length, 6);
  assert.deepEqual(
    result.map((row) => row.visible),
    [true, false, true, false, false, false],
  );
  assert.equal(rows[0].visible, undefined);
});
test("observed header surface includes root-URL notifications while contact scope still trims rows", () => {
  const rows = [
    { audience: "1", url: "/", notificationText: "public" },
    { audience: "3", url: "/", contactId: "other" },
  ];
  const options = {
    pathname: "/Applications/draftapplication/",
    user: { id: "current", roles: [] },
  };
  assert.deepEqual(
    notificationVisibility(rows, options).map((row) => row.visible),
    [false, false],
  );
  assert.deepEqual(
    notificationVisibility(rows, { ...options, surface: "header" }).map(
      (row) => row.visible,
    ),
    [true, false],
  );
});

test("role checks match inside the concatenated role names, as the authored check over {{ user.roles }} does", () => {
  const row = (webRoleName) => ({ audience: "1", url: "", webRoleName, contactId: "" });
  const visible = (rows, roles) => notificationVisibility(rows, { user: { id: "current", roles }, surface: "header" }).map((item) => item.visible);
  // The deployed portal renders {{ user.roles }} as "AdministratorsReviewers" and tests includes().
  assert.deepEqual(visible([row("Administrators"), row("Admin"), row("sReview"), row("Editors")], ["Administrators", "Reviewers"]), [true, true, true, false]);
  assert.deepEqual(visible([row("Reviewers")], [{ name: "Reviewers" }]), [true]);
  assert.deepEqual(visible([row("Reviewers")], []), [false]);
});
