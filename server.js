import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import healthRouter from './routes/health.js';
import garminRouter from './routes/garmin.js';
import { authenticateRequest } from './middleware/auth.js';
import { startGarminCron } from './lib/garminCron.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Trust proxy - required for rate limiting behind reverse proxies (Render, Heroku, etc.)
app.set('trust proxy', 1);

// CORS configuration (allow local dev origins + .env overrides)
// The dashboard is normally served by this service, so same-origin requests
// need no entry here. These cover opening the page from somewhere else.
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'https://garmin-sync-75yx.onrender.com',
  'https://www.semantix.co.il',
  'https://semantix-ai.com',
  'https://www.semantix-ai.com'
];

const envAllowed = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || [];
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowed])];

console.log('🔒 CORS allowed origins:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (non-browser requests like curl, server-to-server)
    if (!origin) return callback(null, true);

    const isAllowed = allowedOrigins.includes(origin) ||
                      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

    if (!isAllowed) console.warn(`✗ CORS: Blocking origin: ${origin}`);
    return callback(null, isAllowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Security middleware (applied after CORS to avoid conflicts)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`📨 [${new Date().toISOString()}] ${req.method} ${req.path} | origin: ${req.headers.origin || 'N/A'} | key: ${req.headers['x-api-key'] ? 'present' : 'missing'}`);
  next();
});

// The dashboard — a single self-contained page that asks the operator for their
// own API key, so serving the page itself needs no auth. It carries its markup,
// styles and script inline (it is also meant to be openable straight from disk),
// so this one response relaxes helmet's CSP to allow them.
const sendDashboard = (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src *"
  );
  res.sendFile(path.join(__dirname, 'garmin-dashboard.html'));
};
app.get('/', sendDashboard);
app.get('/garmin', sendDashboard);

// Public: health check, used by the host's health probe
app.use('/health', healthRouter);

// Protected: everything that touches a catalog requires the store's API key
app.use('/api/garmin', authenticateRequest, garminRouter);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`⌚ Garmin sync service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  startGarminCron();
});
