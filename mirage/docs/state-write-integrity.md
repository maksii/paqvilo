# State-write integrity

State mutations use locks, content digests and atomic replacement so one writer cannot silently overwrite another process's changes. Migration/scaffold/generator commands validate the state and detect active runtime ownership before committing. Temporary files and locks are cleaned up on success or failure.

Read a snapshot, prepare the complete change, verify the input digest under the write lock, and atomically replace the file. A stale digest or active owner is an explicit failure. Do not bypass the protocol by writing directly to a running runtime's JSON file. Use `_sim` for running local state changes and stop an owned runtime before offline migration.

State and ownership files remain private under `.paqvilo/`. The protocol protects local integrity; it does not grant permission to read or write a reference environment.
