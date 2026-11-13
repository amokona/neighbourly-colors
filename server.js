import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient } from './client.js';
import {
  CUSTOM_EFFECTS,
  isCustomEffectId,
  getCustomEffectById,
  registerAiRecipe,
  unregisterAiRecipe,
  getAiRecipe,
  effectRunner
} from './effects.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TWINKLY_IP = process.env.TWINKLY_IP || 'fallback';
const TWINKLY_IPS = Array.from(
  new Set(
    [
      TWINKLY_IP,
      ...(process.env.TWINKLY_IPS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    ].filter(ip => ip && ip !== 'fallback')
  )
);
if (TWINKLY_IPS.length === 0) {
  TWINKLY_IPS.push(TWINKLY_IP);
}
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN || '';
const DEFAULT_MOVIE_ID = process.env.DEFAULT_MOVIE_ID !== undefined && process.env.DEFAULT_MOVIE_ID !== ''
  ? (isCustomEffectId(process.env.DEFAULT_MOVIE_ID) ? process.env.DEFAULT_MOVIE_ID : Number(process.env.DEFAULT_MOVIE_ID))
  : null;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const DATA_DIR = path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const MAX_LOGS = 500;

// In-memory active session tokens (token -> expiry timestamp)
const activeSessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const key = part.slice(0, idx).trim();
      const val = decodeURIComponent(part.slice(idx + 1).trim());
      cookies[key] = val;
    }
  });
  return cookies;
}

function isValidSessionToken(token) {
  if (!token) return false;
  const expiresAt = activeSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

const DEFAULT_IDLE_PLAYLIST = {
  enabled: true,
  intervalSeconds: 180,
  effects: [
    'custom:aurora',
    'custom:candycane_spiral',
    'custom:starlight_gold',
    'custom:christmas_classic',
    0,
    3,
    8
  ]
};

const DEFAULT_SCHEDULE = {
  enabled: false,
  onTime: '16:30',
  offTime: '23:00'
};
const SCHEDULE_TIMEZONE = process.env.TZ || 'America/Toronto';
const TIME_HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function getCurrentTimeHHMM() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SCHEDULE_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour')?.value || '00';
    const m = parts.find(p => p.type === 'minute')?.value || '00';
    return `${h === '24' ? '00' : h}:${m}`;
  } catch (_) {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
}

function parseMinutes(hhmm) {
  const match = TIME_HHMM_REGEX.exec(String(hhmm || ''));
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isWithinActiveHours(schedule) {
  if (!schedule || !schedule.enabled) return true;
  const nowMin = parseMinutes(getCurrentTimeHHMM());
  const onMin = parseMinutes(schedule.onTime || '16:30');
  const offMin = parseMinutes(schedule.offTime || '23:00');
  if (onMin === offMin) return true;
  if (onMin < offMin) {
    // Same-day window (e.g. 16:30 -> 23:00)
    return nowMin >= onMin && nowMin < offMin;
  }
  // Overnight window crossing midnight (e.g. 16:30 -> 01:00)
  return nowMin >= onMin || nowMin < offMin;
}

// Persistent usage stats & logs
let usageData = {
  startedAt: new Date().toISOString(),
  totalTurns: 0,
  colorTurns: 0,
  effectTurns: 0,
  colorCounts: {},
  movieCounts: {},
  uniqueIps: [],
  logs: [],
  idlePlaylist: { ...DEFAULT_IDLE_PLAYLIST },
  schedule: { ...DEFAULT_SCHEDULE },
  geminiApiKey: '',
  aiCreations: []
};

const VALID_AI_PATTERNS = new Set([
  'diagonal_45_up',
  'diagonal_45_down',
  'downward_wave',
  'upward_wave',
  'right_to_left',
  'left_to_right',
  'twinkle',
  'pulse_heartbeat'
]);

function isAiEffectId(id) {
  return typeof id === 'string' && id.startsWith('ai:') && Boolean(getAiRecipe(id));
}

function sanitizeAiRecipe(raw, fallbackPrompt = '') {
  const name = typeof raw?.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, 40)
    : `✨ ${fallbackPrompt.trim().slice(0, 26) || 'Création IA'}`;
  const description = typeof raw?.description === 'string' && raw.description.trim()
    ? raw.description.trim().slice(0, 110)
    : `Effet sur mesure : « ${fallbackPrompt.trim().slice(0, 80)} »`;
  const pattern = VALID_AI_PATTERNS.has(raw?.pattern) ? raw.pattern : 'diagonal_45_up';
  const speed = Number.isFinite(Number(raw?.speed))
    ? Math.max(0.4, Math.min(2.6, Number(raw.speed)))
    : 1.25;
  const scale = Number.isFinite(Number(raw?.scale))
    ? Math.max(1.0, Math.min(5.0, Number(raw.scale)))
    : 2.6;
  const twinkle = Number.isFinite(Number(raw?.twinkle))
    ? Math.max(0, Math.min(1, Number(raw.twinkle)))
    : 0.2;
  const sharpness = Number.isFinite(Number(raw?.sharpness))
    ? Math.max(0, Math.min(1, Number(raw.sharpness)))
    : 0.25;

  let palette = [];
  if (Array.isArray(raw?.palette)) {
    for (const c of raw.palette.slice(0, 6)) {
      if (Array.isArray(c) && c.length >= 3) {
        palette.push([
          Math.max(0, Math.min(255, Math.round(Number(c[0]) || 0))),
          Math.max(0, Math.min(255, Math.round(Number(c[1]) || 0))),
          Math.max(0, Math.min(255, Math.round(Number(c[2]) || 0)))
        ]);
      }
    }
  }
  if (palette.length === 0) {
    palette = [[99, 102, 241], [236, 72, 153], [250, 204, 21]];
  } else if (palette.length === 1) {
    palette.push([255, 255, 255]);
  }

  return {
    name,
    description,
    pattern,
    speed: Math.round(speed * 100) / 100,
    scale: Math.round(scale * 100) / 100,
    twinkle: Math.round(twinkle * 100) / 100,
    sharpness: Math.round(sharpness * 100) / 100,
    palette
  };
}

