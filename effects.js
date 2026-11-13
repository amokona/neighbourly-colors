import dgram from 'node:dgram';
import { compileAiShader } from './public/shader-engine.js';

const FPS = 30; // Native Twinkly 30 FPS real-time streaming over UDP port 7777
const UDP_PORT = 7777;
const MAX_UDP_PAYLOAD = 900; // Divisible by both 3 (300 RGB LEDs) and 4 (225 RGBW LEDs)

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

const aiRecipes = new Map();

export function registerAiRecipe(id, recipe) {
  let compiled = null;
  if (recipe && typeof recipe.code === 'string' && recipe.code.trim()) {
    try {
      compiled = compileAiShader(recipe.code);
    } catch (err) {
      console.warn(`Failed to compile AI shader ${id}:`, err.message);
    }
  }
  aiRecipes.set(String(id), { ...recipe, _compiled: compiled });
}

export function unregisterAiRecipe(id) {
  aiRecipes.delete(String(id));
}

export function getAiRecipe(id) {
  return aiRecipes.get(String(id)) || null;
}

function samplePaletteRgb(palette, phase, sharpness = 0) {
  if (!Array.isArray(palette) || palette.length === 0) {
    return [255, 255, 255];
  }
  if (palette.length === 1) {
    return palette[0];
  }
  const n = palette.length;
  const p = (((phase % 1) + 1) % 1) * n;
  const i0 = Math.floor(p) % n;
  const i1 = (i0 + 1) % n;
  let f = p - Math.floor(p);
  if (sharpness > 0.01) {
    // Crisp stripe transition when sharpness is high
    const edge = Math.max(0.02, 0.5 * (1 - Math.min(0.95, sharpness)));
    if (f < 0.5 - edge) f = 0;
    else if (f > 0.5 + edge) f = 1;
    else f = (f - (0.5 - edge)) / (2 * edge);
  }
  const c0 = palette[i0];
  const c1 = palette[i1];
  return [
    Math.round(c0[0] * (1 - f) + c1[0] * f),
    Math.round(c0[1] * (1 - f) + c1[1] * f),
    Math.round(c0[2] * (1 - f) + c1[2] * f)
  ];
}

