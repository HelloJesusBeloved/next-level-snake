import { NextRequest, NextResponse } from "next/server";

// Every write endpoint takes JSON only. Browsers cannot send a cross-site
// application/json body without a CORS preflight, so this also closes the
// "form post from another site" route into a cookie-authenticated request.
export function requireJson(request: NextRequest): NextResponse | null {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.startsWith("application/json")) return null;
  return NextResponse.json(
    { error: "Content-Type must be application/json" },
    { status: 415, headers: { "Cache-Control": "no-store" } },
  );
}

export const NO_STORE = { "Cache-Control": "no-store" } as const;
