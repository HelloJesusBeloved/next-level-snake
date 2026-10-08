import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { scores } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth";
import { NO_STORE, requireJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// DELETE /api/games/:id — remove one of your own games from your log.
// The log and the leaderboards are the same data, so a removed game also
// leaves the leaderboard.
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const notJson = requireJson(request);
  if (notJson) return notJson;

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json(
      { error: "Sign in to remove games" },
      { status: 401, headers: NO_STORE },
    );
  }

  const { id: rawId } = await context.params;
  const id = /^\d{1,9}$/.test(rawId) ? Number(rawId) : NaN;
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "Game not found" }, { status: 404, headers: NO_STORE });
  }

  try {
    // Scoped to the caller, so someone else's id looks exactly like a missing one.
    const removed = await db
      .delete(scores)
      .where(and(eq(scores.id, id), eq(scores.userId, user.id)))
      .returning({ id: scores.id });
    if (removed.length === 0) {
      return NextResponse.json({ error: "Game not found" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Could not remove the game" }, { status: 500, headers: NO_STORE });
  }
}
