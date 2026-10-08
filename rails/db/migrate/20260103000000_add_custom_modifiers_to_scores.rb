class AddCustomModifiersToScores < ActiveRecord::Migration[8.0]
  # Modifiers are now either presets (speed 1..6, growth 1..5) or custom
  # 0..100 values. Exactly one of the pair is always set; the combo text
  # ("3-1", "c42-c7", ...) keeps every score isolated per combination.
  def change
    change_column_null :scores, :speed_level, false
    change_column_null :scores, :growth, false
    add_column :scores, :speed_custom, :integer
    add_column :scores, :growth_custom, :integer
  end
end
