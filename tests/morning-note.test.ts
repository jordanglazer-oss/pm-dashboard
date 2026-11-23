import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_CHARS,
  NOTE_PREFIX,
  archiveDates,
  buildPromptInput,
  cleanSource,
  easternDay,
  estimateUsd,
  isWeekday,
  noteKey,
  noteToText,
  sanitizeSections,
  splitEarnings,
  talkingPointsText,
  type MorningNote,
  type PromptInput,
} from "@/app/lib/morning-note-shared";
import { composeNote } from "@/app/lib/morning-note";

const input: PromptInput & { onFileTickers: string[] } = {
  date: "2026-11-23",
  snapshot: [
    { key: "es", label: "S&P 500 futures", value: 6012.5, changePct: 0.31 },
    { key: "us10y", label: "US 10-year yield", value: 4.21, changePct: -0.03, unit: "%" },
    { key: "usdcad", label: "USD/CAD", value: 1.3955, changePct: 0.1, unit: "fx" },
    { key: "vix", label: "VIX", value: null, changePct: null },
  ],
  held: [{ ticker: "AVGO", name: "Broadcom" }, { ticker: "RY-T" }],
  watchlist: [{ ticker: "SHOP", name: "Shopify" }],
  earningsToday: [{ ticker: "AVGO", name: "Broadcom", date: "2026-11-23", held: true }],
  earningsWeek: [{ ticker: "SHOP", date: "2026-11-25", held: false }],
  onFile: [{ ticker: "AVGO", date: "2026-11-22", kind: "metrics", text: "Q4 Earnings. Revenue ahead of consensus." }],
  onFileTickers: ["AVGO"],
  notes: [
    { author: "Mark Newton", latest: { date: "2026-11-20", text: "N".repeat(MAX_NOTE_CHARS + 500) }, prior: { date: "2026-11-19", text: "prior view" } },
    { author: "Tom Lee" },
  ],
};

describe("morning note — dates and archive", () => {
  it("keys by Eastern date, not UTC", () => {
    // 02:30 UTC on the 24th is still the evening of the 23rd in Toronto.
    expect(easternDay(new Date("2026-11-24T02:30:00Z"))).toBe("2026-11-23");
    expect(noteKey("2026-11-23")).toBe("pm:morning-note:2026-11-23");
    expect(isWeekday("2026-11-23")).toBe(true);
    expect(isWeekday("2026-11-22")).toBe(false);
  });

  it("lists valid dates inside the window, newest first, ignoring anything else", () => {
    const keys = [`${NOTE_PREFIX}2026-11-20`, `${NOTE_PREFIX}2026-11-23`, `${NOTE_PREFIX}2026-11-23`, `${NOTE_PREFIX}2026-06-01`, `${NOTE_PREFIX}2026-11-30`, `${NOTE_PREFIX}garbage`, "pm:morning-note-lock", "pm:brief"];
    expect(archiveDates(keys, "2026-11-23", 100)).toEqual(["2026-11-23", "2026-11-20"]);
  });
});

describe("morning note — content rules", () => {
  it("rejects forums, social sites and non-links as sources", () => {
    expect(cleanSource({ url: "https://www.reuters.com/markets/x", title: " Reuters " })).toEqual({ title: "Reuters", url: "https://www.reuters.com/markets/x" });
    for (const url of ["https://www.reddit.com/r/stocks/1", "https://old.reddit.com/x", "https://x.com/abc", "https://forums.example.com/t/1", "javascript:alert(1)", "not a url", ""]) expect(cleanSource({ url })).toBeNull();
    expect(cleanSource(null)).toBeNull();
  });

  it("drops unsourced items and decides 'held' from our own list", () => {
    const s = sanitizeSections(
      {
        closeLine: { text: "Stocks rose on rate hopes.", sources: [{ url: "https://www.reuters.com/a" }] },
        news: [
          { headline: "Sourced", whyItMatters: "Touches AVGO", tickers: ["avgo"], source: { url: "https://www.bloomberg.com/a" } },
          { headline: "No link", whyItMatters: "x", source: {} },
          { headline: "Forum", whyItMatters: "x", source: { url: "https://reddit.com/r/x" } },
          { headline: "No why", whyItMatters: "", source: { url: "https://www.ft.com/a" } },
        ],
        geopolitics: [
          { event: "With channel", channel: "Oil", source: { url: "https://apnews.com/a" } },
          { event: "No channel", channel: "", source: { url: "https://apnews.com/b" } },
        ],
        earningsReported: [
          { ticker: "shop", held: true, summary: "Beat.", sources: [{ url: "https://www.cnbc.com/a" }] },
          { ticker: "AVGO", summary: "Beat, from the recap on file.", sources: [] },
          { ticker: "MSFT", summary: "No source and nothing on file.", sources: [] },
        ],
        calendar: [{ timeET: "8:30", event: "US CPI", consensus: "0.2%", prior: "0.3%" }, { event: "BoC speech", consensus: "n/a", source: { url: "https://www.bankofcanada.ca/a" } }],
        talkingPoints: [{ concern: "Is the rally over?", response: "Calm answer.", attribution: "Tom Lee" }, { concern: "", response: "x" }],
        strategists: [{ author: "Mark Newton", noteDate: "2026-11-20", points: ["Support at 5,900", ""], changeFromPrior: "" }, { author: "Nobody", points: [] }],
      },
      ["AVGO"],
      ["AVGO"],
    );
    expect(s.closeLine?.text).toBe("Stocks rose on rate hopes.");
    expect(s.news.map((n) => n.headline)).toEqual(["Sourced"]);
    expect(s.news[0].tickers).toEqual(["AVGO"]);
    expect(s.geopolitics.map((g) => g.event)).toEqual(["With channel"]);
    // AVGO first (held, from our list); SHOP is NOT held whatever the model said; MSFT dropped.
    expect(s.earningsReported.map((e) => [e.ticker, e.held])).toEqual([["AVGO", true], ["SHOP", false]]);
    // A consensus / prior figure with no source is removed; the event stays.
    expect(s.calendar[0]).toEqual({ timeET: "8:30", event: "US CPI" });
    expect(s.calendar[1].consensus).toBe("n/a");
    expect(s.talkingPoints).toHaveLength(1);
    expect(s.strategists).toEqual([{ author: "Mark Newton", noteDate: "2026-11-20", points: ["Support at 5,900"] }]);
    expect(sanitizeSections("not json", []).news).toEqual([]);
  });

  it("puts holdings first and one row per name in the earnings lists", () => {
    const r = splitEarnings(
      [
        { ticker: "SHOP", date: "2026-11-23", held: false },
        { ticker: "AVGO", date: "2026-11-23", held: true },
        { ticker: "AVGO", date: "2026-11-23", held: true },
        { ticker: "RY-T", date: "2026-11-27", held: true },
        { ticker: "ZZZ", date: "2026-12-15", held: true },
        { ticker: "OLD", date: "2026-11-20", held: true },
      ],
      "2026-11-23",
    );
    expect(r.today.map((e) => e.ticker)).toEqual(["AVGO", "SHOP"]);
    expect(r.week.map((e) => e.ticker)).toEqual(["RY-T"]);
  });
});

