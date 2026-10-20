class AddClosedReasonToRooms < ActiveRecord::Migration[8.0]
  # Why a room closed, so the join endpoints can tell an invitation code that
  # was disbanded by its host apart from one whose room quietly expired after
  # everybody left (step 3 requirement: handle invalid, expired and disbanded
  # codes distinctly). Nullable and additive: existing rooms keep NULL.
  def change
    add_column :rooms, :closed_reason, :string
    add_check_constraint :rooms,
                         "closed_reason IS NULL OR closed_reason IN ('host_disbanded', 'expired')",
                         name: "rooms_closed_reason_check"
  end
end
