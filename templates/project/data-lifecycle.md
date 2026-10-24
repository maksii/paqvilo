# Local data and persona runbook

1. Register trusted pack modules in the catalogue, then test their website matching.
   Registration alone does not activate a pack on an unrelated export. Review each
   site's pack ownership in [configuration](configuration.md).
2. Select a preset deliberately. `presetMode: bootstrap` seeds a new state once;
   existing local edits survive a restart. Editing a pack does not reseed an existing
   state. A manual preset reapply is an explicit reset, so save needed evidence first.
3. Give simultaneous scenarios distinct state files or persona `instanceKey` values.
   Never reset a shared active state to prepare another test. Use public context/session
   APIs and bound `personaContexts.maxInstances` when creating isolated copies.
4. Each browser visitor starts anonymous. Sign it in through public session helpers
   for permission assertions. Persona catalogue entries describe contacts; they do
   not create contacts, role memberships or permissions. Full presets and additive
   generation differ: generation preserves local rows; membership materialization
   requires explicit opt-in and exact roles from the selected export.
5. Configuration presets are also explicit. Applying local settings/snippets is
   separate from changing exported sources and does not deploy anything.
6. Read persisted state with `readStateFile` from `paqvilo/mirage`, including
   journal-backed files. Use portal-session reads for permission assertions;
   administrative state reads are inspection, not proof of visitor access.
7. Close visitors/browser contexts first. Then stop copies or parent runtimes you
   own. Closing a visitor does not necessarily stop a shared scenario copy. Preserve
   evidence before a targeted reset; leave unrelated runtimes running.

Test these properties in invented fixtures: edit/restart preservation, intentional
reapply, two isolated scenarios, anonymous/member/denied reads and owned cleanup.
The optional [acceptance recipe](acceptance.md) shows public APIs; keep complete
project scenarios and their evidence here rather than in toolkit core.

See the installed package's [state storage]({{docs}}mirage/docs/state-storage.md),
[persona catalogue]({{docs}}mirage/docs/persona-catalog.md),
[data packs]({{docs}}mirage/docs/data-packs.md) and
[public API]({{docs}}docs/public-api.md) guides.
