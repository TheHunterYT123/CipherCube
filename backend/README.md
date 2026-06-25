# CipherCube — Backend

API de cuentas, perfiles, planes y pagos para CipherCube.
**Stack:** Node.js (Express) + PostgreSQL + JWT + bcrypt. Pagos con **Stripe**, **PayPal** y **MercadoPago**.

El frontend (la PWA en la raíz del repo) sigue siendo 100% estático y cifra todo en el navegador.
Este backend **no toca tus secretos ni tu frase maestra**: solo gestiona cuentas, planes y cobros.

---

## 1. Requisitos

- **Node.js 20+** (probado en 24).
- **PostgreSQL 13+** (local o gestionado: Railway, Supabase, RDS, etc.).
- Cuentas en los proveedores de pago que quieras activar (Stripe / PayPal / MercadoPago).

## 2. Puesta en marcha (desarrollo)

```bash
cd backend
npm install
cp .env.example .env        # y rellena los valores (ver sección 4)
# Crea la base de datos en Postgres (una vez):
#   createdb ciphercube     (o créala desde tu cliente SQL)
npm run migrate             # crea tablas + siembra los planes
npm run dev                 # arranca en http://localhost:4000 (auto-reload)
```

Comprueba que vive:

```bash
curl http://localhost:4000/health        # -> {"ok":true,...}
curl http://localhost:4000/api/plans     # -> catálogo de planes + proveedores activos
```

## 3. Conectar el frontend

En `index.html` (raíz del repo), antes de `<script type="module" src="js/app.js">`, añade:

```html
<script>window.CIPHERCUBE_API_BASE = 'http://localhost:4000';</script>
```

En producción cámbialo por tu dominio de API, p. ej. `https://api.ciphercube.app`.
Si no lo defines, el frontend usa `http://localhost:4000` por defecto. Si el backend no responde,
la app sigue funcionando en modo gratuito (sin sesión) sin romperse.

## 4. Variables de entorno

Todas están documentadas en [`.env.example`](.env.example). Las imprescindibles:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL. **Si la dejas vacía se usa SQLite** (solo desarrollo). |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Firma de tokens (genera 2 distintos y largos) |
| `CORS_ORIGINS` | Dominios del frontend permitidos |
| `FRONTEND_URL`, `PUBLIC_BACKEND_URL` | Redirecciones de pago y webhooks |
| `ADMIN_EMAILS` | Correos que se promueven a admin del panel al registrarse |
| `SMTP_*`, `REQUIRE_EMAIL_VERIFICATION` | Envío del correo de verificación (opcional) |

### Base de datos: SQLite (dev) vs PostgreSQL (producción)

El backend tiene **driver dual**: usa PostgreSQL si defines `DATABASE_URL` (o `PGHOST`),
y SQLite en caso contrario. SQLite vale para desarrollo local, pero **en producción usa
PostgreSQL** (concurrencia, replicación y backups). `npm run migrate` aplica el esquema
correcto según el driver activo (`schema.sql` o `schema.pg.sql`).

### Administrador del panel

Marca una cuenta como admin (debe existir):

```bash
npm run grant-admin correo@dominio.com          # conceder
npm run grant-admin correo@dominio.com --revoke  # revocar
```

Genera secretos seguros:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 5. Configurar los pagos

Los precios se definen en `.env` (`PRICE_PLUS_USD`, `PRICE_BOVEDA_MXN`, …).
El backend solo ofrece al frontend los proveedores que estén configurados.

### Stripe
1. Crea **Products → Prices** (uno por plan) y copia los `price_...` a `STRIPE_PRICE_PLUS` / `STRIPE_PRICE_BOVEDA`.
2. `STRIPE_SECRET_KEY` desde *Developers → API keys*.
3. Webhook: *Developers → Webhooks → Add endpoint*
   - URL: `https://TU_BACKEND/api/payments/webhook/stripe`
   - Evento: `checkout.session.completed`
   - Copia el *Signing secret* a `STRIPE_WEBHOOK_SECRET`.

