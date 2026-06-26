import { NextRequest, NextResponse } from "next/server";
import { importJWK, SignJWT } from "jose";
import { randomUUID } from "crypto";

/**
 * GET /api/admin/factset-test?ticker=AAPL-US[&aud=token|issuer][&scope=...]
 *
 * Minimal, locked-down proof that the FactSet OAuth setup works:
 *   1. read FACTSET_CREDENTIALS from env (Confidential Client / Private-Key-JWT)
 *   2. discover the token endpoint from the credential's wellKnownUri
 *   3. sign a client-assertion JWT with the private jwk
 *   4. exchange it for an access token (client-credentials grant)
 *   5. best-effort: one Estimates read for the ticker
 *
 * SECURITY: admin-only (cookie middleware gates /api/admin/*). NEVER logs or
 * returns the private key OR the access token — only step outcomes + the API's
 * own (non-secret) response body, so we can diagnose without exposing anything.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Jwk = { alg?: string; kid?: string; kty: string; [k: string]: unknown };
type Creds = { clientId?: string; wellKnownUri?: string; jwk?: Jwk };

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const ticker = sp.get("ticker") || "AAPL-US";
  const audMode = sp.get("aud") === "issuer" ? "issuer" : "token";
  const scope = sp.get("scope") || "";

  const raw = process.env.FACTSET_CREDENTIALS;
  if (!raw) return NextResponse.json({ ok: false, step: "env", error: "FACTSET_CREDENTIALS not set in this environment." }, { status: 500 });
  let creds: Creds;
  try { creds = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, step: "parse", error: "FACTSET_CREDENTIALS is not valid JSON." }, { status: 500 }); }
  if (!creds.clientId || !creds.jwk || !creds.wellKnownUri) {
    return NextResponse.json({ ok: false, step: "shape", error: "Credential missing clientId / jwk / wellKnownUri.", has: { clientId: !!creds.clientId, jwk: !!creds.jwk, wellKnownUri: !!creds.wellKnownUri } }, { status: 500 });
  }

  // 1) discover token endpoint + issuer
  let tokenEndpoint = "", issuer = "";
  try {
    const wk = await fetch(creds.wellKnownUri, { cache: "no-store" }).then((r) => r.json());
    tokenEndpoint = wk.token_endpoint || "";
    issuer = wk.issuer || "";
  } catch (e) {
    return NextResponse.json({ ok: false, step: "discovery", error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  if (!tokenEndpoint) return NextResponse.json({ ok: false, step: "discovery", error: "well-known had no token_endpoint", issuer }, { status: 502 });

  // 2) sign the client-assertion JWT
  let assertion = "";
  try {
    const alg = creds.jwk.alg || "RS256";
    const key = await importJWK(creds.jwk, alg);
    const aud = audMode === "issuer" ? issuer : tokenEndpoint;
    assertion = await new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg, kid: creds.jwk.kid, typ: "JWT" })
      .setIssuer(creds.clientId)
      .setSubject(creds.clientId)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  } catch (e) {
    return NextResponse.json({ ok: false, step: "sign", error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  // 3) exchange for an access token
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  if (scope) form.set("scope", scope);
  let accessToken = "";
  try {
    const tr = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const tj = await tr.json().catch(() => ({}));
    if (tr.ok && tj.access_token) accessToken = tj.access_token;
    else return NextResponse.json({ ok: false, step: "token", tokenEndpoint, audMode, hint: "If this says invalid audience, retry with &aud=issuer; if it needs a scope, add &scope=…", factsetError: { status: tr.status, body: tj } });
  } catch (e) {
    return NextResponse.json({ ok: false, step: "token", tokenEndpoint, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  // 4) best-effort data probe (proves the Estimates entitlement). Never returns the token.
  let dataStatus = 0, dataSample = "";
  try {
    const url = `https://api.factset.com/content/factset-estimates/v2/consensus?ids=${encodeURIComponent(ticker)}&metrics=PRICE_TGT&periodicity=ANN`;
    const dr = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    dataStatus = dr.status;
    dataSample = (await dr.text()).slice(0, 800);
  } catch (e) {
    dataSample = "data fetch threw: " + (e instanceof Error ? e.message : String(e));
  }

  return NextResponse.json({ ok: true, step: "done", tokenOk: true, tokenEndpoint, audMode, dataStatus, dataSample });
}
