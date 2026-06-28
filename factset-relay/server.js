"use strict";

/**
 * FactSet Relay
 * -------------
 * A tiny, single-purpose proxy that runs on a VPS with a STATIC outbound IP
 * (the IP FactSet whitelists). The PM dashboard on Vercel — whose IPs rotate
 * and therefore can't be whitelisted — calls this relay instead of FactSet
 * directly.
 *
 * SECURITY MODEL (see factset-relay/README.md for the full writeup):
 *   - The FactSet API key lives ONLY here, in /etc/factset-relay.env (root-only),
 *     injected as FACTSET_AUTH ("USERNAME-SERIAL:APIKEY"). It is never sent to,
 *     stored in, or logged by the dashboard.
 *   - The dashboard authenticates to this relay with a SEPARATE shared secret
 *     (RELAY_SECRET) sent in the `x-relay-key` header. Leaking that secret lets
 *     someone USE the relay, but never lets them READ the FactSet key.
 *   - This is NOT a general proxy: it only forwards to api.factset.com, only the
 *     allow-listed FactSet API path prefixes, read-only (GET), and never logs the
 *     key or the Authorization header.
 *   - It listens on localhost only; a Caddy reverse proxy in front terminates
 *     HTTPS (real cert via <ip>.nip.io) so traffic to it is encrypted.
 *
 * Request contract (from the dashboard):
 *   GET https://<ip>.nip.io/?u=<url-encoded FactSet path + query>
 *   Header: x-relay-key: <RELAY_SECRET>
 *   e.g. u = /formula-api/v1/cross-sectional?ids=AAPL-US&formulas=P_PRICE
 */

const http = require("http");

const PORT = process.env.PORT || 8080;
const RELAY_SECRET = process.env.RELAY_SECRET;
const FACTSET_AUTH = process.env.FACTSET_AUTH; // "USERNAME-SERIAL:APIKEY"

if (
  !RELAY_SECRET ||
  !FACTSET_AUTH ||
  RELAY_SECRET === "REPLACE_ME" ||
  FACTSET_AUTH === "REPLACE_ME"
) {
  console.error(
    "[factset-relay] RELAY_SECRET and FACTSET_AUTH must be set in /etc/factset-relay.env"
  );
  process.exit(1);
}

const FACTSET_HOST = "https://api.factset.com";

// Defence in depth: only these FactSet products can ever be reached through the
// relay. Everything else is rejected before any upstream call is made.
const ALLOWED_PREFIXES = [
  "/formula-api/v1/",
  "/content/factset-funds/",
  "/content/factset-etf/",
  "/content/factset-fundamentals/",
  "/content/factset-estimates/",
  "/content/factset-prices/",
];

const basicAuth = "Basic " + Buffer.from(FACTSET_AUTH).toString("base64");

// Constant-time string compare so the secret can't be guessed by timing.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  try {
    const url = new URL(req.url, "http://localhost");

    // Unauthenticated health check (no secret, no upstream call).
    if (url.pathname === "/health") return send(200, { ok: true });

    if (!safeEqual(req.headers["x-relay-key"] || "", RELAY_SECRET)) {
      return send(401, { error: "unauthorized" });
    }

    const target = url.searchParams.get("u");
    if (!target || !target.startsWith("/")) {
      return send(400, { error: "missing or invalid 'u' param" });
    }
    if (!ALLOWED_PREFIXES.some((p) => target.startsWith(p))) {
      return send(403, { error: "path not allowed" });
    }

    const fsRes = await fetch(FACTSET_HOST + target, {
      headers: { authorization: basicAuth, accept: "application/json" },
    });
    const body = await fsRes.text();
    res.writeHead(fsRes.status, {
      "content-type": fsRes.headers.get("content-type") || "application/json",
    });
    res.end(body);
  } catch (e) {
    send(502, { error: "relay_error", detail: String((e && e.message) || e) });
  }
});

// Bind to localhost only — Caddy (HTTPS) is the sole public entry point.
server.listen(PORT, "127.0.0.1", () =>
  console.log("[factset-relay] listening on 127.0.0.1:" + PORT)
);
