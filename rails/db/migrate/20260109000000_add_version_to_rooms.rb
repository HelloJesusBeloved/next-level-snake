class AddVersionToRooms < ActiveRecord::Migration[8.0]
  # Monotonic sequence number for the live room state (step 4). Every visible
  # change bumps it once; each WebSocket event carries the version it produced.
  # A client applies an event only when it is exactly one ahead of the snapshot
  # it holds — anything older is a stale replay it drops, anything further
  # ahead means it missed events, so it fetches the authoritative snapshot.
  #
  # Additive with a default, so existing rows and rollbacks stay valid.
  def change
    add_column :rooms, :version, :bigint, null: false, default: 1
  end
end
