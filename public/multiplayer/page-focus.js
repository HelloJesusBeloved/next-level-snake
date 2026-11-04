/*!
 * Page-wide mobile focus for a live Brawl. Presentation and gesture wiring
 * only: a completed swipe calls the existing sendDirection path. It does not
 * decide turns, talk to the server, or touch the simulation.
 */
import { SwipeSteering } from './swipe-steering.js?v=step10-mobile4';

const INTERACTIVE = 'button, a, input, textarea, select, label, option, summary, [contenteditable="true"], dialog, [role="dialog"]';

export function isInteractiveTarget(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest(INTERACTIVE);
}

// Once per match id, and only while that match is actually running.
export function shouldRevealBoard(previousId, match) {
  if (!match || match.status !== 'running' || match.id == null) return false;
  return previousId !== match.id;
}

export function createPageFocus({ send, board, reducedMotion = () => false } = {}) {
  const swipes = new SwipeSteering({ send: (direction) => send?.(direction) });
  let active = false;
  let pointerId = null;

  const onDown = (event) => {
    if (!active) return;
    if (event.pointerType === 'mouse') return;
    if (event.isPrimary === false) return;
    if (pointerId !== null) return;
    if (isInteractiveTarget(event.target)) return;
    pointerId = event.pointerId;
    swipes.begin({ x: event.clientX, y: event.clientY });
  };
  const onMove = (event) => {
    if (!active || event.pointerId !== pointerId) return;
    swipes.move({ x: event.clientX, y: event.clientY });
    if (event.cancelable) event.preventDefault();
  };
  const finish = (event, cancel) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (cancel) swipes.cancel();
    else swipes.end({ x: event.clientX, y: event.clientY });
  };

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', (event) => finish(event, false), true);
  document.addEventListener('pointercancel', (event) => finish(event, true), true);

  const reveal = () => {
    if (!board) return;
    board.scrollIntoView({
      block: 'center',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  };

  return {
    get active() { return active; },
    enable() {
      active = true;
      document.documentElement.classList.add('mp-page-focused');
    },
    disable() {
      active = false;
      pointerId = null;
      swipes.cancel();
      document.documentElement.classList.remove('mp-page-focused');
    },
    reveal,
    destroy() {
      this.disable();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
    },
  };
}
