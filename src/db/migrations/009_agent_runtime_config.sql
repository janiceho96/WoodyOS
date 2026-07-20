ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS model_config JSONB NOT NULL
    DEFAULT '{"temperature":0.2,"maxTokens":4096,"topP":1}'::jsonb,
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL
    DEFAULT '{"webBrowser":false,"codeInterpreter":false,"knowledgeBase":true}'::jsonb;
