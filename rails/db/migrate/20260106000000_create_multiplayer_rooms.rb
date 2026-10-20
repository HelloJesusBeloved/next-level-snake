class CreateMultiplayerRooms < ActiveRecord::Migration[8.0]
  # Multiplayer foundation (step 2): rooms, one membership per player per
  # room, and guest identities that never need an account.
  #
  # This migration is purely additive — `users` and `scores` (and every
  # single-player record) are untouched, so it is safe on existing installs.
  #
  # Identity model, in one paragraph: a membership belongs to exactly one
  # principal — a signed-in `users` row OR a `guest_sessions` row (enforced
  # by a CHECK constraint). A guest session stores only the SHA-256 digest
  # of a 256-bit random token; the raw token lives solely in the guest's
  # httpOnly cookie (issued by a later step's endpoint) and never appears
  # in a URL or in this database. A room's invitation code is a separate,
  # shareable secret: it lets someone join as themselves, it never
  # authenticates anyone as an existing member.
  #
  # Uniqueness invariants enforced here (the database, not just the models):
  #   * invitation codes are globally unique;
  #   * one membership row per (room, user) and per (room, guest session);
  #   * at most one ACTIVE membership per user / per guest session across
  #     all rooms, so one identity can never control several simultaneous
  #     matches (partial unique indexes over joined/ready/playing);
  #   * at most one active host per room;
  #   * active display names are unique per room (case-insensitive), so a
  #     name freed by leaving can be reused but never impersonated live.
  #
  # Match-specific tables (Brawl/Duel rounds, results, rankings) come in
  # later steps and will reference rooms/room_memberships. Rooms are never
  # hard-deleted in normal play — they are disbanded, then archived — so
  # those future rows keep a stable parent.
  def change
    active_states = "('joined', 'ready', 'playing')"

    # A guest browser's credential — NOT a user account and NOT a display
    # name. `public_id` is a random, non-secret handle safe to log/serialise;
    # `token_digest` is the SHA-256 of the bearer token. `claimed_by_user`
    # records the one-way, audited moment a verified guest attached their
    # current membership to an account (the token is revoked at the same
    # instant, so it can never be replayed or claimed by anyone else).
    create_table :guest_sessions do |t|
      t.string :public_id, null: false
      t.string :token_digest, null: false
      t.datetime :expires_at, null: false
      t.datetime :last_seen_at
      t.datetime :revoked_at
      t.datetime :claimed_at
      t.references :claimed_by_user,
                   foreign_key: { to_table: :users, on_delete: :nullify },
                   index: true

      t.timestamps null: false

      t.index :public_id, unique: true, name: "guest_sessions_public_id_idx"
      t.index :token_digest, unique: true, name: "guest_sessions_token_digest_idx"
      t.check_constraint "(claimed_by_user_id IS NULL AND claimed_at IS NULL) OR " \
                         "(claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL)",
                         name: "guest_sessions_claimed_pair_check"
    end

    create_table :rooms do |t|
      # 12 chars from a 31-symbol unambiguous alphabet (~59 bits), generated
      # with SecureRandom in the model. Shareable by design; see note above.
      t.string :invitation_code, null: false
      t.string :name
      # Extensible: today's Brawls and Duels differ only in capacity/rules;
      # new modes join the CHECK list when their step lands.
      t.string :mode, null: false, default: "brawl"
      # lobby -> in_match -> finished -> (lobby for a rematch | disbanded)
      # disbanded/finished -> archived. Only `lobby` accepts joins.
      t.string :state, null: false, default: "lobby"
      t.integer :max_members, null: false, default: 8
      # Allow-listed, model-sanitised knobs (speed/growth presets today).
      t.jsonb :settings, null: false, default: {}
      t.datetime :started_at
      t.datetime :finished_at
      t.datetime :disbanded_at
      t.datetime :archived_at

      t.timestamps null: false

      t.index :invitation_code, unique: true, name: "rooms_invitation_code_idx"
      t.index [:state, :created_at], name: "rooms_state_created_idx"
      t.check_constraint "mode IN ('brawl', 'duel')",
                         name: "rooms_mode_check"
      t.check_constraint "state IN ('lobby', 'in_match', 'finished', 'disbanded', 'archived')",
                         name: "rooms_state_check"
      t.check_constraint "max_members BETWEEN 2 AND 16",
                         name: "rooms_max_members_check"
    end

    # One row per player per room, kept after leaving (rejoining reactivates
    # the same row) so future match/result rows have a stable identity to
    # point at. `display_name` is room-specific: changing it never touches
    # `users.username`, and guests pick one freely — it is a label, never a
    # credential. The host is the active membership with role "host" (so a
    # guest can host, and hosting can be transferred without a user row).
    create_table :room_memberships do |t|
      t.references :room, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.references :user, foreign_key: { on_delete: :cascade }
      t.references :guest_session, foreign_key: { on_delete: :cascade }
      t.string :display_name, null: false
      t.string :role, null: false, default: "player"
      # joined <-> ready -> playing -> joined (after a match), and
      # joined/ready/playing -> left (voluntary) | removed (kicked).
      t.string :state, null: false, default: "joined"
      t.datetime :joined_at, null: false
      t.datetime :left_at
      t.datetime :last_seen_at

      t.timestamps null: false

      # Room rosters / state sweeps; also covers plain room_id lookups.
      t.index [:room_id, :state], name: "room_memberships_room_state_idx"
      # One membership row per identity per room — forever, even after
      # leaving — so a rejoin can never fork a second identity in a room.
      t.index [:room_id, :user_id], unique: true, where: "user_id IS NOT NULL",
              name: "room_memberships_room_user_idx"
      t.index [:room_id, :guest_session_id], unique: true, where: "guest_session_id IS NOT NULL",
              name: "room_memberships_room_guest_idx"
      # One ACTIVE seat per identity across ALL rooms: a player must leave
      # before sitting elsewhere, and can therefore never be `playing` in
      # two matches at once. Leaving frees the seat immediately.
      t.index [:user_id], unique: true,
              where: "user_id IS NOT NULL AND state IN #{active_states}",
              name: "room_memberships_one_active_user_idx"
      t.index [:guest_session_id], unique: true,
              where: "guest_session_id IS NOT NULL AND state IN #{active_states}",
              name: "room_memberships_one_active_guest_idx"
      # At most one seated host per room at any moment.
      t.index [:room_id], unique: true,
              where: "role = 'host' AND state IN #{active_states}",
              name: "room_memberships_one_host_idx"
      # No two seated players in a room may share a display name.
      t.index "room_id, LOWER(display_name)", unique: true,
              where: "state IN #{active_states}",
              name: "room_memberships_active_name_idx"

      t.check_constraint "(user_id IS NULL) <> (guest_session_id IS NULL)",
                         name: "room_memberships_identity_check"
      t.check_constraint "role IN ('host', 'player')",
                         name: "room_memberships_role_check"
      t.check_constraint "state IN ('joined', 'ready', 'playing', 'left', 'removed')",
                         name: "room_memberships_state_check"
      t.check_constraint "char_length(btrim(display_name)) BETWEEN 2 AND 30",
                         name: "room_memberships_display_name_check"
      t.check_constraint "(state IN ('left', 'removed') AND left_at IS NOT NULL) OR " \
                         "(state IN #{active_states} AND left_at IS NULL)",
                         name: "room_memberships_left_at_check"
    end
  end
end
