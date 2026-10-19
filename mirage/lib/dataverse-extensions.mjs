// Extensions installed into the Dataverse API when it starts. An entry is { name, install(api), reset?(api) }:
// install runs once per API before the first request, reset runs on every reseed before security is re-seeded.
// reset must use api.store directly: reseed runs inside the server's change queue, where api.change would wait on itself.
// Empty by default; callers pass their own list as startDataverseApi({ extensions }).
export const EXTENSIONS = [];
