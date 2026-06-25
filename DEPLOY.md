# Guía de despliegue de CipherCube

Cómo poner CipherCube en producción de forma **segura**: PostgreSQL gestionado,
backend con PM2 (o systemd), Nginx como proxy inverso, HTTPS con Let's Encrypt,
backups, monitoreo y un checklist final.

> Arquitectura objetivo
>
> ```
>  Navegador ──HTTPS──> Nginx ──┬── /            → frontend estático (index.html, js/, css/)
>  (usuario)                    └── /api, /health → proxy a backend Node (127.0.0.1:4000)
>                                              │
>                                              └──> PostgreSQL gestionado (TLS)
> ```
>
> Dominios sugeridos: `ciphercube.app` (frontend) y `api.ciphercube.app` (backend).
> También puedes servir todo desde un solo dominio (frontend en `/`, backend en `/api`).

---

## 0. Requisitos

- Un **VPS** con Ubuntu 22.04+ (DigitalOcean, Hetzner, Linode, etc.), acceso `ssh` y `sudo`.
- Un **dominio** apuntando al VPS (registros DNS `A` para `ciphercube.app` y `api.ciphercube.app`).
- **PostgreSQL** (recomendado: gestionado — Supabase, Neon, RDS, DigitalOcean Managed DB).
- Node.js 20+ en el VPS.

```bash
# En el VPS, instalar Node 20 + herramientas
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm install -g pm2
```

---

## 1. PostgreSQL

### Opción A — Base de datos gestionada (recomendado)
1. Crea una instancia PostgreSQL en tu proveedor.
2. Crea una base de datos `ciphercube` y un usuario con contraseña fuerte.
3. Copia la **cadena de conexión** (suele exigir SSL): `postgres://usuario:clave@host:5432/ciphercube?sslmode=require`.
4. Activa **backups automáticos** y, si el plan lo permite, una **réplica de lectura** (redundancia).

### Opción B — PostgreSQL en el propio VPS (más mantenimiento)
```bash
sudo apt-get install -y postgresql
sudo -u postgres psql -c "CREATE USER ciphercube WITH PASSWORD 'PON_UNA_CLAVE_FUERTE';"
sudo -u postgres psql -c "CREATE DATABASE ciphercube OWNER ciphercube;"
```
Si eliges esta opción, configura tú mismo los backups (ver §6).

> El backend detecta PostgreSQL automáticamente en cuanto defines `DATABASE_URL`
> (o `PGHOST`). Sin esas variables usaría SQLite, que **no** debe usarse en producción.

---

## 2. Backend: código y variables de entorno

```bash
# En el VPS
sudo mkdir -p /var/www/ciphercube && sudo chown $USER:$USER /var/www/ciphercube
git clone <TU_REPO> /var/www/ciphercube
cd /var/www/ciphercube/backend
npm ci --omit=dev
cp .env.example .env
nano .env   # rellena los valores reales (ver abajo)
```

`.env` de producción — lo mínimo crítico:

```ini
NODE_ENV=production
PORT=4000

# Dominios del frontend permitidos por CORS (tu dominio real, con https)
CORS_ORIGINS=https://ciphercube.app
FRONTEND_URL=https://ciphercube.app
PUBLIC_BACKEND_URL=https://api.ciphercube.app

# PostgreSQL (activa el driver Postgres)
DATABASE_URL=postgres://ciphercube:CLAVE@host:5432/ciphercube?sslmode=require
PGSSL=true

# Secretos JWT — genera 2 distintos y largos:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...

# Admin del panel
ADMIN_EMAILS=thehunter9856@gmail.com

# Correo de verificación (proveedor SMTP real)
SMTP_HOST=smtp.tu-proveedor.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=CipherCube <no-reply@ciphercube.app>
REQUIRE_EMAIL_VERIFICATION=true

# Pagos (Stripe/PayPal/MercadoPago) — ver backend/README.md
STRIPE_SECRET_KEY=...
# etc.
```

Aplica el esquema y crea el catálogo de planes (usa `schema.pg.sql` automáticamente):

```bash
npm run migrate
# Si tu cuenta admin ya existe pero no quedó marcada:
npm run grant-admin thehunter9856@gmail.com
```

---

## 3. Arrancar el backend con PM2

```bash
cd /var/www/ciphercube/backend
pm2 start src/server.js --name ciphercube-api
pm2 save                 # guarda el set de procesos
pm2 startup              # imprime un comando: cópialo y ejecútalo (arranque al boot)
pm2 logs ciphercube-api  # ver logs en vivo
```

<details>
<summary>Alternativa: systemd en vez de PM2</summary>

`/etc/systemd/system/ciphercube-api.service`:
```ini
[Unit]
Description=CipherCube API
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/ciphercube/backend
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=/var/www/ciphercube/backend/.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ciphercube-api
sudo systemctl status ciphercube-api
```
</details>

El backend escucha en `127.0.0.1:4000`; **no lo expongas directo a internet** — siempre detrás de Nginx.

---

## 4. Nginx + HTTPS

### 4.1 Frontend estático
Copia los archivos del frontend (todo menos `backend/`) a `/var/www/ciphercube-web`.
Edita `index.html` para apuntar al backend (justo antes de `js/app.js`):

