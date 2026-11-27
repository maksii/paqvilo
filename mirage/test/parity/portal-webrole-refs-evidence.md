# Native Power Pages web role membership evidence

The native corpus is the `refs` group of hosted session F1 (2026-11-26): eight signed-in portal Web API requests on an
enhanced data model site, recorded four times. Runs a and b met the site without Web API settings or table permissions
for `mspp_webrole` and `powerpagecomponent`. Runs a2 and b2 ran after the recorder's refs phase had enabled
`Webapi/mspp_webrole` (`mspp_webroleid,mspp_name`) and `Webapi/powerpagecomponent` (`powerpagecomponentid,name`) and
granted the contact's web role Global Read, Append and Append To on both tables. Both runs of each configuration agree
on every status, code and message.

| Suite                        | Captures         | Configuration |
| ---------------------------- | ---------------- | ------------- |
| `hosted-f1-without-settings` | refs-a, refs-b   | `none`        |
| `hosted-f1-webrole-api`      | refs-a2, refs-b2 | `webrole-api` |

The converter replaces the signed-in contact, the referenced web role and the site origin with placeholders and reads
the configuration from the session's actions log (the refs phase on or off when the run started). Each case keeps the
status and the error's code and message. The rows of the `mspp_webroles` read are not projected: the hosted answer held
the web roles of every site in the environment. Every recorded request is a case, the read through the contact's
membership navigation included.

The adapter's fixture holds what the recorded site held for these requests: the contact's only active contact permission
(Self scope, Read, Append and Append To, no Write), `Webapi/contact` columns that name no navigation, and a referenced web
role the contact does not hold.

To regenerate, convert each run with the session's actions log, then build each suite from its two captures:

```sh
node mirage/test/parity/capture-portal-webrole-refs.mjs RUN_DIR/a/refs.json ACTIONS_LOG refs-a.json
node mirage/test/parity/capture-portal-webrole-refs.mjs RUN_DIR/b/refs.json ACTIONS_LOG refs-b.json
node scripts/parity-cases.mjs build --surface portal-webrole-refs --suite hosted-f1-without-settings \
  --capture refs-a.json --capture refs-b.json
```

Runs a2 and b2 build `hosted-f1-webrole-api` the same way. The existing suites supply the oracle description when a case
file is regenerated.
