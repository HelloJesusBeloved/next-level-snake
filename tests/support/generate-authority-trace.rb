# Deterministic two-client tape for Responsive authority tests.
#
# Runs the real Simulation::World. Records one authoritative state per tick and
# the frames a Responsive match runner would actually emit (one complete
# snapshot per simulated tick, including each step of a catch-up burst).
#
#   ruby tests/support/generate-authority-trace.rb
require "json"
require_relative "../../rails/app/lib/simulation"
%w[direction config rules rng food snake ranking world protocol scheduler supervisor].each do |file|
  require_relative "../../rails/app/lib/simulation/#{file}"
end

TICKS = 640
TICK_MS = 105
COLUMNS = 24
ROWS = 18

def build
  config = Simulation::Config.new(columns: COLUMNS, rows: ROWS, seed: 11, max_ticks: TICKS + 5,
                                  mode: :brawl, growth: 1, speed_level: nil, tick_ms: TICK_MS)
  people = [
    { id: 1, name: "One", color_hex: "#FF3355", color_slot: 0 },
    { id: 2, name: "Two", color_hex: "#33FF55", color_slot: 1 }
  ]
  world = Simulation::World.new(id: 4242, config: config, participants: people,
                                presentation_strategy: "responsive")
  world.start!
  world.snakes.each_with_index do |snake, index|
    y = 4 + index * 6
    snake.body.replace([[3, y], [2, y], [1, y]])
    snake.direction = Simulation::Direction.parse("right")
    snake.queue.clear
    snake.grow = 0
    snake.score = 0
    snake.food = Simulation::Food.new(x: 18, y: y, owner_id: snake.id, generation: 1)
  end
  world
end

def flat(world, snake)
  snake.body.map { |x, y| y * world.columns + x }
end

# Two rectangles that do not cross themselves. A straight line on a 24-wide
# row dies of self-collision once length passes the row, which used to end
# the tape around tick 330. Perimeter 56 stays ahead of ~40 eats.
BOXES = [
  { left: 1, right: 22, top: 1, bottom: 8 },
  { left: 1, right: 22, top: 10, bottom: 16 }
].freeze

def desired_direction(x, y, dir, box)
  case dir
  when "right" then x >= box[:right] ? "down" : "right"
  when "down" then y >= box[:bottom] ? "left" : "down"
  when "left" then x <= box[:left] ? "up" : "left"
  when "up" then y <= box[:top] ? "right" : "up"
  else "right"
  end
end

def step_cell(x, y, dir, world)
  case dir
  when "right" then [(x + 1) % world.columns, y]
  when "left" then [(x - 1) % world.columns, y]
  when "down" then [x, (y + 1) % world.rows]
  when "up" then [x, (y - 1) % world.rows]
  else [x, y]
  end
end

def ahead_on_path(world, snake, box, distance)
  x, y = snake.head
  dir = snake.direction.name
  distance.times do
    dir = desired_direction(x, y, dir, box)
    x, y = step_cell(x, y, dir, world)
  end
  [x, y]
end

def authority(world)
  {
    "t" => world.tick,
    "players" => world.snakes.map { |snake|
      {
        "i" => snake.id, "h" => flat(world, snake)[0], "b" => flat(world, snake),
        "l" => snake.length, "sc" => snake.score, "d" => snake.direction.name
      }
    },
    "foods" => world.foods.map { |food|
      { "o" => food.owner_id, "c" => food.index(world.columns), "g" => food.generation }
    },
    "fe" => Array(world.food_events).map { |event|
      { "o" => event[:owner], "g" => event[:generation], "t" => event[:tick], "c" => event[:cell] }
    }
  }
end

def steer!(world)
  world.snakes.each_with_index do |snake, index|
    box = BOXES[index]
    x, y = snake.head
    want = desired_direction(x, y, snake.direction.name, box)
    next if want == snake.direction.name

    snake.queue_direction(Simulation::Direction.parse(want), capacity: 4)
  end
end

def park_food(world)
  world.snakes.each_with_index do |snake, index|
    next unless snake.food && snake.food_eaten_at_tick == world.tick

    cell = ahead_on_path(world, snake, BOXES[index], 15)
    snake.food = Simulation::Food.new(x: cell[0], y: cell[1], owner_id: snake.id,
                                      generation: snake.food.generation)
  end
end

world = build
world.snakes.each_with_index do |snake, index|
  box = BOXES[index]
  y = box[:top]
  snake.body.replace([[3, y], [2, y], [1, y]])
  snake.direction = Simulation::Direction.parse("right")
  snake.queue.clear
  snake.grow = 0
  snake.score = 0
  cell = ahead_on_path(world, snake, box, 15)
  snake.food = Simulation::Food.new(x: cell[0], y: cell[1], owner_id: snake.id, generation: 1)
end

states = []
wire = []
world.server_time_ms = 0
world.note_responsive_frame!
states << authority(world)

while world.running? && world.tick < TICKS
  burst = world.tick.positive? && (world.tick % 50).zero? ? 5 : 1
  burst.times do
    break unless world.running? && world.tick < TICKS

    steer!(world)
    world.step!
    park_food(world)
    world.server_time_ms = world.tick * TICK_MS
    world.note_responsive_frame!
    states << authority(world)
  end
  wire.concat(world.drain_responsive_frames)
end

sample = wire.find { |frame| frame["t"] == 30 } || wire.last
payload = {
  "generated_by" => "tests/support/generate-authority-trace.rb",
  "tick_ms" => TICK_MS,
  "columns" => COLUMNS,
  "rows" => ROWS,
  "growth" => 1,
  "snapshot_bytes" => sample.to_json.bytesize,
  "states" => states,
  "wire" => wire
}
puts JSON.generate(payload)