function evaluateAiRecipe(recipe, led, t) {
  const { x, y, z, angle, index } = led;
  if (typeof recipe._compiled === 'function') {
    try {
      return recipe._compiled(x, y, z, angle, index, 2400, t);
    } catch (_) {
      return [0, 0, 0, 0];
    }
  }
  const palette = Array.isArray(recipe.palette) && recipe.palette.length > 0
    ? recipe.palette
    : [[99, 102, 241], [236, 72, 153], [250, 204, 21]];
  const speed = Number.isFinite(recipe.speed) ? Math.max(0.2, Math.min(3.5, recipe.speed)) : 1.25;
  const scale = Number.isFinite(recipe.scale) ? Math.max(0.8, Math.min(6.0, recipe.scale)) : 2.5;
  const twinkle = Number.isFinite(recipe.twinkle) ? Math.max(0, Math.min(1, recipe.twinkle)) : 0.2;
  const sharpness = Number.isFinite(recipe.sharpness) ? Math.max(0, Math.min(1, recipe.sharpness)) : 0.2;
  const cycleSeconds = Number.isFinite(recipe.cycleSeconds) ? Math.max(1.0, Math.min(30.0, recipe.cycleSeconds)) : 4.0;
  const fadeSeconds = Number.isFinite(recipe.fadeSeconds) ? Math.max(0.2, Math.min(cycleSeconds, recipe.fadeSeconds)) : cycleSeconds * 0.7;
  const minBrightness = Number.isFinite(recipe.minBrightness) ? Math.max(0, Math.min(0.8, recipe.minBrightness)) : 0.0;
  const pattern = recipe.pattern || 'diagonal_45_up';

  let r = 0, g = 0, b = 0, w = 0;

  if (pattern === 'burst_fade') {
    const cycleIndex = Math.floor(t / cycleSeconds);
    const localT = t % cycleSeconds;
    let level = minBrightness;

    if (localT < fadeSeconds) {
      const attack = Math.min(0.2, fadeSeconds * 0.1);
      if (localT < attack) {
        level = minBrightness + (1 - minBrightness) * (localT / attack);
      } else {
        const decayProgress = (localT - attack) / Math.max(0.05, fadeSeconds - attack);
        // Smooth exponential-like fade down to minBrightness (0 = completely off)
        const curve = Math.pow(Math.max(0, 1 - decayProgress), 1.8);
        level = minBrightness + (1 - minBrightness) * curve;
      }
    }

    const [pr, pg, pb] = palette[cycleIndex % palette.length];
    r = Math.round(pr * level);
    g = Math.round(pg * level);
    b = Math.round(pb * level);
    if (twinkle > 0.05 && level > 0.05) {
      const seed = hash01(index * 7.3 + 5.1);
      const sp = Math.pow(Math.max(0, Math.sin(t * (3.2 + seed * 4.0) + seed * 30.0)), 8) * twinkle * level;
      w = Math.round(sp * 200);
      r = Math.min(255, Math.round(r + sp * 150));
      g = Math.min(255, Math.round(g + sp * 150));
      b = Math.min(255, Math.round(b + sp * 150));
    }
    return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }

  if (pattern === 'fill_spiral_up' || pattern === 'fill_spiral_down') {
    const progress = (t % cycleSeconds) / cycleSeconds;
    const turns = Math.max(3, Math.round(scale * 2.2));
    const yDir = pattern === 'fill_spiral_up' ? y : (1 - y);
    const band = Math.min(turns - 1, Math.floor(yDir * turns));
    const ledSpiralPos = (band + angle) / turns;

    if (ledSpiralPos <= progress) {
      const [pr, pg, pb] = palette.length === 1
        ? palette[0]
        : samplePaletteRgb(palette, ledSpiralPos * scale, sharpness);
      const distToHead = progress - ledSpiralPos;
      const headGlow = distToHead < 0.04 ? (1 - distToHead / 0.04) : 0;
      r = pr;
      g = pg;
      b = pb;
      w = Math.round(headGlow * 140);
      return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
    }
    if (minBrightness > 0.01) {
      const [pr, pg, pb] = palette[0];
      return [0, Math.round(pr * minBrightness), Math.round(pg * minBrightness), Math.round(pb * minBrightness)];
    }
    return [0, 0, 0, 0];
  }

  if (pattern === 'static') {
    const [pr, pg, pb] = palette.length === 1
      ? palette[0]
      : samplePaletteRgb(palette, y, sharpness);
    r = pr;
    g = pg;
    b = pb;
    if (twinkle > 0.05) {
      const seed = hash01(index * 7.3 + 5.1);
      const sp = Math.pow(Math.max(0, Math.sin(t * (3.2 + seed * 4.0) + seed * 30.0)), 8) * twinkle;
      w = Math.round(sp * 200);
      r = Math.min(255, Math.round(r + sp * 150));
      g = Math.min(255, Math.round(g + sp * 150));
      b = Math.min(255, Math.round(b + sp * 150));
    }
    return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }

  if (pattern === 'twinkle') {
    const seed = hash01(index * 9.1 + 3.7);
    const wave = Math.sin(t * (2.2 + seed * 3.8) * speed + seed * 40.0) * 0.5 + 0.5;
    const [pr, pg, pb] = samplePaletteRgb(palette, seed + wave * 0.5, sharpness);
    const bright = minBrightness + (1 - minBrightness) * Math.pow(wave, 2.2);
    r = Math.round(pr * bright);
    g = Math.round(pg * bright);
    b = Math.round(pb * bright);
    w = Math.round(Math.pow(wave, 5) * 180 * Math.max(0.3, twinkle));
    return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }

  if (pattern === 'pulse_heartbeat') {
    const cycle = ((t * speed * 0.75) % 1.2) / 1.2;
    const b1 = Math.exp(-Math.pow((cycle - 0.18) / 0.07, 2));
    const b2 = 0.8 * Math.exp(-Math.pow((cycle - 0.38) / 0.09, 2));
    const pulse = Math.min(1, b1 + b2);
    const [pr, pg, pb] = palette.length === 1
      ? palette[0]
      : samplePaletteRgb(palette, y * 0.5 - t * 0.2 * speed, 0);
    const factor = minBrightness + (1 - minBrightness) * pulse;
    r = Math.round(pr * factor);
    g = Math.round(pg * factor);
    b = Math.round(pb * factor);
    w = Math.round(pulse * 120 * twinkle * factor);
    return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }

  let phase = 0;
  switch (pattern) {
    case 'diagonal_45_up':
      // As t increases, constant phase moves to larger y (upward) and wraps around angle
      phase = angle * Math.round(scale) - y * (scale * 0.85) + t * speed * 0.45;
      break;
    case 'diagonal_45_down':
      // As t increases, constant phase moves to smaller y (downward) and wraps around angle
      phase = angle * Math.round(scale) + y * (scale * 0.85) + t * speed * 0.45;
      break;
    case 'downward_wave':
      // As t increases, constant phase moves to smaller y (top to bottom)
      phase = y * (scale * 0.75) + t * speed * 0.48 + Math.sin(angle * Math.PI * 2) * 0.06;
      break;
    case 'upward_wave':
      // As t increases, constant phase moves to larger y (bottom to top)
      phase = y * (scale * 0.75) - t * speed * 0.48 + Math.sin(angle * Math.PI * 2) * 0.06;
      break;
    case 'right_to_left':
      phase = angle * Math.max(1, Math.round(scale * 0.8)) + t * speed * 0.45;
      break;
    case 'left_to_right':
      phase = angle * Math.max(1, Math.round(scale * 0.8)) - t * speed * 0.45;
      break;
    default:
      phase = angle * Math.round(scale) - y * (scale * 0.85) + t * speed * 0.45;
      break;
  }

  if (palette.length === 1) {
    const wave = Math.pow(Math.sin(phase * Math.PI * 2) * 0.5 + 0.5, sharpness > 0.5 ? 2.5 : 1.3);
    const level = minBrightness + (1 - minBrightness) * wave;
    r = Math.round(palette[0][0] * level);
    g = Math.round(palette[0][1] * level);
    b = Math.round(palette[0][2] * level);
  } else {
    [r, g, b] = samplePaletteRgb(palette, phase, sharpness);
  }

  if (twinkle > 0.04) {
    const seed = hash01(index * 7.3 + 5.1);
    const sp = Math.pow(Math.max(0, Math.sin(t * (3.2 + seed * 4.0) + seed * 30.0)), 8) * twinkle;
    w = Math.round(sp * 210);
    r = Math.min(255, Math.round(r + sp * 180));
    g = Math.min(255, Math.round(g + sp * 180));
    b = Math.min(255, Math.round(b + sp * 180));
  } else if (r > 215 && g > 215 && b > 215) {
    w = Math.round((r + g + b) / 3 * 0.65);
  }

  return [Math.min(255, w), Math.min(255, r), Math.min(255, g), Math.min(255, b)];
}

