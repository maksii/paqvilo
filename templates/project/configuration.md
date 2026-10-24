# Optional configuration recipes

Keep the active catalogue small. The adjacent `configuration.example.yml` is an
optional two-site recipe, not an export or a second active configuration. It assumes
one pack generated with `--pack sample-data`; adapt its explicit bindings to your pack
IDs and complete `matches()` from your exported website identity. Placeholder origins
are inert and intentionally fail completion. No command in setup clones or deploys.
Copy the example to a new project-root catalogue such as `configuration.recipe.yml`
before using `--config ./configuration.recipe.yml`; its paths assume that root location,
not the `docs/` folder. Review it before replacing any active shared configuration.

| Value                                | Resolution base       |
| ------------------------------------ | --------------------- |
| `sourceRoot`                         | Catalogue directory   |
| Site `source`, `solutionRoots`       | Effective source root |
| Pack module, `mirage.project`        | Catalogue directory   |
| Plain deployment-profile file string | Catalogue directory   |
| Deployment `{ source: path }`        | Selected site export  |
| Deployment `{ sourceRoot: path }`    | Effective source root |
| Relative `PAQVILO_REPO`              | Catalogue directory   |
| Relative CLI `--repo`                | Invoking directory    |

The recipe shares Solution settings from a separate settings checkout, while only
the customer site applies its exported Pages patch. A local profile is selected by
`deploymentProfiles.default`; changing the live environment does not select another
local profile. Explicit CLI profile choices and Mirage project configuration have
their own documented runtime contracts; inspect the resolved setup before starting.

## Personal worktrees and precedence

Use ignored `paqvilo.config.local.yml` for portable per-worktree choices, for example:

```yaml
sourceRoot: ../my-worktree-exports
browser:
  channel: chrome
```

| Layer                      | Precedence                                   |
| -------------------------- | -------------------------------------------- |
| Explicit CLI option        | Highest, for that invocation                 |
| Shell `PAQVILO_*`          | Overrides matching file/environment settings |
| Project `.env`             | Supplies personal `PAQVILO_*` defaults       |
| `paqvilo.config.local.yml` | Merged over the shared catalogue             |
| Shared site settings       | Override shared `defaults` for that site     |
| Shared defaults            | Lowest explicit project layer                |

Do not copy another checkout's personal files. Configuration saves affect the next
preview start: stop only your owned preview, refresh editor files, inspect script
reconciliation proposals, then restart it. Prefer keeping the catalogue and exports
on the same drive so tracked editor references remain workspace-relative. Windows
paths on different drives require absolute editor references: review generated files
before committing and keep personal references local. Resolved machine paths belong
in ignored workspace/local files. Catalogue paths containing shell interpolation or
control characters require manual npm quoting; refresh reports review instead of
emitting an executable script proposal.

## Pack ownership

Generation registers every requested pack on every requested site and new packs
match nothing. Review the matrix explicitly; registration is availability, matching
is activation. Shared packs are supported when that is intentional.

| Example pack                            | customer                            | partner            |
| --------------------------------------- | ----------------------------------- | ------------------ |
| sample-data (site-owned)                | Register and match customer fixture | Omit               |
| shared-helpers (optional separate pack) | Register if needed                  | Register if needed |

For each pack test a positive website identity and an unrelated negative identity.
Also test shared packs against every intended site's fixture. The source-free
`support/mirage.mjs` binding intentionally registers packs before exports exist;
runtime activation still filters `matches({ portal })`. Do not match arbitrary
websites merely to make a test pass.

`observed` facts require this site's evidence and `platform` settings must describe
the intended local experiment. The recipe invents neither. Follow the installed
configuration and deployment-profile documentation for those advanced settings.

See [data lifecycle](data-lifecycle.md), [acceptance](acceptance.md),
[configuration reference]({{docs}}docs/configuration.md) and
[deployment profiles]({{docs}}mirage/docs/deployment-profiles.md).
