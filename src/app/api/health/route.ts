import { NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * Healthcheck used by the preview runtime and by install.sh's smoke test.
 * Deliberately independent of the database so the process can report "up"
 * even while PostgreSQL is still starting.
 */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "snake",
      runtime: "next",
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Keep the db client referenced so the module graph stays honest about its
// dependency on PostgreSQL without failing the healthcheck.
export const __usesDatabase = db !== undefined && sql !== undefined;
