class AddBrawlConnectionRecovery < ActiveRecord::Migration[8.0]
  # Step 10: durable, server-owned Brawl disconnection state.
  #
  # * match_participants carries the authoritative connection classification
  #   and the freeze deadline (a wall-clock instant the leased simulator owner
  #   enforces). A frozen snake is still alive and still on the broadcast board;
  #   only its movement pauses.
  # * match_presences records one row per open MatchChannel socket, so several
  #   tabs of one browser are counted independently. Losing one tab never
  #   freezes the player while another tab is still delivering heartbeats.
  # * freeze_windows_used/last_freeze_started_at bound deliberate
  #   disconnect/reconnect abuse: only a small number of grace windows are
  #   granted per match, each after a cooldown.
  def change
    add_column :match_participants, :connection_state, :string, null: false, default: "connected"
    add_column :match_participants, :disconnected_at, :datetime
    add_column :match_participants, :reconnected_at, :datetime
    add_column :match_participants, :frozen_at, :datetime
    add_column :match_participants, :freeze_deadline_at, :datetime
    add_column :match_participants, :freeze_windows_used, :integer, null: false, default: 0
    add_column :match_participants, :last_freeze_started_at, :datetime
    add_column :match_participants, :freeze_ticks, :bigint, null: false, default: 0
    add_column :match_participants, :last_seen_at, :datetime

    add_check_constraint :match_participants,
                         "connection_state IN ('connected', 'disconnected', 'unattended')",
                         name: "match_participants_connection_state_check"
    add_check_constraint :match_participants,
                         "freeze_windows_used >= 0 AND freeze_ticks >= 0",
                         name: "match_participants_freeze_counters_check"

    # "interrupted" is a terminal state distinct from abandoned/completed: the
    # engine never produced a trustworthy result for it, so it can never own a
    # winner or fabricated standings.
    remove_check_constraint :matches, name: "matches_status_check"
    add_check_constraint :matches,
                         "status IN ('pending', 'running', 'paused', 'completed', 'abandoned', 'interrupted')",
                         name: "matches_status_check"

    add_index :match_participants, [:match_id, :connection_state],
              name: "match_participants_connection_idx"

    create_table :match_presences do |t|
      t.references :match, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.references :room_membership, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.references :match_participant, null: true,
                   foreign_key: { on_delete: :nullify }, index: false
      t.string :socket_token, null: false
      t.string :kind, null: false, default: "participant"
      t.datetime :connected_at, null: false
      t.datetime :last_seen_at, null: false
      t.timestamps
    end

    add_index :match_presences, :socket_token, unique: true
    add_index :match_presences, [:match_id, :room_membership_id],
              name: "match_presences_identity_idx"
    add_index :match_presences, [:match_id, :last_seen_at],
              name: "match_presences_freshness_idx"
  end
end
