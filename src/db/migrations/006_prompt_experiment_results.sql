CREATE TABLE prompt_experiment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES prompt_experiments(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output TEXT,
  accuracy_score NUMERIC(5,4),
  latency_ms INTEGER,
  cost_usd NUMERIC(12,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX prompt_experiment_results_experiment_idx ON prompt_experiment_results(experiment_id, version_id, created_at DESC);
