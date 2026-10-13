import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { PUBLIC_ASSET_VERSION } from "@/lib/public-assets";

export const metadata: Metadata = {
  title: "Next Level Snake — Wall-Wrap Arcade",
  description:
    "Next Level Snake: one long green body, wrapping walls, red food. Preset or custom speed and growth, seven themes, accounts and public leaderboards. Ships as a Ruby on Rails app in one Docker container.",
  icons: {
    icon: [
      { url: `/favicon.svg?v=${PUBLIC_ASSET_VERSION}`, type: "image/svg+xml" },
      { url: `/favicon-32.png?v=${PUBLIC_ASSET_VERSION}`, sizes: "32x32", type: "image/png" },
      { url: `/favicon.png?v=${PUBLIC_ASSET_VERSION}`, sizes: "192x192", type: "image/png" },
      { url: `/favicon.ico?v=${PUBLIC_ASSET_VERSION}`, sizes: "any" },
    ],
    apple: [{ url: `/apple-touch-icon.png?v=${PUBLIC_ASSET_VERSION}`, sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0c0e10",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href={`/favicon.svg?v=${PUBLIC_ASSET_VERSION}`} type="image/svg+xml" />
        <link rel="alternate icon" href={`/favicon.ico?v=${PUBLIC_ASSET_VERSION}`} />
        <link rel="icon" type="image/png" sizes="32x32" href={`/favicon-32.png?v=${PUBLIC_ASSET_VERSION}`} />
        <link rel="icon" type="image/png" sizes="192x192" href={`/favicon.png?v=${PUBLIC_ASSET_VERSION}`} />
        <link rel="apple-touch-icon" sizes="180x180" href={`/apple-touch-icon.png?v=${PUBLIC_ASSET_VERSION}`} />
        <link rel="stylesheet" href={`/game.css?v=${PUBLIC_ASSET_VERSION}`} />
        <link rel="stylesheet" href={`/styles.css?v=${PUBLIC_ASSET_VERSION}`} />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=JSON.parse(localStorage.getItem('snake.settings.v1')||'{}');document.documentElement.setAttribute('data-theme',s.theme||'classic')}catch(e){document.documentElement.setAttribute('data-theme','classic')}",
          }}
        />
      </head>
      <body>
        {children}
        {/* Terminal theme's Matrix rain, shared by the game and profile pages.
            beforeInteractive guarantees window.MatrixRain exists before app.js
            or profile.js (both afterInteractive) ask for it. */}
        <Script
          id="snake-rain"
          src={`/rain.js?v=${PUBLIC_ASSET_VERSION}`}
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