function generateFallbackRecipe(promptText = '') {
  const lower = promptText.toLowerCase();
  const colorDictionary = [
    { keys: ['canadien', 'habs', 'montréal', 'montreal', 'tricolore'], multi: [[25, 70, 235], [255, 255, 255], [239, 35, 50]] },
    { keys: ['québec', 'quebec', 'fleurdelisé'], multi: [[20, 75, 230], [255, 255, 255]] },
    { keys: ['arc-en-ciel', 'rainbow', 'multicolore'], multi: [[239, 38, 38], [249, 115, 22], [250, 204, 21], [16, 185, 129], [59, 130, 246], [168, 85, 247]] },
    { keys: ['rouge', 'red', 'carmin', 'feu', 'lave', 'magma'], rgb: [239, 38, 38] },
    { keys: ['bleu', 'blue', 'azur', 'glace', 'océan', 'ocean', 'saphir'], rgb: [37, 99, 235] },
    { keys: ['blanc', 'white', 'neige', 'snow', 'argent', 'givre'], rgb: [255, 255, 255] },
    { keys: ['vert', 'green', 'émeraude', 'menthe', 'sapin', 'forêt'], rgb: [16, 195, 110] },
    { keys: ['jaune', 'yellow', 'or', 'gold', 'doré', 'soleil', 'citron'], rgb: [250, 204, 21] },
    { keys: ['orange', 'ambre', 'corail', 'flamme'], rgb: [249, 115, 22] },
    { keys: ['violet', 'purple', 'mauve', 'lilas', 'améthyste'], rgb: [147, 51, 234] },
    { keys: ['rose', 'pink', 'magenta', 'néon', 'fuchsia'], rgb: [236, 72, 153] },
    { keys: ['cyan', 'turquoise', 'aqua', 'lagoon'], rgb: [6, 182, 212] },
    { keys: ['chocolat', 'brun', 'cuivre', 'bronze'], rgb: [160, 82, 45] }
  ];

  let palette = [];
  for (const entry of colorDictionary) {
    if (entry.keys.some(k => lower.includes(k))) {
      if (entry.multi) {
        palette.push(...entry.multi);
      } else if (entry.rgb) {
        palette.push(entry.rgb);
      }
    }
  }
  if (palette.length === 0) {
    palette = [[99, 102, 241], [236, 72, 153], [250, 204, 21]];
  } else if (palette.length === 1) {
    palette.push([255, 255, 255]);
  }

  let pattern = 'diagonal_45_up';
  if (lower.includes('45') && (lower.includes('bas') || lower.includes('descend') || lower.includes('down'))) {
    pattern = 'diagonal_45_down';
  } else if (lower.includes('45') || lower.includes('diag') || lower.includes('spirale') || lower.includes('sucre')) {
    pattern = 'diagonal_45_up';
  } else if (lower.includes('descend') || lower.includes('bas') || lower.includes('tomb') || lower.includes('pluie') || lower.includes('down') || lower.includes('cascade')) {
    pattern = 'downward_wave';
  } else if (lower.includes('mont') || lower.includes('haut') || lower.includes('up') || lower.includes('lave') || lower.includes('flamme') || lower.includes('feu')) {
    pattern = 'upward_wave';
  } else if (lower.includes('gauche') || lower.includes('right to left') || lower.includes('tourne')) {
    pattern = 'right_to_left';
  } else if (lower.includes('droite') || lower.includes('left to right')) {
    pattern = 'left_to_right';
  } else if (lower.includes('coeur') || lower.includes('cœur') || lower.includes('pulse') || lower.includes('battement') || lower.includes('respir')) {
    pattern = 'pulse_heartbeat';
  } else if (lower.includes('scintill') || lower.includes('twinkl') || lower.includes('étoile') || lower.includes('étincel')) {
    pattern = 'twinkle';
  }

  const twinkle = (lower.includes('scintill') || lower.includes('twinkl') || lower.includes('étincel') || lower.includes('étoile')) ? 0.85 : 0.2;
  const sharpness = (lower.includes('rayure') || lower.includes('bande') || lower.includes('stripe') || lower.includes('drapeau')) ? 0.8 : 0.25;
  const speed = (lower.includes('lent') || lower.includes('doux') || lower.includes('slow') || lower.includes('calme')) ? 0.75 :
                (lower.includes('rapide') || lower.includes('vite') || lower.includes('fast') || lower.includes('vif')) ? 1.85 : 1.3;

  const cleanText = promptText.trim();
  const shortTitle = cleanText.slice(0, 26) + (cleanText.length > 26 ? '…' : '');
  return sanitizeAiRecipe({
    name: `✨ ${shortTitle || 'Création IA'}`,
    description: `Effet sur mesure : « ${cleanText.slice(0, 90)} »`,
    pattern,
    speed,
    scale: 2.6,
    twinkle,
    sharpness,
    palette
  }, promptText);
}

