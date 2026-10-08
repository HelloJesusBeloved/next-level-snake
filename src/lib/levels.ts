// Speed levels and growth multipliers — one definition shared by the game
// engine (public/game.js mirrors this table), the API and the UI.
//
// Modifiers are either presets (speed 1..6, growth 1..5) or custom values on a
// 0..100 scale. A run is "custom mode" when at least one modifier is custom,
// and custom runs get their own leaderboard.
export type Level = {
  id: number;
  label: string;
  ms: number;
};

export const LEVELS: Level[] = [
  { id: 1, label: "Chill", ms: 165 },
  { id: 2, label: "Easy", ms: 130 },
  { id: 3, label: "Normal", ms: 105 },
  { id: 4, label: "Fast", ms: 80 },
  { id: 5, label: "Insane", ms: 60 },
  { id: 6, label: "Ludicrous", ms: 42 },
];

export const MIN_SPEED_ID = 1;
export const MAX_SPEED_ID = 6;
export const MIN_GROWTH = 1;
export const MAX_GROWTH = 5;
export const MIN_CUSTOM = 0;
export const MAX_CUSTOM = 100;

export function levelOf(id: number): Level {
  return LEVELS.find((level) => level.id === id) ?? LEVELS[2];
}

// Combo key: "3-1" (presets) or "c42-c7" (custom values), "c42-1" mixed.
export function comboKeyFrom(
  speedLevel: number | null,
  speedCustom: number | null,
  growth: number | null,
  growthCustom: number | null,
): string {
  const s = speedCustom != null ? `c${speedCustom}` : String(speedLevel);
  const g = growthCustom != null ? `c${growthCustom}` : String(growth);
  return `${s}-${g}`;
}

export function describeSpeed(
  speedLevel: number | null,
  speedCustom: number | null,
): string {
  if (speedCustom != null) return `Custom · ${speedCustom} ms`;
  const level = levelOf(Number(speedLevel));
  return `${level.label} · ${level.ms} ms`;
}

export function describeGrowth(
  growth: number | null,
  growthCustom: number | null,
): string {
  if (growthCustom != null) return `×${growthCustom} (custom)`;
  return `×${growth}`;
}
