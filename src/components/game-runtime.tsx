"use client";

import Script from "next/script";
import { useState } from "react";
import { PUBLIC_ASSET_VERSION } from "@/lib/public-assets";

/**
 * The shared vanilla game mutates its canvas, score tables, and theme DOM.
 * Start it only after this page has hydrated, otherwise React can replace
 * those nodes and leave every event handler attached to detached elements.
 * Rails loads the same files normally, with no React hydration involved.
 */
export default function GameRuntime() {
  const [engineReady, setEngineReady] = useState(false);

  return (
    <>
      <Script
        id="snake-engine"
        src={`/game.js?v=${PUBLIC_ASSET_VERSION}`}
        strategy="afterInteractive"
        onReady={() => setEngineReady(true)}
      />
      {engineReady && (
        <Script
          id="snake-controls"
          src={`/app.js?v=${PUBLIC_ASSET_VERSION}`}
          strategy="afterInteractive"
        />
      )}
    </>
  );
}