async function generateEffectWithGeminiOrFallback(promptText) {
  const apiKey = (usageData.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return { recipe: generateFallbackRecipe(promptText), source: 'fallback' };
  }

  const systemInstruction = `Tu es un designer d'effets lumineux 3D pour un sapin de Noël Twinkly de 2400 LEDs.
Convertis la description de l'utilisateur en un objet JSON strict avec les propriétés suivantes :
- "name": Titre court et accrocheur en français commençant par un emoji (max 32 caractères, ex: "🏒 Tricolore Glorieux", "🌋 Lave Volcanique").
- "description": Courte phrase descriptive en français (max 95 caractères).
- "pattern": Choisis exactement l'un de :
  - "diagonal_45_up" (rayures ou bandes diagonales montant à 45 degrés)
  - "diagonal_45_down" (rayures ou bandes diagonales descendant à 45 degrés)
  - "downward_wave" (vagues ou couleurs voyageant du haut vers le bas)
  - "upward_wave" (vagues ou flammes montant du bas vers le haut)
  - "right_to_left" (couleurs tournant de droite à gauche)
  - "left_to_right" (couleurs tournant de gauche à droite)
  - "twinkle" (scintillement d'étoiles sur tout le sapin)
  - "pulse_heartbeat" (pulsation rythmique sur tout le sapin)
- "palette": Tableau de 2 à 5 couleurs au format [R, G, B] (entiers de 0 à 255) correspondant exactement aux couleurs demandées.
- "speed": Nombre entre 0.5 (très lent) et 2.4 (très rapide), défaut 1.3.
- "scale": Nombre entre 1.2 (larges vagues) et 4.5 (rayures serrées), défaut 2.6.
- "twinkle": Nombre entre 0.0 (aucun scintillement) et 1.0 (scintillement intense).
- "sharpness": Nombre entre 0.0 (dégradé doux) et 0.9 (rayures franches et nettes).`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.6,
            responseMimeType: 'application/json'
          }
        })
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Gemini API returned ${response.status}:`, errText.slice(0, 200));
      return { recipe: generateFallbackRecipe(promptText), source: 'fallback' };
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(rawText);
    return { recipe: sanitizeAiRecipe(parsed, promptText), source: 'gemini' };
  } catch (err) {
    console.warn('Gemini generation failed, using smart local parser:', err.message);
    return { recipe: generateFallbackRecipe(promptText), source: 'fallback' };
  }
}

let knownMovies = {
  0: 'Chute de Neige Étincelante',
  1: 'Hélice Lumineuse',
  2: 'Neige d\'Hiver',
  3: 'Arc-en-Ciel',
  4: 'Scintillement Vif',
  5: 'Sucre d\'Orge',
  6: 'Coucher de Soleil',
  7: 'Vagues Diagonales',
  8: 'Noël Vintage',
  9: 'Vague Douce'
};
CUSTOM_EFFECTS.forEach(eff => {
  knownMovies[eff.id] = eff.name;
});

function getDeviceMovieMeta(rawName = '', id = 0) {
  const n = rawName.trim().toLowerCase();

  if (n.includes('snowfall')) {
    return {
      name: 'Chute de Neige Étincelante',
      description: 'Scintillement bleu et blanc glacé sur tout le sapin',
      preview: 'linear-gradient(135deg, #1d4ed8, #38bdf8, #ffffff)'
    };
  }
  if (n.includes('rotor')) {
    return {
      name: 'Hélice Lumineuse',
      description: 'Colonnes rouges et blanches tournant autour du sapin',
      preview: 'repeating-linear-gradient(90deg, #ef4444 0%, #ef4444 50%, #ffffff 50%, #ffffff 100%)'
    };
  }
  if (n === 'snow' || n.includes('snow')) {
    return {
      name: 'Neige d\'Hiver',
      description: 'Flocons blancs purs descendant doucement sur le sapin',
      preview: 'linear-gradient(180deg, #ffffff, #cbd5e1, #0f172a)'
    };
  }
  if (n.includes('rainbow')) {
    return {
      name: 'Arc-en-Ciel',
      description: 'Couleurs de l\'arc-en-ciel descendant sur tout le sapin',
      preview: 'linear-gradient(180deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7)'
    };
  }
  if (n.includes('twinkle')) {
    return {
      name: 'Scintillement Vif',
      description: 'Étoiles blanches et violettes clignotant avec éclat',
      preview: 'linear-gradient(135deg, #6b21a8, #a855f7, #ffffff)'
    };
  }
  if (n.includes('candy')) {
    return {
      name: 'Sucre d\'Orge',
      description: 'Rayures rouges et blanches montant à 45° sur le sapin',
      preview: 'repeating-linear-gradient(45deg, #ef4444 0px, #ef4444 10px, #ffffff 10px, #ffffff 20px)'
    };
  }
  if (n.includes('sunset')) {
    return {
      name: 'Coucher de Soleil',
      description: 'Vagues rouge, orange et jaune glissant de droite à gauche',
      preview: 'linear-gradient(270deg, #ef4444, #f97316, #facc15)'
    };
  }
  if (n.includes('diagonal')) {
    return {
      name: 'Vagues Diagonales',
      description: 'Bandes blanches et bleues montant en diagonale à 45°',
      preview: 'repeating-linear-gradient(45deg, #2563eb 0px, #2563eb 10px, #ffffff 10px, #ffffff 20px)'
    };
  }
  if (n.includes('vintage')) {
    return {
      name: 'Noël Vintage',
      description: 'Lumières blanc très chaud et ambre scintillant doucement',
      preview: 'linear-gradient(135deg, #92400e, #f59e0b, #fef3c7)'
    };
  }
  if (n.includes('slow wave') || n.includes('wave')) {
    return {
      name: 'Vague Douce',
      description: 'Ondulation jaune, rouge et violette descendant sur le sapin',
      preview: 'linear-gradient(180deg, #facc15, #ef4444, #9333ea)'
    };
  }

  return {
    name: rawName || `Effet #${id}`,
    description: 'Animation lumineuse sur tout le sapin',
    preview: 'linear-gradient(135deg, #4f46e5, #06b6d4)'
  };
}

function loadUsageData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(USAGE_FILE)) {
      const raw = fs.readFileSync(USAGE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const savedPlaylist = parsed.idlePlaylist || {};
      const savedSchedule = parsed.schedule || {};
      usageData = {
        ...usageData,
        ...parsed,
        colorCounts: parsed.colorCounts || {},
        movieCounts: parsed.movieCounts || {},
        uniqueIps: Array.isArray(parsed.uniqueIps) ? parsed.uniqueIps : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        idlePlaylist: {
          enabled: typeof savedPlaylist.enabled === 'boolean' ? savedPlaylist.enabled : DEFAULT_IDLE_PLAYLIST.enabled,
          intervalSeconds: Number.isFinite(Number(savedPlaylist.intervalSeconds))
            ? Math.max(15, Math.min(3600, Number(savedPlaylist.intervalSeconds)))
            : DEFAULT_IDLE_PLAYLIST.intervalSeconds,
          effects: Array.isArray(savedPlaylist.effects)
            ? savedPlaylist.effects
            : [...DEFAULT_IDLE_PLAYLIST.effects]
        },
        schedule: {
          enabled: typeof savedSchedule.enabled === 'boolean' ? savedSchedule.enabled : DEFAULT_SCHEDULE.enabled,
          onTime: TIME_HHMM_REGEX.test(savedSchedule.onTime || '') ? savedSchedule.onTime : DEFAULT_SCHEDULE.onTime,
          offTime: TIME_HHMM_REGEX.test(savedSchedule.offTime || '') ? savedSchedule.offTime : DEFAULT_SCHEDULE.offTime
        },
        geminiApiKey: typeof parsed.geminiApiKey === 'string' ? parsed.geminiApiKey : '',
        aiCreations: Array.isArray(parsed.aiCreations) ? parsed.aiCreations : []
      };

      for (const item of usageData.aiCreations) {
        if (item && item.id && item.recipe) {
          registerAiRecipe(item.id, item.recipe);
          knownMovies[item.id] = item.name || item.recipe.name || 'Création IA';
        }
      }
    }
  } catch (error) {
    console.error('Error loading usage data:', error);
  }
}

function saveUsageData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageData, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving usage data:', error);
  }
}

function addLogEntry(entry) {
  const logItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry
  };
  usageData.logs.unshift(logItem);
  if (usageData.logs.length > MAX_LOGS) {
    usageData.logs.length = MAX_LOGS;
  }
  saveUsageData();
  return logItem;
}

