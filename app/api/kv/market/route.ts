import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { defaultMarketData } from "@/app/lib/defaults";
import {
  appendOscillatorEntry,
  appendPutCallEntry,
  appendStrategistNote,
} from "@/app/lib/forward-looking";

const KEY = "pm:market";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) {
      await redis.set(KEY, JSON.stringify(defaultMarketData));
      return NextResponse.json({ market: defaultMarketData });
    }
    return NextResponse.json({ market: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (market):", e);
    return NextResponse.json({ market: defaultMarketData });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { updates } = await req.json();
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const existing = raw ? JSON.parse(raw) : defaultMarketData;
    const merged = { ...existing, ...updates };
    await redis.set(KEY, JSON.stringify(merged));

    // If the PM updated the S&P Oscillator, append it to the rolling history
    // log so the sparkline tile in SentimentGauges has trajectory data. The
    // oscillator stays manual (MarketEdge requires login), but logging every
    // saved value lets us show context that a single number can't.
    if (
      typeof updates?.spOscillator === "number" &&
      !isNaN(updates.spOscillator)
    ) {
      // Fire-and-forget — failure to log shouldn't block the save.
      appendOscillatorEntry(updates.spOscillator).catch((err) =>
        console.error("Oscillator history append failed:", err)
      );
    }

    // If the PM updated the Put/Call Ratio, log it to rolling history.
    if (
      typeof updates?.putCall === "number" &&
      !isNaN(updates.putCall)
    ) {
      appendPutCallEntry(updates.putCall).catch((err) =>
        console.error("Put/Call history append failed:", err)
      );
    }

    // If strategist notes changed, append them to the rolling 7-day history
    // log. Each strategist gets its own dated entry so the brief prompt can
    // show the trailing week of notes and Claude can track theme evolution.
    if (updates?.strategistNotes) {
      const notes = updates.strategistNotes as {
        newton?: string;
        lee?: string;
      };
      if (typeof notes.newton === "string") {
        appendStrategistNote("newton", notes.newton).catch((err) =>
          console.error("Newton note history append failed:", err)
        );
      }
      if (typeof notes.lee === "string") {
        appendStrategistNote("lee", notes.lee).catch((err) =>
          console.error("Lee note history append failed:", err)
        );
      }
    }

    return NextResponse.json({ market: merged });
  } catch (e) {
    console.error("Redis write error (market):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
