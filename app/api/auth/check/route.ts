import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const authCookie = req.cookies.get("auth");
  if (authCookie?.value === "authenticated") {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}
