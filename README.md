# CipherCube

**Cifra secretos en cubos 3D escaneables — todo en tu navegador, sin servidores.**

CipherCube es una Progressive Web App que te permite:
- 🔐 Cifrar secretos con AES-256-GCM (256 bits)
- 📦 Generar cubos 3D imprimibles y escaneables
- 📷 Escanear cubos cara por cara con la cámara
- 🔄 Repartir secretos con Shamir (solo con K de N partes lo recuperas)
- 📱 Instalar como app nativa en tu teléfono
- ✈️ Funciona completamente offline

**Criptografía:**
- **Derivación de clave:** PBKDF2-SHA256 (600k iteraciones) o Argon2id
- **Encriptación:** AES-256-GCM
- **Redundancia:** Reed-Solomon GF(256) para corregir errores en cubos dañados
- **Compartir secretos:** Shamir Secret Sharing en GF(256)

## Uso

### En el navegador (web)
```bash
python -m http.server 8000
# Abre http://localhost:8000
```

O en Windows (PowerShell):
```powershell
python -m http.server 8000
```

### En tu teléfono
**Android:**
1. Abre la app en Chrome
2. Menú → "Instalar app" o "Agregar a pantalla de inicio"

**iPhone:**
1. Abre en Safari
2. Compartir → "Agregar a pantalla de inicio"

## Características

### 🔐 Crear
- Texto o archivos adjuntos
- 3 tamaños: Mini (24×24), Estándar (40×40), Pro (60×60)
- Volumen oculto (datos adicionales ocultos en la clave)
- Exporta PNG o cubo 3D escaneable

### 📷 Descifrar
- **Cámara en vivo:** Apunta cada cara del cubo — se captura automáticamente
- **Subir imagen:** PNG exportado o foto manual (se ajusta automáticamente)
- Corrección automática de errores (Reed-Solomon)

### 🔄 Bóveda
- Reparte tu frase en N partes, recupera con K (ej: 5 partes, necesitas 3)
- Escáner en vivo o subida de imágenes
- Reconstrucción automática al reunir K partes

## Arquitectura

```
index.html              ← Shell PWA (manifest, Service Worker)
├── css/
│   ├── base.css       ← Reset, tipografía, layout
│   ├── theme.css      ← Tokens de color (light/dark)
│   ├── components.css ← Cards, botones, viewfinder, etc.
│   └── animations.css ← Stagger, transiciones suaves
├── js/
│   ├── app.js         ← Bootstrap, Crear, Perfil, Tienda, Inicio
│   ├── camera.js      ← Descifrar, subida de imágenes, Bóveda
│   ├── camera-live.js ← Escáner 3D en vivo (fábrica reutilizable)
│   ├── crypto.js      ← AES-256-GCM, PBKDF2, Argon2id, RS, Shamir
│   ├── cube3d.js      ← Render v2 de baldosas, detección, decodificación
│   ├── argon2-loader.js ← Carga asincrónica de Argon2
│   ├── ui.js          ← Navegación, toasts, tema, overlay premium
│   ├── plans.js       ← Sistema de planes (free/plus/bóveda)
│   └── storage.js     ← localStorage: tema, historial de cubos
├── vendor/
│   ├── argon2-bundled.min.js ← Argon2id compilado a WASM
│   └── argon2.wasm
├── assets/
│   ├── logo-black.png ← Logo en fondo blanco
│   ├── logo-white.png ← Logo en fondo negro
│   └── icons/         ← PWA icons (192px, 512px, apple-touch-icon)
├── manifest.json      ← Metadatos PWA
└── sw.js              ← Service Worker (network-first cache)
```

## Seguridad

### ✅ Seguro
- Todo el cifrado ocurre **en el navegador del usuario**
- La frase maestra **nunca se transmite** ni se guarda
- Cada cubo es **independiente** (no hay clave maestra global)
- No hay servidores — no hay base de datos de secretos

### ⚠️ Sistema de planes
El sistema de planes (free/plus/bóveda) hoy usa `localStorage` — spoofeable en el navegador. **Para producción con pagos reales,** se debe implementar:
- Backend con autenticación OAuth/JWT
- Base de datos verificada de usuarios y planes
- El frontend solo es caché; el servidor es la fuente de verdad

## Compatibilidad

- ✅ Chrome/Edge (desktop y móvil)
- ✅ Firefox
- ✅ Safari (iOS 12+, macOS)
- ⚠️ Requiere HTTPS en producción (cámara, Service Worker)

## Desarrollo

### Estructura de módulos (ES6)
- Importación/exportación estándar
- Requiere servidor HTTP (no funciona con `file://`)

### Testing
```bash
node test/kdf-migration.test.mjs
```

### Service Worker
- Estrategia **network-first** para código fresco siempre online
- Cache offline como respaldo
- Versión: `ciphercube-v9`

## Licencia

Código abierto — úsalo, modifica, distribuye libremente.

## Notas

- 🎨 Tema claro/oscuro automático según preferencia del sistema
- ⚡ Animaciones suaves, respeta `prefers-reduced-motion`
- 🚀 PWA instalable — funciona offline, ícono en home
- 🔄 Historial local persistente (sin secretos — solo metadatos)
