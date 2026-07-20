ALTER TABLE tasks ADD COLUMN workflow_node_id TEXT;
CREATE INDEX tasks_workflow_node_idx
  ON tasks(workflow_run_id, workflow_node_id, status)
  WHERE workflow_run_id IS NOT NULL;
