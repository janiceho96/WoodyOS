import { describe, expect, it } from 'vitest';
import { toolConfigurationError } from '../src/routes/tools.js';

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
});
