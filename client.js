import { TwinklyClient } from '@twinklyjs/twinkly';

// Store client instances by IP
export const clients = new Map();

// Get or create a Twinkly client for a given IP
export function getClient(ip) {
  if (!clients.has(ip)) {
    clients.set(ip, new TwinklyClient({ ip }));
  }
  return clients.get(ip);
}
