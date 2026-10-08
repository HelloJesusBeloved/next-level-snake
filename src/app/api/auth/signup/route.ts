import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  hashPassword,
  normalizeUsername,
  validatePassword,
} from "@/lib/auth";
import { NO_STORE, requireJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const notJson = requireJson(request);
  if (notJson) return notJson;

  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const username = normalizeUsername(body.username);
  if (!username) {
    return NextResponse.json(
      { error: "Username must be 2–20 characters: letters, digits, _ or -" },
      { status: 400 },
    );
  }

  const password = validatePassword(body.password);
  if (!password) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }

  try {
    // Case-insensitive: "Bob" and "bob" are the same account, but the name is
    // stored exactly as typed for display.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
      .limit(1);
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "That username is already taken" },
        { status: 409 },
      );
    }

    const inserted = await db
      .insert(users)
      .values({ username, passwordDigest: hashPassword(password) })
      .returning({ id: users.id, username: users.username });

    const sessionId = await createSession(inserted[0].id);
    // `token` is the same session id the cookie carries. The page keeps it and
    // sends it as a bearer header, which keeps working when the browser refuses
    // to store the cookie (embedded previews, strict privacy settings).
    const response = NextResponse.json(
      { user: { username: inserted[0].username }, token: sessionId },
      { status: 201, headers: NO_STORE },
    );
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Could not create the account" },
      { status: 500 },
    );
  }
}
