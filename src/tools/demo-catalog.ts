export type DemoApiDefinition = {
  slug: string;
  name: string;
  description: string;
  provider: string;
  documentationUrl: string;
  examplePrompt: string;
  config: Record<string, unknown>;
  permissions: string[];
};

export const demoApiCatalog: readonly DemoApiDefinition[] = [
  {
    slug: 'weather-forecast',
    name: 'Demo · Weather Forecast',
    description: 'Read-only current weather lookup by latitude and longitude. No credentials required.',
    provider: 'Open-Meteo',
    documentationUrl: 'https://open-meteo.com/en/docs',
    examplePrompt: 'Check the current weather for Kuala Lumpur using latitude 3.139 and longitude 101.687.',
    permissions: ['public_data.read', 'weather.read'],
    config: {
      endpoint: 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto&forecast_days=1',
      healthCheckUrl: 'https://api.open-meteo.com/v1/forecast?latitude=3.139&longitude=101.687&current=temperature_2m&forecast_days=1',
      method: 'GET',
      readOnly: true,
      agentDescription: 'Look up current public weather conditions. Supply decimal latitude and longitude. This tool only reads public weather data.',
      inputSchema: {
        type: 'object',
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in decimal degrees.' },
          longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude in decimal degrees.' },
        },
        required: ['latitude', 'longitude'],
        additionalProperties: false,
      },
    },
  },
  {
    slug: 'book-search',
    name: 'Demo · Book Search',
    description: 'Read-only search across Open Library titles and authors. No credentials required.',
    provider: 'Open Library',
    documentationUrl: 'https://openlibrary.org/dev/docs/api/search',
    examplePrompt: 'Find five beginner-friendly books about robotics and summarize their titles, authors, and publication years.',
    permissions: ['public_data.read', 'books.read'],
    config: {
      endpoint: 'https://openlibrary.org/search.json?fields=key,title,author_name,first_publish_year&limit=5',
      healthCheckUrl: 'https://openlibrary.org/search.json?q=robotics&fields=key,title&limit=1',
      method: 'GET',
      readOnly: true,
      agentDescription: 'Search Open Library for public book metadata. Supply a concise search query in q. Returns at most five records with selected fields.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 2, maxLength: 200, description: 'Book, author, or topic to search for.' },
        },
        required: ['q'],
        additionalProperties: false,
      },
    },
  },
  {
    slug: 'exchange-rates',
    name: 'Demo · Exchange Rates',
    description: 'Read-only daily reference exchange rates. No credentials required and not intended for trading.',
    provider: 'Frankfurter',
    documentationUrl: 'https://frankfurter.dev/v1/',
    examplePrompt: 'Look up the latest USD exchange rates for MYR and EUR and clearly state the reference date.',
    permissions: ['public_data.read', 'exchange_rates.read'],
    config: {
      endpoint: 'https://api.frankfurter.dev/v1/latest',
      healthCheckUrl: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=MYR,EUR',
      method: 'GET',
      readOnly: true,
      agentDescription: 'Look up public daily reference exchange rates. Supply a three-letter base currency and comma-separated target symbols. Do not present the data as live trading prices or financial advice.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Three-letter base currency, for example USD.' },
          symbols: { type: 'string', pattern: '^[A-Z]{3}(,[A-Z]{3})*$', description: 'Comma-separated target currencies, for example MYR,EUR.' },
        },
        required: ['base', 'symbols'],
        additionalProperties: false,
      },
    },
  },
];

export function publicDemoApi(definition: DemoApiDefinition) {
  return {
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    provider: definition.provider,
    documentationUrl: definition.documentationUrl,
    examplePrompt: definition.examplePrompt,
    permissions: definition.permissions,
  };
}
