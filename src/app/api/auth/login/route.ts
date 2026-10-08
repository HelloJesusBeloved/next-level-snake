import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { sql } from "drizzle-orm";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  verifyPassword,
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

  // Login never validates input shape — a wrong-length credential gets the
  // same 401 as any other bad credential, so nothing is leaked.
  // Usernames are stored with their original capitalisation, so match on the
  // lowercased value but return the stored name.
  const typed = typeof body.username === "string" ? body.username.trim() : "";
  const username = typed.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 },
    );
  }

  try {
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = ${username}`)
      .limit(1);
    const user = rows[0];

    // Verify even when the user does not exist so the timing is indistinguishable.
    const ok = user
      ? verifyPassword(password, user.passwordDigest)
      : verifyPassword(password, "scrypt$00000000000000000000000000000000$" + "0".repeat(128));

    if (!ok || !user) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 },
      );
    }

    const sessionId = await createSession(user.id);
    const response = NextResponse.json(
      { user: { username: user.username }, token: sessionId },
      { headers: NO_STORE },
    );
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Could not sign in" }, { status: 500 });
  }
}
