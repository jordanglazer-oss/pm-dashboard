# FactSet Relay

A tiny static-IP proxy so the PM dashboard (on Vercel, rotating IPs) can reach
the FactSet API key — which requires a whitelisted IP. The key lives **only** on
this VPS; the dashboard talks to the relay with a separate shared secret.

## Why this exists
FactSet's API key auth requires the caller's outbound IP to be whitelisted.
Vercel's serverless IPs rotate, so they can't be whitelisted. This relay runs on
a VPS with a fixed outbound IP; the dashboard routes FactSet calls through it.

## Security model
- FactSet key (`FACTSET_AUTH` = `USERNAME-SERIAL:APIKEY`) lives only in
  `/etc/factset-relay.env` (root-only, mode 600). Never in the repo, Vercel, the
  browser, or logs.
- Dashboard authenticates with `RELAY_SECRET` (`x-relay-key` header). Leaking it
  lets someone *use* the relay, not *read* the key. Rotate to revoke.
- Not a general proxy: only `api.factset.com`, only the allow-listed path
  prefixes (see `server.js`), read-only.
- Relay binds to localhost; Caddy fronts it with real HTTPS via `<ip>.nip.io`.
- FactSet IP whitelist is the final backstop even if both secrets leak.

## Setup (DigitalOcean, no SSH client needed)
1. **Create droplet**: Ubuntu 24.04, smallest plan (~$4–6/mo), region near you
   (e.g. Toronto). In **Advanced options → Add Initial Scripts (user data)**,
   paste the entire contents of `cloud-init.sh`. Create the droplet.
2. **Wait ~3 minutes** for first-boot setup, then note the droplet's public IP.
   Your relay hostname is `https://<IP>.nip.io`.
3. **Set the secrets** via the droplet's **Console** (DigitalOcean web console,
   logged in as `root`). Paste, with your real values:
   ```bash
   cat > /etc/factset-relay.env <<'EOF'
   FACTSET_AUTH=YOUR-USERNAME-SERIAL:YOUR-API-KEY
   RELAY_SECRET=A-LONG-RANDOM-STRING-YOU-CHOOSE
   EOF
   chmod 600 /etc/factset-relay.env
   systemctl restart factset-relay
   ```
4. **Whitelist the droplet IP** in the FactSet developer portal (replace the
   personal-machine IP from testing with the droplet's IP).
5. **Verify** (from anywhere):
   ```bash
   # health (no secret needed)
   curl -s https://<IP>.nip.io/health
   # a real price through the relay (needs the secret)
   curl -s -H "x-relay-key: YOUR-RELAY-SECRET" \
     "https://<IP>.nip.io/?u=/formula-api/v1/cross-sectional?ids=AAPL-US&formulas=P_PRICE"
   ```
   A price with `error:0` = the relay works end to end.
6. **Wire into the dashboard**: set Vercel env vars
   `FACTSET_RELAY_URL=https://<IP>.nip.io` and `FACTSET_RELAY_SECRET=<secret>`.

## Operations
- Logs: `journalctl -u factset-relay -n 50` (no secrets are logged).
- Restart: `systemctl restart factset-relay`.
- Rotate the relay secret: edit `/etc/factset-relay.env`, restart the service,
  update `FACTSET_RELAY_SECRET` in Vercel.
- Rotate the FactSet key: regenerate in the FactSet portal, update
  `/etc/factset-relay.env`, restart.
