/**
 * Deterministic material-adverse-event scan (audit Finding 05).
 *
 * The scoring prompt's hard floors (fraud investigation, restatement,
 * delisting risk, bankruptcy, ...) were gated entirely on web_search — which
 * is off by default and capped, so a company could file for Chapter 11 and
 * still score normally because nothing in a default rescore ever looked.
 *
 * This module closes the three floors the SEC discloses STRUCTURALLY, using
 * the submissions index already cached at pm:edgar-submissions:{cik} (no new
 * upstream calls in the common case):
 *   - 8-K item 4.02  → non-reliance on previously issued financials
 *                      (the restatement floor)
 *   - 8-K item 1.03  → bankruptcy / receivership (the bankruptcy floor)
 *   - 8-K item 3.01  → notice of delisting / continued-listing deficiency
 *                      (the delisting floor; presumptive — can be cured)
 *   - Form 25 / 25-NSE → exchange delisting notification
 *
 * US-only by nature (Canadian names have no EDGAR); the web_search floors
 * still cover what filings can't (fraud investigations named by outlets,
 * auditor going-concern language, forced executive exits).
 */
import { getCikForTickerWithCrossList } from "./edgar";
import { getSubmissions } from "./edgar-industry";

export type AdverseFlag = {
  kind: "restatement" | "bankruptcy" | "delisting-notice" | "delisted";
  form: string;
  filingDate: string;
  items?: string;
};

const LOOKBACK_DAYS = 365;

/** Scan the cached SEC submissions index for hard-floor 8-K items within the
 *  last 12 months. Returns [] for non-US names, on any error, or when clean —
 *  scoring must never fail because this scan couldn't run. */
export async function getAdverseEventFlags(ticker: string): Promise<AdverseFlag[]> {
  try {
    const cikInfo = await getCikForTickerWithCrossList(ticker);
    if (!cikInfo) return [];
    const sub = await getSubmissions(cikInfo.paddedCik);
    const recent = sub?.filings?.recent;
    if (!recent?.form || !recent.filingDate) return [];

    const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
    const flags: AdverseFlag[] = [];
    for (let i = 0; i < recent.form.length; i++) {
      const date = recent.filingDate[i];
      if (!date || Date.parse(date) < cutoff) continue;
      const form = (recent.form[i] || "").toUpperCase();
      const items = recent.items?.[i] || "";
      if (form.startsWith("8-K")) {
        if (/\b4\.02\b/.test(items)) flags.push({ kind: "restatement", form, filingDate: date, items });
        if (/\b1\.03\b/.test(items)) flags.push({ kind: "bankruptcy", form, filingDate: date, items });
        if (/\b3\.01\b/.test(items)) flags.push({ kind: "delisting-notice", form, filingDate: date, items });
      } else if (form === "25" || form === "25-NSE") {
        flags.push({ kind: "delisted", form, filingDate: date });
      }
    }
    return flags;
  } catch (e) {
    console.warn(`[Score] adverse-event scan failed for ${ticker}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

const KIND_LABEL: Record<AdverseFlag["kind"], string> = {
  restatement: "NON-RELIANCE ON PRIOR FINANCIALS (8-K item 4.02) — the restatement hard floor",
  bankruptcy: "BANKRUPTCY / RECEIVERSHIP (8-K item 1.03) — the bankruptcy hard floor",
  "delisting-notice": "DELISTING / LISTING-DEFICIENCY NOTICE (8-K item 3.01) — the delisting hard floor (presumptive; can be cured)",
  delisted: "EXCHANGE DELISTING NOTIFICATION (Form 25)",
};

/** Prompt block for the flags. Empty string when there are none. */
export function formatAdverseFlagsForPrompt(flags: AdverseFlag[]): string {
  if (!flags.length) return "";
  const lines = [
    "=== MATERIAL EVENT FLAGS (SEC filings, detected deterministically) ===",
    "The following filings were detected server-side in this issuer's SEC submissions index. These are FILED regulatory disclosures — they satisfy the hard-floor evidence standard on their own (no web_search confirmation needed).",
  ];
  for (const f of flags) {
    lines.push(`  - ${f.filingDate}: ${KIND_LABEL[f.kind]}${f.items ? ` [items: ${f.items}]` : ""}`);
  }
  lines.push(
    "Apply the HARD FLOORS rule from the system prompt: items 4.02 and 1.03 and Form 25 are unambiguous — score every AI/SEMI category 0 and explain why in the summaries. Item 3.01 is PRESUMPTIVE: apply the floor unless the data above or a verify-mode search shows the deficiency was since cured or the notice withdrawn — in that case say so explicitly and score normally with confidence capped at \"medium\". Cite the filing date in the affected dataPoints with source: \"edgar\".",
  );
  return lines.join("\n");
}
