CREATE OR REPLACE FUNCTION reject_workflow_evaluation_manifest_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_manifest IS DISTINCT FROM OLD.execution_manifest THEN
    RAISE EXCEPTION 'Workflow evaluation execution manifest is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_evaluation_runs_manifest_immutable ON workflow_evaluation_runs;
CREATE TRIGGER workflow_evaluation_runs_manifest_immutable
BEFORE UPDATE ON workflow_evaluation_runs
FOR EACH ROW EXECUTE FUNCTION reject_workflow_evaluation_manifest_mutation();