function recordQueueTurn({ nickname, type, color, movieId, ip }) {
  usageData.totalTurns += 1;
  if (ip && !usageData.uniqueIps.includes(ip)) {
    usageData.uniqueIps.push(ip);
  }
  if (type === 'color' && color) {
    usageData.colorTurns += 1;
    const normalized = color.toLowerCase();
    usageData.colorCounts[normalized] = (usageData.colorCounts[normalized] || 0) + 1;
  } else if (type === 'effect' && movieId !== null && movieId !== undefined) {
    usageData.effectTurns += 1;
    const key = String(movieId);
    usageData.movieCounts[key] = (usageData.movieCounts[key] || 0) + 1;
  }
  saveUsageData();
}

loadUsageData();

// Run an async operation across all configured Twinkly controllers in the group
async function forAllControllers(actionFn) {
  const results = await Promise.allSettled(
    TWINKLY_IPS.map(ip => actionFn(getClient(ip), ip))
  );
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  if (fulfilled.length === 0 && results.length > 0) {
    throw results[0].reason || new Error('Aucun contrôleur Twinkly n\'a répondu');
  }
  return results;
}

// Helper to apply either a custom 3D effect, an AI-generated effect, or an on-device movie across all controllers
async function applyEffectOrMovie(movieId) {
  if (isCustomEffectId(movieId) || isAiEffectId(movieId)) {
    await effectRunner.start(getClient, TWINKLY_IPS, movieId);
  } else {
    effectRunner.stop();
    const numericId = Number(movieId);
    await forAllControllers(async (client) => {
      await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
      await client.setCurrentMovie({ id: numericId });
      await client.setLEDOperationMode({ mode: 'movie' });
    });
  }
}

// Helper to apply a solid RGB color across all controllers
async function applySolidColor({ r, g, b }) {
  effectRunner.stop();
  await forAllControllers(async (client) => {
    await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
    await client.setLEDOperationMode({ mode: 'color' });
    await client.setLEDColor({ r, g, b });
  });
}

// Trust first reverse proxy so req.ip reflects the real client IP safely
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve /admin cleanly
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Middleware to require admin login on all admin & direct-control endpoints
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: 'ADMIN_PASSWORD non configuré sur le serveur. Définissez ADMIN_PASSWORD dans docker-compose.yml.'
    });
  }

  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = cookies.twinkly_admin_session || req.headers['x-admin-token'] || bearerToken;

  if (isValidSessionToken(token) || timingSafeCompare(token, ADMIN_PASSWORD)) {
    return next();
  }

  return res.status(401).json({ error: 'Authentification requise' });
}

// Admin Login & Logout endpoints
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: 'ADMIN_PASSWORD non configuré sur le serveur.'
    });
  }

  const { username, password } = req.body || {};
  const userOk = timingSafeCompare(username || '', ADMIN_USER);
  const passOk = timingSafeCompare(password || '', ADMIN_PASSWORD);

  if (!userOk || !passOk) {
    addLogEntry({
      event: 'admin_login_failed',
      nickname: String(username || 'inconnu').slice(0, 20),
      ip: req.ip || req.socket?.remoteAddress,
      status: 'error',
      details: 'Tentative de connexion admin échouée'
    });
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeSessions.set(sessionToken, Date.now() + SESSION_TTL_MS);

  res.setHeader(
    'Set-Cookie',
    `twinkly_admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );

  addLogEntry({
    event: 'admin_action',
    nickname: ADMIN_USER,
    ip: req.ip || req.socket?.remoteAddress,
    status: 'info',
    details: 'Connexion à l\'interface d\'administration'
  });

  res.json({ success: true, token: sessionToken, username: ADMIN_USER });
});

app.post('/api/admin/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = cookies.twinkly_admin_session || req.headers['x-admin-token'] || bearerToken;

  if (token) {
    activeSessions.delete(token);
  }

  res.setHeader(
    'Set-Cookie',
    'twinkly_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  );
  res.json({ success: true });
});

// Queue system, Idle Playlist rotation & Night Schedule
let queue = [];
let currentUser = null;
let currentTimeout = null;
let queuePaused = false;
let idleTimer = null;
let idlePlaylistIndex = 0;
let currentIdleEffectId = null;
let isSleepingForNight = false;

function stopIdlePlaylist() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  currentIdleEffectId = null;
}

async function runIdlePlaylistStep() {
  if (currentUser || queue.length > 0 || isSleepingForNight) {
    stopIdlePlaylist();
    return;
  }

  const playlist = usageData.idlePlaylist || DEFAULT_IDLE_PLAYLIST;
  if (!playlist.enabled || !Array.isArray(playlist.effects) || playlist.effects.length === 0) {
    stopIdlePlaylist();
    if (DEFAULT_MOVIE_ID !== null && DEFAULT_MOVIE_ID !== '') {
      try {
        currentIdleEffectId = DEFAULT_MOVIE_ID;
        await applyEffectOrMovie(DEFAULT_MOVIE_ID);
      } catch (error) {
        console.error('Error reverting to default movie:', error);
      }
    } else {
      effectRunner.stop();
    }
    return;
  }

  const effectId = playlist.effects[idlePlaylistIndex % playlist.effects.length];
  idlePlaylistIndex = (idlePlaylistIndex + 1) % playlist.effects.length;
  currentIdleEffectId = effectId;

  try {
    await applyEffectOrMovie(effectId);
    console.log(`Idle playlist playing: ${knownMovies[effectId] || effectId}`);
  } catch (error) {
    console.error('Error applying idle playlist effect:', error.message);
  }

  if (!currentUser && queue.length === 0 && !isSleepingForNight && playlist.enabled && playlist.effects.length > 0) {
    const delayMs = Math.max(15, Number(playlist.intervalSeconds) || 180) * 1000;
    idleTimer = setTimeout(() => {
      runIdlePlaylistStep();
    }, delayMs);
  }
}

async function startIdlePlaylist() {
  stopIdlePlaylist();
  if (isSleepingForNight) return;
  await runIdlePlaylistStep();
}

async function evaluateScheduleState(forceApply = false) {
  const schedule = usageData.schedule || DEFAULT_SCHEDULE;
  const shouldSleep = Boolean(schedule.enabled) && !isWithinActiveHours(schedule);

  if (shouldSleep && (!isSleepingForNight || forceApply)) {
    isSleepingForNight = true;
    if (currentTimeout) {
      clearTimeout(currentTimeout);
      currentTimeout = null;
    }
    currentUser = null;
    queue = [];
    stopIdlePlaylist();
    effectRunner.stop();

    try {
      await forAllControllers(async (client) => {
        await client.setLEDOperationMode({ mode: 'off' });
      });
      console.log(`🌙 Night schedule active: tree turned off until ${schedule.onTime}`);
      addLogEntry({
        event: 'schedule_off',
        nickname: 'Système',
        status: 'info',
        details: `Extinction nocturne automatique (réouverture à ${schedule.onTime})`
      });
    } catch (err) {
      console.error('Error turning off tree for night schedule:', err.message);
    }
  } else if (!shouldSleep && (isSleepingForNight || forceApply)) {
    const wasSleeping = isSleepingForNight;
    isSleepingForNight = false;
    if (wasSleeping) {
      console.log(`☀️ Active hours started (${schedule.onTime}): waking up tree`);
      addLogEntry({
        event: 'schedule_on',
        nickname: 'Système',
        status: 'info',
        details: `Allumage automatique programmé (${schedule.onTime})`
      });
    }
    if (!currentUser && queue.length === 0) {
      await startIdlePlaylist();
    }
  }
}

// Process next person in queue
async function processNextInQueue() {
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }

  if (queue.length === 0) {
    currentUser = null;
    await startIdlePlaylist();
    return;
  }

  stopIdlePlaylist();
  currentUser = queue.shift();
  currentUser.startTime = Date.now();
  currentUser.duration = 120000; // 2 minutes in milliseconds

  console.log(`Processing queue item for ${currentUser.nickname}`);

  try {
    if (currentUser.type === 'color') {
      const hex = currentUser.color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      stopIdlePlaylist();
    await applySolidColor({ r, g, b });
    } else {
      await applyEffectOrMovie(currentUser.movieId);
    }

    console.log(`Applied ${currentUser.type} for ${currentUser.nickname}`);
    addLogEntry({
      event: 'turn_started',
      nickname: currentUser.nickname,
      ip: currentUser.ip,
      type: currentUser.type,
      color: currentUser.color,
      movieId: currentUser.movieId,
      movieName: currentUser.movieId !== null ? (knownMovies[currentUser.movieId] || `Effet #${currentUser.movieId}`) : null,
      status: 'success',
      details: 'Tour démarré sur le sapin (2 min)'
    });
  } catch (error) {
    console.error('Error applying lights:', error);
    addLogEntry({
      event: 'error',
      nickname: currentUser.nickname,
      ip: currentUser.ip,
      type: currentUser.type,
      color: currentUser.color,
      movieId: currentUser.movieId,
      status: 'error',
      details: `Erreur Twinkly: ${error.message}`
    });
  }

  // Set timeout to process next user after 2 minutes
  currentTimeout = setTimeout(() => {
    processNextInQueue();
  }, 120000);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Twinkly server is running!' });
});

