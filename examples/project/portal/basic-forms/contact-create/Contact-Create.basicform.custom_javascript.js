$(function () {
  var accountId = new URLSearchParams(window.location.search).get("accountid");
  if (!accountId) return;
  $("[id$='parentcustomerid']").val(accountId);
  $("[id$='parentcustomerid_name']").val("Account");
  $("[id$='parentcustomerid_entityname']").val("account");
});
