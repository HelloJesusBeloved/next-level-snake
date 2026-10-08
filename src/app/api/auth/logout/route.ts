import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, destroySession, getPresentedSessionIds } from "@/lib/auth";
import { NO_STORE, requireJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const notJson = requireJson(request);
  if (notJson) return notJson;

  try {
    // End every session this request presents: the cookie and the bearer token.
    for (const id of await getPresentedSessionIds()) await destroySession(id);
  } catch {
    // ignore — logging out is idempotent
  }

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
