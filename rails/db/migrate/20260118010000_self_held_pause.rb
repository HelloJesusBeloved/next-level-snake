# A host who paused their own snake is not released when another host
# unpauses everyone else. self_held is that private hold; held stays the
# flag the simulator copies.
class SelfHeldPause < ActiveRecord::Migration[8.0]
  def change
    add_column :match_participants, :self_held, :boolean, default: false, null: false
  end
end
