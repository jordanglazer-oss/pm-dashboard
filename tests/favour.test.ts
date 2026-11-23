import { describe, expect, it } from "vitest";
import { favourNote, readFavour, type Series } from "@/app/lib/favour";

/** Weekday closes from 2025-11-03, built from a per-day growth function. */
function series(days: number, step: (i: number) => number): Series {
  const dates: string[] = [];
  const adj: number[] = [];
  let v = 100;
  const d = new Date("2025-11-03T12:00:00Z");
  while (dates.length < days) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      v *= 1 + step(dates.length);
      dates.push(d.toISOString().slice(0, 10));
      adj.push(v);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { dates, adj };
}
const flat = series(270, () => 0);

describe("in / out of favour", () => {
  it("a steady riser at its high is in favour; a steady faller is out of favour", () => {
    const up = readFavour(series(270, () => 0.002), flat);
    expect(up.state).toBe("in");
    expect(up.fromHighPct).toBe(0);
    expect(up.rel.m6!).toBeGreaterThan(10);
    const down = readFavour(series(270, () => -0.002), flat);
    expect(down.state).toBe("out");
    expect(down.fromHighPct!).toBeLessThan(-20);
    expect(down.reasons.join(" ")).toContain("52-week high");
  });

  it("relative, not absolute: a stock rising with the index is neutral", () => {
    const idx = series(270, () => 0.002);
    expect(readFavour(series(270, () => 0.002), idx).state).toBe("neutral");
  });

  it("a long fall with a strong last three months is coming back into favour", () => {
    const s = series(270, (i) => (i < 205 ? -0.003 : 0.006));
    const r = readFavour(s, flat);
    expect(r.state).toBe("recovering");
    expect(favourNote(r.state, "Portfolio")).toContain("switch candidate");
  });

  it("a long rise with a weak last three months is losing favour", () => {
    expect(readFavour(series(270, (i) => (i < 205 ? 0.004 : -0.003)), flat).state).toBe("slipping");
  });

  it("under six months of history is labelled, not guessed", () => {
    expect(readFavour(series(60, () => 0.01), flat).state).toBe("thin");
    expect(readFavour({ dates: [], adj: [] }, flat).state).toBe("thin");
  });
});
