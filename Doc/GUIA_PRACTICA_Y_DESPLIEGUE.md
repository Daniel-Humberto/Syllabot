# 🚀 Syllabot — Guía Práctica, Despliegue y Manual de Operaciones

> Manual de instrucciones paso a paso para levantar el entorno de desarrollo, ejecutar pruebas automatizadas, desplegar en producción y operar los 7 contenedores del sistema.

---

## ⏱️ Inicio Rápido en 3 Minutos (Local)

### Prerrequisitos
- **Docker Engine 24+** y **Docker Compose V2**
- **Node.js 20+** y **npm** (para desarrollo local o ejecución de tests)
- **API Key de OpenAI** con acceso a modelos `gpt-4o-mini` y `tts-1`

### Pasos de Instalación

```bash
# 1. Clonar el repositorio y acceder a la raíz
git clone <url-del-repositorio>
cd "OpenAI Global Hackathon"

# 2. Configurar variables de entorno
cp .env.example .env
# Edita .env y coloca al menos tu OPENAI_API_KEY y TELEGRAM_BOT_TOKEN (si usas Telegram)
nano .env

# 3. Levantar la infraestructura completa con el script automatizado
chmod +x start-dev.sh
./start-dev.sh
```

El script `./start-dev.sh` se encarga de:
1. Comprobar que Docker esté activo.
2. Levantar los contenedores de soporte: PostgreSQL 18, Neo4j 5, Qdrant, SearXNG y FastAPI Transcript.
3. Ejecutar las migraciones SQL iniciales.
4. Compilar y levantar la aplicación central (`hackathon-agent-app`) y el frontend (`hackathon-agent-frontend`).

---

## ⚙️ Referencia Completa de Variables de Entorno (`.env`)

| Variable | Requerida | Valor por Defecto | Descripción y Propósito |
|---|---|---|---|
| `OPENAI_API_KEY` | **Sí** | `sk-...` | Clave de autenticación para modelos de lenguaje (`gpt-4o`, `gpt-4o-mini`) y síntesis de voz (`tts-1`). |
| `PORT` | No | `3000` | Puerto HTTP donde el backend Express expone la API y el streaming de audio. |
| `FRONTEND_PORT` | No | `3001` | Puerto HTTP donde el frontend Next.js sirve el dashboard interactivo. |
| `PUBLIC_URL` | No | `https://syllabot.humbert.uk` | URL base pública utilizada para construir enlaces absolutos a audios MP3 en Telegram y Discord. |
| `TELEGRAM_BOT_TOKEN` | Condicional | `""` | Token provisto por `@BotFather` para habilitar el bot de Telegram. Requerido para interacción por Telegram. |
| `POSTGRES_HOST` | No | `postgres` | Host del servidor PostgreSQL dentro de la red Docker (`hackathon-net`). |
| `POSTGRES_PORT` | No | `5432` | Puerto del servidor PostgreSQL. |
| `POSTGRES_DB` | No | `syllabot` | Nombre de la base de datos relacional. |
| `POSTGRES_USER` | No | `postgres` | Usuario administrador de PostgreSQL. |
| `POSTGRES_PASSWORD` | No | `postgres_secret` | Contraseña de acceso a PostgreSQL. |
| `NEO4J_URI` | No | `bolt://neo4j:7687` | URI Bolt de conexión al clúster de Neo4j. |
| `NEO4J_USER` | No | `neo4j` | Usuario de Neo4j. |
| `NEO4J_PASSWORD` | No | `neo4j_secret` | Contraseña del grafo en Neo4j. |
| `QDRANT_URL` | No | `http://qdrant:6333` | Endpoint REST del motor vectorial Qdrant. |
| `SEARXNG_URL` | No | `http://searxng:8080` | Endpoint de metabúsqueda federada privada. |
| `TRANSCRIPT_SERVICE_URL` | No | `http://transcript:8000` | Endpoint del microservicio FastAPI de verificación de subtítulos de YouTube. |

---

## 🐳 Gestión Operativa de Contenedores Docker

### Comandos Frecuentes

```bash
# Ver el estado de salud de todos los contenedores
docker compose ps

# Ver logs en tiempo real de la aplicación principal
docker compose logs -f app

# Ver logs del microservicio de transcripción de YouTube
docker compose logs -f transcript

# Reconstruir la aplicación tras hacer cambios en el código TypeScript
npm run build
docker compose up -d --build app

# Reiniciar un servicio específico (ej. SearXNG o Postgres)
docker compose restart searxng
docker compose restart postgres

# Detener todos los contenedores preservando los volúmenes de datos
docker compose down

# Limpieza total (¡Atención: borra bases de datos y audios almacenados!)
docker compose down -v
```

### Mapeo de Volúmenes y Persistencia
- `./storage:/app/storage`: Almacén local de archivos MP3 generados por el motor de síntesis de voz.
- `postgres_data:/var/lib/postgresql/data`: Base de datos relacional persistente.
- `neo4j_data:/data`: Grafo de conocimientos persistente.
- `qdrant_data:/qdrant/storage`: Vectores e índices persistentes.

---

## 🧪 Recetario de Pruebas de API con `curl`

