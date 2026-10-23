class AddMatchLiveSnapshotsAndInputs < ActiveRecord::Migration[8.0]
  # Step 8: full client synchronization without per-tick game writes.
  #
  # * matches.live_snapshot is the latest COMPLETE authoritative frame. It is
  #   persisted only at the independent broadcast cadence (10 Hz), never at
  #   movement frequency, so a reconnecting MatchChannel can bootstrap from a
  #   whole snapshot instead of replaying deltas.
  # * match_inputs rows are small authenticated direction commands written by
  #   any Action Cable worker and consumed only by the match's leased simulator
  #   owner. Applied rows are removed atomically with the checkpoint that
  #   includes their sequence, so a crash replays them from the previous
  #   checkpoint instead of silently dropping an acknowledged turn.
  def change
    add_column :matches, :live_snapshot, :jsonb
    add_column :matches, :snapshot_tick, :bigint, null: false, default: 0
    add_check_constraint :matches, "snapshot_tick >= 0", name: "matches_snapshot_tick_check"

    add_column :match_participants, :last_input_seq, :bigint, null: false, default: 0
    add_check_constraint :match_participants, "last_input_seq >= 0",
                         name: "match_participants_last_input_seq_check"

    create_table :match_inputs do |t|
      t.references :match, null: false, foreign_key: { on_delete: :cascade }, index: false
      t.references :match_participant, null: false,
                   foreign_key: { on_delete: :cascade }, index: false
      t.bigint :input_seq, null: false
      t.bigint :client_tick, null: false
      t.string :direction, null: false
      t.datetime :received_at, null: false

      t.index [:match_id, :id], name: "match_inputs_match_order_idx"
      t.index [:match_participant_id, :input_seq], unique: true,
              name: "match_inputs_participant_seq_idx"
      t.check_constraint "input_seq > 0 AND client_tick >= 0",
                         name: "match_inputs_sequence_check"
      t.check_constraint "direction IN ('up', 'down', 'left', 'right')",
                         name: "match_inputs_direction_check"
    end
  end
end
