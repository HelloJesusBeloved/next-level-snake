// The cabinet skins a player can pick. The ids match public/app.js (THEMES) and
// public/styles.css ([data-theme=…]); `sunsetfire` is shown as "Royal Sunset".
export const THEME_IDS = [
  "arcade",
  "classic",
  "vintage",
  "terminal",
  "paper",
  "violet",
  "sunsetfire",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
