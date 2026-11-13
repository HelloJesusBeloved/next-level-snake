import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveTarget, isSteeringBlocker, matchViewInset, shouldRevealBoard } from '../public/multiplayer/page-focus.js';

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

test('the phone start view leaves half a pill-gap above the room border', () => {
  assert.equal(matchViewInset(100, 108), 4);
  assert.equal(matchViewInset(null, null), 4);
  assert.equal(matchViewInset(20, 10), 4);
});

test('focus mode blocks buttons and text controls, not unfocus or a dialog', () => {
  const button = {
    closest: (sel) => (sel.includes('button') && !sel.includes('#mp-page-focus') ? button : null),
  };
  const unfocus = {
    closest: (sel) => (sel.includes('#mp-page-focus') || sel.includes('button') ? unfocus : null),
  };
  const dialogBtn = {
    closest: (sel) => (sel.includes('dialog') || sel.includes('button') ? dialogBtn : null),
  };
  const board = { closest: () => null };
  assert.equal(isSteeringBlocker(button), true);
  assert.equal(isSteeringBlocker(unfocus), false);
  assert.equal(isSteeringBlocker(dialogBtn), false);
  assert.equal(isSteeringBlocker(board), false);
});
