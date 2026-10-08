class CreateScores < ActiveRecord::Migration[8.0]
  def change
    create_table :scores do |t|
      t.integer :score, null: false, default: 0
      t.integer :speed_level, null: false
      t.integer :growth, null: false
      t.string :combo, null: false
      t.datetime :created_at, null: false

      t.index [:combo, :score], name: "scores_combo_score_idx"
    end
  end
end
