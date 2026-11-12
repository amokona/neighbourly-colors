import dgram from 'node:dgram';

const UDP_PORT = 7777;
const MAX_PAYLOAD_BYTES = 900; // 225 RGBW LEDs (900 bytes) per UDP v3 fragment
const FPS = 20;

export const CUSTOM_EFFECTS = [
  {
    id: 'custom:aurora',
    name: 'Aurore Boréale',
    description: 'Rubans d\'émeraude, turquoise et violet ondulant sur le sapin',
    preview: 'linear-gradient(135deg, #00ff87, #00b4d8, #7209b7)',
    source: 'custom'
  },
  {
    id: 'custom:fireplace',
    name: 'Feu de Foyer',
    description: 'Flammes chaudes rouge, orange et ambre montant du bas du sapin',
    preview: 'linear-gradient(135deg, #7f0000, #ff4500, #ffb703)',
    source: 'custom'
  },
  {
    id: 'custom:candycane_spiral',
    name: 'Spirale Sucre d\'Orge',
    description: 'Spirale 3D rouge et blanc chaud tournant autour du sapin',
    preview: 'repeating-linear-gradient(45deg, #e63946 0px, #e63946 12px, #fff8e7 12px, #fff8e7 24px)',
    source: 'custom'
  },
  {
    id: 'custom:starlight_gold',
    name: 'Pluie d\'Étoiles Dorées',
    description: 'Fond doré chaleureux avec scintillement d\'étoiles blanches',
    preview: 'linear-gradient(135deg, #b45309, #fbbf24, #fef08a)',
    source: 'custom'
  },
  {
    id: 'custom:meteor_shower',
    name: 'Pluie de Météores',
    description: 'Étoiles filantes bleu glacé et blanc descendant le long du sapin',
    preview: 'linear-gradient(135deg, #0f172a, #0284c7, #e0f2fe)',
    source: 'custom'
  },
  {
    id: 'custom:rainbow_vortex',
    name: 'Tourbillon Arc-en-Ciel 3D',
    description: 'Hélice arc-en-ciel 3D tournoyant de la base au sommet',
    preview: 'linear-gradient(135deg, #ff0000, #eab308, #22c55e, #3b82f6, #a855f7)',
    source: 'custom'
  },
  {
    id: 'custom:christmas_classic',
    name: 'Noël Traditionnel',
    description: 'Rouge rubis, vert sapin et or chaud avec étincelles douces',
    preview: 'linear-gradient(135deg, #dc2626, #15803d, #f59e0b)',
    source: 'custom'
  },
  {
    id: 'custom:icy_blizzard',
    name: 'Blizzard Polaire',
    description: 'Rafales de neige bleu arctique, cyan et blanc pur',
    preview: 'linear-gradient(135deg, #0369a1, #38bdf8, #f0f9ff)',
    source: 'custom'
  },
  {
    id: 'custom:cyberpunk',
    name: 'Néon Cyberpunk',
    description: 'Vagues électriques magenta, cyan et violet profond',
    preview: 'linear-gradient(135deg, #f72585, #7209b7, #4cc9f0)',
    source: 'custom'
  },
  {
    id: 'custom:heartbeat',
    name: 'Battement de Cœur',
    description: 'Double pulsation rouge rubis et rose rayonnant du centre',
    preview: 'linear-gradient(135deg, #881337, #e11d48, #fda4af)',
    source: 'custom'
  },
  {
    id: 'custom:matrix',
    name: 'Cascades d\'Émeraude',
    description: 'Gouttes lumineuses vert émeraude glissant verticalement',
    preview: 'linear-gradient(135deg, #022c22, #10b981, #a7f3d0)',
    source: 'custom'
  },
  {
    id: 'custom:confetti',
    name: 'Confettis de Fête',
    description: 'Explosion joyeuse de confettis multicolores scintillants',
    preview: 'linear-gradient(135deg, #ec4899, #8b5cf6, #06b6d4, #eab308)',
    source: 'custom'
  }
];

export function isCustomEffectId(id) {
  return typeof id === 'string' && CUSTOM_EFFECTS.some(e => e.id === id);
}

export function getCustomEffectById(id) {
  return CUSTOM_EFFECTS.find(e => e.id === id) || null;
}

