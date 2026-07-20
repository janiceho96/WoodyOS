CREATE TABLE mcp_catalog_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_name TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website_url TEXT,
  repository_url TEXT,
  repository_source TEXT,
  repository_id TEXT,
  icon_url TEXT,
  registry_status TEXT NOT NULL DEFAULT 'active'
    CHECK (registry_status IN ('active', 'deprecated', 'deleted', 'unknown')),
  is_latest BOOLEAN NOT NULL DEFAULT true,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  registry_published_at TIMESTAMPTZ,
  registry_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(registry_name, version)
);

CREATE TABLE mcp_catalog_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_server_id UUID NOT NULL REFERENCES mcp_catalog_servers(id) ON DELETE CASCADE,
  transport TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  header_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  endpoint_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  supported BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(catalog_server_id, transport, endpoint_url)
);

CREATE TABLE mcp_registry_sync_state (
  registry_url TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'never'
    CHECK (status IN ('never', 'running', 'succeeded', 'failed')),
  last_started_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  servers_seen INTEGER NOT NULL DEFAULT 0,
  servers_updated INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  catalog_server_id UUID REFERENCES mcp_catalog_servers(id) ON DELETE SET NULL,
  catalog_endpoint_id UUID REFERENCES mcp_catalog_endpoints(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'streamable-http',
  endpoint_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none'
    CHECK (auth_type IN ('none', 'bearer', 'custom_headers', 'oauth2')),
  encrypted_credentials JSONB,
  auth_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT false,
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy', 'auth_required', 'disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_health_check_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  server_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_by UUID NOT NULL REFERENCES users(id),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mcp_connections_workspace_endpoint_active_idx
  ON mcp_connections(workspace_id, endpoint_url)
  WHERE deleted_at IS NULL;

CREATE TABLE mcp_connection_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  remote_name TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL DEFAULT '',
  input_schema JSONB NOT NULL DEFAULT '{"type":"object"}'::jsonb,
  output_schema JSONB,
  annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  risk_level TEXT NOT NULL DEFAULT 'unknown'
    CHECK (risk_level IN ('read', 'write', 'destructive', 'external_write', 'unknown')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  schema_hash TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connection_id, remote_name)
);

CREATE INDEX mcp_catalog_servers_search_idx
  ON mcp_catalog_servers USING GIN (
    to_tsvector('simple', registry_name || ' ' || title || ' ' || description)
  );
CREATE INDEX mcp_catalog_servers_status_idx
  ON mcp_catalog_servers(registry_status, is_latest, registry_updated_at DESC);
CREATE INDEX mcp_catalog_endpoints_server_idx
  ON mcp_catalog_endpoints(catalog_server_id, supported, position);
CREATE INDEX mcp_connections_workspace_idx
  ON mcp_connections(workspace_id, deleted_at, enabled, health_status);
CREATE INDEX mcp_connection_tools_connection_idx
  ON mcp_connection_tools(connection_id, enabled, risk_level);
