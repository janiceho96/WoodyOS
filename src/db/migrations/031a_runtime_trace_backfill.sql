CREATE OR REPLACE FUNCTION ensure_runtime_root_trace()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.trace_id := COALESCE(NEW.trace_id, gen_random_uuid());
  NEW.span_id := COALESCE(NEW.span_id, gen_random_uuid());
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_runtime_child_trace()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject_trace UUID;
  subject_span UUID;
BEGIN
  IF TG_TABLE_NAME='task_events' THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM tasks WHERE id=NEW.task_id;
  ELSIF TG_TABLE_NAME IN ('workflow_run_events','workflow_run_node_states') THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM workflow_runs WHERE id=NEW.workflow_run_id;
  ELSIF TG_TABLE_NAME='action_authorizations' AND NEW.task_id IS NOT NULL THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM tasks WHERE id=NEW.task_id;
  ELSIF TG_TABLE_NAME='action_authorizations' AND NEW.workflow_run_id IS NOT NULL THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM workflow_runs WHERE id=NEW.workflow_run_id;
  ELSIF TG_TABLE_NAME='mcp_tool_calls' AND NEW.task_id IS NOT NULL THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM tasks WHERE id=NEW.task_id;
  ELSIF TG_TABLE_NAME='mcp_tool_calls' AND NEW.workflow_run_id IS NOT NULL THEN
    SELECT trace_id,span_id INTO subject_trace,subject_span FROM workflow_runs WHERE id=NEW.workflow_run_id;
  END IF;
  IF subject_trace IS NULL OR subject_span IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_PARENT_TRACE_REQUIRED';
  END IF;
  IF NEW.trace_id IS NOT NULL AND NEW.trace_id<>subject_trace THEN
    RAISE EXCEPTION 'RUNTIME_TRACE_MISMATCH';
  END IF;
  NEW.trace_id := subject_trace;
  NEW.span_id := COALESCE(NEW.span_id,gen_random_uuid());
  NEW.parent_span_id := COALESCE(NEW.parent_span_id,subject_span);
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tasks_require_runtime_root_trace') THEN
    CREATE TRIGGER tasks_require_runtime_root_trace
      BEFORE INSERT ON tasks
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_root_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workflow_runs_require_runtime_root_trace') THEN
    CREATE TRIGGER workflow_runs_require_runtime_root_trace
      BEFORE INSERT ON workflow_runs
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_root_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='task_events_require_runtime_child_trace') THEN
    CREATE TRIGGER task_events_require_runtime_child_trace
      BEFORE INSERT ON task_events
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_child_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workflow_events_require_runtime_child_trace') THEN
    CREATE TRIGGER workflow_events_require_runtime_child_trace
      BEFORE INSERT ON workflow_run_events
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_child_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='workflow_node_states_require_runtime_child_trace') THEN
    CREATE TRIGGER workflow_node_states_require_runtime_child_trace
      BEFORE INSERT ON workflow_run_node_states
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_child_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='action_authorizations_require_runtime_child_trace') THEN
    CREATE TRIGGER action_authorizations_require_runtime_child_trace
      BEFORE INSERT ON action_authorizations
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_child_trace();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='mcp_tool_calls_require_runtime_child_trace') THEN
    CREATE TRIGGER mcp_tool_calls_require_runtime_child_trace
      BEFORE INSERT ON mcp_tool_calls
      FOR EACH ROW EXECUTE FUNCTION ensure_runtime_child_trace();
  END IF;
END;
$$;

ALTER TABLE tasks
  ALTER COLUMN trace_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN span_id SET DEFAULT gen_random_uuid();
ALTER TABLE workflow_runs
  ALTER COLUMN trace_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN span_id SET DEFAULT gen_random_uuid();

UPDATE workflow_runs
   SET trace_id=COALESCE(trace_id,gen_random_uuid()),
       span_id=COALESCE(span_id,gen_random_uuid())
 WHERE status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND (trace_id IS NULL OR span_id IS NULL);

