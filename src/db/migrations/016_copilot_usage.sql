ALTER TABLE ai_usage_events DROP CONSTRAINT IF EXISTS ai_usage_events_source_check;
ALTER TABLE ai_usage_events
  ADD CONSTRAINT ai_usage_events_source_check
  CHECK(source IN ('task','prompt_compiler','copilot','historical_task'));