// Compute [w, r, g, b] for a single LED so every LED on the tree is actively lit
function evaluateLed(effectId, led, t) {
  if (typeof effectId === 'string' && effectId.startsWith('ai:')) {
    const recipe = aiRecipes.get(effectId);
    if (recipe) {
      return evaluateAiRecipe(recipe, led, t);
    }
  }
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
    this.udpSocket = null;
    this.deviceMetaCache = new Map();
  }

  ensureUdpSocket() {
    if (!this.udpSocket) {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.on('error', (err) => {
        console.warn('UDP socket error:', err.message);
      });
    }
    return this.udpSocket;
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

    const totalBytes = numLeds * bytesPerLed;
    const frameBuffer = Buffer.alloc(totalBytes);

    // Pre-allocate UDP v3 fragment buffers (12-byte header + up to 900-byte payload)
    const fragments = [];
    let fragIndex = 0;
    for (let byteOffset = 0; byteOffset < totalBytes; byteOffset += MAX_UDP_PAYLOAD) {
      const payloadLength = Math.min(MAX_UDP_PAYLOAD, totalBytes - byteOffset);
      const packetBuffer = Buffer.alloc(12 + payloadLength);
      packetBuffer[0] = 0x03; // Protocol v3
      packetBuffer[9] = 0x00;
      packetBuffer[10] = 0x00;
      packetBuffer[11] = fragIndex;
      fragments.push({
        byteOffset,
        payloadLength,
        packetBuffer
      });
      fragIndex++;
    }

    const meta = {
      ip,
      numLeds,
      bytesPerLed,
      leds,
      frameBuffer,
      fragments
    };
    this.deviceMetaCache.set(ip, meta);
    return meta;
  }

  async start(getClientFn, ipsInput, effectId) {
    this.stop();
    this.currentEffectId = effectId;
    const socket = this.ensureUdpSocket();

    const ips = Array.isArray(ipsInput) ? ipsInput : [ipsInput];
    const targets = [];

    await Promise.allSettled(
      ips.map(async (ip) => {
        try {
          const client = typeof getClientFn === 'function' ? getClientFn(ip) : getClientFn;
          const meta = await this.getDeviceMeta(client, ip);
          await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
          await client.setLEDOperationMode({ mode: 'rt' });
          const tokenBase64 = client.getToken();
          const tokenBytes = tokenBase64 ? Buffer.from(tokenBase64, 'base64') : null;
          targets.push({ ip, client, meta, tokenBytes });
        } catch (err) {
          console.error(`Failed to initialize RT effect on ${ip}:`, err.message);
        }
      })
    );

    if (targets.length === 0) {
      throw new Error('Aucun contrôleur Twinkly accessible pour l\'effet 3D');
    }

    const startTime = Date.now();

    const sendFrameToTarget = (target, t) => {
      if (this.currentEffectId !== effectId) return;
      const { ip, client, meta } = target;

      const latestToken = client.getToken();
      if (latestToken && (!target.tokenBytes || target.lastTokenStr !== latestToken)) {
        target.lastTokenStr = latestToken;
        target.tokenBytes = Buffer.from(latestToken, 'base64');
      }
      if (!target.tokenBytes) return;

      const { numLeds, bytesPerLed, leds, frameBuffer, fragments } = meta;

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

      for (let f = 0; f < fragments.length; f++) {
        const { byteOffset, payloadLength, packetBuffer } = fragments[f];
        target.tokenBytes.copy(packetBuffer, 1, 0, 8);
        frameBuffer.copy(packetBuffer, 12, byteOffset, byteOffset + payloadLength);
        socket.send(packetBuffer, 0, packetBuffer.length, UDP_PORT, ip);
      }
    };

    const sendAllFrames = () => {
      if (this.currentEffectId !== effectId) return;
      const t = (Date.now() - startTime) / 1000;
      for (let i = 0; i < targets.length; i++) {
        sendFrameToTarget(targets[i], t);
      }
    };

    this.interval = setInterval(sendAllFrames, Math.round(1000 / FPS));
    sendAllFrames();

    // Keep RT mode and auth tokens active across all controllers in the group
    this.keepAliveInterval = setInterval(async () => {
      if (this.currentEffectId !== effectId) return;
      await Promise.allSettled(
        targets.map(async (target) => {
          try {
            await target.client.setLEDOperationMode({ mode: 'rt' });
          } catch (_) {}
        })
      );
    }, 20000);
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
