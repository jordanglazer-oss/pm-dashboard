import { describe, expect, it } from "vitest";
import { enteredForClose, isUsTradingDay, lastMarketClose, noteIsCurrent, usMarketHolidays } from "@/app/lib/last-close";

// Eastern Standard Time is UTC-5 in late November; EDT is UTC-4 in summer.
const est = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`);
const edt = (date: string, time: string) => new Date(`${date}T${time}:00-04:00`);

describe("lastMarketClose", () => {
  it("before 4 pm is the previous trading day; from 4 pm it is today", () => {
    expect(lastMarketClose(est("2026-11-24", "09:15"))).toBe("2026-11-23"); // Tue morning → Mon
    expect(lastMarketClose(est("2026-11-24", "15:59"))).toBe("2026-11-23");
    expect(lastMarketClose(est("2026-11-24", "16:00"))).toBe("2026-11-24");
    expect(lastMarketClose(est("2026-11-24", "21:30"))).toBe("2026-11-24");
  });
  it("just after midnight still points at the close that just happened", () => {
    expect(lastMarketClose(est("2026-11-25", "00:30"))).toBe("2026-11-24");
  });
  it("rolls back over a weekend", () => {
    expect(lastMarketClose(est("2026-11-21", "11:00"))).toBe("2026-11-20"); // Saturday
    expect(lastMarketClose(est("2026-11-22", "18:00"))).toBe("2026-11-20"); // Sunday evening
    expect(lastMarketClose(est("2026-11-23", "08:00"))).toBe("2026-11-20"); // Monday morning
  });
  it("rolls back over a market holiday", () => {
    expect(lastMarketClose(est("2026-11-26", "17:00"))).toBe("2026-11-25"); // Thanksgiving evening
    expect(lastMarketClose(est("2026-11-27", "10:00"))).toBe("2026-11-25"); // Friday morning after
    expect(lastMarketClose(est("2026-11-27", "16:30"))).toBe("2026-11-27");
    expect(lastMarketClose(edt("2026-07-06", "09:00"))).toBe("2026-07-02"); // Jul 4 on a Saturday → Fri Jul 3 closed
  });
  it("works in daylight time", () => {
    expect(lastMarketClose(edt("2026-06-10", "15:30"))).toBe("2026-06-09");
    expect(lastMarketClose(edt("2026-06-10", "16:05"))).toBe("2026-06-10");
  });
});

describe("US market holidays", () => {
  it("2026", () => {
    expect(usMarketHolidays(2026)).toEqual(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]);
  });
  it("2027: weekend dates are observed on the nearest weekday", () => {
    const h = usMarketHolidays(2027);
    expect(h).toContain("2027-03-26"); // Good Friday
    expect(h).toContain("2027-06-18"); // Juneteenth (Sat) → Friday
    expect(h).toContain("2027-07-05"); // Jul 4 (Sun) → Monday
    expect(h).toContain("2027-12-24"); // Christmas (Sat) → Friday
  });
  it("New Year's Day on a Saturday is not observed", () => {
    expect(usMarketHolidays(2028)).not.toContain("2027-12-31"); // Jan 1 2028 is a Saturday
    expect(isUsTradingDay("2027-12-31")).toBe(true);
  });
  it("ordinary days", () => {
    expect(isUsTradingDay("2026-11-24")).toBe(true);
    expect(isUsTradingDay("2026-11-28")).toBe(false);
  });
});

describe("Daily input checklist dates", () => {
  // Wed 2026-11-25. 15:00 ET = 20:00 UTC; 20:00 ET = 01:00 UTC next day.
  const wed3pm = new Date("2026-11-25T20:00:00Z");
  const wed8pm = new Date("2026-11-26T01:00:00Z");
  it("a number typed for the close in force counts, whatever the UTC date", () => {
    expect(enteredForClose("2026-11-25T14:00:00Z", wed3pm)).toBe(true); // typed 9 am, Tuesday's close
    expect(enteredForClose("2026-11-25T22:00:00Z", wed8pm)).toBe(true); // typed 5 pm, read 8 pm (UTC already Thursday)
    expect(enteredForClose("2026-11-25T20:00:00Z", wed8pm)).toBe(false); // typed 3 pm for Tuesday; Wednesday's close now due
    expect(enteredForClose(undefined, wed3pm)).toBe(false);
  });
  it("a note dated today counts; last evening's prior-close note counts the next morning", () => {
    expect(noteIsCurrent("2026-11-25", "pre-market", wed3pm)).toBe(true);
    expect(noteIsCurrent("2026-11-25", "pre-market", wed8pm)).toBe(true); // UTC date is the 26th
    expect(noteIsCurrent("2026-11-24", "prior-close", wed3pm)).toBe(true);
    expect(noteIsCurrent("2026-11-24", "pre-market", wed3pm)).toBe(false);
    expect(noteIsCurrent("2026-11-24", "prior-close", wed8pm)).toBe(false); // Wednesday's close has happened
    expect(noteIsCurrent(undefined, "prior-close", wed3pm)).toBe(false);
  });
});
