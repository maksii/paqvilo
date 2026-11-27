# Native Power Pages basic form postback evidence

The native corpus is one form postback for each of 20 basic-form scenarios of the toolkit's invented baseline fixture
(`examples/project/baseline`), uploaded over the demo portal (`examples/project/portal`) that the fixture site extends.
Two separate signed-in browser runs, `live` and `live-2`, recorded every scenario through the baseline harness
(`mirage/baseline-capture.mjs`) on 2026-10-15. The hosted build was not recorded.

The converter reads each scenario's recorded `requests.json` and the scenario matrix the run used. The input is the
page, the fixture record keys that the recorded address redacts (from the matrix `goto` step), the texts the form
posted for the columns the scenario filled in, and the posted button. The output is projected from the postback
response by the adapter's `projectPostback`: HTTP status, a redirect's target with record ids replaced, the message
panel's kind and text, and the validation summary entries. Both runs give the same input and output for every case.

The suite `baseline-basic-form-attachments-20261015` holds the two create forms with the attach-file control
(`item-create-attach`, `item-create-attach-multiple`), recorded in the same two runs. Their input adds the file the
control uploaded: each recorded `InitializeFileUpload` request names the type of the file it starts, and the scenario's
upload step holds its bytes. Which of the offered files the control accepted is recorded input, not replayed. The
adapter uploads the file through the same file API, posts the form as multipart with the annotation ids, and reads the
created record's notes as its edit page does; the output adds those attachments (file name, content type, image flag
and displayed size).

`basic-form/item-edit-associated/save-text` is left out: its record source resolves through the recorded contact's own
relationships, which the invented fixture contact does not hold. Scenarios recorded in one run only are not in this
corpus.

The recorded site's PAC export sets `Site/EnableCustomPluginError` to `true`; the demo portal source does not carry
that setting, so the adapter adds it. The redacted recordings remain with the project that ran them. Live record ids,
the signed-in contact and tenant details are absent from the replay input.

To regenerate, run the converter for each side with the run's scenario folder and matrix, then build:

```sh
node mirage/test/parity/capture-portal-form-postback.mjs SCENARIOS_DIR MATRIX_JSON live LIVE_CAPTURE
node mirage/test/parity/capture-portal-form-postback.mjs SCENARIOS_DIR MATRIX_JSON live-2 LIVE_2_CAPTURE
node scripts/parity-cases.mjs build --surface portal-form-postback --suite baseline-basic-form-20261015 \
  --capture LIVE_CAPTURE --capture LIVE_2_CAPTURE
```

For the attachment suite, pass its two scenario ids after `OUT` in each converter run and build
`baseline-basic-form-attachments-20261015` from those two captures.

The existing suite supplies the oracle description when regenerating its case file.

## Hosted session F2

The suites `hosted-f2-basic-form-20261127` (runs a and b, 21 cases) and `hosted-f2-basic-form-attachments-20261127`
(runs k and l, 6 cases) are postbacks of hosted session F2 on an Enhanced, Bootstrap 5 site, recorded on 2026-11-27 by
the workbench's hosted-f2 harness over an invented `pqf2` schema. The workbench converter `to-postback-captures.mjs
<run> <other run>` writes both captures of a pair: it replaces the run name with `<run>` only where the scenario put
it (the last word of a value it filled in, the attachment file names and their text), leaves the texts the page showed
as shown, and writes the same case list for both runs. `attach:max2-admin:two-files` was recorded in run b only and is
not in the a/b suite; run e has no second run and gives no case.

The adapter replays a page under `/pqf2-` on `hosted-f2-fixture-site.mjs`: the forms, fields, pages and records those
postbacks read, from the workbench's provision, seed and site-component sources, with `Site/EnableCustomPluginError`
absent as on the recorded site. A form that stays on its page after a save with files reports no attachments. The
attachment suite has no declared gaps; recorded files are the ones offered to the control, and a selection over the
rendered MaxFile uploads none, as the control does.

The site ran with enhanced authorization enabled (`enhancedauthorization` 3) for the whole session (setup correction
of the workbench summary `summary-F2.md`); the suites' oracle scope says so. The state-0 re-run of the workbench
(`enhancedauthorization` 0, attach runs s0b–s0f and the attachdel and notes runs, `compare-state3-state0.json`) gave the
same attachment and notes results; the oracle scope keeps naming state 3 until a revision rebuilds it from captures. The F2 summary lists the multistep step
1 messages in the order of a sorted digest; the raw traces of runs e and f order them Create of the step's record,
Create of the `adx_webformsession` row, then its Update, which is what the plug-in message tests assert.

To regenerate, convert each pair in the workbench and build each suite from its two captures:

```sh
node to-postback-captures.mjs a b
node to-postback-captures.mjs k l
node scripts/parity-cases.mjs build --surface portal-form-postback --suite hosted-f2-basic-form-20261127 \
  --capture A_CAPTURE --capture B_CAPTURE
node scripts/parity-cases.mjs build --surface portal-form-postback --suite hosted-f2-basic-form-attachments-20261127 \
  --capture K_CAPTURE --capture L_CAPTURE
```

The existing suites supply the oracle description when regenerating their case files.
