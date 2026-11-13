# Shared crowns, permanent spectators, a host pause that survives the
# simulator process, and the "apply my favorite theme" switch on the account
# rather than only in this browser.
class SharedHostPauseAndTheme < ActiveRecord::Migration[8.0]
  def up
    add_column :room_memberships, :permanent_spectator, :boolean, default: false, null: false
    add_column :users, :apply_favorite_theme, :boolean, default: false, null: false
    add_column :match_participants, :held, :boolean, default: false, null: false
    add_column :match_participants, :hold_release_at, :datetime
    add_column :matches, :host_pause, :string
    add_column :matches, :host_pause_until, :datetime

    remove_index :room_memberships, name: "room_memberships_one_host_idx"
    add_index :room_memberships, :room_id, name: "room_memberships_hosts_idx",
              where: "((role)::text = 'host'::text) AND ((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text]))"

    add_check_constraint :matches,
                         "host_pause IS NULL OR (host_pause::text = ANY (ARRAY['paused'::character varying::text, 'countdown'::character varying::text]))",
                         name: "matches_host_pause_check"
  end

  def down
    remove_check_constraint :matches, name: "matches_host_pause_check"
    remove_index :room_memberships, name: "room_memberships_hosts_idx"
    add_index :room_memberships, :room_id, name: "room_memberships_one_host_idx", unique: true,
              where: "((role)::text = 'host'::text) AND ((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text]))"
    remove_column :matches, :host_pause_until
    remove_column :matches, :host_pause
    remove_column :match_participants, :hold_release_at
    remove_column :match_participants, :held
    remove_column :users, :apply_favorite_theme
    remove_column :room_memberships, :permanent_spectator
  end
end