```html
<script>window.CIPHERCUBE_API_BASE = 'https://api.ciphercube.app';</script>
```

### 4.2 Configuración de Nginx

`/etc/nginx/sites-available/ciphercube`:

```nginx
# ---- Frontend ----
server {
  server_name ciphercube.app;
  root /var/www/ciphercube-web;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
  # listen 443 ssl;  ← lo añade Certbot
}

# ---- Backend API ----
server {
  server_name api.ciphercube.app;

  # Los webhooks de pago pueden traer cuerpos grandes; ajusta si hace falta.
  client_max_body_size 1m;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # imprescindible: el backend usa trust proxy
  }
  # listen 443 ssl;  ← lo añade Certbot
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ciphercube /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 4.3 HTTPS con Let's Encrypt (Certbot)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ciphercube.app -d api.ciphercube.app
```

Certbot edita los `server {}` para añadir `listen 443 ssl`, instala los certificados y
crea la **renovación automática**. Verifícala:

```bash
sudo certbot renew --dry-run
```

> **Alternativa más simple: Caddy.** Si prefieres no pelear con Nginx+Certbot, Caddy
> hace HTTPS automático. Un `Caddyfile` equivalente:
> ```
> ciphercube.app {
>   root * /var/www/ciphercube-web
>   try_files {path} /index.html
>   file_server
> }
> api.ciphercube.app {
>   reverse_proxy 127.0.0.1:4000
> }
> ```

---

## 5. Webhooks de pago

Una vez con HTTPS, registra en cada proveedor las URLs **públicas** del backend:

- **Stripe** → `https://api.ciphercube.app/api/payments/webhook/stripe`
- **MercadoPago** → `https://api.ciphercube.app/api/payments/webhook/mercadopago`

Copia el *signing secret* de Stripe a `STRIPE_WEBHOOK_SECRET` y reinicia (`pm2 restart ciphercube-api`).
PayPal se confirma por captura en el retorno (no necesita webhook). Detalles en [backend/README.md](backend/README.md).

---

## 6. Backups y redundancia

- **BD gestionada:** activa snapshots diarios + retención y, si puedes, una réplica de lectura.
- **BD propia (VPS):** programa `pg_dump` cifrado fuera del servidor. Ejemplo (cron diario):
  ```bash
  0 3 * * * pg_dump "$DATABASE_URL" | gzip | gpg -c --batch --passphrase-file /etc/cc-backup.key > /backups/cc-$(date +\%F).sql.gz
  ```
  Sube `/backups` a almacenamiento externo (S3/Backblaze) y **prueba una restauración** de vez en cuando.
- Guarda el `.env` (secretos) en un gestor seguro; sin él no podrás descifrar backups ni firmar tokens.

---

## 7. Monitoreo y alertas

El backend ya deja rastro de todo en la tabla `audit_logs` (registros, logins, login fallidos,
pagos, accesos al panel, errores). Para convertir eso en alertas:

- **Uptime:** un *healthcheck* externo (UptimeRobot, Healthchecks.io) contra `https://api.ciphercube.app/health`.
- **Errores de la app:** integra Sentry, o un cron que consulte `audit_logs` por `severity='error'`
  o picos de `login_failed` y avise por correo/Telegram.
- **Logs del proceso:** `pm2 logs` / `journalctl -u ciphercube-api`. Considera rotación (`pm2 install pm2-logrotate`).

---

## 8. Checklist de seguridad final

- [ ] HTTPS activo en frontend y API; `http://` redirige a `https://` (Certbot lo hace).
- [ ] `NODE_ENV=production` (hace que falten variables críticas aborten el arranque).
- [ ] `JWT_ACCESS_SECRET` y `JWT_REFRESH_SECRET` largos, aleatorios y **distintos**.
- [ ] `DATABASE_URL` apunta a PostgreSQL con SSL (`PGSSL=true`); **no** SQLite.
- [ ] `CORS_ORIGINS` = tu dominio real (sin `localhost`).
- [ ] `REQUIRE_EMAIL_VERIFICATION=true` y SMTP probado (te llega el correo de verificación).
- [ ] Backend solo accesible vía Nginx (puerto 4000 cerrado en el firewall: `sudo ufw allow 22,80,443/tcp`).
- [ ] Cuenta admin verificada y, idealmente, con **2FA activado**.
- [ ] Backups automáticos funcionando y una restauración probada.
- [ ] `npm audit` sin vulnerabilidades (`cd backend && npm audit`).

---

## 9. Verificación post-despliegue

```bash
curl https://api.ciphercube.app/health           # {"ok":true,...}
```
En el navegador (`https://ciphercube.app`):
1. Regístrate → debe llegarte el correo de verificación → ábrelo → "Correo verificado".
2. Inicia sesión, activa 2FA en el perfil, cierra sesión y vuelve a entrar (te pedirá el código).
3. Con la cuenta admin, abre el **Panel de administración** y comprueba que los datos son reales.
4. Haz una compra de prueba (modo sandbox del proveedor) y confirma que el plan se concede.

---

### Actualizar a una versión nueva
```bash
cd /var/www/ciphercube && git pull
cd backend && npm ci --omit=dev && npm run migrate
pm2 restart ciphercube-api
# Si cambió el frontend, vuelve a copiarlo a /var/www/ciphercube-web
```
