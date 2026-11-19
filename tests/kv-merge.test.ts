import { describe, expect, it } from "vitest";
import { checkModelsRevision, mergeTradeLog, missingFromBody } from "@/app/lib/kv-merge";

describe("mergeTradeLog (PUT /api/kv/pim-portfolio-state)", () => {
  const stored = {
    groupStates: [
      {
        groupId: "pim",
        lastRebalance: { date: "2026-10-22" },
        trackingStart: { date: "2026-01-02" },
        transactions: [
          { id: "t1", date: "2026-10-01", symbol: "AAPL" },
          { id: "t2", date: "2026-10-15", symbol: "MSFT" },
        ],
      },
      { groupId: "kpmg", lastRebalance: null, trackingStart: null, transactions: [{ id: "k1", date: "2026-09-01" }] },
    ],
    lastUpdated: "2026-11-01",
  };
  const raw = JSON.stringify(stored);

  it("keeps a stored group the body is missing", () => {
    const { merged, keptGroups } = mergeTradeLog(raw, { groupStates: [{ ...stored.groupStates[0] }] });
    expect(keptGroups).toBe(1);
    expect(merged.groupStates.map((g) => g.groupId)).toEqual(["pim", "kpmg"]);
    expect(merged.groupStates[1]).toEqual(stored.groupStates[1]);
  });

  it("keeps stored transactions the body is missing, chronologically", () => {
    const body = { groupStates: [{ groupId: "pim", transactions: [{ id: "t3", date: "2026-11-02" }] }, stored.groupStates[1]] };
    const { merged, keptTransactions } = mergeTradeLog(raw, body);
    expect(keptTransactions).toBe(2);
    expect(merged.groupStates[0].transactions!.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("never nulls a stored lastRebalance / trackingStart", () => {
    const body = { groupStates: [{ groupId: "pim", lastRebalance: null, transactions: [] }] };
    const { merged } = mergeTradeLog(raw, body);
    expect(merged.groupStates[0].lastRebalance).toEqual({ date: "2026-10-22" });
    expect(merged.groupStates[0].trackingStart).toEqual({ date: "2026-01-02" });
  });

  it("the body wins for a transaction it carries (settle replaces by id)", () => {
    const body = { groupStates: [{ groupId: "pim", transactions: [{ id: "t1", date: "2026-10-01", symbol: "AAPL", settled: true }, stored.groupStates[0].transactions[1]] }] };
    const { merged, keptTransactions } = mergeTradeLog(raw, body);
    expect(keptTransactions).toBe(0);
    expect(merged.groupStates[0].transactions![0]).toMatchObject({ id: "t1", settled: true });
    expect(merged.groupStates[0].transactions).toHaveLength(2);
  });

  it("keeps other top-level body fields", () => {
    const { merged } = mergeTradeLog(raw, { groupStates: [], lastUpdated: "2026-11-19" });
    expect(merged.lastUpdated).toBe("2026-11-19");
    expect(merged.groupStates).toHaveLength(2);
  });

  it("no / unreadable stored blob → body as-is", () => {
    const body = { groupStates: [] };
    expect(mergeTradeLog(null, body).merged).toBe(body);
    expect(mergeTradeLog("not json", body).merged).toBe(body);
  });
});

describe("missingFromBody (pim-positions books, pim-performance series)", () => {
  const stored = [
    { groupId: "pim", profile: "balanced", units: 1 },
    { groupId: "pim", profile: "stocks", units: 2 },
    { groupId: "kpmg", profile: "growth", units: 3 },
  ];

  it("returns the stored books/series the body lacks", () => {
    const kept = missingFromBody(stored, [{ groupId: "pim", profile: "balanced" }]);
    expect(kept.map((b) => `${b.groupId}|${b.profile}`)).toEqual(["pim|stocks", "kpmg|growth"]);
  });

  it("returns nothing when the body carries every one", () => {
    expect(missingFromBody(stored, stored)).toEqual([]);
  });

  it("matches on groupId AND profile", () => {
    expect(missingFromBody(stored, [{ groupId: "kpmg", profile: "balanced" }])).toHaveLength(3);
  });
});

describe("checkModelsRevision (PUT /api/kv/pim-models)", () => {
  it("refuses a stale revision", () => {
    expect(checkModelsRevision({ revision: 5 }, { revision: 4 }).refuse).toBe(true);
  });

  it("refuses a missing revision once the stored model has one", () => {
    expect(checkModelsRevision({ revision: 5 }, {}).refuse).toBe(true);
    expect(checkModelsRevision({ revision: 5 }, { revision: "5" }).refuse).toBe(true);
  });

  it("accepts the current revision", () => {
    expect(checkModelsRevision({ revision: 5 }, { revision: 5 })).toEqual({ storedRev: 5, bodyRev: 5, refuse: false });
  });

  it("accepts anything when nothing stored has a revision yet", () => {
    expect(checkModelsRevision(null, {}).refuse).toBe(false);
    expect(checkModelsRevision({}, {}).storedRev).toBe(0);
  });
});
