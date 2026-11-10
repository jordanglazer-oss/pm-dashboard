import { NextRequest, NextResponse } from "next/server";
import { loadMonthlyDraft } from "@/app/lib/pm-monthly-drafts";
import { textToDocx } from "@/app/lib/docx-lite";

/**
 * GET /api/pm-monthly/docx?month=YYYY-MM&lang=en|fr — the SAVED draft for
 * that month as a Word file. Read-only.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get("month") ?? "";
  const lang = req.nextUrl.searchParams.get("lang") === "fr" ? "fr" : "en";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "month required" }, { status: 400 });
  const draft = await loadMonthlyDraft(month);
  const text = draft?.[lang]?.trim();
  if (!text) return NextResponse.json({ error: `no saved ${lang === "en" ? "English" : "French"} draft for ${month}` }, { status: 404 });
  const [y, m] = month.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleString(lang === "en" ? "en-CA" : "fr-CA", { month: "long", year: "numeric", timeZone: "UTC" });
  const title = lang === "en" ? `PM Monthly — ${name}` : `Bulletin mensuel — ${name}`;
  const bytes = textToDocx(text, title);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="PM-Monthly-${month}-${lang.toUpperCase()}.docx"`,
      "Cache-Control": "no-store",
    },
  });
}
