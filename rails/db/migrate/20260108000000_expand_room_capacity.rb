class ExpandRoomCapacity < ActiveRecord::Migration[8.0]
  # Rooms no longer have a size you pick at creation. They start at the
  # default (8) and grow on demand as players arrive, up to a hard ceiling
  # (config.x.multiplayer.max_capacity), so nobody fails to pile into their
  # friends' lobby because it started small. The column stays — check-ins,
  # sweeps and the payload use it — only the ceiling moves from 16 to 64.
  def up
    remove_check_constraint :rooms, name: "rooms_max_members_check"
    add_check_constraint :rooms, "max_members BETWEEN 2 AND 64",
                         name: "rooms_max_members_check"
  end

  def down
    # Rollback deliberately refuses to shrink existing rows: rooms larger
    # than 16 would violate the old constraint, which is exactly why the
    # migration prints its name first — cut capacity down first if you truly
    # need to go back.
    if Room.where("max_members > 16").exists?
      raise ActiveRecord::IrreversibleMigration,
            "rooms with more than 16 seats exist; shrink them before rolling back"
    end

    remove_check_constraint :rooms, name: "rooms_max_members_check"
    add_check_constraint :rooms, "max_members BETWEEN 2 AND 16",
                         name: "rooms_max_members_check"
  end
end
