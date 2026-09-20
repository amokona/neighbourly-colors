import express from 'express';
import cors from 'cors';
import { TwinklyClient, discover } from '@twinklyjs/twinkly';

const app = express();
const PORT = process.env.PORT || 3000;
const TWINKLY_IP = process.env.TWINKLY_IP || 'fallback';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Store client instances by IP
const clients = new Map();

// Queue system
let queue = [];
let currentUser = null;
let currentTimeout = null;

// Get or create a Twinkly client for a given IP
function getClient(ip) {
  if (!clients.has(ip)) {
    clients.set(ip, new TwinklyClient({ ip }));
  }
  return clients.get(ip);
}

// Process next person in queue
async function processNextInQueue() {
  if (queue.length === 0) {
    currentUser = null;
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
      const hex = currentUser.color.replace('#', '');
      const r = parseInt(hex.substr(0, 2), 16);
      const g = parseInt(hex.substr(2, 2), 16);
      const b = parseInt(hex.substr(4, 2), 16);
      
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

// Get device information
app.get('/api/info', async (req, res) => {
  try {
    const ip = req.query.ip || TWINKLY_IP; // Use hardcoded IP if not provided

    const client = getClient(ip);
    const info = await client.getDeviceDetails();
    res.json(info);
  } catch (error) {
    console.error('Error getting device info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current mode
app.get('/api/mode', async (req, res) => {
  try {
    const ip = req.query.ip || TWINKLY_IP;

    const client = getClient(ip);
    const mode = await client.getLEDOperationMode();
    res.json(mode);
  } catch (error) {
    console.error('Error getting mode:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set operation mode (on/off)
app.post('/api/mode', async (req, res) => {
  try {
    const ip = req.body.ip || TWINKLY_IP;
    const { mode } = req.body;
    if (!mode) {
      return res.status(400).json({ error: 'Mode required' });
    }

    const client = getClient(ip);
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

// Set solid color
app.post('/api/color', async (req, res) => {
  try {
    const ip = req.body.ip || TWINKLY_IP;
    const { r, g, b } = req.body;
    if (r === undefined || g === undefined || b === undefined) {
      return res.status(400).json({ error: 'RGB values required' });
    }

    const client = getClient(ip);
    
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

// Set brightness
app.post('/api/brightness', async (req, res) => {
  try {
    const ip = req.body.ip || TWINKLY_IP;
    const { brightness } = req.body;
    if (brightness === undefined) {
      return res.status(400).json({ error: 'Brightness required' });
    }

    const client = getClient(ip);
    await client.setLEDBrightness({ value: brightness, mode: 'enabled', type: 'A' });
    res.json({ success: true, brightness });
  } catch (error) {
    console.error('Error setting brightness:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get brightness
app.get('/api/brightness', async (req, res) => {
  try {
    const ip = req.query.ip || TWINKLY_IP;

    const client = getClient(ip);
    const brightness = await client.getLEDBrightness();
    res.json(brightness);
  } catch (error) {
    console.error('Error getting brightness:', error);
    res.status(500).json({ error: error.message });
  }
});

// Discover devices on the network
app.get('/api/discover', async (req, res) => {
  try {
    const devices = await discover({ timeout: 5000 });
    res.json({ devices });
  } catch (error) {
    console.error('Error discovering devices:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of movies/patterns
app.get('/api/movies', async (req, res) => {
  try {
    const ip = req.query.ip || TWINKLY_IP;

    const client = getClient(ip);
    const movies = await client.getMovies();
    res.json(movies);
  } catch (error) {
    console.error('Error getting movies:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current movie
app.get('/api/current-movie', async (req, res) => {
  try {
    const ip = req.query.ip || TWINKLY_IP;

    const client = getClient(ip);
    const currentMovie = await client.getCurrentMovie();
    res.json(currentMovie);
  } catch (error) {
    console.error('Error getting current movie:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set current movie
app.post('/api/current-movie', async (req, res) => {
  try {
    const ip = req.body.ip || TWINKLY_IP;
    const { movie_id } = req.body;
    if (movie_id === undefined) {
      return res.status(400).json({ error: 'Movie ID required' });
    }

    const client = getClient(ip);
    
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
    const { nickname, type, color, movieId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    if (!nickname || !type) {
      return res.status(400).json({ error: 'Le surnom et le type sont requis' });
    }
    
    if (type === 'color' && !color) {
      return res.status(400).json({ error: 'La couleur est requise pour le type couleur' });
    }
    
    if (type === 'effect' && movieId === undefined) {
      return res.status(400).json({ error: 'L\'ID de l\'effet est requis pour le type effet' });
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
      nickname,
      type,
      color: type === 'color' ? color : null,
      movieId: type === 'effect' ? movieId : null,
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
  console.log(`� Serveur Twinkly en cours d'exécution sur http://localhost:${PORT}`);
  console.log(`API disponible à http://localhost:${PORT}/api`);
  console.log(`\nSystème de File d'Attente Actif!`);
  console.log(`- Les utilisateurs peuvent rejoindre la file pour contrôler les lumières pendant 2 minutes`);
  console.log(`- Chaque utilisateur est identifié par son adresse IP`);
  console.log(`\nPoints d'accès disponibles:`);
  console.log(`- GET  /api/health`);
  console.log(`- GET  /api/info?ip=<IP>`);
  console.log(`- GET  /api/mode?ip=<IP>`);
  console.log(`- POST /api/mode (body: {ip, mode})`);
  console.log(`- POST /api/color (body: {ip, r, g, b})`);
  console.log(`- POST /api/brightness (body: {ip, brightness})`);
  console.log(`- GET  /api/movies?ip=<IP>`);
  console.log(`- GET  /api/current-movie?ip=<IP>`);
  console.log(`- POST /api/current-movie (body: {ip, movie_id})`);
  console.log(`- POST /api/queue/join (body: {nickname, type, color?, movieId?})`);
  console.log(`- GET  /api/queue/status`);
  console.log(`- GET  /api/discover`);
  console.log(`\nTestez le point d'accès de santé: http://localhost:${PORT}/api/health`);
});
