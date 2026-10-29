require "test_helper"

class MatchTest < ActiveSupport::TestCase
  def started_room
    room = make_room_with_guest_host
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    room.start_match!
    room
  end

  def test_starting_a_room_freezes_a_durable_match_with_participant_colors
    room = started_room
    match = room.reload.live_match

    assert match, "Room#start_match! creates the durable match"
    assert_equal "pending", match.status
    assert_equal room.mode, match.mode
    assert_equal "classic", match.presentation_strategy
    assert_equal "classic", room.match_configuration["presentation_strategy"]
    assert_equal "classic", match.client_summary[:presentation_strategy]
    assert_equal [room.brawl_columns, room.brawl_rows], [match.columns, match.rows]
    assert_equal room.match_configuration["participants"].length, match.match_participants.count
    assert_equal room.match_configuration["participants"].map { |p| p["color"] }.sort,
                 match.match_participants.pluck(:color_hex).sort
    assert_equal "pending", match.status
    assert_nil match.owner_token
    assert_nil match.started_at
  end

  # Regression guard: a roster that silently shrinks would start a different
  # match than the host froze. Missing frozen participants must fail loudly.
  test "the match factory also refuses Responsive until that presentation is implemented" do
    room = make_room_with_guest_host
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    now = Time.current
    participants = room.room_memberships.active.map do |member|
      { "membership_id" => member.id, "color_slot" => member.color_slot,
        "color" => RoomPalette.color(member.color_slot)[:hex] }
    end
    room.update_columns(
      presentation_strategy: "responsive", state: "in_match", started_at: now,
      match_configuration: {
        "columns" => 24, "rows" => 18, "presentation_strategy" => "responsive",
        "mobile_default" => true, "locked_at" => now.iso8601(6), "participants" => participants
      }
    )

    error = assert_raises(Room::InvalidTransition) { Match.open_for_room!(room.reload) }
    assert_match(/Responsive Brawl is unavailable/, error.message)
    assert_equal 0, Match.where(room_id: room.id).count
  end

  test "match creation refuses to silently drop a frozen participant" do
    room = make_room_with_guest_host
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    now = Time.current
    room.update_columns(
      state: "in_match", started_at: now,
      match_configuration: {
        "columns" => 24, "rows" => 18, "mobile_default" => true,
        "locked_at" => now.iso8601(6),
        "participants" => [
          { "membership_id" => room.host_membership.id, "color_slot" => 0, "color" => "#F66B71" },
          { "membership_id" => 999_999, "color_slot" => 1, "color" => "#0FB4BB" }
        ]
      }
    )

    error = assert_raises(ArgumentError) { Match.open_for_room!(room.reload) }
    assert_match(/no longer seated/, error.message)
    assert_equal 0, Match.where(room_id: room.id).count, "nothing is persisted on refusal"
  end

  test "only one live match may exist per room" do
    room = started_room
    assert_raises(ActiveRecord::RecordNotUnique) { Match.open_for_room!(room.reload) }
  end

  test "the engine world exposes one snake per participant with their frozen colors" do
    room = started_room
    match = room.live_match
    world = match.build_world

    assert_equal match.match_participants.count, world.snakes.length
    assert_equal match.match_participants.pluck(:id).sort, world.snakes.map(&:id).sort
    assert_equal match.match_participants.pluck(:color_hex).sort, world.snakes.map(&:color_hex).sort
    assert_equal [match.columns, match.rows], [world.columns, world.rows]
    assert_equal "pending", world.status.to_s
    assert_equal "classic", world.presentation_strategy
    snapshot = Simulation::Protocol.encode(world)
    assert_equal match.id, snapshot["m"]
    assert_equal 0, snapshot["t"]
    assert_equal 1, snapshot["v"]
    assert_equal "classic", snapshot["strategy"]
    assert_equal 0, snapshot["p"].first["is"]
    assert_nil snapshot["p"].first["it"]
  end

  test "independent matches never share simulation state" do
    first_room = started_room
    second_room = started_room
    first = first_room.live_match.build_world
    second = second_room.live_match.build_world
    first.start!
    first.step!
    assert_equal 1, first.tick
    assert_equal 0, second.tick
  end

  test "a lease is exclusive, renewable and released on completion" do
    match = started_room.live_match
    now = Time.current

    assert match.claim_lease!(token: "owner-a", ttl_seconds: 5, now: now)
    refute match.claim_lease!(token: "owner-b", ttl_seconds: 5, now: now),
           "a second process must not claim a live lease"
    assert match.renew_lease!(token: "owner-a", ttl_seconds: 5, now: now + 4)
    assert match.claim_lease!(token: "owner-b", ttl_seconds: 5, now: now + 20),
           "an expired lease may be taken over"
    refute match.renew_lease!(token: "owner-a", ttl_seconds: 5, now: now + 21)
  end

  test "checkpoints and results are fenced on the owning token" do
    match = started_room.live_match
    world = match.build_world
    world.start!
    now = Time.current
    assert match.claim_lease!(token: "owner-a", ttl_seconds: 5, now: now)
    assert match.save_progress!(world, token: "owner-a", now: now + 1)
    assert_equal "running", match.reload.status

    assert match.claim_lease!(token: "owner-b", ttl_seconds: 60, now: now + 30)
    refute match.save_progress!(world, token: "owner-a", now: now + 31),
           "a stale owner cannot overwrite the checkpoint"
    refute match.complete_from_world!(world, token: "owner-a", now: now + 31)
    assert_equal "running", match.reload.status
  end

  test "completion persists final points, placements and the winning membership" do
    match = started_room.live_match
    world = match.build_world
    world.start!
    eliminated, survivor = world.snakes
    eliminated.score = 9
    eliminated.eliminate!(at_tick: 3, reason: :self_collision)
    eliminated.survived_ticks = 3
    survivor.score = 4
    survivor.survived_ticks = 90
    world.finish!(reason: :tick_limit)

    token = "owner-a"
    assert match.claim_lease!(token: token, ttl_seconds: 30)
    entries = match.complete_from_world!(world, token: token)
    assert_equal 2, entries.length
    assert_equal eliminated.id, entries.first.id, "final points outrank survival"

    match.reload
    assert match.completed?
    assert_equal "tick_limit", match.end_reason
    assert_equal ["completed", "running"].include?(match.status) ? "completed" : match.status, match.status
    winner = match.match_participants.find(eliminated.id)
    runner_up = match.match_participants.find(survivor.id)
    assert_equal 1, winner.placement
    assert_equal 9, winner.final_score
    assert_equal 3, winner.eliminated_at_tick
    assert_equal 2, runner_up.placement
    assert_equal 4, runner_up.final_score
    assert_equal winner.room_membership_id, match.winner_membership_id
    assert_nil match.owner_token
  end

  test "an abandoned match still ranks the last checkpoint instead of losing points" do
    match = started_room.live_match
    world = match.build_world
    world.start!
    world.snakes.first.score = 6
    world.snakes.last.score = 2
    assert match.claim_lease!(token: "owner-a", ttl_seconds: 30)
    assert match.save_progress!(world, token: "owner-a")

    match.abandon!(reason: "room_disbanded")

    assert match.reload.abandoned?
    assert_equal "room_disbanded", match.end_reason
    assert_equal 6, match.match_participants.find(world.snakes.first.id).final_score
    assert_equal 1, match.match_participants.find(world.snakes.first.id).placement
  end

  # Regression: an abandoned match with no checkpoint used to spawn a fresh
  # world and persist zero-point placements, fabricating a result.
  test "abandonment without a checkpoint records no fabricated standings" do
    match = started_room.live_match

    match.abandon!(reason: "room_disbanded")

    assert match.reload.abandoned?
    assert_equal [0], match.match_participants.pluck(:final_score).uniq
    assert_equal [nil], match.match_participants.pluck(:placement).uniq,
                 "a match that never ran must not be ranked"
    assert_nil match.winner_membership_id
  end

  test "abandonment from a real checkpoint still preserves points and placement" do
    match = started_room.live_match
    world = match.build_world
    world.start!
    world.snakes.first.score = 7
    world.snakes.last.score = 2
    match.update_columns(status: "running", checkpoint: world.to_state,
                         checkpoint_tick: 0, tick: 0)

    match.abandon!(reason: "room_disbanded")

    assert_equal [7, 2], match.match_participants.order(:placement).pluck(:final_score)
    assert_equal [1, 2], match.match_participants.order(:placement).pluck(:placement)
  end

  test "finishing or disbanding the room abandons its live match" do
    room = started_room
    match = room.live_match
    room.finish_match!
    assert_equal "abandoned", match.reload.status
    assert_equal "room_finished", match.end_reason

    other = started_room
    other_match = other.live_match
    other.disband!
    assert_equal "abandoned", other_match.reload.status
    assert_equal "room_disbanded", other_match.end_reason
  end

  test "room speed and growth settings become validated engine configuration" do
    room = make_room_with_guest_host(settings: { "speed_level" => 5, "growth" => 3 })
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    room.start_match!
    match = room.live_match
    config = match.simulation_config
    assert_equal 60, config.tick_ms
    assert_equal 3, config.growth
    assert_equal 5, match.speed_level
    assert_equal "brawl", config.mode.to_s
  end

  test "engine presets mirror the canonical single-player engine and board bounds" do
    source = Rails.root.parent.join("public/game.js").read
    levels = source[/var LEVELS = \[(.*?)\];/m, 1]
    expected_ms = levels.scan(/ms:\s*(\d+)/).flatten.map(&:to_i)
    assert_equal expected_ms, Simulation::Config::SPEED_PRESETS.sort.to_h.values,
                 "server ticks must use the same speed presets as public/game.js"
    default_cols = source[/var cols = opts\.cols \|\| (\d+)/, 1].to_i
    default_rows = source[/var rows = opts\.rows \|\| (\d+)/, 1].to_i
    assert_equal [default_cols, default_rows],
                 [Simulation::Config::DEFAULT_COLUMNS, Simulation::Config::DEFAULT_ROWS]
    assert_equal [RoomBoard::COLUMNS.first, RoomBoard::COLUMNS.last],
                 [Simulation::Config::MIN_COLUMNS, Simulation::Config::MAX_COLUMNS]
    assert_equal [RoomBoard::ROWS.first, RoomBoard::ROWS.last],
                 [Simulation::Config::MIN_ROWS, Simulation::Config::MAX_ROWS]
  end

  test "the maximum roster spawns without overlapping on the smallest frozen board" do
    room = make_room_with_guest_host
    63.times { |index| room.join!(guest_session: make_guest.first, display_name: "P#{index}") }
    room.update_columns(brawl_columns: 24, brawl_rows: 18)
    room.start_match!
    match = room.live_match
    world = match.build_world
    assert_equal 64, world.snakes.length
    cells = world.snakes.flat_map(&:body)
    assert_equal cells.length, cells.uniq.length, "spawned bodies must never overlap"
  end
end

# Real threads, real (non-transactional) rows: proves the database, not a Ruby
# flag, decides who owns a match.
class MatchLeaseConcurrencyTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  setup do
    @room = Room.create_with_host!(guest_session: GuestSession.issue.first, display_name: "Host")
    @room.join!(guest_session: GuestSession.issue.first, display_name: "Rival")
    @room.start_match!
    @match = @room.live_match
  end

  teardown do
    MatchParticipant.delete_all
    Match.delete_all
    RoomMembership.delete_all
    Room.delete_all
    GuestSession.delete_all
    User.delete_all
    Score.delete_all
  end

  test "exactly one of eight processes wins the match lease" do
    tokens = Array.new(8) { |index| "contender-#{index}" }
    gate = Queue.new
    threads = tokens.map do |token|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          gate.pop
          @match.claim_lease!(token: token, ttl_seconds: 30, now: Time.current)
        end
      end
    end
    tokens.each { gate << true }
    results = threads.map(&:value)

    assert_equal 1, results.count(true), "the conditional UPDATE admits one owner"
    winner = tokens[results.index(true)]
    assert_equal winner, @match.reload.owner_token
  end
end
