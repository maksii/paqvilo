// Child process for the certificate gate: @azure/msal-node builds a PS256 client assertion (x5t#S256 + x5c)
// from the per-run certificate and redeems it over the simulator's TLS authority, then calls WhoAmI.
// The parent sets NODE_EXTRA_CA_CERTS so this process trusts the simulator CA; prints one JSON line.
import { ConfidentialClientApplication } from "@azure/msal-node";

const tlsOrigin = process.env.SIM_TLS_ORIGIN;
const emit = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);

try {
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.SIM_CLIENT_ID,
      authority: `${tlsOrigin}/${process.env.SIM_TENANT}`,
      knownAuthorities: [new URL(tlsOrigin).host],
      clientCertificate: {
        thumbprintSha256: process.env.SIM_THUMBPRINT_SHA256,
        privateKey: process.env.SIM_KEY_PEM,
        x5c: process.env.SIM_CERT_PEM,
      },
    },
  });
  const { accessToken } = await msal.acquireTokenByClientCredential({ scopes: [`${tlsOrigin}/.default`] });
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));

  const response = await fetch(`${tlsOrigin}/api/data/v9.2/WhoAmI`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const who = await response.json();
  emit({ ok: response.ok, appid: claims.appid, appidacr: claims.appidacr, userId: who.UserId, organizationId: who.OrganizationId, status: response.status });
} catch (error) {
  emit({ ok: false, error: String(error?.message ?? error) });
}
