class CreateMatches < ActiveRecord::Migration[8.0]
  # Step 7: durable match records plus the ownership lease that guarantees one
  # authoritative simulator per match across Puma workers/hosts. State is
  # checkpointed periodically (see MatchRunner), never on every tick.
  def change
    create_table :matches do |t|
      t.references :room, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.string :mode, null: false, default: "brawl"
      t.string :status, null: false, default: "pending"
      t.integer :columns, null: false
      t.integer :rows, null: false
      t.integer :tick_ms, null: false
      t.integer :speed_level
      t.integer :growth, null: false, default: 1
      t.bigint :seed, null: false
      t.bigint :tick, null: false, default: 0
      t.integer :max_ticks, null: false
      t.jsonb :checkpoint, null: false, default: {}
      t.bigint :checkpoint_tick, null: false, default: 0
      t.string :owner_token
      t.datetime :lease_expires_at
      t.datetime :started_at
      t.datetime :ended_at
      t.string :end_reason
      t.bigint :winner_membership_id

      t.timestamps null: false

      # One live match per room. Completed/abandoned history is unconstrained.
      t.index [:room_id], unique: true, name: "matches_one_live_per_room_idx",
              where: "status IN ('pending', 'running', 'paused')"
      t.index [:status, :lease_expires_at], name: "matches_claimable_idx"
      t.index [:room_id, :created_at], name: "matches_room_created_idx"

      t.check_constraint "mode IN ('brawl', 'duel')", name: "matches_mode_check"
      t.check_constraint "status IN ('pending', 'running', 'paused', 'completed', 'abandoned')",
                         name: "matches_status_check"
      t.check_constraint "columns BETWEEN 24 AND 96 AND rows BETWEEN 18 AND 72",
                         name: "matches_board_check"
      t.check_constraint "tick_ms BETWEEN 40 AND 1000", name: "matches_tick_ms_check"
      t.check_constraint "growth BETWEEN 0 AND 100", name: "matches_growth_check"
      t.check_constraint "tick >= 0 AND checkpoint_tick >= 0", name: "matches_ticks_check"
    end
    add_foreign_key :matches, :room_memberships, column: :winner_membership_id, on_delete: :nullify

    create_table :match_participants do |t|
      t.references :match, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.references :room_membership, foreign_key: { on_delete: :nullify }, index: true
      t.string :display_name, null: false
      t.integer :color_slot, null: false
      t.string :color_hex, null: false
      t.string :status, null: false, default: "alive"
      t.integer :final_score, null: false, default: 0
      t.integer :longest_length, null: false, default: 0
      t.bigint :survived_ticks, null: false, default: 0
      t.bigint :eliminated_at_tick
      t.integer :placement

      t.timestamps null: false

      t.index [:match_id, :room_membership_id], unique: true, name: "match_participants_identity_idx"
      t.index [:match_id, :placement], name: "match_participants_placement_idx"
      t.check_constraint "status IN ('alive', 'eliminated', 'left')",
                         name: "match_participants_status_check"
      t.check_constraint "color_slot BETWEEN 0 AND 95", name: "match_participants_color_check"
      t.check_constraint "final_score >= 0 AND longest_length >= 0 AND survived_ticks >= 0",
                         name: "match_participants_counters_check"
    end
  end
end
