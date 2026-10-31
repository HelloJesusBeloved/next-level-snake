// Dedicated ES-module entry point for the Rails /multiplayer page.
// The shared layout restores snake.settings.v1 before paint and loads rain.js.
// Keep the single-player engine and app.js out of this page.
import { mountLobby } from './lobby.js?v=step11-responsive-5';

const root = document.getElementById('multiplayer-root');

if (root && document.documentElement.dataset.theme === 'terminal') {
  window.MatrixRain?.set(true);
}

mountLobby(root);
