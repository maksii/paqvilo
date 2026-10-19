// Child process for the msal variant A gate: real OIDC discovery over the simulator's TLS listener.
// The parent sets NODE_EXTRA_CA_CERTS so this process trusts the simulator CA; prints one JSON line.
import { ConfidentialClientApplication } from "@azure/msal-node";
import { DynamicsWebApi } from "dynamics-web-api";

const tlsOrigin = process.env.SIM_TLS_ORIGIN;
const emit = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);

try {
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.SIM_CLIENT_ID,
      clientSecret: process.env.SIM_CLIENT_SECRET,
      authority: `${tlsOrigin}/${process.env.SIM_TENANT}`,
      knownAuthorities: [new URL(tlsOrigin).host],
    },
  });
  const { accessToken } = await msal.acquireTokenByClientCredential({ scopes: [`${tlsOrigin}/.default`] });
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));

  const api = new DynamicsWebApi({ serverUrl: tlsOrigin, dataApi: { version: "9.2" }, onTokenRefresh: async () => accessToken });
  const who = await api.callFunction("WhoAmI");

  emit({ ok: true, appid: claims.appid, userId: who.UserId });
} catch (error) {
  emit({ ok: false, appid: null, userId: null, error: String(error?.message ?? error) });
}
