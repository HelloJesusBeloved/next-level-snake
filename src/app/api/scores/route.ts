import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scores } from "@/db/schema";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth";
import { NO_STORE, requireJson } from "@/lib/http";
import { sanitizeEndState } from "@/lib/endState";
import {
  MAX_CUSTOM,
  MAX_GROWTH,
  MAX_SPEED_ID,
  MIN_CUSTOM,
  MIN_GROWTH,
  MIN_SPEED_ID,
  comboKeyFrom,
} from "@/lib/levels";

export const dynamic = "force-dynamic";

type Row = {
  speed_level: number | null;
  speed_custom: number | null;
  growth: number | null;
  growth_custom: number | null;
  score: number;
};

export type ScorePayload = {
  score: number;
  speed_level?: number | null;
  speed_custom?: number | null;
  growth?: number | null;
  growth_custom?: number | null;
  end_state?: unknown;
};

// The signed-in player's own best run for every modifier combination,
// keyed like "3-1" (presets) or "c42-c7" (custom). Guests have none.
async function bestFor(userId: number): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (speed_level, speed_custom, growth, growth_custom)
      speed_level, speed_custom, growth, growth_custom, score
    FROM scores
    WHERE user_id = ${userId}
    ORDER BY speed_level NULLS FIRST, speed_custom NULLS FIRST,
             growth NULLS FIRST, growth_custom NULLS FIRST,
             score DESC, created_at DESC
  `);
  const best: Record<string, number> = {};
  for (const row of (result.rows ?? []) as unknown as Row[]) {
    best[comboKeyFrom(row.speed_level, row.speed_custom, row.growth, row.growth_custom)] = Number(row.score);
  }
  return best;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export async function GET() {
  try {
    const user = await getAuthUser();
    return NextResponse.json(
      { best: user ? await bestFor(user.id) : {} },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ best: {} }, { headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const notJson = requireJson(request);
  if (notJson) return notJson;

  // Only signed-in runs are stored. Guests get a clear refusal, never a row.
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json(
      { error: "Sign in to save your score" },
      { status: 401, headers: NO_STORE },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const body = (raw ?? {}) as ScorePayload;
  const score = toNumberOrNull(body.score);
  const speedLevel = toNumberOrNull(body.speed_level);
  const speedCustom = toNumberOrNull(body.speed_custom);
  const growth = toNumberOrNull(body.growth);
  const growthCustom = toNumberOrNull(body.growth_custom);

  const bad = (error: string) =>
    NextResponse.json({ error }, { status: 400, headers: NO_STORE });

  if (score == null || score < MIN_CUSTOM || score > 1_000_000) return bad("score must be between 0 and 1000000");
  if (speedLevel == null && speedCustom == null) return bad("Provide speed_level (1-6) or speed_custom (0-100)");
  if (speedLevel != null && speedCustom != null) return bad("Provide exactly one of speed_level or speed_custom");
  if (speedLevel != null && (speedLevel < MIN_SPEED_ID || speedLevel > MAX_SPEED_ID)) return bad("speed_level must be 1-6");
  if (speedCustom != null && (speedCustom < MIN_CUSTOM || speedCustom > MAX_CUSTOM)) return bad("speed_custom must be 0-100");
  if (growth == null && growthCustom == null) return bad("Provide growth (1-5) or growth_custom (0-100)");
  if (growth != null && growthCustom != null) return bad("Provide exactly one of growth or growth_custom");
  if (growth != null && (growth < MIN_GROWTH || growth > MAX_GROWTH)) return bad("growth must be 1-5");
  if (growthCustom != null && (growthCustom < MIN_CUSTOM || growthCustom > MAX_CUSTOM)) return bad("growth_custom must be 0-100");

  try {
    await db.insert(scores).values({
      score,
      speedLevel,
      speedCustom,
      growth,
      growthCustom,
      combo: comboKeyFrom(speedLevel, speedCustom, growth, growthCustom),
      userId: user.id,
      // A malformed snapshot is dropped; it never blocks saving the score.
      endState: sanitizeEndState(body.end_state),
    });
    return NextResponse.json(
      { ok: true, best: await bestFor(user.id) },
      { status: 201, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "Could not store score" }, { status: 500, headers: NO_STORE });
  }
}