### PayPal
1. *developer.paypal.com → Apps & Credentials* → copia `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`.
2. `PAYPAL_ENV=sandbox` para pruebas, `live` en producción.
3. No necesita webhook: el frontend captura la orden al volver (`/api/payments/paypal/capture`).

### MercadoPago
1. *Tus integraciones → Credenciales* → copia `MERCADOPAGO_ACCESS_TOKEN`.
2. El webhook se registra solo en cada preferencia (`notification_url` apunta a
   `https://TU_BACKEND/api/payments/webhook/mercadopago`). Asegúrate de que `PUBLIC_BACKEND_URL` sea correcto.

> **Importante:** los webhooks necesitan que el backend sea accesible públicamente por HTTPS.
> En desarrollo usa [Stripe CLI](https://stripe.com/docs/stripe-cli) (`stripe listen --forward-to ...`)
> o un túnel (ngrok/cloudflared) para recibirlos.

## 6. Despliegue en VPS (producción)

Ejemplo con Ubuntu + Nginx + PM2:

```bash
# En el VPS
sudo apt update && sudo apt install -y nginx postgresql
# Instala Node 20+ (nvm o nodesource).
git clone <tu-repo> && cd CipherCube/backend
npm ci
cp .env.example .env   # rellena con valores de PRODUCCIÓN (NODE_ENV=production)
npm run migrate
npm i -g pm2
pm2 start src/server.js --name ciphercube-api
pm2 save && pm2 startup
```

Reverse proxy con Nginx (`/etc/nginx/sites-available/ciphercube-api`):

```nginx
server {
  server_name api.tudominio.com;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ciphercube-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.tudominio.com   # HTTPS automático
```

El frontend estático (raíz del repo) puede servirse en otro dominio (Netlify, Vercel, Nginx)
apuntando `CIPHERCUBE_API_BASE` a `https://api.tudominio.com`.

## 7. Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/health` | — | Estado del servicio |
| POST | `/api/auth/register` | — | Crear cuenta |
| POST | `/api/auth/login` | — | Iniciar sesión |
| POST | `/api/auth/refresh` | — | Renovar access token |
| POST | `/api/auth/logout` | — | Revocar refresh token |
| GET | `/api/auth/me` | ✓ | Usuario actual |
| GET | `/api/profile` | ✓ | Ver perfil |
| PATCH | `/api/profile` | ✓ | Editar perfil |
| POST | `/api/profile/change-password` | ✓ | Cambiar contraseña |
| GET | `/api/plans` | — | Catálogo de planes + proveedores activos |
| POST | `/api/payments/checkout` | ✓ | Iniciar compra (devuelve URL del proveedor) |
| POST | `/api/payments/paypal/capture` | ✓ | Capturar orden de PayPal |
| POST | `/api/payments/webhook/stripe` | firma | Webhook de Stripe |
| POST | `/api/payments/webhook/mercadopago` | — | Webhook de MercadoPago |

## 8. Seguridad

- Contraseñas con **bcrypt** (coste 12). Nunca se guardan en claro.
- **JWT access** corto (15 min) con el plan firmado por el servidor → el cliente
  no puede falsificar un plan superior editando `localStorage`.
- **Refresh tokens** guardados *hasheados* y revocables (logout y cambio de contraseña).
- `helmet`, CORS por lista blanca, **rate limiting** en auth, validación con `zod`,
  consultas **parametrizadas** (sin SQL injection).
- Webhooks **idempotentes** (tabla `webhook_events`) para no acreditar dos veces.
- El plan se concede **solo desde el servidor** tras confirmación del proveedor.

### Límite conocido (cifrado en el cliente)
CipherCube cifra en el navegador. El backend protege cuentas, pagos y permisos de forma
robusta, pero las funciones de cifrado viven en el cliente: un usuario técnico podría
invocarlas por su cuenta sin pagar. Para *enforcement* total habría que mover la generación
premium al servidor (rompiendo el modelo "sin servidores"). Hoy el gating es:
**servidor = fuente de verdad de cuentas/planes/cobros**, con tokens firmados no falsificables.