// Get device information (admin only)
app.get('/api/info', requireAdmin, async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const info = await client.getDeviceDetails();
    try {
      const summary = await client.getSummary();
      if (summary?.group?.size) {
        info.group_leds = summary.group.size;
        info.number_of_led = summary.group.size;
      }
    } catch (_) {}
    info.controllers_count = TWINKLY_IPS.length;
    info.controllers = TWINKLY_IPS;
    res.json(info);
  } catch (error) {
    console.error('Error getting device info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current mode (admin only)
app.get('/api/mode', requireAdmin, async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const mode = await client.getLEDOperationMode();
    res.json(mode);
  } catch (error) {
    console.error('Error getting mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set operation mode (on/off) (admin only)
app.post('/api/mode', requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) {
      return res.status(400).json({ error: 'Mode required' });
    }

    if (mode !== 'rt') {
      stopIdlePlaylist();
      effectRunner.stop();
    }

    await forAllControllers(async (client) => {
      await client.setLEDOperationMode({ mode });
      if (mode === 'movie' || mode === 'color') {
        await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
      }
    });

    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      type: 'mode',
      status: 'success',
      details: `Mode changé vers "${mode}"`
    });

    res.json({ success: true, mode });
  } catch (error) {
    console.error('Error setting mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set solid color (admin only)
app.post('/api/color', requireAdmin, async (req, res) => {
  try {
    const { r, g, b } = req.body;
    if (r === undefined || g === undefined || b === undefined) {
      return res.status(400).json({ error: 'RGB values required' });
    }

    stopIdlePlaylist();
    await applySolidColor({ r, g, b });

    const hex = '#' + [r, g, b].map(v => Number(v).toString(16).padStart(2, '0')).join('');
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      type: 'color',
      color: hex,
      status: 'success',
      details: `Couleur directe appliquée (${hex})`
    });

    res.json({ success: true, color: { r, g, b } });
  } catch (error) {
    console.error('Error setting color:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set brightness (admin only)
app.post('/api/brightness', requireAdmin, async (req, res) => {
  try {
    const { brightness } = req.body;
    if (brightness === undefined) {
      return res.status(400).json({ error: 'Brightness required' });
    }

    const value = Math.max(0, Math.min(100, Number(brightness)));
    await forAllControllers(async (client) => {
      await client.setLEDBrightness({ value, mode: 'enabled', type: 'A' });
    });

    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      type: 'brightness',
      status: 'success',
      details: `Luminosité réglée à ${value}%`
    });

    res.json({ success: true, brightness: value });
  } catch (error) {
    console.error('Error setting brightness:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get brightness (admin only)
app.get('/api/brightness', requireAdmin, async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const brightness = await client.getLEDBrightness();
    res.json(brightness);
  } catch (error) {
    console.error('Error getting brightness:', error);
    res.status(500).json({ error: error.message });
  }
});

// Discover devices on the network (admin only)
app.get('/api/discover', requireAdmin, async (req, res) => {
  try {
    const { discover } = await import('@twinklyjs/twinkly');
    const devices = await discover({ timeout: 5000 });
    res.json({ devices });
  } catch (error) {
    console.error('Error discovering devices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of movies/patterns (public - returns both custom 3D effects and device movies)
app.get('/api/movies', async (req, res) => {
  try {
    let deviceMovies = [];
    try {
      const client = getClient(TWINKLY_IP);
      const moviesData = await client.getMovies();
      if (moviesData && Array.isArray(moviesData.movies)) {
        deviceMovies = moviesData.movies.map(m => {
          const meta = getDeviceMovieMeta(m.name, m.id);
          knownMovies[m.id] = meta.name;
          return {
            ...m,
            name: meta.name,
            source: 'device',
            description: meta.description,
            preview: meta.preview
          };
        });
      }
    } catch (devErr) {
      console.warn('Could not fetch device movies, returning custom effects only:', devErr.message);
    }

    res.json({
      movies: [...CUSTOM_EFFECTS, ...deviceMovies]
    });
  } catch (error) {
    console.error('Error getting movies:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current movie (admin only)
app.get('/api/current-movie', requireAdmin, async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const currentMovie = await client.getCurrentMovie();
    res.json(currentMovie);
  } catch (error) {
    console.error('Error getting current movie:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set current movie or custom effect (admin only)
app.post('/api/current-movie', requireAdmin, async (req, res) => {
  try {
    const { movie_id } = req.body;
    if (movie_id === undefined) {
      return res.status(400).json({ error: 'Movie ID required' });
    }

    stopIdlePlaylist();
    const targetId = (isCustomEffectId(movie_id) || isAiEffectId(movie_id)) ? movie_id : Number(movie_id);
    await applyEffectOrMovie(targetId);

    const movieName = knownMovies[targetId] || `Effet #${targetId}`;
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      type: 'effect',
      movieId: targetId,
      movieName,
      status: 'success',
      details: `Effet direct appliqué: ${movieName}`
    });

    res.json({ success: true, movie_id: targetId });
  } catch (error) {
    console.error('Error setting current movie:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public & Admin AI Effect Generation Endpoints
const aiRateLimitMap = new Map();

function getSortedAiCreations() {
  const list = Array.isArray(usageData.aiCreations) ? [...usageData.aiCreations] : [];
  return list.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1;
    }
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
}

app.get('/api/ai/creations', (req, res) => {
  res.json({
    creations: getSortedAiCreations().slice(0, 20)
  });
});

app.post('/api/ai/generate', async (req, res) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const lastCall = aiRateLimitMap.get(ip) || 0;
    if (Date.now() - lastCall < 2500) {
      return res.status(429).json({
        error: 'Veuillez patienter quelques secondes avant de générer un autre effet.'
      });
    }
    aiRateLimitMap.set(ip, Date.now());

    const { prompt, nickname } = req.body || {};
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim().slice(0, 140) : '';
    if (cleanPrompt.length < 3) {
      return res.status(400).json({ error: 'Veuillez décrire l\'effet souhaité (au moins 3 caractères).' });
    }

    const cleanAuthor = typeof nickname === 'string' && nickname.trim()
      ? nickname.trim().slice(0, 20)
      : 'Voisin';

    const { recipe, source } = await generateEffectWithGeminiOrFallback(cleanPrompt);
    const id = `ai:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    const creation = {
      id,
      name: recipe.name,
      description: recipe.description,
      prompt: cleanPrompt,
      author: cleanAuthor,
      createdAt: new Date().toISOString(),
      pinned: false,
      source,
      recipe
    };

    registerAiRecipe(id, recipe);
    knownMovies[id] = recipe.name;

    if (!Array.isArray(usageData.aiCreations)) {
      usageData.aiCreations = [];
    }
    usageData.aiCreations.unshift(creation);

    // Keep all pinned items + up to 30 most recent unpinned items
    const pinned = usageData.aiCreations.filter(c => c.pinned);
    const unpinned = usageData.aiCreations.filter(c => !c.pinned);
    if (unpinned.length > 30) {
      const removed = unpinned.slice(30);
      for (const r of removed) {
        unregisterAiRecipe(r.id);
      }
    }
    usageData.aiCreations = [...pinned, ...unpinned.slice(0, 30)];
    saveUsageData();

    addLogEntry({
      event: 'ai_generate',
      nickname: cleanAuthor,
      ip,
      type: 'effect',
      movieId: id,
      movieName: recipe.name,
      status: 'info',
      details: `Effet IA généré (${source === 'gemini' ? 'Gemini' : 'Local'}): « ${cleanPrompt} » → ${recipe.name}`
    });

    res.json({
      success: true,
      creation,
      creations: getSortedAiCreations().slice(0, 20)
    });
  } catch (error) {
    console.error('Error generating AI effect:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/ai/config', requireAdmin, (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (typeof apiKey === 'string') {
      usageData.geminiApiKey = apiKey.trim();
      saveUsageData();
      addLogEntry({
        event: 'admin_action',
        nickname: ADMIN_USER,
        ip: req.ip || req.socket?.remoteAddress,
        status: 'info',
        details: usageData.geminiApiKey
          ? 'Clé API Gemini configurée dans l\'interface Admin'
          : 'Clé API Gemini supprimée (mode parseur local actif)'
      });
    }
    const hasEnv = Boolean(process.env.GEMINI_API_KEY);
    const hasAdmin = Boolean(usageData.geminiApiKey);
    res.json({
      success: true,
      hasKey: hasEnv || hasAdmin,
      source: hasAdmin ? 'admin' : (hasEnv ? 'env' : 'fallback')
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/ai/pin', requireAdmin, (req, res) => {
  try {
    const { id } = req.body || {};
    const target = (usageData.aiCreations || []).find(c => c.id === id);
    if (!target) {
      return res.status(404).json({ error: 'Création IA introuvable' });
    }
    target.pinned = !target.pinned;
    saveUsageData();
    res.json({
      success: true,
      creation: target,
      creations: getSortedAiCreations()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/ai/delete', requireAdmin, (req, res) => {
  try {
    const { id } = req.body || {};
    const idx = (usageData.aiCreations || []).findIndex(c => c.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: 'Création IA introuvable' });
    }
    const [removed] = usageData.aiCreations.splice(idx, 1);
    unregisterAiRecipe(removed.id);
    saveUsageData();
    res.json({
      success: true,
      removed,
      creations: getSortedAiCreations()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin statistics & management endpoints
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const turnsLast24h = usageData.logs.filter(
      l => l.event === 'queue_join' && new Date(l.timestamp).getTime() >= oneDayAgo
    ).length;

    const topColors = Object.entries(usageData.colorCounts || {})
      .map(([color, count]) => ({ color, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const topEffects = Object.entries(usageData.movieCounts || {})
      .map(([id, count]) => ({
        movieId: id,
        name: knownMovies[id] || `Effet #${id}`,
        count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    let current = null;
    if (currentUser) {
      const elapsed = now - currentUser.startTime;
      const remaining = Math.max(0, currentUser.duration - elapsed);
      current = {
        ...currentUser,
        movieName: currentUser.movieId !== null ? (knownMovies[currentUser.movieId] || `Effet #${currentUser.movieId}`) : null,
        timeRemaining: remaining
      };
    }

    const playlist = usageData.idlePlaylist || DEFAULT_IDLE_PLAYLIST;
    const schedule = usageData.schedule || DEFAULT_SCHEDULE;

    res.json({
      summary: {
        startedAt: usageData.startedAt,
        totalTurns: usageData.totalTurns,
        colorTurns: usageData.colorTurns,
        effectTurns: usageData.effectTurns,
        uniqueVisitors: (usageData.uniqueIps || []).length,
        turnsLast24h
      },
      topColors,
      topEffects,
      idlePlaylist: {
        enabled: Boolean(playlist.enabled),
        intervalSeconds: Number(playlist.intervalSeconds) || 180,
        effects: Array.isArray(playlist.effects) ? playlist.effects : [],
        active: !currentUser && !isSleepingForNight && Boolean(playlist.enabled) && currentIdleEffectId !== null,
        currentEffectId: currentIdleEffectId,
        currentEffectName: currentIdleEffectId !== null ? (knownMovies[currentIdleEffectId] || `Effet #${currentIdleEffectId}`) : null
      },
      schedule: {
        enabled: Boolean(schedule.enabled),
        onTime: schedule.onTime || '16:30',
        offTime: schedule.offTime || '23:00',
        sleeping: isSleepingForNight,
        serverTime: getCurrentTimeHHMM(),
        timezone: SCHEDULE_TIMEZONE
      },
      aiConfig: {
        hasKey: Boolean(usageData.geminiApiKey || process.env.GEMINI_API_KEY),
        source: usageData.geminiApiKey ? 'admin' : (process.env.GEMINI_API_KEY ? 'env' : 'fallback'),
        creations: getSortedAiCreations()
      },
      queueState: {
        paused: queuePaused,
        current,
        queue: queue.map((item, index) => ({
          ...item,
          position: index + 1,
          movieName: item.movieId !== null ? (knownMovies[item.movieId] || `Effet #${item.movieId}`) : null
        }))
      },
      logs: usageData.logs.slice(0, 150)
    });
  } catch (error) {
    console.error('Error getting admin stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Configure Automatic On/Off Night Schedule (admin only)
app.post('/api/admin/schedule', requireAdmin, async (req, res) => {
  try {
    const { enabled, onTime, offTime } = req.body || {};

    const cleanEnabled = typeof enabled === 'boolean'
      ? enabled
      : Boolean(usageData.schedule?.enabled);

    const cleanOnTime = TIME_HHMM_REGEX.test(String(onTime || ''))
      ? String(onTime)
      : (usageData.schedule?.onTime || '16:30');

    const cleanOffTime = TIME_HHMM_REGEX.test(String(offTime || ''))
      ? String(offTime)
      : (usageData.schedule?.offTime || '23:00');

    usageData.schedule = {
      enabled: cleanEnabled,
      onTime: cleanOnTime,
      offTime: cleanOffTime
    };
    saveUsageData();

    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: `Horaire automatique mis à jour (${cleanEnabled ? `Activé : ${cleanOnTime} → ${cleanOffTime}` : 'Désactivé'})`
    });

    await evaluateScheduleState(true);

    res.json({
      success: true,
      schedule: {
        ...usageData.schedule,
        sleeping: isSleepingForNight,
        serverTime: getCurrentTimeHHMM()
      }
    });
  } catch (error) {
    console.error('Error saving schedule:', error);
    res.status(500).json({ error: error.message });
  }
});

// Configure Idle Playlist (admin only)
app.post('/api/admin/playlist', requireAdmin, async (req, res) => {
  try {
    const { enabled, intervalSeconds, effects } = req.body || {};

    const cleanEnabled = typeof enabled === 'boolean'
      ? enabled
      : Boolean(usageData.idlePlaylist?.enabled);

    const parsedInterval = Number(intervalSeconds);
    const cleanInterval = Number.isFinite(parsedInterval)
      ? Math.max(15, Math.min(3600, Math.round(parsedInterval)))
      : (usageData.idlePlaylist?.intervalSeconds || 180);

    let cleanEffects = Array.isArray(usageData.idlePlaylist?.effects)
      ? [...usageData.idlePlaylist.effects]
      : [...DEFAULT_IDLE_PLAYLIST.effects];

    if (Array.isArray(effects)) {
      cleanEffects = [];
      const seen = new Set();
      for (const rawId of effects) {
        if (isCustomEffectId(rawId) || isAiEffectId(rawId)) {
          if (!seen.has(rawId)) {
            seen.add(rawId);
            cleanEffects.push(rawId);
          }
        } else {
          const numId = Number(rawId);
          if (Number.isInteger(numId) && numId >= 0 && !seen.has(numId)) {
            seen.add(numId);
            cleanEffects.push(numId);
          }
        }
      }
    }

    usageData.idlePlaylist = {
      enabled: cleanEnabled,
      intervalSeconds: cleanInterval,
      effects: cleanEffects
    };
    saveUsageData();

    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: `Playlist veille mise à jour (${cleanEnabled ? 'Activée' : 'Désactivée'}, ${cleanEffects.length} effet(s), cycle ${cleanInterval}s)`
    });

    if (!currentUser && queue.length === 0) {
      idlePlaylistIndex = 0;
      await startIdlePlaylist();
    }

    res.json({
      success: true,
      idlePlaylist: usageData.idlePlaylist
    });
  } catch (error) {
    console.error('Error saving idle playlist:', error);
    res.status(500).json({ error: error.message });
  }
});

// Advance to next effect in Idle Playlist immediately (admin only)
app.post('/api/admin/playlist/next', requireAdmin, async (req, res) => {
  try {
    if (currentUser) {
      return res.status(400).json({ error: 'Un utilisateur contrôle actuellement le sapin.' });
    }
    await startIdlePlaylist();
    const effectName = currentIdleEffectId !== null ? (knownMovies[currentIdleEffectId] || `Effet #${currentIdleEffectId}`) : 'Aucun';
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: `Playlist veille : passage à "${effectName}"`
    });
    res.json({
      success: true,
      currentEffectId: currentIdleEffectId,
      currentEffectName: effectName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/queue/skip', requireAdmin, async (req, res) => {
  try {
    const skippedUser = currentUser ? currentUser.nickname : null;
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: skippedUser ? `Tour de "${skippedUser}" passé par l'admin` : 'Passage au suivant demandé'
    });
    await processNextInQueue();
    res.json({ success: true, skipped: skippedUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/queue/remove', requireAdmin, (req, res) => {
  try {
    const { joinedAt } = req.body || {};
    const index = queue.findIndex(item => item.joinedAt === Number(joinedAt));
    if (index === -1) {
      return res.status(404).json({ error: 'Élément introuvable dans la file' });
    }
    const [removed] = queue.splice(index, 1);
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: `"${removed.nickname}" retiré de la file d'attente`
    });
    res.json({ success: true, removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/queue/clear', requireAdmin, async (req, res) => {
  try {
    const count = queue.length;
    queue = [];
    if (req.body?.stopCurrent) {
      await processNextInQueue();
    }
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: `File d'attente vidée (${count} en attente supprimé(s))`
    });
    res.json({ success: true, cleared: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/queue/pause', requireAdmin, (req, res) => {
  try {
    queuePaused = typeof req.body?.paused === 'boolean' ? req.body.paused : !queuePaused;
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: queuePaused ? 'File d\'attente mise en pause' : 'File d\'attente réactivée'
    });
    res.json({ success: true, paused: queuePaused });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/logs/clear', requireAdmin, (req, res) => {
  try {
    usageData.logs = [];
    saveUsageData();
    addLogEntry({
      event: 'admin_action',
      nickname: ADMIN_USER,
      ip: req.ip || req.socket?.remoteAddress,
      status: 'info',
      details: 'Journal d\'activité effacé'
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Queue endpoints
app.post('/api/queue/join', async (req, res) => {
  try {
    if (isSleepingForNight) {
      const onTime = usageData.schedule?.onTime || '16:30';
      return res.status(403).json({
        error: `🌙 Le sapin se repose pour la nuit ! Il se rallumera automatiquement à ${onTime}.`
      });
    }

    if (queuePaused) {
      return res.status(403).json({ error: 'La file d\'attente est temporairement fermée par l\'administrateur.' });
    }

    const { nickname, type, color, movieId } = req.body || {};
    const ip = req.ip || req.socket?.remoteAddress;

    const cleanNickname = typeof nickname === 'string'
      ? nickname.trim().slice(0, 20)
      : '';

    if (!cleanNickname || !type) {
      return res.status(400).json({ error: 'Le surnom et le type sont requis' });
    }

    if (type !== 'color' && type !== 'effect') {
      return res.status(400).json({ error: 'Type de contrôle invalide' });
    }

    if (type === 'color') {
      if (typeof color !== 'string' || !HEX_COLOR_REGEX.test(color)) {
        return res.status(400).json({ error: 'Couleur hexadécimale invalide (ex: #ff0000)' });
      }
    }

    let validatedMovieId = null;
    if (type === 'effect') {
      if (isCustomEffectId(movieId) || isAiEffectId(movieId)) {
        validatedMovieId = movieId;
      } else {
        const parsedMovieId = Number(movieId);
        if (movieId === undefined || movieId === null || !Number.isInteger(parsedMovieId) || parsedMovieId < 0) {
          return res.status(400).json({ error: 'Veuillez sélectionner un effet valide' });
        }
        validatedMovieId = parsedMovieId;
      }
    }

    // Check if user already in queue
    const existingIndex = queue.findIndex(item => item.ip === ip);
    if (existingIndex !== -1) {
      return res.status(400).json({ error: 'Vous êtes déjà dans la file d\'attente!' });
    }

    // Check if user is currently playing
    if (currentUser && currentUser.ip === ip) {
      return res.status(400).json({ error: 'Vous contrôlez actuellement les lumières!' });
    }

    const normalizedColor = type === 'color' ? color.toLowerCase() : null;
    const queueItem = {
      nickname: cleanNickname,
      type,
      color: normalizedColor,
      movieId: validatedMovieId,
      ip,
      joinedAt: Date.now()
    };

    queue.push(queueItem);

    recordQueueTurn(queueItem);
    addLogEntry({
      event: 'queue_join',
      nickname: queueItem.nickname,
      ip: queueItem.ip,
      type: queueItem.type,
      color: queueItem.color,
      movieId: queueItem.movieId,
      movieName: queueItem.movieId !== null ? (knownMovies[queueItem.movieId] || `Effet #${queueItem.movieId}`) : null,
      status: 'info',
      details: `A rejoint la file (position ${queue.length})`
    });

    // If no one is currently playing, start immediately
    if (!currentUser) {
      processNextInQueue();
    }

    res.json({
      success: true,
      position: queue.length,
      message: 'Ajouté à la file avec succès'
    });
  } catch (error) {
    console.error('Error joining queue:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/queue/status', (req, res) => {
  try {
    let current = null;

    if (currentUser) {
      const elapsed = Date.now() - currentUser.startTime;
      const remaining = Math.max(0, currentUser.duration - elapsed);

      current = {
        nickname: currentUser.nickname,
        type: currentUser.type,
        color: currentUser.color,
        movieId: currentUser.movieId,
        movieName: currentUser.movieId !== null ? (knownMovies[currentUser.movieId] || null) : null,
        timeRemaining: remaining
      };
    }

    const schedule = usageData.schedule || DEFAULT_SCHEDULE;

    res.json({
      paused: queuePaused,
      sleeping: isSleepingForNight,
      schedule: {
        enabled: Boolean(schedule.enabled),
        onTime: schedule.onTime || '16:30',
        offTime: schedule.offTime || '23:00'
      },
      current,
      idleEffect: (!current && !isSleepingForNight && currentIdleEffectId !== null)
        ? {
            movieId: currentIdleEffectId,
            movieName: knownMovies[currentIdleEffectId] || null
          }
        : null,
      queue: queue.map(item => ({
        nickname: item.nickname,
        type: item.type,
        color: item.color,
        movieId: item.movieId,
        movieName: item.movieId !== null ? (knownMovies[item.movieId] || null) : null
      }))
    });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🎄 Serveur Twinkly en cours d'exécution sur http://localhost:${PORT}`);
  console.log(`Contrôleurs Twinkly (${TWINKLY_IPS.length}): ${TWINKLY_IPS.join(', ')}`);
  console.log(`Tableau de bord Admin: http://localhost:${PORT}/admin`);
  console.log(`API disponible à http://localhost:${PORT}/api`);

  // Evaluate schedule and start idle playlist shortly after boot
  setTimeout(async () => {
    await evaluateScheduleState(true);
  }, 1500);

  // Check night/day schedule every 20 seconds
  setInterval(() => {
    evaluateScheduleState(false).catch(err => console.error('Schedule check error:', err.message));
  }, 20000);
});
