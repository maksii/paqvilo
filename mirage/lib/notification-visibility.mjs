/** Apply the authored notification audience, path and user checks to query rows. */
export function notificationVisibility(
  rows,
  { pathname = "/", user = null, surface = "banner" } = {},
) {
  const contactId = String(user?.id ?? user?.contactId ?? "");
  // The authored check tests each role with String.includes against the rendered {{ user.roles }},
  // which is the role names concatenated without separators (recorded on the reference portal:
  // docs/parity-evidence.md, Persona derivation; the local engine renders it the same way). So a
  // name can match inside another or across two adjacent roles there too; matching exact names
  // here would hide notifications that the deployed portal shows.
  const roles = (user?.roles ?? user?.webroles ?? [])
    .map((role) => (typeof role === "string" ? role : (role.name ?? "")))
    .join("");
  return rows.map((row) => {
    const url = String(row.url ?? ""),
      role = String(row.webRoleName ?? ""),
      contact = String(row.contactId ?? "");
    const matchesPath =
      url === "" ||
      (url === "/"
        ? pathname === "/"
        : pathname.endsWith(url) || pathname.endsWith(url + "/"));
    const matchesUser =
      role === ""
        ? contact === "" || contact === contactId
        : roles.includes(role);
    return {
      ...row,
      visible:
        ["1", "2", "3"].includes(String(row.audience)) &&
        row.dismissed !== true &&
        (surface === "header" || matchesPath) &&
        matchesUser,
    };
  });
}