describe("morning note — prompt input", () => {
  it("carries our facts, marks the snapshot as not to be restated, and bounds the notes", () => {
    const text = buildPromptInput(input);
    expect(text).toContain("TODAY: 2026-11-23");
    expect(text).toContain("do NOT restate or change these figures");
    expect(text).toContain("S&P 500 futures: 6,013 (+0.31%)");
    expect(text).toContain("US 10-year yield: 4.21% (-0.03 pts)");
    expect(text).toContain("USD/CAD: 1.3955 (+0.10%)");
    expect(text).toContain("VIX: n/a");
    expect(text).toContain("AVGO (Broadcom), RY-T");
    expect(text).toContain("Today: AVGO (held) — Broadcom, 2026-11-23");
    expect(text).toContain("[AVGO · 2026-11-22 · metrics]");
    expect(text).toContain("--- Tom Lee ---\nNo recent note on file.");
    expect(text).not.toContain("N".repeat(MAX_NOTE_CHARS + 1));
    expect(text).toContain("N".repeat(MAX_NOTE_CHARS));
  });
});

describe("morning note — composing and copying", () => {
  const answer = JSON.stringify({
    closeLine: { text: "Stocks rose.", sources: [{ url: "https://www.reuters.com/a" }] },
    news: [{ headline: "Chip demand", whyItMatters: "We hold AVGO.", tickers: ["AVGO"], source: { title: "Reuters", url: "https://www.reuters.com/b" } }],
    geopolitics: [],
    strategists: [{ author: "Mark Newton", points: ["Trend intact"] }],
    calendar: [],
    talkingPoints: [{ concern: "Is tech too expensive?", response: "Two calm sentences.", attribution: "Mark Newton" }],
    earningsReported: [],
  });
  const now = new Date("2026-11-23T12:15:00Z");

  it("builds the note from a stubbed model answer and records what the run cost", async () => {
    const n = await composeNote(input, async () => ({ text: `Here you go:\n${answer}`, inputTokens: 80_000, outputTokens: 3_000, searches: 6 }), now);
    expect(n.date).toBe("2026-11-23");
    expect(n.snapshot).toBe(input.snapshot);
    expect(n.earningsToday).toBe(input.earningsToday);
    expect(n.news).toHaveLength(1);
    expect(n.usage).toMatchObject({ searches: 6, estUsd: 0.345 });
    expect(n.warnings).toBeUndefined();
  });

  it("keeps our own data and says why when the model fails or answers in prose", async () => {
    const failed = await composeNote(input, async () => { throw new Error("overloaded"); }, now);
    expect(failed.snapshot).toHaveLength(4);
    expect(failed.news).toEqual([]);
    expect(failed.warnings?.[0]).toMatch(/could not be written/);
    const prose = await composeNote(input, async () => ({ text: "I could not find anything.", inputTokens: 10, outputTokens: 5, searches: 0 }), now);
    expect(prose.warnings?.[0]).toMatch(/Regenerate/);
    expect(prose.earningsWeek).toBe(input.earningsWeek);
  });

  it("copies as plain text, with links, and talking points on their own", async () => {
    const n: MorningNote = await composeNote(input, async () => ({ text: answer, inputTokens: 1, outputTokens: 1, searches: 0 }), now);
    const text = noteToText(n);
    expect(text.startsWith("Morning note — 2026-11-23")).toBe(true);
    expect(text).toContain("PRE-MARKET SNAPSHOT\nS&P 500 futures: 6,013 (+0.31%)");
    expect(text).not.toContain("VIX: n/a");
    expect(text).toContain("- Chip demand\n  Why it matters: We hold AVGO.\n  Reuters — https://www.reuters.com/b");
    expect(text).not.toContain("GEOPOLITICS");
    expect(text).not.toMatch(/<[a-z]/);
    expect(talkingPointsText(n)).toBe("1. Is tech too expensive?\nTwo calm sentences. (Mark Newton)");
  });

  it("estimates cost from token and search counts", () => {
    expect(estimateUsd(100_000, 5_000, 6)).toBe(0.435);
    expect(estimateUsd(0, 0, 0)).toBe(0);
  });
});
