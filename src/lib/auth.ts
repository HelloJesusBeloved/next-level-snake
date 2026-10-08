import { timingSafeEqual, randomBytes, scryptSync } from "crypto";
import { cookies, headers } from "next/headers";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Passwords — Node's built-in scrypt, no external dependency. Hashes are
// stored as "scrypt$<salt-hex>$<key-hex>".
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, digest: string): boolean {
  const [scheme, salt, key] = digest.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(key, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

// Usernames are displayed exactly as typed: capital letters, numbers,
// punctuation and spaces are all allowed. Only path separators, angle
// brackets, backticks and control characters are rejected (they would break
// URL routing or HTML).
export const MIN_USERNAME_LEN = 2;
export const MAX_USERNAME_LEN = 30;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const username = raw.trim();
  if (username.length < MIN_USERNAME_LEN || username.length > MAX_USERNAME_LEN) return null;
  if (/[/\\<>`]/.test(username)) return null;
  if (/[\u0000-\u001f\u007f]/.test(username)) return null;
  return username;
}

export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 8 || raw.length > 128) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Sessions. A session id can arrive two ways:
//   * the httpOnly cookie (normal browsing), or
//   * an "Authorization: Bearer <id>" header.
// The header exists because browsers refuse to keep cookies for a page that is
// embedded in a frame on another site (hosted previews, dashboards, some
// privacy modes). In that situation the cookie never sticks and every request
// looks anonymous, so the page also keeps the id and sends it explicitly.
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "snake_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const SESSION_ID = /^[a-f0-9]{64}$/i;

export type AuthUser = {
  id: number;
  username: string;
};

export async function createSession(userId: number): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return id;
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

// Every session id the request presents, header first.
export async function getPresentedSessionIds(): Promise<string[]> {
  const [jar, hdrs] = await Promise.all([cookies(), headers()]);
  const bearer = /^Bearer\s+(\S+)$/i.exec(hdrs.get("authorization") ?? "")?.[1];
  const fromCookie = jar.get(SESSION_COOKIE)?.value;
  return [bearer, fromCookie].filter(
    (id): id is string => typeof id === "string" && SESSION_ID.test(id),
  );
}

async function userForSession(sessionId: string): Promise<AuthUser | null> {
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

// Resolves the caller from the bearer token or the cookie.
export async function getAuthUser(): Promise<AuthUser | null> {
  try {
    for (const id of await getPresentedSessionIds()) {
      const user = await userForSession(id);
      if (user) return user;
    }
    return null;
  } catch {
    return null;
  }
}