// Convert HSV (h: 0..1, s: 0..1, v: 0..1) to RGB (0..255)
function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [
    Math.round(Math.max(0, Math.min(255, r * 255))),
    Math.round(Math.max(0, Math.min(255, g * 255))),
    Math.round(Math.max(0, Math.min(255, b * 255)))
  ];
}

// Deterministic pseudo-random helper in 0..1
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

// Compute [w, r, g, b] for a single LED at normalized coords (x: -1..1, y: 0..1, z: -1..1, angle: 0..1, idx) and time t (seconds)
function evaluateLed(effectId, led, t) {
  const { x, y, z, angle, index } = led;

  switch (effectId) {
    case 'custom:aurora': {
      const wave1 = Math.sin(y * 5.0 - t * 1.4 + Math.sin(angle * Math.PI * 2 + t * 0.5));
      const wave2 = Math.cos(x * 3.5 + z * 3.5 + t * 0.9);
      const blend = (wave1 + wave2) * 0.25 + 0.5; // 0..1
      // Hue from green (0.38) through cyan (0.52) to purple (0.78)
      const hue = 0.36 + blend * 0.42;
      const brightness = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(y * 3.14 + wave1 * 0.8)), 1.2);
      const [r, g, b] = hsvToRgb(hue, 0.88, brightness);
      return [0, r, g, b];
    }

    case 'custom:fireplace': {
      const flicker = Math.sin(t * 7.5 + index * 0.37) * 0.5 + Math.sin(t * 13.0 + x * 6.0) * 0.5;
      const flameHeight = Math.max(0.05, 1.0 - y * 0.85 + flicker * 0.22);
      const heat = Math.max(0, Math.min(1, flameHeight));
      const r = Math.round(Math.min(255, heat * 320));
      const g = Math.round(Math.max(0, Math.min(255, (heat - 0.28) * 260)));
      const b = Math.round(Math.max(0, Math.min(120, (heat - 0.75) * 300)));
      const w = Math.round(Math.max(0, Math.min(180, (heat - 0.55) * 260)));
      return [w, r, g, b];
    }

    case 'custom:candycane_spiral': {
      const phase = (angle * 3.0 + y * 2.2 - t * 0.45) % 1;
      const normPhase = (phase + 1) % 1;
      const stripe = Math.sin(normPhase * Math.PI * 2);
      if (stripe > 0) {
        return [0, 255, 10, 15]; // Bright candy red
      } else {
        return [220, 255, 200, 140]; // Crisp warm white
      }
    }

    case 'custom:starlight_gold': {
      const seed = hash01(index);
      const twinkleSpeed = 1.5 + seed * 3.5;
      const sparkle = Math.pow(Math.max(0, Math.sin(t * twinkleSpeed + seed * 50.0)), 14);
      const w = Math.round(65 + sparkle * 190);
      const r = Math.round(180 + sparkle * 75);
      const g = Math.round(105 + sparkle * 140);
      const b = Math.round(sparkle * 180);
      return [w, r, g, b];
    }

    case 'custom:meteor_shower': {
      // Multiple virtual meteors falling down along angular columns
      const col = Math.floor(((angle % 1 + 1) % 1) * 8);
      const speed = 0.65 + (col % 3) * 0.2;
      const headY = 1.2 - (((t * speed + col * 0.37) % 1.6));
      const dist = y - headY; // trail is above headY (dist >= 0)
      if (dist >= -0.04 && dist < 0.38) {
        const intensity = dist < 0 ? 1.0 : Math.pow(1.0 - dist / 0.38, 2.2);
        const w = dist < 0.05 ? Math.round(intensity * 255) : 0;
        const r = Math.round(intensity * 110);
        const g = Math.round(intensity * 210);
        const b = Math.round(intensity * 255);
        return [w, r, g, b];
      }
      // Subtle starry night background
      const bgTwinkle = Math.pow(Math.max(0, Math.sin(t * 2.0 + index * 1.7)), 16);
      return [Math.round(bgTwinkle * 120), 4, 12, Math.round(35 + bgTwinkle * 100)];
    }

    case 'custom:rainbow_vortex': {
      const hue = (angle + y * 1.2 - t * 0.35) % 1;
      const wave = 0.75 + 0.25 * Math.sin(y * 8.0 - t * 3.0);
      const [r, g, b] = hsvToRgb(hue, 0.95, wave);
      return [0, r, g, b];
    }

    case 'custom:christmas_classic': {
      const group = index % 3;
      const shimmer = Math.pow(Math.max(0, Math.sin(t * 2.4 + index * 0.9)), 8);
      const w = Math.round(shimmer * 180);
      if (group === 0) {
        return [w, 240, 15, 15]; // Red
      } else if (group === 1) {
        return [w, 10, 210, 25]; // Green
      } else {
        return [Math.max(90, w), 255, 165, 20]; // Warm Gold
      }
    }

    case 'custom:icy_blizzard': {
      const swirl = Math.sin(angle * Math.PI * 4 + y * 6.0 + t * 2.8) * 0.5 + 0.5;
      const snow = Math.pow(Math.max(0, Math.sin(t * 4.0 + index * 2.3)), 10);
      const w = Math.round(Math.pow(swirl, 3) * 160 + snow * 95);
      const r = Math.round(swirl * 60 + snow * 150);
      const g = Math.round(100 + swirl * 130);
      const b = 255;
      return [Math.min(255, w), Math.min(255, r), Math.min(255, g), b];
    }

    case 'custom:cyberpunk': {
      const v = Math.sin(y * 6.0 - t * 2.2) * Math.cos(angle * Math.PI * 2 + t * 1.3);
      if (v > 0.15) {
        const k = Math.min(1, (v - 0.15) / 0.85);
        return [0, Math.round(255 * k), 10, Math.round(160 * k)]; // Neon Magenta
      } else if (v < -0.15) {
        const k = Math.min(1, (-v - 0.15) / 0.85);
        return [0, 0, Math.round(230 * k), Math.round(255 * k)]; // Electric Cyan
      }
      return [0, 45, 5, 95]; // Deep Violet base
    }

    case 'custom:heartbeat': {
      // Double beat every 1.2s
      const cycle = (t % 1.2) / 1.2;
      const beat1 = Math.exp(-Math.pow((cycle - 0.18) / 0.06, 2));
      const beat2 = 0.75 * Math.exp(-Math.pow((cycle - 0.36) / 0.08, 2));
      const pulse = Math.min(1, beat1 + beat2);
      const distCenter = Math.hypot(x, (y - 0.45) * 1.4, z);
      const wave = Math.max(0.12, pulse * Math.max(0.2, 1.15 - distCenter * 0.75));
      const r = Math.round(Math.min(255, 60 + wave * 195));
      const g = Math.round(wave * 25);
      const b = Math.round(wave * 55);
      const w = Math.round(Math.pow(wave, 2.5) * 90);
      return [w, r, g, b];
    }

    case 'custom:matrix': {
      const col = Math.floor(((angle % 1 + 1) % 1) * 14);
      const speed = 0.55 + (col % 4) * 0.15;
      const dropY = 1.15 - (((t * speed + col * 0.29) % 1.4));
      const dist = y - dropY;
      if (dist >= -0.03 && dist < 0.32) {
        const k = dist < 0 ? 1.0 : Math.pow(1.0 - dist / 0.32, 1.8);
        const w = dist < 0.03 ? Math.round(k * 160) : 0;
        const r = Math.round(k * 40);
        const g = Math.round(k * 255);
        const b = Math.round(k * 70);
        return [w, r, g, b];
      }
      return [0, 0, 18, 4];
    }

    case 'custom:confetti':
    default: {
      const bucket = Math.floor(t * 6 + hash01(index) * 20);
      const pop = Math.pow(Math.max(0, Math.sin(t * 5.0 + index * 3.1)), 12);
      const hue = hash01(index + bucket * 13.7);
      const [r, g, b] = hsvToRgb(hue, 0.9, 0.2 + pop * 0.8);
      const w = Math.round(pop * 110);
      return [w, r, g, b];
    }
  }
}

