#!/bin/bash
#
# FactSet Relay — VPS bootstrap (paste into the "user data" box when creating an
# Ubuntu 22.04/24.04 droplet). Runs once, as root, on first boot.
#
# IMPORTANT: this script contains NO secrets. The FactSet key and relay secret
# are set AFTER boot, via the droplet's private web console (see README.md),
# so the key never lands in cloud-provider metadata.
#
set -euxo pipefail

# --- 1. Node.js 20 -----------------------------------------------------------
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# --- 2. Relay app ------------------------------------------------------------
mkdir -p /opt/factset-relay
cat > /opt/factset-relay/server.js <<'RELAY_EOF'
"use strict";
const http = require("http");
const PORT = process.env.PORT || 8080;
const RELAY_SECRET = process.env.RELAY_SECRET;
const FACTSET_AUTH = process.env.FACTSET_AUTH;
if (!RELAY_SECRET || !FACTSET_AUTH || RELAY_SECRET === "REPLACE_ME" || FACTSET_AUTH === "REPLACE_ME") {
  console.error("[factset-relay] set RELAY_SECRET and FACTSET_AUTH in /etc/factset-relay.env");
  process.exit(1);
}
const FACTSET_HOST = "https://api.factset.com";
const ALLOWED_PREFIXES = [
  "/formula-api/v1/",
  "/content/factset-funds/",
  "/content/factset-etf/",
  "/content/factset-fundamentals/",
  "/content/factset-estimates/",
  "/content/factset-prices/",
];
const basicAuth = "Basic " + Buffer.from(FACTSET_AUTH).toString("base64");
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const server = http.createServer(async (req, res) => {
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });
    if (!safeEqual(req.headers["x-relay-key"] || "", RELAY_SECRET)) return send(401, { error: "unauthorized" });
    const target = url.searchParams.get("u");
    if (!target || !target.startsWith("/")) return send(400, { error: "missing or invalid 'u' param" });
    if (!ALLOWED_PREFIXES.some((p) => target.startsWith(p))) return send(403, { error: "path not allowed" });
    const fsRes = await fetch(FACTSET_HOST + target, { headers: { authorization: basicAuth, accept: "application/json" } });
    const body = await fsRes.text();
    res.writeHead(fsRes.status, { "content-type": fsRes.headers.get("content-type") || "application/json" });
    res.end(body);
  } catch (e) { send(502, { error: "relay_error", detail: String((e && e.message) || e) }); }
});
server.listen(PORT, "127.0.0.1", () => console.log("[factset-relay] listening on 127.0.0.1:" + PORT));
RELAY_EOF

# --- 3. Secrets file (placeholder; real values set via console post-boot) -----
if [ ! -f /etc/factset-relay.env ]; then
  cat > /etc/factset-relay.env <<'ENV_EOF'
FACTSET_AUTH=REPLACE_ME
RELAY_SECRET=REPLACE_ME
ENV_EOF
fi
chmod 600 /etc/factset-relay.env

# --- 4. systemd service ------------------------------------------------------
cat > /etc/systemd/system/factset-relay.service <<'SVC_EOF'
[Unit]
Description=FactSet Relay
After=network.target

[Service]
EnvironmentFile=/etc/factset-relay.env
ExecStart=/usr/bin/node /opt/factset-relay/server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
SVC_EOF
systemctl daemon-reload
systemctl enable factset-relay
systemctl start factset-relay || true   # will idle until secrets are set

# --- 5. Caddy: automatic HTTPS via <public-ip>.nip.io ------------------------
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

PUBLIC_IP="$(curl -fsSL https://api.ipify.org)"
cat > /etc/caddy/Caddyfile <<CADDY_EOF
${PUBLIC_IP}.nip.io {
    reverse_proxy 127.0.0.1:8080
}
CADDY_EOF
systemctl restart caddy

# --- 6. Firewall: only SSH + HTTP(S) ----------------------------------------
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "FactSet relay bootstrap complete. Public hostname: ${PUBLIC_IP}.nip.io"
