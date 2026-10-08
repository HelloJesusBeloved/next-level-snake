class AddProfileFields < ActiveRecord::Migration[8.0]
  # Profile page: where each run ended (for the game log) and the player's
  # favorite theme. Both are optional, so existing rows stay valid.
  def change
    add_column :scores, :end_state, :jsonb
    add_column :scores, :theme, :string
    add_column :users, :favorite_theme, :string
  end
end
