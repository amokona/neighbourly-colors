import express from 'express';
import cors from 'cors';
import { getClient } from './client.js';

const app = express();
const PORT = process.env.PORT || 3000;
const TWINKLY_IP = process.env.TWINKLY_IP || 'fallback';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DEFAULT_MOVIE_ID = process.env.DEFAULT_MOVIE_ID !== undefined && process.env.DEFAULT_MOVIE_ID !== ''
  ? Number(process.env.DEFAULT_MOVIE_ID)
  : null;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

// Trust first reverse proxy so req.ip reflects the real client IP safely
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Middleware to protect direct device-control endpoints from public queue bypass
function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const headerToken = req.headers['x-admin-token'] || bearerToken;
    if (headerToken === ADMIN_TOKEN) {
      return next();
    }
    return res.status(403).json({ error: 'Accès non autorisé' });
  }

  // If no ADMIN_TOKEN is configured, only allow direct control from localhost
  const isForwarded = Boolean(req.headers['x-forwarded-for']);
  const remote = req.socket?.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isForwarded && isLoopback) {
    return next();
  }

  return res.status(403).json({ error: 'Accès direct désactivé. Veuillez utiliser la file d\'attente.' });
}

// Queue system
let queue = [];
let currentUser = null;
let currentTimeout = null;

// Process next person in queue
async function processNextInQueue() {
  if (queue.length === 0) {
    currentUser = null;
    currentTimeout = null;

    if (DEFAULT_MOVIE_ID !== null && !Number.isNaN(DEFAULT_MOVIE_ID)) {
      try {
        const client = getClient(TWINKLY_IP);
        await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
        await client.setCurrentMovie({ id: DEFAULT_MOVIE_ID });
        await client.setLEDOperationMode({ mode: 'movie' });
        console.log(`Queue empty: reverted to default movie ${DEFAULT_MOVIE_ID}`);
      } catch (error) {
        console.error('Error reverting to default movie:', error);
      }
    }
    return;
  }

  currentUser = queue.shift();
  currentUser.startTime = Date.now();
  currentUser.duration = 120000; // 2 minutes in milliseconds

  console.log(`Processing queue item for ${currentUser.nickname}`);

  try {
    const client = getClient(TWINKLY_IP);

    if (currentUser.type === 'color') {
      // Convert hex to RGB
      const hex = currentUser.color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);

      await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
      await client.setLEDOperationMode({ mode: 'color' });
      await client.setLEDColor({ r, g, b });
    } else {
      // Effect/movie
      await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
      await client.setCurrentMovie({ id: currentUser.movieId });
      await client.setLEDOperationMode({ mode: 'movie' });
    }

    console.log(`Applied ${currentUser.type} for ${currentUser.nickname}`);
  } catch (error) {
    console.error('Error applying lights:', error);
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

// Get device information (admin/local only)
app.get('/api/info', requireAdmin, async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const info = await client.getDeviceDetails();
    res.json(info);
  } catch (error) {
    console.error('Error getting device info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current mode (admin/local only)
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

// Set operation mode (on/off) (admin/local only)
app.post('/api/mode', requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body;
    if (!mode) {
      return res.status(400).json({ error: 'Mode required' });
    }

    const client = getClient(TWINKLY_IP);
    await client.setLEDOperationMode({ mode });

    // Always set brightness to 100% when turning on
    if (mode === 'movie' || mode === 'color') {
      await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });
    }

    res.json({ success: true, mode });
  } catch (error) {
    console.error('Error setting mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set solid color (admin/local only)
app.post('/api/color', requireAdmin, async (req, res) => {
  try {
    const { r, g, b } = req.body;
    if (r === undefined || g === undefined || b === undefined) {
      return res.status(400).json({ error: 'RGB values required' });
    }

    const client = getClient(TWINKLY_IP);

    // Set brightness to 100%
    await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });

    // Set mode to color
    await client.setLEDOperationMode({ mode: 'color' });

    // Then set the color
    await client.setLEDColor({ r, g, b });

    res.json({ success: true, color: { r, g, b } });
  } catch (error) {
    console.error('Error setting color:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set brightness (admin/local only)
app.post('/api/brightness', requireAdmin, async (req, res) => {
  try {
    const { brightness } = req.body;
    if (brightness === undefined) {
      return res.status(400).json({ error: 'Brightness required' });
    }

    const client = getClient(TWINKLY_IP);
    await client.setLEDBrightness({ value: brightness, mode: 'enabled', type: 'A' });
    res.json({ success: true, brightness });
  } catch (error) {
    console.error('Error setting brightness:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get brightness (admin/local only)
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

// Discover devices on the network (admin/local only)
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

// Get list of movies/patterns (public - needed by queue UI)
app.get('/api/movies', async (req, res) => {
  try {
    const client = getClient(TWINKLY_IP);
    const movies = await client.getMovies();
    res.json(movies);
  } catch (error) {
    console.error('Error getting movies:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current movie (admin/local only)
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

// Set current movie (admin/local only)
app.post('/api/current-movie', requireAdmin, async (req, res) => {
  try {
    const { movie_id } = req.body;
    if (movie_id === undefined) {
      return res.status(400).json({ error: 'Movie ID required' });
    }

    const client = getClient(TWINKLY_IP);

    // Set brightness to 100%
    await client.setLEDBrightness({ value: 100, mode: 'enabled', type: 'A' });

    // Set the movie
    await client.setCurrentMovie({ id: movie_id });

    // Set mode to movie so it plays
    await client.setLEDOperationMode({ mode: 'movie' });

    res.json({ success: true, movie_id });
  } catch (error) {
    console.error('Error setting current movie:', error);
    res.status(500).json({ error: error.message });
  }
});

// Queue endpoints
app.post('/api/queue/join', async (req, res) => {
  try {
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

    const parsedMovieId = type === 'effect' ? Number(movieId) : null;
    if (type === 'effect') {
      if (movieId === undefined || movieId === null || !Number.isInteger(parsedMovieId) || parsedMovieId < 0) {
        return res.status(400).json({ error: 'L\'ID de l\'effet est requis et doit être un entier valide' });
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

    const queueItem = {
      nickname: cleanNickname,
      type,
      color: type === 'color' ? color.toLowerCase() : null,
      movieId: type === 'effect' ? parsedMovieId : null,
      ip,
      joinedAt: Date.now()
    };

    queue.push(queueItem);

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
        timeRemaining: remaining
      };
    }

    res.json({
      current,
      queue: queue.map(item => ({
        nickname: item.nickname,
        type: item.type,
        color: item.color,
        movieId: item.movieId
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
  console.log(`API disponible à http://localhost:${PORT}/api`);
  console.log(`\nSystème de File d'Attente Actif!`);
  console.log(`- Les utilisateurs peuvent rejoindre la file pour contrôler les lumières pendant 2 minutes`);
  console.log(`- Chaque utilisateur est identifié par son adresse IP`);
  console.log(`\nPoints d'accès publics:`);
  console.log(`- GET  /api/health`);
  console.log(`- GET  /api/movies`);
  console.log(`- POST /api/queue/join (body: {nickname, type, color?, movieId?})`);
  console.log(`- GET  /api/queue/status`);
  console.log(`\nTestez le point d'accès de santé: http://localhost:${PORT}/api/health`);
});
