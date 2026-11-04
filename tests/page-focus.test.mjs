import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveTarget, shouldRevealBoard } from '../public/multiplayer/page-focus.js';

test('a running match is brought into view once per match id', () => {
  assert.equal(shouldRevealBoard(null, { id: 4, status: 'running' }), true);
  assert.equal(shouldRevealBoard(4, { id: 4, status: 'running' }), false);
  assert.equal(shouldRevealBoard(4, { id: 5, status: 'running' }), true);
  assert.equal(shouldRevealBoard(null, { id: 4, status: 'completed' }), false);
  assert.equal(shouldRevealBoard(null, null), false);
});

test('interactive controls are not swipe targets', () => {
  const button = { closest: (sel) => (sel.includes('button') ? button : null) };
  const board = { closest: () => null };
  assert.equal(isInteractiveTarget(button), true);
  assert.equal(isInteractiveTarget(board), false);
  assert.equal(isInteractiveTarget(null), false);
});
