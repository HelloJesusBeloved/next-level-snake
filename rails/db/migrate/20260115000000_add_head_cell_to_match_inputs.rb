class AddHeadCellToMatchInputs < ActiveRecord::Migration[8.0]
  def change
    add_column :match_inputs, :head_cell, :integer
    add_check_constraint :match_inputs, "head_cell IS NULL OR head_cell >= 0",
                         name: "match_inputs_head_cell_check"
  end
end
