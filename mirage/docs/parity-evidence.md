# Reference parity evidence

Parity compares a local runtime with an explicitly selected, authorized reference environment through the intended signed-in browser. It is a separate operation from source bootstrap and local testing. Keep plans, business routes, expected persona access and reference fixtures in your portal project.

```sh
paqvilo mirage parity-suite --site <site> --env <env> --config <catalogue> --cdp http://127.0.0.1:<debug-port> --out .paqvilo/parity
```

Use a browser session started with a free debug port and confirm that port in Lense agent status. Reference operations are read-only; plans and route guards reject writes and forbidden actions. Task authorization is required for navigating and reading the selected environment. Never store bearer tokens or credentials, and redact query values in reports.

Reports distinguish passes, expected differences, skipped/incomplete observations, source/deployment differences and runtime gaps. Record persona/session, source baseline, runtime fingerprint, reference context and diagnostics. Do not infer a deployed commit. A source inventory, successful import, login page or local screenshot is not successful parity coverage.

The public toolkit supplies generic runners and scenarios, not an organisation's reference results. Cite the project's retained comparison when claiming a specific behavior matches live.
