# Native Power Pages file-range evidence

The native corpus consists of a full file-column GET and a GET with Range bytes=0-15. Two separate browser probe runs
used the same signed-in portal contact and test-owned synthetic file. The adapter recreates this file under an invented
local table and row. The suite covers this observed portal configuration and download path. The hosted build was not
recorded.

| Capture ID                   | Original receipt write time (UTC) |
| ---------------------------- | --------------------------------- |
| file-range-portal-authorized | 2026-11-26T09:28:28.703Z          |
| file-range-portal-repeat     | 2026-11-26T09:29:26.689Z          |

The recorder exclusively created each receipt immediately after its own browser probe. On the original receipts, file
creation and last-write timestamps agree. These timestamps document receipt creation. The case schema retains their
UTC dates and the SHA-256 digests of the original receipt bytes. The redacted receipts remain with the project that ran
the probe. Route names, tenant details and identities are absent from the replay input.

The converter checks the exact synthetic input against both response digests and selects the status, Content-Length,
Content-Range, Accept-Ranges, validator presence, received byte count and response SHA-256. The repeated capture alone
adds the suffix and conditional range requests and Content-Type observation. Both 416 receipts omit the JSON payload.
Those observations do not enter this suite.

To regenerate, run the converter for each original receipt with the exact synthetic upload file. The complete file is
also encoded in the generated case input.

```sh
node mirage/test/parity/capture-portal-file-range.mjs AUTHORIZED_RECEIPT SYNTHETIC_FILE AUTHORIZED_CAPTURE
node mirage/test/parity/capture-portal-file-range.mjs REPEAT_RECEIPT SYNTHETIC_FILE REPEAT_CAPTURE
node scripts/parity-cases.mjs build --surface portal-file-range --suite hosted-20261126 \
  --capture AUTHORIZED_CAPTURE --capture REPEAT_CAPTURE
```

The existing suite supplies the oracle description when regenerating its case file. Each capture names the original
receipt by filename without its extension.
