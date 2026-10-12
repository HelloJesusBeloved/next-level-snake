// XP and level curve shared by the scores API and the profile page.
// Level L needs 100*(L-1)^2 cumulative XP. Custom-mode games and quits earn none.
// Weights match public/profile.js XP_WEIGHT.

export const XP_WEIGHT: Record<number, number> = {
  1: 0.6,
  2: 0.8,
  3: 1,
  4: 1.3,
  5: 1.6,
  6: 2,
};

export type XpProgress = {
  xp: number;
  level: number;
  into: number;
  span: number;
  toNext: number;
  pct: number;
};

export function levelFromXp(xp: number): XpProgress {
  const safe = Math.max(0, Math.round(Number.isFinite(xp) ? xp : 0));
  const level = Math.floor(Math.sqrt(safe / 100)) + 1;
  const base = 100 * (level - 1) * (level - 1);
  const next = 100 * level * level;
  const span = next - base;
  const into = safe - base;
  return {
    xp: safe,
    level,
    into,
    span,
    toNext: next - safe,
    pct: span ? into / span : 0,
  };
}
