class DefaultPresentationStrategyResponsive < ActiveRecord::Migration[8.0]
  def change
    change_column_default :rooms, :presentation_strategy, from: "classic", to: "responsive"
    change_column_default :matches, :presentation_strategy, from: "classic", to: "responsive"
  end
end
