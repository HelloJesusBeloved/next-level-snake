// public/profile.js exposes this for the React preview (Rails just runs it once).
export {};

declare global {
  interface Window {
    SnakeProfile?: { boot: () => void; reload: () => void };
  }
}
