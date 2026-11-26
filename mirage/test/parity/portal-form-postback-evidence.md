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