class RealtimeEffectRunner {
  constructor() {
    this.interval = null;
    this.keepAliveInterval = null;
    this.socket = null;
    this.currentEffectId = null;
    this.deviceMetaCache = new Map();
  }

  async getDeviceMeta(client, ip) {
    if (this.deviceMetaCache.has(ip)) {
      return this.deviceMetaCache.get(ip);
    }

    const details = await client.getDeviceDetails();
    const numLeds = details.number_of_led || 600;
    const bytesPerLed = details.bytes_per_led || 4;

    let leds = [];
    try {
      const layout = await client.getLayout();
      if (layout && Array.isArray(layout.coordinates) && layout.coordinates.length === numLeds) {
        let minY = Infinity, maxY = -Infinity;
        layout.coordinates.forEach(c => {
          if (c.y < minY) minY = c.y;
          if (c.y > maxY) maxY = c.y;
        });
        const spanY = Math.max(0.001, maxY - minY);
        leds = layout.coordinates.map((c, index) => {
          const nx = c.x || 0;
          const ny = (c.y - minY) / spanY;
          const nz = c.z || 0;
          const angle = (Math.atan2(nz, nx) / (Math.PI * 2) + 1) % 1;
          return { x: nx, y: ny, z: nz, angle, index };
        });
      }
    } catch (err) {
      console.warn('Could not load 3D layout, falling back to spiral coordinates:', err.message);
    }

    if (leds.length !== numLeds) {
      leds = Array.from({ length: numLeds }, (_, index) => {
        const y = index / Math.max(1, numLeds - 1);
        const radius = 1 - y * 0.85;
        const theta = index * 0.25;
        const x = Math.cos(theta) * radius;
        const z = Math.sin(theta) * radius;
        const angle = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
        return { x, y, z, angle, index };
      });
    }

    const meta = { numLeds, bytesPerLed, leds };
    this.deviceMetaCache.set(ip, meta);
    return meta;
  }

