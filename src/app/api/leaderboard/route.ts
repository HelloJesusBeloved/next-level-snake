import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql, type SQL } from "drizzle-orm";
import { MAX_GROWTH, MAX_SPEED_ID, MIN_GROWTH, MIN_SPEED_ID } from "@/lib/levels";
import { parseFilter, type Filter } from "@/lib/filters";
import { NO_STORE } from "@/lib/http";

export const dynamic = "force-dynamic";

const LIMIT = 25;

type Row = {
  username: string;
  speed_level: number | null;
  speed_custom: number | null;
  growth: number | null;
  growth_custom: number | null;
  score: number;
  created_at: string;
  total: number;
};

// One filter dimension -> one SQL condition. Column names are fixed
// constants; every value goes through a bound parameter.
function condition(filter: Filter, level: SQL, custom: SQL): SQL {
  switch (filter.kind) {
    case "all":
      return sql`TRUE`;
    case "preset":
      return sql`${level} = ${filter.value}`;
    case "custom":
      return filter.value === null
        ? sql`${custom} IS NOT NULL`
        : sql`${custom} = ${filter.value}`;
  }
}

// GET /api/leaderboard?board=standard|custom&speed=all|1..6|c|cNN&growth=...
// Each signed-in player's best run per modifier combination, ranked.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const board = params.get("board") === "custom" ? "custom" : "standard";
  const speed = parseFilter(params.get("speed"), MIN_SPEED_ID, MAX_SPEED_ID);
  const growth = parseFilter(params.get("growth"), MIN_GROWTH, MAX_GROWTH);

  if (!speed || !growth) {
    return NextResponse.json(
      { error: "Invalid filter. Use all, a preset number, c, or cNN." },
      { status: 400, headers: NO_STORE },
    );
  }

  const boardCondition =
    board === "custom"
      ? sql`(best.speed_custom IS NOT NULL OR best.growth_custom IS NOT NULL)`
      : sql`(best.speed_custom IS NULL AND best.growth_custom IS NULL)`;
  const speedCondition = condition(speed, sql.raw("best.speed_level"), sql.raw("best.speed_custom"));
  const growthCondition = condition(growth, sql.raw("best.growth"), sql.raw("best.growth_custom"));

  try {
    const result = await db.execute(sql`
      SELECT
        u.username,
        best.speed_level, best.speed_custom, best.growth, best.growth_custom,
        best.score,
        to_char(best.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
        (COUNT(*) OVER ())::int AS total
      FROM (
        SELECT DISTINCT ON (user_id, speed_level, speed_custom, growth, growth_custom)
          user_id, speed_level, speed_custom, growth, growth_custom, score, created_at
        FROM scores
        ORDER BY user_id,
          speed_level NULLS FIRST, speed_custom NULLS FIRST,
          growth NULLS FIRST, growth_custom NULLS FIRST,
          score DESC, created_at DESC
      ) best
      JOIN users u ON u.id = best.user_id
      WHERE ${boardCondition} AND ${speedCondition} AND ${growthCondition}
      ORDER BY best.score DESC, best.created_at ASC
      LIMIT ${LIMIT}
    `);
    const rows = (result.rows ?? []) as unknown as Row[];
    return NextResponse.json(
      {
        board,
        total: rows[0]?.total ?? 0,
        rows: rows.map((row) => ({
          username: row.username,
          speed_level: row.speed_level,
          speed_custom: row.speed_custom,
          growth: row.growth,
          growth_custom: row.growth_custom,
          score: row.score,
          created_at: row.created_at,
        })),
      },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "Could not load the leaderboard" }, { status: 500, headers: NO_STORE });
  }
}
