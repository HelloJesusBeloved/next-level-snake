# Step 10 — mobile follow-up 4: fast multi-turn swipes

Base: **pushed HEAD `1a42912`**. Apply `step-10-performance-mobile-4.patch`
with `git am`. One add-on commit. No schema, Duel, protocol-version or
prediction/interpolation change.

## The report

> "If I am going right, and I swipe down and left immediately, I immediately
> want the snake to be going to the left, right alongside itself. Half the time
> when I do that move, I am one square away from myself even though the swipes
> were fast and right."

## Three causes found, each reproduced

### 1. The swipe origin was never re-anchored (the "half the time" bug)

`swipeDirection()` compared the finger against the **single point where the
gesture began**. An L-shaped swipe — down 40 px, then left 40 px — leaves the
finger at `dx = -40, dy = +40` relative to that origin. The axis test
`|dx| > |dy|` is false on a tie, so **the second turn never fired**; it only
fired once the leftward travel exceeded the downward travel. A fast, accurate
two-leg swipe therefore turned down and *kept going down*, or turned left one
or more ticks late — landing the snake a square (or more) away from the body
the player was aiming to hug.

Fixed in `public/multiplayer/swipe-steering.js`: the origin is **re-anchored to
the current finger position after every emitted turn, and after every duplicate
leg**. Each leg now only has to cross a 14 px threshold from where the previous
turn fired. Lifting the finger still commits the leg in progress, so a very
fast flick that never produced a separate move event is not lost. An exact
diagonal tie is deliberately unresolved rather than guessed, and a cancelled
gesture sends nothing.

`tests/swipe-steering.test.mjs` replays the exact reported gesture, the
equal-length-leg case that used to be lost, the lift-flick case, a Z-shaped
three-turn gesture, duplicate-leg suppression and malformed input.

### 2. A client cache silently disabled ALL steering (regression in mobile-3)

`state.controls` cached the own-player state under the keys
`alive`/`frozen`/`direction`, while `sendDirection()` tested `!own.a` and
`own.fr`. Because the cache was preferred, `own.a` was **undefined**, so
`!own?.a` was always true and **every steering intent returned early** — no
WebSocket frame was ever sent. Keyboard, the swipe pad and swipe steering were
all affected; it was invisible to the mobile-3 test run because that suite's
assertion read the *displayed* direction, which a server turn had already
changed by another path.

Fixed by giving the cache the **same field names as the snapshot player**
(`a`, `fr`, `d`). Caught by driving genuine CDP touch events through the real
page and asserting on the actual outgoing Action Cable frames — a mouse-driven
test would have missed it, because the arena correctly ignores mouse pointers.

### 3. A two-deep turn buffer dropped the tail of a fast burst

`MAX_QUEUED_DIRECTIONS = 2` mirrored single-player `pushDir`. A fast touch
gesture can legitimately produce three or four turns inside one movement tick;
the third and fourth were answered `:queue_full` and dropped, with the sequence
number still consumed.

Buffer depth is now a **mode rule**: `Rules#max_queued_directions`, **4 for
Brawl** (a swipe pad on a phone) and **2 for Duel** (solid bodies make a deeper
buffer a hazard). `Snake#queue_direction` takes the limit from the caller, so
the engine default is unchanged for standalone use. Reversal and duplicate
checks are unchanged, the buffer survives a checkpoint round trip, and turns
still apply one per tick in order.

`rails/test/simulation/input_buffer_test.rb` asserts the reported move lands
the snake **directly alongside its own body** (row 6 while the body it left is
in row 5), that a four-turn burst is fully buffered and replayed in order, that
Duel keeps depth 2, and that reversals/duplicates are still refused.

## Verification

* Real touch events (CDP `Input.dispatchTouchEvent`, `pointerType: 'touch'`)
  against the live Rails server, simulator and PostgreSQL Cable adapter:
  **4/4 runs** sent `['down', 'left']`, **2/2 accepted**, **0 rejected**, no
  page errors. The authoritative direction ended `left`.
* New permanent browser test
  `a fast down-then-left touch swipe commits both turns` (mobile project).
* Full browser suites: **18 passed, 1 intentional desktop-only skip**
  (the touch test is phone-only).
* `node --test` across all suites: **69 tests, 0 failures**.
* `bundle exec rails test`: **331 runs / 1,736 assertions, 0 failures**.
* All freeze/clock tests still use injected clocks; none sleep 30 real seconds.

These are local virtualised-browser measurements, not a physical handset,
Cloudflare RTT or scanout guarantee. A swipe that arrives between two server
ticks still takes effect on the next tick — that is server authority, not lag.
