class RemoveAnonymousScores < ActiveRecord::Migration[8.0]
  # Guest runs used to be stored with no user. They are no longer kept: only
  # signed-in runs are saved, and the anonymous bench has been removed. This
  # deletes the leftover guest rows once, then requires an owner on every run.
  # Deleting an account now removes that player's runs, instead of leaving
  # anonymous ones behind.
  def up
    execute "DELETE FROM scores WHERE user_id IS NULL"
    change_column_null :scores, :user_id, false

    remove_foreign_key :scores, :users
    add_foreign_key :scores, :users, on_delete: :cascade
  end

  def down
    remove_foreign_key :scores, :users
    add_foreign_key :scores, :users, on_delete: :nullify
    change_column_null :scores, :user_id, true
  end
end
