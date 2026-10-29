class AddBrawlPresentationStrategy < ActiveRecord::Migration[8.0]
  def change
    add_column :rooms, :presentation_strategy, :string, null: false, default: "classic"
    add_column :matches, :presentation_strategy, :string, null: false, default: "classic"

    add_check_constraint :rooms,
                         "presentation_strategy IN ('classic', 'responsive')",
                         name: "rooms_presentation_strategy_check"
    add_check_constraint :matches,
                         "presentation_strategy IN ('classic', 'responsive')",
                         name: "matches_presentation_strategy_check"
  end
end
