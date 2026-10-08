# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running
# `bin/rails db:schema:load`. When creating a new database, `bin/rails db:prepare`
# is one way to create the schema.
#
# Strongly recommend checking this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 2026_01_05_000000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "plpgsql"

  create_table "scores", force: :cascade do |t|
    t.integer "score", default: 0, null: false
    t.integer "speed_level"
    t.integer "growth"
    t.string "combo", null: false
    t.datetime "created_at", null: false
    t.bigint "user_id", null: false
    t.integer "speed_custom"
    t.integer "growth_custom"
    t.jsonb "end_state"
    t.string "theme"
    t.index ["combo", "score"], name: "scores_combo_score_idx"
    t.index ["user_id"], name: "index_scores_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "username", null: false
    t.string "password_digest", null: false
    t.string "favorite_theme"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "lower((username)::text)", name: "users_username_lower_idx", unique: true
  end

  add_foreign_key "scores", "users", on_delete: :cascade
end
