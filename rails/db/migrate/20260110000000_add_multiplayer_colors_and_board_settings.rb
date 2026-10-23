class AddMultiplayerColorsAndBoardSettings < ActiveRecord::Migration[8.0]
  def up
    # Step 3's migration already specified 64, but upstream's step-4/5 schema
    # dump still had 16. Reconcile both upgrade and schema-loaded installs with
    # the existing room capacity policy before adding palette reservations.
    remove_check_constraint :rooms, name: "rooms_max_members_check"
    add_check_constraint :rooms, "max_members BETWEEN 2 AND 64", name: "rooms_max_members_check"
    add_column :room_memberships, :color_slot, :integer
    add_column :room_memberships, :spectator, :boolean, null: false, default: false
    add_column :room_memberships, :device_reports, :jsonb, null: false, default: {}
    # Active seats first, in a stable order. Inactive history may reuse slots;
    # rejoining checks/reserves a new slot if its former one has been taken.
    execute <<~SQL
      WITH slots AS (
        SELECT id, ((row_number() OVER (
          PARTITION BY room_id ORDER BY (state IN ('joined', 'ready', 'playing')) DESC, joined_at, id
        ) - 1) % 96)::integer AS slot FROM room_memberships
      ) UPDATE room_memberships SET color_slot = slots.slot FROM slots WHERE slots.id = room_memberships.id
    SQL
    change_column_null :room_memberships, :color_slot, false
    add_check_constraint :room_memberships, "color_slot BETWEEN 0 AND 95", name: "memberships_color_slot_check"
    add_check_constraint :room_memberships, "jsonb_typeof(device_reports) = 'object'", name: "memberships_device_reports_check"
    add_index :room_memberships, [:room_id, :color_slot], unique: true,
              where: "state IN ('joined', 'ready', 'playing')", name: "memberships_active_color_idx"

    add_column :rooms, :brawl_columns, :integer, default: 24, null: false
    add_column :rooms, :brawl_rows, :integer, default: 18, null: false
    add_column :rooms, :match_configuration, :jsonb
    add_check_constraint :rooms, "brawl_columns BETWEEN 24 AND 96 AND brawl_rows BETWEEN 18 AND 72", name: "rooms_board_bounds_check"
    # Safe on an installation where an operator used the existing model-only
    # lifecycle hooks: preserve its running roster and freeze the default grid.
    execute <<~SQL
      UPDATE rooms SET match_configuration = jsonb_build_object(
        'columns', 24, 'rows', 18, 'mobile_default', true,
        'locked_at', COALESCE(started_at, created_at),
        'participants', COALESCE((SELECT jsonb_agg(jsonb_build_object('membership_id', id, 'color_slot', color_slot))
          FROM room_memberships WHERE room_id = rooms.id AND state = 'playing'), '[]'::jsonb)
      ) WHERE state = 'in_match'
    SQL
    add_check_constraint :rooms, <<~SQL.squish, name: "rooms_match_configuration_check"
      match_configuration IS NULL OR (
        jsonb_typeof(match_configuration) = 'object' AND
        match_configuration ?& ARRAY['columns','rows','participants','locked_at'] AND
        (match_configuration->>'columns')::integer BETWEEN 24 AND 96 AND
        (match_configuration->>'rows')::integer BETWEEN 18 AND 72 AND
        jsonb_typeof(match_configuration->'participants') = 'array'
      )
    SQL
    add_check_constraint :rooms, "state <> 'in_match' OR match_configuration IS NOT NULL", name: "rooms_running_board_required"
    # DB backstop, including update_all/update_columns and a simultaneous state
    # change. Only the NEXT start (from lobby) may replace the frozen snapshot.
    execute File.read(File.expand_path("../room_board_freeze.sql", __dir__))
  end

  def down
    execute "DROP TRIGGER snake_freeze_running_board ON rooms; DROP FUNCTION snake_freeze_running_board();"
    remove_check_constraint :rooms, name: "rooms_running_board_required"
    remove_check_constraint :rooms, name: "rooms_match_configuration_check"
    remove_check_constraint :rooms, name: "rooms_board_bounds_check"
    remove_column :rooms, :match_configuration
    remove_column :rooms, :brawl_rows
    remove_column :rooms, :brawl_columns
    remove_index :room_memberships, name: "memberships_active_color_idx"
    remove_check_constraint :room_memberships, name: "memberships_color_slot_check"
    remove_check_constraint :room_memberships, name: "memberships_device_reports_check"
    remove_column :room_memberships, :device_reports
    remove_column :room_memberships, :spectator
    remove_column :room_memberships, :color_slot
  end
end
