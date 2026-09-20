import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getClient, clients } from './client.js';

// Mock the TwinklyClient module
vi.mock('@twinklyjs/twinkly', () => {
  return {
    TwinklyClient: vi.fn().mockImplementation(function({ ip }) {
      this.ip = ip;
      this.mocked = true;
    })
  };
});

import { TwinklyClient } from '@twinklyjs/twinkly';

describe('getClient', () => {
  beforeEach(() => {
    // Clear the map and mocks before each test
    clients.clear();
    vi.clearAllMocks();
  });

  it('creates a new client when IP is not in cache', () => {
    const ip = '192.168.1.100';

    // Initial state: cache is empty
    expect(clients.has(ip)).toBe(false);

    // Call the function
    const client = getClient(ip);

    // Verify TwinklyClient was instantiated with the correct IP
    expect(TwinklyClient).toHaveBeenCalledTimes(1);
    expect(TwinklyClient).toHaveBeenCalledWith({ ip });

    // Verify the returned client is the one we mocked
    expect(client.ip).toBe(ip);
    expect(client.mocked).toBe(true);

    // Verify the cache was updated
    expect(clients.has(ip)).toBe(true);
    expect(clients.get(ip)).toBe(client);
  });

  it('returns cached client when IP is already in cache', () => {
    const ip = '192.168.1.100';

    // First call - should create and cache
    const client1 = getClient(ip);
    expect(TwinklyClient).toHaveBeenCalledTimes(1);

    // Second call - should return cached instance
    const client2 = getClient(ip);

    // Verify TwinklyClient was NOT instantiated again
    expect(TwinklyClient).toHaveBeenCalledTimes(1);

    // Verify it returns the exact same reference
    expect(client1).toBe(client2);
  });
});
