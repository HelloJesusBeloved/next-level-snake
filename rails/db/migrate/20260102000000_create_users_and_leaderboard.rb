class CreateUsersAndLeaderboard < ActiveRecord::Migration[8.0]
  def change
    create_table :users do |t|
      t.string :username, null: false
      t.string :password_digest, null: false
      t.timestamps null: false

      t.index "LOWER(username)", name: "users_username_lower_idx", unique: true
    end

    add_reference :scores, :user, foreign_key: { on_delete: :nullify }, index: true
  end
end
