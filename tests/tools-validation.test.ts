import { describe, expect, it } from 'vitest';
import { toolConfigurationError } from '../src/routes/tools.js';
import { demoApiCatalog, publicDemoApi } from '../src/tools/demo-catalog.js';

describe('tool configuration validation', () => {
  it('requires a valid HTTPS execution endpoint for API tools', () => {
    expect(toolConfigurationError('api', {})).toBe('endpoint is required');
    expect(toolConfigurationError('api', { endpoint: 'http://api.example.test' })).toBe('endpoint must use HTTPS');
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run' })).toBeNull();
  });

  it('validates the optional health-check endpoint independently', () => {
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run', healthCheckUrl: 'not-a-url' })).toBe('healthCheckUrl must be a valid HTTPS URL');
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run', healthCheckUrl: 'https://api.example.test/health' })).toBeNull();
  });

  it('does not apply remote endpoint rules to internal tools', () => {
    expect(toolConfigurationError('internal', {})).toBeNull();
  });

  it('keeps starter APIs keyless, HTTPS-only, GET-only and read-only', () => {
    expect(demoApiCatalog).toHaveLength(3);
    for (const demo of demoApiCatalog) {
      expect(demo.config).toMatchObject({ method: 'GET', readOnly: true });
      expect(new URL(String(demo.config.endpoint)).protocol).toBe('https:');
      expect(new URL(String(demo.config.healthCheckUrl)).protocol).toBe('https:');
      expect(JSON.stringify(demo.config)).not.toMatch(/api[-_]?key|authorization|bearer|password|secret/i);
      const publicDefinition = publicDemoApi(demo);
      expect(publicDefinition).not.toHaveProperty('config');
      expect(JSON.stringify(publicDefinition)).not.toMatch(/encrypted_credentials|api.?key|authorization/i);
    }
  });
});
