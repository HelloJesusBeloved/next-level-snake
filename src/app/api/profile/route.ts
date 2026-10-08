import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { scores, users } from "@/db/schema";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth";
import { NO_STORE, requireJson } from "@/lib/http";
import { isThemeId } from "@/lib/themes";

export const dynamic = "force-dynamic";

// Public profiles: anyone — signed in or not — can view any player's profile.
// Only the owner (is_you) may edit (favorite theme) or delete games; the client
// shows edit controls only when is_you is true.
const MAX_GAMES = 1000;

type GameRow = {
  id: number;
  score: number;
  speed_level: number | null;
  speed_custom: number | null;
  growth: number | null;
  growth_custom: number | null;
  end_state: unknown;
  created_at: string | Date;
};

function rankQuery(userId: number) {
  // Rank = 1 + the number of players whose total completed score (crash runs,
  // excluding quits) is strictly greater. Players with no completed games rank
  // just below everyone who has at least one.
  return sql`(
    SELECT COALESCE((
      SELECT COUNT(*)
      FROM (
        SELECT user_id, SUM(score) AS total
        FROM scores
        WHERE (end_state IS NULL OR end_state->>'cause' <> 'quit')
        GROUP BY user_id
        HAVING SUM(score) > (
          SELECT COALESCE(SUM(score), 0) FROM scores
          WHERE user_id = ${userId}
            AND (end_state IS NULL OR end_state->>'cause' <> 'quit')
        )
      ) ranked
    ), 0) + 1
  )`;
}

async function loadProfile(userId: number) {
  const rows = await db
    .select({
      username: users.username,
      favorite_theme: users.favoriteTheme,
      created_at: users.createdAt,
      rank: rankQuery(userId),
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) return null;

  const games = await db
    .select({
      id: scores.id,
      score: scores.score,
      speed_level: scores.speedLevel,
      speed_custom: scores.speedCustom,
      growth: scores.growth,
      growth_custom: scores.growthCustom,
      end_state: scores.endState,
      created_at: scores.createdAt,
    })
    .from(scores)
    .where(eq(scores.userId, userId))
    .orderBy(desc(scores.createdAt), desc(scores.id))
    .limit(MAX_GAMES);

  return {
    username: user.username,
    favorite_theme: user.favorite_theme,
    created_at: user.created_at,
    rank: Number(user.rank) || 1,
    games,
  };
}

// GET /api/profile              — your own profile (requires sign-in)
// GET /api/profile?username=X   — any player's public profile (no sign-in needed)
export async function GET(request: NextRequest) {
  const usernameParam = request.nextUrl.searchParams.get("username");

  try {
    if (usernameParam) {
      // Exact match first, then a case-insensitive exact match (no LIKE, so
      // punctuation in a name is treated literally).
      const rows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(sql`(lower(${users.username}) = lower(${usernameParam}) OR ${users.username} = ${usernameParam})`)
        .limit(2);
      const exact = rows.find((m) => m.username === usernameParam) ?? rows[0];
      if (!exact) {
        return NextResponse.json({ error: "No player with that name" }, { status: 404, headers: NO_STORE });
      }
      const profile = await loadProfile(exact.id);
      if (!profile) {
        return NextResponse.json({ error: "No player with that name" }, { status: 404, headers: NO_STORE });
      }
      const authUser = await getAuthUser();
      const isYou = authUser ? authUser.username.toLowerCase() === exact.username.toLowerCase() : false;
      return NextResponse.json(
        { user: { ...profile, is_you: isYou } },
        { headers: NO_STORE },
      );
    }

    const authUser = await getAuthUser();
    if (!authUser) {
      return NextResponse.json(
        { error: "Sign in to see your profile" },
        { status: 401, headers: NO_STORE },
      );
    }
    const target = await loadProfile(authUser.id);
    if (!target) {
      return NextResponse.json({ error: "Account not found" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(
      { user: { ...target, is_you: true } },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "Could not load the profile" }, { status: 500, headers: NO_STORE });
  }
}

// PATCH /api/profile { favorite_theme } — owner only.
export async function PATCH(request: NextRequest) {
  const notJson = requireJson(request);
  if (notJson) return notJson;

  const authUser = await getAuthUser();
  if (!authUser) {
    return NextResponse.json(
      { error: "Sign in to edit your profile" },
      { status: 401, headers: NO_STORE },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  if (!("favorite_theme" in body)) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400, headers: NO_STORE });
  }
  const theme = body.favorite_theme;
  if (theme !== null && !isThemeId(theme)) {
    return NextResponse.json({ error: "Unknown theme" }, { status: 400, headers: NO_STORE });
  }

  try {
    await db.update(users).set({ favoriteTheme: theme }).where(eq(users.id, authUser.id));
    const target = await loadProfile(authUser.id);
    return NextResponse.json(
      { user: { ...target, is_you: true } },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "Could not save your profile" }, { status: 500, headers: NO_STORE });
  }
}
