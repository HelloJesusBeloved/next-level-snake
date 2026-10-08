import { MAX_CUSTOM, MIN_CUSTOM } from "@/lib/levels";

// Leaderboard filter values, as sent in the query string:
//   "all"  every value        "3"    one preset (speed 1-6 / growth 1-5)
//   "c"    any custom value   "c42"  exactly this custom value (0-100)
export type Filter =
  | { kind: "all" }
  | { kind: "preset"; value: number }
  | { kind: "custom"; value: number | null };

export function parseFilter(
  raw: string | null,
  presetMin: number,
  presetMax: number,
): Filter | null {
  const text = (raw ?? "all").trim().toLowerCase();
  if (text === "" || text === "all") return { kind: "all" };
  if (text === "c") return { kind: "custom", value: null };

  const custom = /^c(\d{1,3})$/.exec(text);
  if (custom) {
    const value = Number(custom[1]);
    return value >= MIN_CUSTOM && value <= MAX_CUSTOM
      ? { kind: "custom", value }
      : null;
  }

  if (/^\d$/.test(text)) {
    const value = Number(text);
    return value >= presetMin && value <= presetMax
      ? { kind: "preset", value }
      : null;
  }
  return null;
}
