const FPS = 14; // ~70ms per frame over persistent HTTP keep-alive to /xled/v1/led/rt/frame

export const CUSTOM_EFFECTS = [
  {
    id: 'custom:aurora',
    name: 'Aurore Boréale',
    description: 'Rubans d\'émeraude, turquoise et violet ondulant sur tout le sapin',
    preview: 'linear-gradient(135deg, #00ff87, #00b4d8, #7209b7)',
    source: 'custom'
  },
  {
    id: 'custom:fireplace',
    name: 'Feu de Foyer',
    description: 'Flammes chaudes rouge, orange et doré embrasant tout le sapin',
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
    description: 'Ciel étoilé bleu saphir traversé d\'étoiles filantes blanches',
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
    description: 'Double pulsation rouge rubis et rose rayonnant sur tout le sapin',
    preview: 'linear-gradient(135deg, #881337, #e11d48, #fda4af)',
    source: 'custom'
  },
  {
    id: 'custom:matrix',
    name: 'Cascades d\'Émeraude',
    description: 'Vagues lumineuses vert émeraude et menthe glissant sur le sapin',
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

function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

// Compute [w, r, g, b] for a single LED so every LED on the tree is actively lit
function evaluateLed(effectId, led, t) {
  const { x, y, z, angle, index } = led;

  switch (effectId) {
    case 'custom:aurora': {
      const wave1 = Math.sin(y * 5.0 - t * 1.6 + Math.sin(angle * Math.PI * 2 + t * 0.7));
      const wave2 = Math.cos(x * 3.5 + z * 3.5 + t * 1.1);
      const blend = (wave1 + wave2) * 0.25 + 0.5;
      const hue = 0.36 + blend * 0.42; // Emerald green -> cyan -> violet
      const [r, g, b] = hsvToRgb(hue, 0.9, 0.75 + 0.25 * Math.sin(y * 4.0 + t * 2.0));
      return [0, r, g, b];
    }

    case 'custom:fireplace': {
      const flicker = Math.sin(t * 7.5 + index * 0.37) * 0.5 + Math.sin(t * 12.0 + x * 5.0) * 0.5;
      // Keep the entire tree glowing warm from base (bright amber/white-hot) to top (rich red/orange embers)
      const heat = Math.max(0.35, Math.min(1.0, 0.85 - y * 0.35 + flicker * 0.25));
      const r = 255;
      const g = Math.round(Math.max(25, Math.min(220, (heat - 0.2) * 240)));
      const b = 0;
      const w = Math.round(Math.max(0, Math.min(160, (heat - 0.55) * 320)));
      return [w, r, g, b];
    }

    case 'custom:candycane_spiral': {
      const phase = (angle * 3.0 + y * 2.5 - t * 0.5) % 1;
      const normPhase = (phase + 1) % 1;
      const stripe = Math.sin(normPhase * Math.PI * 2);
      if (stripe > 0) {
        return [0, 255, 10, 15]; // Bright candy red
      } else {
        return [230, 255, 210, 150]; // Crisp warm white
      }
    }

    case 'custom:starlight_gold': {
      const seed = hash01(index);
      const twinkleSpeed = 1.8 + seed * 3.2;
      const sparkle = Math.pow(Math.max(0, Math.sin(t * twinkleSpeed + seed * 50.0)), 10);
      const w = Math.round(80 + sparkle * 175);
      const r = Math.round(210 + sparkle * 45);
      const g = Math.round(130 + sparkle * 125);
      const b = Math.round(20 + sparkle * 180);
      return [w, r, g, b];
    }

    case 'custom:meteor_shower': {
      const col = Math.floor(((angle % 1 + 1) % 1) * 8);
      const speed = 0.7 + (col % 3) * 0.22;
      const headY = 1.2 - (((t * speed + col * 0.37) % 1.5));
      const dist = y - headY;
      if (dist >= -0.06 && dist < 0.42) {
        const intensity = dist < 0 ? 1.0 : Math.pow(1.0 - dist / 0.42, 1.8);
        const w = Math.round(intensity * 255);
        const r = Math.round(80 + intensity * 175);
        const g = Math.round(180 + intensity * 75);
        const b = 255;
        return [w, r, g, b];
      }
      // Rich glowing sapphire & cyan night sky on all other LEDs
      const skyWave = 0.5 + 0.5 * Math.sin(t * 2.2 + index * 0.7);
      return [Math.round(skyWave * 40), 15, Math.round(70 + skyWave * 90), 235];
    }

    case 'custom:rainbow_vortex': {
      const hue = (angle + y * 1.2 - t * 0.38) % 1;
      const [r, g, b] = hsvToRgb(hue, 0.95, 1.0);
      return [0, r, g, b];
    }

    case 'custom:christmas_classic': {
      const group = index % 3;
      const shimmer = Math.pow(Math.max(0, Math.sin(t * 2.5 + index * 0.9)), 6);
      const w = Math.round(shimmer * 180);
      if (group === 0) {
        return [w, 255, Math.min(255, 15 + w), Math.min(255, 15 + w)]; // Red + sparkle
      } else if (group === 1) {
        return [w, Math.min(255, 10 + w), 240, Math.min(255, 25 + w)]; // Green + sparkle
      } else {
        return [Math.max(110, w), 255, Math.min(255, 175 + Math.round(w * 0.4)), Math.min(255, 25 + Math.round(w * 0.6))]; // Warm Gold + sparkle
      }
    }

    case 'custom:icy_blizzard': {
      const swirl = Math.sin(angle * Math.PI * 4 + y * 6.0 + t * 3.0) * 0.5 + 0.5;
      const snow = Math.pow(Math.max(0, Math.sin(t * 4.0 + index * 2.3)), 8);
      const w = Math.round(40 + Math.pow(swirl, 2) * 140 + snow * 75);
      const r = Math.round(40 + swirl * 80 + snow * 135);
      const g = Math.round(140 + swirl * 115);
      const b = 255;
      return [Math.min(255, w), Math.min(255, r), Math.min(255, g), b];
    }

    case 'custom:cyberpunk': {
      const v = Math.sin(y * 5.0 - t * 2.4 + angle * Math.PI * 2);
      const blend = v * 0.5 + 0.5; // 0..1 between Electric Cyan and Neon Magenta
      const r = Math.round(255 * blend + 20 * (1 - blend));
      const g = Math.round(15 * blend + 230 * (1 - blend));
      const b = Math.round(180 * blend + 255 * (1 - blend));
      return [0, r, g, b];
    }

    case 'custom:heartbeat': {
      const cycle = (t % 1.2) / 1.2;
      const beat1 = Math.exp(-Math.pow((cycle - 0.18) / 0.07, 2));
      const beat2 = 0.8 * Math.exp(-Math.pow((cycle - 0.38) / 0.09, 2));
      const pulse = Math.min(1, beat1 + beat2);
      const r = Math.round(130 + pulse * 125);
      const g = Math.round(10 + pulse * 50);
      const b = Math.round(30 + pulse * 80);
      const w = Math.round(pulse * 120);
      return [w, r, g, b];
    }

    case 'custom:matrix': {
      const wave = Math.sin(y * 8.0 + t * 3.2 + Math.floor(angle * 12) * 0.7) * 0.5 + 0.5;
      const w = Math.round(Math.pow(wave, 4) * 140);
      const r = Math.round(wave * 40);
      const g = Math.round(90 + wave * 165);
      const b = Math.round(25 + wave * 85);
      return [w, r, g, b];
    }

    case 'custom:confetti':
    default: {
      const bucket = Math.floor(t * 4 + hash01(index) * 15);
      const hue = hash01(index * 3.1 + bucket * 13.7);
      const sparkle = 0.65 + 0.35 * Math.sin(t * 6.0 + index * 1.9);
      const [r, g, b] = hsvToRgb(hue, 0.88, sparkle);
      const w = Math.round(Math.pow(sparkle, 3) * 90);
      return [w, r, g, b];
    }
  }
}

class RealtimeEffectRunner {
  constructor() {
    this.interval = null;
    this.keepAliveInterval = null;
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

    let groupOffset = 0;
    try {
      const summary = await client.getSummary();
      if (summary?.group?.offset && Number.isFinite(summary.group.offset)) {
        groupOffset = summary.group.offset;
      }
    } catch (_) {
      // Optional group offset metadata
    }

    let leds = [];
    try {
      const layout = await client.getLayout();
      if (layout && Array.isArray(layout.coordinates) && layout.coordinates.length === numLeds) {
        // Twinkly layout coordinates are already normalized in global group 3D space (y in 0..1, x/z in -1..1)
        leds = layout.coordinates.map((c, localIdx) => {
          const nx = c.x || 0;
          const ny = Math.max(0, Math.min(1, c.y ?? 0.5));
          const nz = c.z || 0;
          const angle = (Math.atan2(nz, nx) / (Math.PI * 2) + 1) % 1;
          return { x: nx, y: ny, z: nz, angle, index: groupOffset + localIdx };
        });
      }
    } catch (err) {
      console.warn(`Could not load 3D layout for ${ip}, falling back to spiral coordinates:`, err.message);
    }

    if (leds.length !== numLeds) {
      leds = Array.from({ length: numLeds }, (_, localIdx) => {
        const y = localIdx / Math.max(1, numLeds - 1);
        const radius = 1 - y * 0.85;
        const theta = localIdx * 0.25;
        const x = Math.cos(theta) * radius;
        const z = Math.sin(theta) * radius;
        const angle = ((theta / (Math.PI * 2)) % 1 + 1) % 1;
        return { x, y, z, angle, index: groupOffset + localIdx };
      });
    }

    const meta = {
      ip,
      numLeds,
      bytesPerLed,
      leds,
      frameBuffer: Buffer.alloc(numLeds * bytesPerLed),
      frameUrl: `http://${ip}/xled/v1/led/rt/frame`
    };
    this.deviceMetaCache.set(ip, meta);
    return meta;
  }

  async start(getClientFn, ipsInput, effectId) {
    this.stop();
    this.currentEffectId = effectId;

    const ips = Array.isArray(ipsInput) ? ipsInput : [ipsInput];
    const targets = [];

    await Promise.allSettled(
      ips.map(async (ip) => {
        try {
          const client = typeof getClientFn === 'function' ? getClientFn(ip) : getClientFn;
          const meta = await this.getDeviceMeta(client, ip);
          await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
          await client.setLEDOperationMode({ mode: 'rt' });
          targets.push({ ip, client, meta, inFlight: false });
        } catch (err) {
          console.error(`Failed to initialize RT effect on ${ip}:`, err.message);
        }
      })
    );

    if (targets.length === 0) {
      throw new Error('Aucun contrôleur Twinkly accessible pour l\'effet 3D');
    }

    const startTime = Date.now();

    const sendFrameToTarget = async (target, t) => {
      if (this.currentEffectId !== effectId || target.inFlight) return;
      const { client, meta } = target;
      const tokenBase64 = client.getToken();
      if (!tokenBase64) return;

      target.inFlight = true;
      try {
        const { numLeds, bytesPerLed, leds, frameBuffer, frameUrl } = meta;

        for (let i = 0; i < numLeds; i++) {
          const [w, r, g, b] = evaluateLed(effectId, leds[i], t);
          const offset = i * bytesPerLed;
          if (bytesPerLed === 4) {
            // Twinkly RGBW byte order: W, R, G, B
            frameBuffer[offset] = w;
            frameBuffer[offset + 1] = r;
            frameBuffer[offset + 2] = g;
            frameBuffer[offset + 3] = b;
          } else {
            // Twinkly RGB byte order: R, G, B
            frameBuffer[offset] = r;
            frameBuffer[offset + 1] = g;
            frameBuffer[offset + 2] = b;
          }
        }

        const res = await fetch(frameUrl, {
          method: 'POST',
          headers: {
            'X-Auth-Token': tokenBase64,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(frameBuffer.length)
          },
          body: frameBuffer
        });

        // If token expired (401), re-authenticate automatically
        if (res.status === 401) {
          client.tokenData = undefined;
          await client.getDeviceDetails();
          await client.setLEDOperationMode({ mode: 'rt' });
        }
      } catch (_) {
        // Ignore transient network hiccups during real-time loop
      } finally {
        target.inFlight = false;
      }
    };

    const sendAllFrames = () => {
      if (this.currentEffectId !== effectId) return;
      const t = (Date.now() - startTime) / 1000;
      for (const target of targets) {
        sendFrameToTarget(target, t);
      }
    };

    this.interval = setInterval(sendAllFrames, Math.round(1000 / FPS));
    sendAllFrames();

    // Keep RT mode active across all controllers in the group
    this.keepAliveInterval = setInterval(async () => {
      if (this.currentEffectId !== effectId) return;
      await Promise.allSettled(
        targets.map(({ client }) => client.setLEDOperationMode({ mode: 'rt' }))
      );
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
  }
}

export const effectRunner = new RealtimeEffectRunner();