UPDATE tasks task
   SET trace_id=run.trace_id,
       span_id=COALESCE(task.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(task.parent_span_id,run.span_id)
  FROM workflow_runs run
 WHERE task.workflow_run_id=run.id
   AND task.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND run.trace_id IS NOT NULL
   AND run.span_id IS NOT NULL
   AND (task.trace_id IS NULL OR task.span_id IS NULL OR task.parent_span_id IS NULL);

UPDATE tasks
   SET trace_id=COALESCE(trace_id,gen_random_uuid()),
       span_id=COALESCE(span_id,gen_random_uuid())
 WHERE status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND (trace_id IS NULL OR span_id IS NULL);

UPDATE workflow_run_node_states state
   SET trace_id=COALESCE(state.trace_id,run.trace_id),
       span_id=COALESCE(state.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(state.parent_span_id,run.span_id)
  FROM workflow_runs run
 WHERE state.workflow_run_id=run.id
   AND run.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND run.trace_id IS NOT NULL
   AND run.span_id IS NOT NULL
   AND (state.trace_id IS NULL OR state.span_id IS NULL OR state.parent_span_id IS NULL);

UPDATE workflow_run_events event
   SET trace_id=COALESCE(event.trace_id,run.trace_id),
       span_id=COALESCE(event.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(event.parent_span_id,run.span_id)
  FROM workflow_runs run
 WHERE event.workflow_run_id=run.id
   AND run.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND run.trace_id IS NOT NULL
   AND run.span_id IS NOT NULL
   AND (event.trace_id IS NULL OR event.span_id IS NULL OR event.parent_span_id IS NULL);

UPDATE task_events event
   SET trace_id=COALESCE(event.trace_id,task.trace_id),
       span_id=COALESCE(event.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(event.parent_span_id,task.span_id)
  FROM tasks task
 WHERE event.task_id=task.id
   AND task.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND task.trace_id IS NOT NULL
   AND task.span_id IS NOT NULL
   AND (event.trace_id IS NULL OR event.span_id IS NULL OR event.parent_span_id IS NULL);

UPDATE action_authorizations authorization
   SET trace_id=COALESCE(authorization.trace_id,task.trace_id),
       span_id=COALESCE(authorization.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(authorization.parent_span_id,task.span_id)
  FROM tasks task
 WHERE authorization.task_id=task.id
   AND task.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND task.trace_id IS NOT NULL
   AND task.span_id IS NOT NULL
   AND (authorization.trace_id IS NULL OR authorization.span_id IS NULL OR authorization.parent_span_id IS NULL);

UPDATE action_authorizations authorization
   SET trace_id=COALESCE(authorization.trace_id,run.trace_id),
       span_id=COALESCE(authorization.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(authorization.parent_span_id,run.span_id)
  FROM workflow_runs run
 WHERE authorization.workflow_run_id=run.id
   AND run.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND run.trace_id IS NOT NULL
   AND run.span_id IS NOT NULL
   AND (authorization.trace_id IS NULL OR authorization.span_id IS NULL OR authorization.parent_span_id IS NULL);

UPDATE mcp_tool_calls tool_call
   SET trace_id=COALESCE(tool_call.trace_id,task.trace_id),
       span_id=COALESCE(tool_call.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(tool_call.parent_span_id,task.span_id)
  FROM tasks task
 WHERE tool_call.task_id=task.id
   AND task.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND task.trace_id IS NOT NULL
   AND task.span_id IS NOT NULL
   AND (tool_call.trace_id IS NULL OR tool_call.span_id IS NULL OR tool_call.parent_span_id IS NULL);

UPDATE mcp_tool_calls tool_call
   SET trace_id=COALESCE(tool_call.trace_id,run.trace_id),
       span_id=COALESCE(tool_call.span_id,gen_random_uuid()),
       parent_span_id=COALESCE(tool_call.parent_span_id,run.span_id)
  FROM workflow_runs run
 WHERE tool_call.task_id IS NULL
   AND tool_call.workflow_run_id=run.id
   AND run.status::text IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
   AND run.trace_id IS NOT NULL
   AND run.span_id IS NOT NULL
   AND (tool_call.trace_id IS NULL OR tool_call.span_id IS NULL OR tool_call.parent_span_id IS NULL);
