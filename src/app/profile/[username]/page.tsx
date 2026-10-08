import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ProfileShell from "@/components/profile-shell";

export const metadata: Metadata = {
  title: "Player profile — Next Level Snake",
};

export const dynamic = "force-dynamic";

// Any player's public profile. The username comes from the URL segment; it may
// contain spaces/punctuation/case, so Next decodes it before passing it here.
// public/profile.js loads /api/profile?username=NAME and draws the profile.
export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  // Next.js already URL-decodes the segment; decode again only when it still
  // looks encoded, because a username may legally contain a literal "%".
  const { username } = await params;
  let name = username;
  try {
    name = decodeURIComponent(username);
  } catch {
    name = username; // a literal "%" that is not a valid escape — use it as-is
  }
  name = name.trim();
  if (!name) notFound();
  return <ProfileShell username={name} />;
}
