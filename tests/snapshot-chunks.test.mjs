import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SnapshotChunks } from '../public/multiplayer/snapshot-chunks.js';

// Generated with Rails MatchChannel.snapshot_messages, not a guessed browser
// wire shape. Includes an eight-player Brawl with >8000-byte NOTIFY payload,
// and a name containing multibyte Unicode characters.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mobile3-notify-packets.json', import.meta.url)));
const { snapshot, messages } = fixture;
const fresh = () => new SnapshotChunks();

test('real Rails transport chunks assemble the complete authoritative Brawl', () => {
  const parts = fresh();
  const frames = messages.map((part) => parts.receive(part, 42, -1));
  assert.ok(frames.slice(0, -1).every((frame) => frame === null), 'no partial snake reaches the renderer');
  assert.deepEqual(frames.at(-1), snapshot);
  assert.equal(frames.at(-1).p[0].n, 'Snäkë 🐍 0');
  assert.equal(frames.at(-1).p[0].b.length, 250);
  assert.equal(parts.pending, null);
});

test('a lost or duplicate chunk cannot display an incomplete snake', () => {
  const parts = fresh();
  assert.equal(parts.receive(messages[0], 42), null);
  assert.equal(parts.receive(messages[2], 42), null, 'out of order part discards the whole frame');
  for (let i = 1; i < messages.length; i++) assert.equal(parts.receive(messages[i], 42), null);
  assert.equal(parts.pending, null);
  assert.equal(parts.receive(messages[0], 42), null);
  assert.equal(parts.receive(messages[0], 42), null, 'duplicate header resets rather than completing an old frame');
  const completed = messages.slice(1).map((part) => parts.receive(part, 42)).at(-1);
  assert.deepEqual(completed, snapshot, 'next complete snapshot recovers without reconnecting');
});

test('newer frame supersedes an incomplete one; stale ticks never rewind the board', () => {
  const parts = fresh();
  assert.equal(parts.receive(messages[0], 42, 86), null);
  const newerData = messages.map((part) => part.data).join('').replace('"t":87', '"t":88');
  const newer = Array.from({ length: Math.ceil(newerData.length / 3000) }, (_, part) => ({
    ...messages[0], t: 88, part, parts: Math.ceil(newerData.length / 3000),
    data: newerData.slice(part * 3000, (part + 1) * 3000),
  }));
  assert.equal(parts.receive(newer[0], 42, 87), null, 'a newer header supersedes incomplete data');
  assert.equal(parts.receive(messages[1], 42, 88), null, 'an older tick cannot complete a newer frame');
  assert.equal(parts.pending, null);
  const result = newer.map((part) => parts.receive(part, 42, 87)).at(-1);
  assert.equal(result.t, 88, 'the next complete authoritative frame recovers the stream');
  assert.deepEqual(result.p[0].b, snapshot.p[0].b);
  assert.equal(parts.receive(messages[0], 42, 88), null, 'old header rejected after latest tick');
  assert.equal(parts.pending, null);
});

test('wrong match and malformed or over-limit chunks never allocate an unbounded buffer', () => {
  const parts = new SnapshotChunks({ maxParts: 3, maxBytes: 500 });
  assert.equal(parts.receive({ ...messages[0], m: 999 }, 42), null);
  assert.equal(parts.receive({ ...messages[0], parts: 100_000 }, 42), null);
  assert.equal(parts.receive({ ...messages[0], data: 'x'.repeat(3_001) }, 42), null);
  assert.equal(parts.receive(messages[0], 42), null);
  assert.equal(parts.pending, null, 'byte limit rejects the oversized first part');
});

test('corrupt assembled data is discarded and later valid snapshots still work', () => {
  const parts = fresh();
  const broken = messages.map((part) => ({ ...part }));
  broken[0].data = '!' + broken[0].data.slice(1);
  assert.ok(broken.every((part) => parts.receive(part, 42) === null));
  assert.equal(parts.pending, null);
  const frames = messages.map((part) => parts.receive(part, 42));
  assert.deepEqual(frames.at(-1), snapshot);
  parts.reset();
  assert.equal(parts.pending, null, 'rematch and unsubscribe can discard inflight bytes');
});
