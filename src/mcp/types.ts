export type McpRegistryHeader = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
};

export type McpRegistryRemote = {
  type: string;
  url: string;
  headers?: McpRegistryHeader[];
  variables?: Record<string, unknown>;
};

export type McpRegistryServer = {
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  repository?: {
    url?: string;
    source?: string;
    id?: string;
  };
  icons?: Array<{ src?: string; mimeType?: string }>;
  remotes?: McpRegistryRemote[];
};

export type McpRegistryEntry = {
  server: McpRegistryServer;
  _meta?: Record<string, unknown>;
};

export type McpRegistryPage = {
  servers: McpRegistryEntry[];
  metadata: {
    nextCursor?: string;
    count?: number;
  };
};

export type McpCatalogServerRow = {
  id: string;
  registry_name: string;
  version: string;
  title: string;
  description: string;
  website_url: string | null;
  repository_url: string | null;
  icon_url: string | null;
  registry_status: 'active' | 'deprecated' | 'deleted' | 'unknown';
  registry_updated_at: string | null;
  endpoints: Array<{
    id: string;
    transport: string;
    endpoint_url: string;
    header_inputs: McpRegistryHeader[];
    supported: boolean;
  }>;
};
