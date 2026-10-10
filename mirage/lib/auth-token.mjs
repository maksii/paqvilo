import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

/*
 * OAuth 2.0 implicit grant endpoints of the portal :
 * POST /_services/auth/token issues an ID token (RS256 JWT) for the signed-in contact and
 * GET /_services/auth/publickey returns the key that validates it. Contract (Microsoft
 * Learn, "Use OAuth 2.0 implicit grant flow in your Power Pages site"): optional client_id
 * (registered in ImplicitGrantFlow/RegisteredClientId, added as aud and appid), state
 * (returned as a response header), nonce (claim) and response_type=token; expires_in
 * header; validity ImplicitGrantFlow/TokenExpirationTime seconds (default 900, 60..3600);
 * Connector/ImplicitGrantFlowEnabled=False turns the flow off; errors are JSON documents
 * with ErrorId, ErrorMessage, Timestamp and CorrelationId. The local key pair is generated
 * per server process (the platform signs with its site or custom certificate).
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });

const base64Url = (value) => Buffer.from(value).toString("base64url");
const setting = (portal, name) => Object.entries(portal?.settings ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const enabled = (portal) => !/^false$/i.test(String(setting(portal, "Connector/ImplicitGrantFlowEnabled") ?? "true").trim());

export function tokenLifetime(portal) {
  const value = String(setting(portal, "ImplicitGrantFlow/TokenExpirationTime") ?? "").trim();
  if (!/^\d+$/.test(value)) return 900;
  return Math.min(Math.max(Number(value), 60), 3600);
}

/** Sign a compact RS256 JWT with the local site key. */
export function signIdToken(claims) {
  const header = base64Url(JSON.stringify({ typ: "JWT", alg: "RS256" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

export const implicitGrantPublicKey = () => PUBLIC_KEY;

function tokenError(res, status, errorId, message) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(
    JSON.stringify({
      ErrorId: errorId,
      ErrorMessage: message,
      Timestamp: new Date().toLocaleString("en-US", { timeZone: "UTC" }),
      CorrelationId: randomUUID(),
    }),
  );
  return true;
}

async function parameters(req, url) {
  const values = Object.fromEntries(url.searchParams);
  if (req.method === "POST" && /application\/x-www-form-urlencoded/i.test(req.headers["content-type"] ?? "")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    Object.assign(values, Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
  }
  return values;
}

/**
 * Handle /_services/auth/token and /_services/auth/publickey. `contact` is the signed-in
 * contact row (or null), `origin` the site origin used as the issuer.
 */
export async function handleImplicitGrant(req, res, url, { portal, identity, contact, origin }) {
  const route = /^\/_services\/auth\/(token|publickey)\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (!route) return false;
  if (!enabled(portal)) return false;
  if (route === "publickey") {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : PUBLIC_KEY);
    return true;
  }
  if (req.method !== "POST") return false;
  const contactId = identity?.contactId ?? identity?.id ?? null;
  if (!contactId) {
    // Cookie authentication answers an anonymous AJAX call with 200 and X-Responded-JSON
    // (status 401 and the sign-in location); a navigation is redirected to sign-in.
    const location = `${origin}/SignIn?ReturnUrl=${encodeURIComponent(url.pathname + url.search)}`;
    if (/xmlhttprequest/i.test(req.headers["x-requested-with"] ?? "")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-responded-json": JSON.stringify({ status: 401, headers: { location } }) });
      res.end();
    } else {
      res.writeHead(302, { location, "cache-control": "no-store" });
      res.end();
    }
    return true;
  }
  const params = await parameters(req, url);
  const clientId = params.client_id;
  if (clientId != null && clientId !== "") {
    const registered = String(setting(portal, "ImplicitGrantFlow/RegisteredClientId") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!/^[A-Za-z0-9-]{1,36}$/.test(clientId) || !registered.includes(clientId))
      return tokenError(res, 400, "PortalSTS0001", "Client Id provided in the request is not a valid client Id registered for this portal. Please check the parameter and try again.");
  }
  const now = Math.floor(Date.now() / 1000);
  const lifetime = tokenLifetime(portal);
  const field = (name) => contact?.[name] ?? identity?.[name] ?? "";
  const claims = {
    sub: contactId,
    preferred_username: field("adx_identity_username") || field("emailaddress1") || field("fullname") || contactId,
    phone_number: field("mobilephone") || field("telephone1") || "",
    given_name: field("firstname"),
    family_name: field("lastname"),
    email: field("emailaddress1"),
    ...(params.nonce ? { nonce: params.nonce } : {}),
    ...(clientId ? { aud: clientId, appid: clientId } : {}),
    iat: now,
    nbf: now,
    exp: now + lifetime,
    iss: new URL(origin).host,
  };
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", expires_in: String(lifetime) };
  if (params.state) headers.state = params.state;
  res.writeHead(200, headers);
  res.end(signIdToken(claims));
  return true;
}
