$(function () {
  var parameters = new URLSearchParams(window.location.search);
  var accountId = parameters.get("accountid") || (parameters.get("refentity") === "account" ? parameters.get("refid") : null);
  if (!accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) return;
  var lookup = $("#parentcustomerid"), label = $("#parentcustomerid_name");
  if (lookup.val() && lookup.val() !== accountId) return;
  lookup.val(accountId).trigger("change");
  $("#parentcustomerid_entityname").val("account");
  try {
    var parentId = new URLSearchParams(window.parent.location.search).get("id");
    var parentName = window.parent.document.getElementById("name");
    if (parentId === accountId && parentName && parentName.value) {
      label.val(parentName.value).trigger("change");
      return;
    }
  } catch (_) {}
  // Standalone accountid links resolve the actual record name through the portal API.
  window.shell.getTokenDeferred().done(function (token) {
    $.ajax({url:"/_api/accounts(" + accountId + ")?$select=name",headers:{__RequestVerificationToken:token}}).done(function (account) {
      if (lookup.val() === accountId) label.val(account.name || "").trigger("change");
    });
  });
});

// The native form is hosted in an iframe with its own document and theme.
(function(){
 document.body.classList.add('demo-native','demo-native-frame');
 if(!document.querySelector('link[data-demo-form-theme]')){const theme=document.createElement('link');theme.rel='stylesheet';theme.href='/demo.css';theme.dataset.demoFormTheme='true';document.head.appendChild(theme);}
})();
