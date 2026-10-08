"use client";

import Script from "next/script";
import { useEffect } from "react";

/**
 * public/profile.js draws the whole profile into #profile-root. React hydrates
 * over this page, so the profile must be drawn (or redrawn) AFTER hydration —
 * and again on a client-side navigation between /profile and /profile/NAME.
 * The script exposes window.SnakeProfile.boot() for exactly that; Rails just
 * runs it once on load.
 */
export default function ProfileRuntime() {
  useEffect(() => {
    const boot = () => window.SnakeProfile?.boot?.();
    // The script may already be cached from a previous visit to a profile page.
    if (window.SnakeProfile) boot();
    else window.addEventListener("snake-profile-loaded", boot, { once: true });
    return () => window.removeEventListener("snake-profile-loaded", boot);
  }, []);

  return (
    <Script
      id="snake-profile"
      src="/profile.js"
      strategy="afterInteractive"
      onReady={() => {
        window.dispatchEvent(new Event("snake-profile-loaded"));
        window.SnakeProfile?.boot?.();
      }}
    />
  );
}
