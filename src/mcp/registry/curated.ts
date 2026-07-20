export type CuratedMcpAuthMode = 'none' | 'oauth2' | 'bearer' | 'custom_headers';
export type CuratedMcpAvailability = 'available' | 'preview' | 'limited' | 'desktop_bridge';

export type CuratedMcpApp = {
  id: string;
  title: string;
  publisher: string;
  category: string;
  description: string;
  endpointUrl: string | null;
  registryName?: string;
  docsUrl: string;
  verifiedDomain: string;
  availability: CuratedMcpAvailability;
  installable: boolean;
  authModes: CuratedMcpAuthMode[];
  defaultAuth: CuratedMcpAuthMode;
  requiresOAuthClient?: boolean;
  setupNote: string;
  capabilities: string[];
  brandColor: string;
};

export const CURATED_MCP_APPS: readonly CuratedMcpApp[] = [
  {
    id: 'notion',
    title: 'Notion',
    publisher: 'Notion Labs',
    category: 'Knowledge & documents',
    description: 'Search, read, create, and update pages and databases in your Notion workspace.',
    endpointUrl: 'https://mcp.notion.com/mcp',
    registryName: 'com.notion/mcp',
    docsUrl: 'https://developers.notion.com/guides/mcp/overview',
    verifiedDomain: 'notion.com',
    availability: 'available',
    installable: true,
    authModes: ['oauth2'],
    defaultAuth: 'oauth2',
    setupNote: 'Uses Notion’s hosted OAuth connection. You choose the workspace and approve access on Notion.',
    capabilities: ['Workspace search', 'Pages', 'Databases', 'Comments'],
    brandColor: '#f2f2f2',
  },
  {
    id: 'github',
    title: 'GitHub',
    publisher: 'GitHub',
    category: 'Engineering',
    description: 'Work with repositories, issues, pull requests, code search, commits, and Actions.',
    endpointUrl: 'https://api.githubcopilot.com/mcp/',
    registryName: 'io.github.github/github-mcp-server',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
    verifiedDomain: 'githubcopilot.com',
    availability: 'available',
    installable: true,
    authModes: ['bearer'],
    defaultAuth: 'bearer',
    setupNote: 'Woody currently connects with a fine-grained GitHub personal access token. Give the token only the repositories and permissions this agent needs.',
    capabilities: ['Repositories', 'Issues', 'Pull requests', 'Actions'],
    brandColor: '#8b949e',
  },
  {
    id: 'linear',
    title: 'Linear',
    publisher: 'Linear',
    category: 'Product management',
    description: 'Find, create, and update issues, projects, initiatives, comments, and product plans.',
    endpointUrl: 'https://mcp.linear.app/mcp',
    registryName: 'app.linear/linear',
    docsUrl: 'https://linear.app/docs/mcp',
    verifiedDomain: 'linear.app',
    availability: 'available',
    installable: true,
    authModes: ['oauth2', 'bearer'],
    defaultAuth: 'oauth2',
    setupNote: 'Uses Linear OAuth 2.1 with PKCE. Scoped Linear API keys are also supported as bearer tokens.',
    capabilities: ['Issues', 'Projects', 'Initiatives', 'Comments'],
    brandColor: '#7c6df2',
  },
  {
    id: 'stripe',
    title: 'Stripe',
    publisher: 'Stripe',
    category: 'Payments',
    description: 'Search Stripe documentation and securely interact with customers, payments, and billing data.',
    endpointUrl: 'https://mcp.stripe.com',
    registryName: 'com.stripe/mcp',
    docsUrl: 'https://docs.stripe.com/mcp',
    verifiedDomain: 'stripe.com',
    availability: 'available',
    installable: true,
    authModes: ['oauth2', 'bearer'],
    defaultAuth: 'oauth2',
    setupNote: 'OAuth is recommended. If using a key, create a restricted Stripe key with only the required permissions.',
    capabilities: ['Customers', 'Payments', 'Billing', 'Documentation'],
    brandColor: '#635bff',
  },
  {
    id: 'figma',
    title: 'Figma',
    publisher: 'Figma',
    category: 'Design',
    description: 'Bring Figma design context into agents and, for supported clients, create or modify canvas content.',
    endpointUrl: 'https://mcp.figma.com/mcp',
    registryName: 'com.figma.mcp/mcp',
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/',
    verifiedDomain: 'figma.com',
    availability: 'limited',
    installable: false,
    authModes: ['oauth2'],
    defaultAuth: 'oauth2',
    setupNote: 'Figma currently accepts only clients in its approved MCP catalog. Woody needs Figma client approval before one-click connection can be enabled.',
    capabilities: ['Design context', 'Components', 'Variables', 'Code to canvas'],
    brandColor: '#f24e1e',
  },
  {
    id: 'google-drive',
    title: 'Google Drive',
    publisher: 'Google Workspace',
    category: 'Files & documents',
    description: 'Search, read, create, copy, and manage files through Google’s managed remote MCP server.',
    endpointUrl: 'https://drivemcp.googleapis.com/mcp/v1',
    docsUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verifiedDomain: 'googleapis.com',
    availability: 'preview',
    installable: true,
    authModes: ['oauth2'],
    defaultAuth: 'oauth2',
    requiresOAuthClient: true,
    setupNote: 'Developer Preview. Enable the Drive and Drive MCP APIs, then provide a Google OAuth web client ID and secret.',
    capabilities: ['Search files', 'Read content', 'Create files', 'Permissions'],
    brandColor: '#0f9d58',
  },
  {
    id: 'gmail',
    title: 'Gmail',
    publisher: 'Google Workspace',
    category: 'Communication',
    description: 'Search email, read threads, manage labels, and create drafts without granting send access.',
    endpointUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
    docsUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verifiedDomain: 'googleapis.com',
    availability: 'preview',
    installable: true,
    authModes: ['oauth2'],
    defaultAuth: 'oauth2',
    requiresOAuthClient: true,
    setupNote: 'Developer Preview. Enable the Gmail and Gmail MCP APIs, then provide a Google OAuth web client ID and secret.',
    capabilities: ['Search mail', 'Read threads', 'Draft email', 'Labels'],
    brandColor: '#ea4335',
  },
  {
    id: 'google-calendar',
    title: 'Google Calendar',
    publisher: 'Google Workspace',
    category: 'Scheduling',
    description: 'List calendars and events, find availability, create meetings, and respond to invitations.',
    endpointUrl: 'https://calendarmcp.googleapis.com/mcp/v1',
    docsUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    verifiedDomain: 'googleapis.com',
    availability: 'preview',
    installable: true,
    authModes: ['oauth2'],
    defaultAuth: 'oauth2',
    requiresOAuthClient: true,
    setupNote: 'Developer Preview. Enable the Calendar and Calendar MCP APIs, then provide a Google OAuth web client ID and secret.',
    capabilities: ['Events', 'Availability', 'Invitations', 'Calendars'],
    brandColor: '#4285f4',
  },
  {
    id: 'obsidian',
    title: 'Obsidian',
    publisher: 'Obsidian community',
    category: 'Personal knowledge',
    description: 'Read, search, create, and edit notes in a local Obsidian vault through a community plugin.',
    endpointUrl: null,
    docsUrl: 'https://community.obsidian.md/plugins/mcp-server',
    verifiedDomain: 'obsidian.md',
    availability: 'desktop_bridge',
    installable: false,
    authModes: ['bearer'],
    defaultAuth: 'bearer',
    setupNote: 'Obsidian has no first-party hosted MCP server. Its community MCP plugins bind to localhost, so Woody needs a separately sandboxed desktop bridge before this can be connected safely.',
    capabilities: ['Vault search', 'Notes', 'Backlinks', 'Attachments'],
    brandColor: '#7c3aed',
  },
] as const;

export function curatedMcpApp(id: string) {
  return CURATED_MCP_APPS.find((app) => app.id === id);
}
