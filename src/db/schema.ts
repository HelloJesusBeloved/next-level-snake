import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { EndState } from "@/lib/endState";

// Username-only accounts (no email — which is why passwords cannot be reset).
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordDigest: text("password_digest").notNull(),
    // One of the theme ids the page knows (see src/lib/themes.ts), or null.
    favoriteTheme: text("favorite_theme"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("users_username_idx").on(table.username)],
);

// Cookie-backed sessions: the cookie holds the session id.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

// One row per finished run. Scores are compared only within the same
// combination of modifiers (speed level x growth multiplier), so the
// combination key is stored alongside the row. user_id links the run to an
// account when the player is signed in (optional — guests can still play).
export const scores = pgTable(
  "scores",
  {
    id: serial("id").primaryKey(),
    score: integer("score").notNull(),
    // Exactly one of speedLevel / speedCustom is set (preset vs 0..100 custom).
    speedLevel: integer("speed_level"),
    speedCustom: integer("speed_custom"),
    // Exactly one of growth / growthCustom is set (preset vs 0..100 custom).
    growth: integer("growth"),
    growthCustom: integer("growth_custom"),
    combo: text("combo").notNull(),
    // Where the snake ended up: grid size, body cells (head first) as
    // y*cols+x indexes, the food, the crash cell and how the run ended.
    // Null for runs recorded before this existed.
    endState: jsonb("end_state").$type<EndState | null>(),
    // Every stored run belongs to a signed-in player. Guest runs are never saved,
    // and deleting an account removes that player's runs.
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("scores_combo_score_idx").on(table.combo, table.score),
    index("scores_user_idx").on(table.userId),
  ],
);
