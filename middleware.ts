import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow the login page and auth API through
  if (pathname === "/login" || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Check for auth cookie
  const authCookie = req.cookies.get("auth");
  if (authCookie?.value === "authenticated") {
    return NextResponse.next();
  }

  // Redirect to login
  const loginUrl = new URL("/login", req.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