  async start(client, ip, effectId) {
    this.stop();
    this.currentEffectId = effectId;

    const meta = await this.getDeviceMeta(client, ip);
    await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
    await client.setLEDOperationMode({ mode: 'rt' });

    const socket = dgram.createSocket('udp4');
    this.socket = socket;

    const startTime = Date.now();
    const frameBuffer = Buffer.alloc(meta.numLeds * meta.bytesPerLed);

    const sendFrame = () => {
      if (!this.socket || this.currentEffectId !== effectId) return;
      const tokenBase64 = client.getToken();
      if (!tokenBase64) return;
      const tokenBytes = Buffer.from(tokenBase64, 'base64');
      if (tokenBytes.length !== 8) return;

      const t = (Date.now() - startTime) / 1000;

      for (let i = 0; i < meta.numLeds; i++) {
        const [w, r, g, b] = evaluateLed(effectId, meta.leds[i], t);
        const offset = i * meta.bytesPerLed;
        if (meta.bytesPerLed === 4) {
          // Twinkly RGBW byte order: W, R, G, B
          frameBuffer[offset] = w;
          frameBuffer[offset + 1] = r;
          frameBuffer[offset + 2] = g;
          frameBuffer[offset + 3] = b;
        } else {
          frameBuffer[offset] = r;
          frameBuffer[offset + 1] = g;
          frameBuffer[offset + 2] = b;
        }
      }

      // Send fragmented UDP v3 packets (max 900 payload bytes per fragment)
      let fragmentIndex = 0;
      for (let byteOffset = 0; byteOffset < frameBuffer.length; byteOffset += MAX_PAYLOAD_BYTES) {
        const chunk = frameBuffer.subarray(byteOffset, Math.min(frameBuffer.length, byteOffset + MAX_PAYLOAD_BYTES));
        const packet = Buffer.allocUnsafe(12 + chunk.length);
        packet[0] = 0x03; // Protocol v3
        tokenBytes.copy(packet, 1, 0, 8);
        packet[9] = 0x00;
        packet[10] = 0x00;
        packet[11] = fragmentIndex;
        chunk.copy(packet, 12);

        socket.send(packet, UDP_PORT, ip);
        fragmentIndex += 1;
      }
    };

    this.interval = setInterval(sendFrame, Math.round(1000 / FPS));
    sendFrame();

    // Re-assert RT mode every 25s so token & RT session stay active
    this.keepAliveInterval = setInterval(async () => {
      if (this.currentEffectId !== effectId) return;
      try {
        await client.setLEDOperationMode({ mode: 'rt' });
      } catch (err) {
        console.warn('RT keepalive warning:', err.message);
      }
    }, 25000);
  }

  stop() {
    this.currentEffectId = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_) {}
      this.socket = null;
    }
  }
}

export const effectRunner = new RealtimeEffectRunner();
