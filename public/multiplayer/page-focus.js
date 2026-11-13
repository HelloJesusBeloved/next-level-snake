/*!
 * Page-wide mobile focus for a live Brawl. Presentation and gesture wiring
 * only: a completed swipe calls the existing sendDirection path. It does not
 * decide turns, talk to the server, or touch the simulation.
 */
import { SwipeSteering } from './swipe-steering.js?v=step10-mobile4';

const INTERACTIVE = 'button, a, input, textarea, select, label, option, summary, [contenteditable="true"], dialog, [role="dialog"], [role="button"]';
const FOCUS_PASSTHROUGH = '#mp-page-focus, dialog, [role="dialog"]';

export function isInteractiveTarget(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest(INTERACTIVE);
}

// Ordinary buttons, links and fields are not pressable while the page is
// focused. The unfocus control and an open dialog stay usable.
export function isSteeringBlocker(node) {
  if (!isInteractiveTarget(node)) return false;
  return !node.closest(FOCUS_PASSTHROUGH);
}

function isFocusExempt(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest(FOCUS_PASSTHROUGH);
}

// Half the gap between the Live pill and the Score pill. That is the space
// left above the room border when a phone jumps to the start of a Brawl.
export function matchViewInset(statusEdge, scoreEdge, fallbackGap = 8) {
  const gap = Number(scoreEdge) - Number(statusEdge);
  const distance = Number.isFinite(gap) && gap > 0 ? gap : fallbackGap;
  return distance / 2;
}
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
    // Unfocus and dialogs stay real controls. Everything else is the board:
    // a tap on a button must not press it, and the swipe still counts.
    if (isSteeringBlocker(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    } else if (isInteractiveTarget(event.target)) {
      return;
    }
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

  const onClick = (event) => {
    if (!active || !isSteeringBlocker(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onSelectStart = (event) => {
    if (!active) return;
    const node = event.target;
    if (node && typeof node.closest === 'function' && node.closest('dialog, [role="dialog"]')) return;
    event.preventDefault();
  };
  // iOS tap-and-drag starts a selection even when user-select is none.
  // Cancel the gesture, and wipe a range if one still appears.
  const onTouchStart = (event) => {
    if (!active || isFocusExempt(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };
  const onSelection = () => {
    if (!active) return;
    const selection = document.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    const node = selection.anchorNode;
    const element = node && (node.nodeType === 1 ? node : node.parentElement);
    if (element && typeof element.closest === 'function' && element.closest('dialog, [role="dialog"]')) return;
    selection.removeAllRanges();
  };

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', (event) => finish(event, false), true);
  document.addEventListener('pointercancel', (event) => finish(event, true), true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('selectstart', onSelectStart, true);
  document.addEventListener('contextmenu', onSelectStart, true);
  document.addEventListener('dragstart', onSelectStart, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  document.addEventListener('selectionchange', onSelection, true);

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
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('selectstart', onSelectStart, true);
      document.removeEventListener('contextmenu', onSelectStart, true);
      document.removeEventListener('dragstart', onSelectStart, true);
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('selectionchange', onSelection, true);
    },
  };
}
