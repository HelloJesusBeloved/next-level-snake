# Rails' Ruby schema dumper cannot serialize PostgreSQL triggers. Preserve the
# running-board guard in the standard schema load path as well as migrations.
# This is idempotent: the ordinary dump replaces the file before this footer.
Rake::Task["db:schema:dump"].enhance do
  schema = ENV["SCHEMA"].presence || Rails.root.join("db/schema.rb")
  connection = ActiveRecord::Base.connection
  if Rails.application.config.active_record.schema_format != :sql &&
     connection.table_exists?(:rooms) && connection.column_exists?(:rooms, :match_configuration) && File.exist?(schema)
    sql = Rails.root.join("db/room_board_freeze.sql").read
    File.open(schema, "a") do |file|
      file.write("\n# PostgreSQL trigger (retained by lib/tasks/multiplayer_schema.rake).\n")
      file.write("ActiveRecord::Base.connection.execute <<~SQL\n#{sql}SQL\n")
    end
  end
end
