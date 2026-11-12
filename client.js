import { webcrypto } from 'node:crypto';
import { TwinklyClient } from '@twinklyjs/twinkly';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// Store client instances by IP
export const clients = new Map();

// Get or create a Twinkly client for a given IP
export function getClient(ip) {
  if (!clients.has(ip)) {
    clients.set(ip, new TwinklyClient({ ip }));
  }
  return clients.get(ip);
}
