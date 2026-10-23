-- Keep this guard in both migration upgrades and db:schema:load installations.
CREATE OR REPLACE FUNCTION snake_freeze_running_board() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'in_match' AND NEW.match_configuration IS DISTINCT FROM OLD.match_configuration THEN
    RAISE EXCEPTION 'A running match configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS snake_freeze_running_board ON rooms;
CREATE TRIGGER snake_freeze_running_board BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION snake_freeze_running_board();
