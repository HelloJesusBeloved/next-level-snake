require 'test_helper'

# Real Action Cable test adapter and its exact ActiveSupport::JSON coder.
# PostgreSQL NOTIFY rejects a payload >= 8000 bytes; a match with several
# growing snakes previously kept simulating while every client stopped seeing
# new positions. No test sleeps or depends on a browser/room leader.
class SnapshotTransportTest < ActiveSupport::TestCase
  def snapshot(players: 8, body_length: 250)
    {
      'v' => 1, 'type' => 'snapshot', 'm' => 42, 's' => 'running', 't' => 87,
      'b' => { 'c' => 24, 'r' => 18 },
      'p' => Array.new(players) do |id|
        { 'i' => id + 1, 'n' => "Snäkë 🐍 #{id}", 'c' => '#FF0022',
          'sc' => id, 'l' => body_length, 'a' => true, 'd' => 'right',
          'b' => Array.new(body_length) { |cell| cell % 432 } }
      end,
      'f' => [], 'q' => Array.new(players) { |id| { 'i' => id + 1, 'sc' => id, 'p' => id + 1 } }
    }
  end

  test 'ordinary snapshots use the original one-message wire format' do
    frame = snapshot(players: 2, body_length: 3)
    messages = MatchChannel.snapshot_messages(frame)
    assert_equal [frame], messages
    stream = MatchChannel.stream_for(frame.fetch('m'))
    before = ActionCable.server.pubsub.broadcasts(stream).length
    MatchChannel.broadcast_snapshot(frame.fetch('m'), frame)
    written = ActionCable.server.pubsub.broadcasts(stream).drop(before)
    assert_equal 1, written.size
    assert_equal frame, ActiveSupport::JSON.decode(written.first)
  end

  test 'eight long snakes stay visible without exceeding the NOTIFY limit' do
    frame = snapshot
    assert_operator ActiveSupport::JSON.encode(frame).bytesize, :>=, 8_000
    messages = MatchChannel.snapshot_messages(frame)
    assert_operator messages.size, :>, 1
    messages.each_with_index do |message, index|
      assert_equal 'snapshot_chunk', message.fetch('type')
      assert_equal index, message.fetch('part')
      assert_equal messages.length, message.fetch('parts')
      assert_operator ActiveSupport::JSON.encode(message).bytesize, :<, 8_000,
                      "each NOTIFY must be smaller than PostgreSQL's hard payload limit"
      assert message.fetch('data').ascii_only?, 'never split a UTF-8 name/codepoint'
    end
    assert_equal frame, JSON.parse(messages.map { |message| message.fetch('data') }.join)
    stream = MatchChannel.stream_for(frame.fetch('m'))
    before = ActionCable.server.pubsub.broadcasts(stream).length
    MatchChannel.broadcast_snapshot(frame.fetch('m'), frame)
    transmitted = ActionCable.server.pubsub.broadcasts(stream).drop(before)
    assert_equal messages.length, transmitted.length
    assert_equal messages, transmitted.map { |value| ActiveSupport::JSON.decode(value) }
  end

  test 'a full default mobile board remains reconstructible for several opponents' do
    frame = snapshot(players: 12, body_length: 432)
    messages = MatchChannel.snapshot_messages(frame)
    assert_operator messages.length, :>, 2
    assert messages.all? { |message| ActiveSupport::JSON.encode(message).bytesize < 8_000 }
    assert_equal frame, JSON.parse(messages.map { |message| message.fetch('data') }.join)
  end
end
