import type { Metadata } from "next";
import ProfileShell from "@/components/profile-shell";

export const metadata: Metadata = {
  title: "Profile — Next Level Snake",
  description:
    "Your Next Level Snake profile: level, rank, high scores, progress charts, an activity heatmap, favorite mode and theme, and a log of every game with where the snake ended up.",
};

// Your own profile (requires sign-in). public/profile.js reads GET /api/profile
// and draws everything into #profile-root.
export default function ProfilePage() {
  return <ProfileShell />;
}
