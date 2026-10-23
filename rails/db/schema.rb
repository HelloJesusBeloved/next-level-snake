# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 2026_01_09_000000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "guest_sessions", force: :cascade do |t|
    t.string "public_id", null: false
    t.string "token_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "last_seen_at"
    t.datetime "revoked_at"
    t.datetime "claimed_at"
    t.bigint "claimed_by_user_id"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["claimed_by_user_id"], name: "index_guest_sessions_on_claimed_by_user_id"
    t.index ["public_id"], name: "guest_sessions_public_id_idx", unique: true
    t.index ["token_digest"], name: "guest_sessions_token_digest_idx", unique: true
    t.check_constraint "claimed_by_user_id IS NULL AND claimed_at IS NULL OR claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL", name: "guest_sessions_claimed_pair_check"
  end

  create_table "room_memberships", force: :cascade do |t|
    t.bigint "room_id", null: false
    t.bigint "user_id"
    t.bigint "guest_session_id"
    t.string "display_name", null: false
    t.string "role", default: "player", null: false
    t.string "state", default: "joined", null: false
    t.datetime "joined_at", null: false
    t.datetime "left_at"
    t.datetime "last_seen_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index "room_id, lower((display_name)::text)", name: "room_memberships_active_name_idx", unique: true, where: "((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text]))"
    t.index ["guest_session_id"], name: "index_room_memberships_on_guest_session_id"
    t.index ["guest_session_id"], name: "room_memberships_one_active_guest_idx", unique: true, where: "((guest_session_id IS NOT NULL) AND ((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text])))"
    t.index ["room_id", "guest_session_id"], name: "room_memberships_room_guest_idx", unique: true, where: "(guest_session_id IS NOT NULL)"
    t.index ["room_id", "state"], name: "room_memberships_room_state_idx"
    t.index ["room_id", "user_id"], name: "room_memberships_room_user_idx", unique: true, where: "(user_id IS NOT NULL)"
    t.index ["room_id"], name: "room_memberships_one_host_idx", unique: true, where: "(((role)::text = 'host'::text) AND ((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text])))"
    t.index ["user_id"], name: "index_room_memberships_on_user_id"
    t.index ["user_id"], name: "room_memberships_one_active_user_idx", unique: true, where: "((user_id IS NOT NULL) AND ((state)::text = ANY (ARRAY[('joined'::character varying)::text, ('ready'::character varying)::text, ('playing'::character varying)::text])))"
    t.check_constraint "(state::text = ANY (ARRAY['left'::character varying::text, 'removed'::character varying::text])) AND left_at IS NOT NULL OR (state::text = ANY (ARRAY['joined'::character varying::text, 'ready'::character varying::text, 'playing'::character varying::text])) AND left_at IS NULL", name: "room_memberships_left_at_check"
    t.check_constraint "(user_id IS NULL) <> (guest_session_id IS NULL)", name: "room_memberships_identity_check"
    t.check_constraint "char_length(btrim(display_name::text)) >= 2 AND char_length(btrim(display_name::text)) <= 30", name: "room_memberships_display_name_check"
    t.check_constraint "role::text = ANY (ARRAY['host'::character varying::text, 'player'::character varying::text])", name: "room_memberships_role_check"
    t.check_constraint "state::text = ANY (ARRAY['joined'::character varying::text, 'ready'::character varying::text, 'playing'::character varying::text, 'left'::character varying::text, 'removed'::character varying::text])", name: "room_memberships_state_check"
  end

  create_table "rooms", force: :cascade do |t|
    t.string "invitation_code", null: false
    t.string "name"
    t.string "mode", default: "brawl", null: false
    t.string "state", default: "lobby", null: false
    t.integer "max_members", default: 8, null: false
    t.jsonb "settings", default: {}, null: false
    t.datetime "started_at"
    t.datetime "finished_at"
    t.datetime "disbanded_at"
    t.datetime "archived_at"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "closed_reason"
    t.bigint "version", default: 1, null: false
    t.index ["invitation_code"], name: "rooms_invitation_code_idx", unique: true
    t.index ["state", "created_at"], name: "rooms_state_created_idx"
    t.check_constraint "closed_reason IS NULL OR (closed_reason::text = ANY (ARRAY['host_disbanded'::character varying::text, 'expired'::character varying::text]))", name: "rooms_closed_reason_check"
    t.check_constraint "max_members >= 2 AND max_members <= 16", name: "rooms_max_members_check"
    t.check_constraint "mode::text = ANY (ARRAY['brawl'::character varying::text, 'duel'::character varying::text])", name: "rooms_mode_check"
    t.check_constraint "state::text = ANY (ARRAY['lobby'::character varying::text, 'in_match'::character varying::text, 'finished'::character varying::text, 'disbanded'::character varying::text, 'archived'::character varying::text])", name: "rooms_state_check"
  end

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

  add_foreign_key "guest_sessions", "users", column: "claimed_by_user_id", on_delete: :nullify
  add_foreign_key "room_memberships", "guest_sessions", on_delete: :cascade
  add_foreign_key "room_memberships", "rooms", on_delete: :cascade
  add_foreign_key "room_memberships", "users", on_delete: :cascade
  add_foreign_key "scores", "users", on_delete: :cascade
end
