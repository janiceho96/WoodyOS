CREATE OR REPLACE FUNCTION reject_quality_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- FK cascades remove the workflow run before this child-row trigger fires.
  -- A direct child deletion still sees its committed parent and is rejected.
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (
       SELECT 1
         FROM workflow_runs
        WHERE id = OLD.workflow_run_id
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Quality history entries are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS quality_history_entries_immutable ON quality_history_entries;
CREATE TRIGGER quality_history_entries_immutable
BEFORE UPDATE OR DELETE ON quality_history_entries
FOR EACH ROW EXECUTE FUNCTION reject_quality_history_mutation();

DROP TRIGGER IF EXISTS quality_history_entries_immutable_truncate ON quality_history_entries;
CREATE TRIGGER quality_history_entries_immutable_truncate
BEFORE TRUNCATE ON quality_history_entries
FOR EACH STATEMENT EXECUTE FUNCTION reject_quality_history_mutation();