### 1. Comprobación de Salud del Ecosistema
```bash
curl -s http://localhost:3000/health | jq
```
*Respuesta esperada:*
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "services": {
    "postgres": "connected",
    "neo4j": "connected",
    "qdrant": "connected"
  }
}
```

### 2. Generar una Ruta de Aprendizaje Vía API
```bash
curl -X POST http://localhost:3000/api/routes/generate \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Rust Concurrency and Thread Safety",
    "difficulty": "intermediate",
    "channel": "api-test"
  }' | jq
```

### 3. Generar un Podcast Conversacional a 2 Voces
```bash
curl -X POST http://localhost:3000/api/audio/podcast \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Qué son los agentes autónomos de Inteligencia Artificial",
    "title": "Descubriendo los Agentes de IA",
    "turnsCount": 6
  }' | jq
```
*Respuesta esperada:*
```json
{
  "id": "c098c727-f518-405a-9005-31e6bd6d133a",
  "title": "Descubriendo los Agentes de IA",
  "audioUrl": "https://syllabot.humbert.uk/audio/podcast-c098c727-f518-405a-9005-31e6bd6d133a.mp3",
  "turns": 6,
  "status": "ready"
}
```

### 4. Probar Streaming con HTTP 206 (Range Request)
```bash
curl -I -X GET "http://localhost:3000/audio/podcast-c098c727-f518-405a-9005-31e6bd6d133a.mp3" \
  -H "Range: bytes=0-1024"
```
*Respuesta esperada:*
```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1024/1114560
Accept-Ranges: bytes
Content-Length: 1025
Content-Type: audio/mpeg
```

### 5. Probar Microservicio de Transcripción de YouTube
```bash
curl -X POST http://localhost:8000/transcript \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }' | jq
```

---

## ☁️ Despliegue en Producción con Cloudflare Tunnel

Para desplegar Syllabot en un servidor o laptop durante un hackathon sin problemas de NAT, firewalls o WiFi restringido:

### 1. Instalación de `cloudflared`
```bash
# En Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared jammy main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
```

### 2. Configuración del Túnel (`~/.cloudflared/config.yml`)
```yaml
tunnel: sylabot
credentials-file: /home/humbert/.cloudflared/<tunnel-uuid>.json

ingress:
  # Rutas de audio hacia Express (soporta HTTP 206 range requests sin buffer)
  - hostname: syllabot.humbert.uk
    path: /audio/.*
    service: http://localhost:3000

  # Rutas de API y Webhooks hacia Express
  - hostname: syllabot.humbert.uk
    path: /api/.*
    service: http://localhost:3000

  # Resto del tráfico web hacia Next.js 16
  - hostname: syllabot.humbert.uk
    service: http://localhost:3001

  # Túnel seguro para administración remota por SSH
  - hostname: syllabot-ssh.humbert.uk
    service: ssh://localhost:22

  # Fallback obligatorio
  - service: http_status:404
```

### 3. Ejecutar el Túnel en Modo HTTP/2
```bash
cloudflared tunnel --protocol http2 run sylabot
```

> [!TIP]
> **Superar bloqueo de UDP en WiFis de Hackathons:** Muchas redes de sedes o eventos corporativos bloquean tráfico UDP (protocolo QUIC). El flag `--protocol http2` fuerza el túnel sobre TCP seguro en el puerto 443 estándar, garantizando conexión ininterrumpida.

---

## 🧪 Ejecución de la Suite de Pruebas Automatizadas

Syllabot incluye una suite completa de pruebas unitarias y de integración para validar la lógica del agente, contratos de datos y adaptadores:

```bash
# Ejecutar todas las pruebas con Jest
npm test

# Ejecutar con reporte de cobertura
npm test -- --coverage
```

Todas las pruebas se ejecutan de manera aislada utilizando mocks para las llamadas externas a OpenAI, permitiendo verificar la integridad del código en entornos CI/CD sin consumir tokens de API.

---

## 🩺 Diagnóstico y Resolución de Problemas Frecuentes

### 1. Error de audio: "Audio not found" (404)
- **Causa:** El volumen `./storage` no fue montado o el archivo fue eliminado por limpieza de caché.
- **Solución:** Verifica que el directorio `./storage/audio` exista localmente con permisos de escritura:
  ```bash
  mkdir -p ./storage/audio && chmod -R 775 ./storage
  ```

### 2. Telegram no reproduce el podcast directamente
- **Causa:** La variable `PUBLIC_URL` no está configurada o apunta a `http://localhost:3000`. Telegram requiere URLs HTTPS públicas para descargar y transmitir el archivo de audio.
- **Solución:** Asegúrate de que `PUBLIC_URL=https://syllabot.humbert.uk` esté definido en tu archivo `.env`.

### 3. Error en Neo4j: "Connection refused on bolt://neo4j:7687"
- **Causa:** Neo4j puede tardar entre 15 y 25 segundos en iniciar su clúster de grafos en el primer arranque.
- **Solución:** Espera a que el contenedor reporte estado saludable o inspecciona sus logs con `docker compose logs -f neo4j`.

### 4. SearXNG responde con error 403 o JSON inválido
- **Causa:** La configuración `settings.yml` tiene deshabilitado el formato de salida JSON.
- **Solución:** El archivo de configuración incluido en el repositorio ya activa `formats: [html, json]`. Reinicia el contenedor con `docker compose restart searxng`.
