import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Next Level Snake — Wall-Wrap Arcade",
  description:
    "Next Level Snake: one long green body, wrapping walls, red food. Preset or custom speed and growth, seven themes, accounts and public leaderboards. Ships as a Ruby on Rails app in one Docker container.",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
        <link rel="stylesheet" href="/game.css" />
        <link rel="stylesheet" href="/styles.css" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var s=JSON.parse(localStorage.getItem('snake.settings.v1')||'{}');document.documentElement.setAttribute('data-theme',s.theme||'arcade')}catch(e){document.documentElement.setAttribute('data-theme','arcade')}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
