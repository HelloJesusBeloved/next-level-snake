import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAuthUser();
  return NextResponse.json(
    { user: user ? { username: user.username } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
