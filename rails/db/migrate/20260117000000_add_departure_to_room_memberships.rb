class AddDepartureToRoomMemberships < ActiveRecord::Migration[8.0]
  def change
    add_column :room_memberships, :departure, :string
    add_check_constraint :room_memberships,
                         "departure IS NULL OR departure IN ('left', 'kicked', 'banned')",
                         name: "room_memberships_departure_check"
  end
end
