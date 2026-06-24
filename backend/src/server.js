'use strict';
/* =========================================================
   SERVER — bootstrap de Express para el backend de CipherCube.
   Orden importante: los webhooks (cuerpo crudo) van ANTES de express.json().
   ========================================================= */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import profileRoutes from './routes/profile.routes.js';
import plansRoutes from './routes/plans.routes.js';
import paymentsRoutes from './routes/payments.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';

const app = express();
app.set('trust proxy', 1); // detrás de Nginx/Caddy en el VPS

app.use(helmet());
app.use(cors({
  origin(origin, cb){
    // Permite herramientas sin origin (curl/healthchecks) y los orígenes whitelisteados.
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
  credentials: true,
}));

// Salud (para el balanceador/uptime del VPS).
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Webhooks ANTES del parser JSON (Stripe necesita el raw body).
app.use('/api/payments/webhook', webhookRoutes);

// A partir de aquí, JSON normal.
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/payments', paymentsRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`[server] CipherCube backend escuchando en :${config.port} (${config.isProd ? 'producción' : 'desarrollo'})`);
});
