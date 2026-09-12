#!/usr/bin/env bash
set -e

# ==============================================================================
# Script de inicio rápido: Docker Compose (Backend + Frontend Next.js) + Cloudflare
# ==============================================================================

# Colores para consola
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo "    🚀 INICIANDO SYLLABOT (NEXT.JS + EXPRESS + CLOUDFLARE)         "
echo "=================================================================="
echo -e "${NC}"

# 1. Verificar Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}[ERROR] Docker no está instalado.${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}[ERROR] El daemon de Docker no está corriendo. Inicia Docker primero.${NC}"
    exit 1
fi

# 2. Verificar o instalar cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo -e "${YELLOW}[INFO] 'cloudflared' no encontrado en el PATH. Intentando instalar en ~/.local/bin...${NC}"
    mkdir -p "$HOME/.local/bin"
    curl -L --fail --output "$HOME/.local/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x "$HOME/.local/bin/cloudflared"
    export PATH="$HOME/.local/bin:$PATH"
fi

# 3. Preparar archivo de entorno .env si no existe
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo -e "${YELLOW}[INFO] .env no encontrado. Creando copia desde .env.example...${NC}"
        cp .env.example .env
    else
        echo "PORT=3000" > .env
    fi
fi

PORT=$(grep -E '^PORT=' .env | cut -d '=' -f2 | tr -d ' "\r' || true)
PORT=${PORT:-3000}

# 4. Levantar contenedores con Docker Compose
echo -e "${CYAN}[1/3] Levantando contenedores (Backend :${PORT} + Frontend Next.js :3001)...${NC}"
docker compose up -d --build

# 5. Esperar a que el backend y frontend estén saludables
echo -e "${CYAN}[2/3] Esperando respuesta de los servicios locales...${NC}"
MAX_WAIT=30
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -s -f "http://localhost:${PORT}/health" &> /dev/null && curl -s -f "http://localhost:3001" &> /dev/null; then
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo -e "${RED}[ERROR] Los servicios no estuvieron listos después de ${MAX_WAIT}s.${NC}"
    docker compose ps
    docker compose logs --tail=50 app frontend
    exit 1
fi

echo -e "${GREEN}✔ Backend (Express en :${PORT}) y Frontend (Next.js en :3001) respondiendo correctamente.${NC}"

# 6. Iniciar Cloudflare Tunnel
LOG_FILE=$(mktemp -t cf_tunnel_XXXXXX.log)

cleanup() {
    echo -e "\n${YELLOW}Deteniendo Cloudflare Tunnel (PID: $CF_PID)...${NC}"
    kill "$CF_PID" 2>/dev/null || true
    rm -f "$LOG_FILE"
    echo -e "${GREEN}Infraestructura detenida.${NC}"
    exit 0
}
trap cleanup SIGINT SIGTERM

if [ -f "$HOME/.cloudflared/config.yml" ] && grep -q "syllabot.humbert.uk" "$HOME/.cloudflared/config.yml" 2>/dev/null; then
    echo -e "${CYAN}[3/3] Iniciando túnel permanente personalizado: ${BOLD}syllabot.humbert.uk${NC}..."
    cloudflared tunnel --protocol http2 --logfile "$LOG_FILE" run sylabot &
    CF_PID=$!
    CF_URL="https://syllabot.humbert.uk"
    sleep 3
else
    echo -e "${CYAN}[3/3] Iniciando Cloudflare Quick Tunnel hacia http://localhost:3001...${NC}"
    cloudflared tunnel --protocol http2 --url "http://localhost:3001" > "$LOG_FILE" 2>&1 &
    CF_PID=$!

    CF_URL=""
    for i in {1..30}; do
        CF_URL=$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)
        if [ -n "$CF_URL" ]; then
            break
        fi
        sleep 1
    done

    if [ -z "$CF_URL" ]; then
        echo -e "${RED}[ERROR] No se pudo obtener la URL de Cloudflare Tunnel. Logs recientes:${NC}"
        tail -n 25 "$LOG_FILE"
        kill "$CF_PID" 2>/dev/null || true
        exit 1
    fi
fi

# 7. Mostrar la URL generada y los comandos de prueba bien visibles
echo ""
echo -e "${GREEN}${BOLD}=================================================================="
echo -e "           🎉 SYLLABOT CLOUDFLARE FULLSTACK ACTIVO Y LISTO         "
echo -e "==================================================================${NC}"
echo ""
echo -e "  ${BOLD}Frontend Next.js (UI):${NC}   ${CYAN}${BOLD}${CF_URL}${NC}"
echo -e "  ${BOLD}Backend Health Check:${NC}    ${GREEN}${CF_URL}/api/backend/health${NC}"
echo -e "  ${BOLD}Webhook Endpoint:${NC}        ${YELLOW}${BOLD}${CF_URL}/api/backend/webhook/:channel${NC}"
echo ""
if [[ "$CF_URL" == *"syllabot.humbert.uk"* ]]; then
    echo -e "  ${GREEN}${BOLD}✔ SUBDOMINIO FIJO PERMANENTE:${NC} Tu URL NO cambiará."
else
    echo -e "  ${YELLOW}${BOLD}⚠️  AVISO (QUICK TUNNEL EFÍMERO):${NC} La URL cambiará si reinicias."
fi
echo ""
echo -e "  Configuración para tus canales:"
echo -e "    • Slack:     ${CF_URL}/api/backend/webhook/slack"
echo -e "    • Telegram:  https://api.telegram.org/bot<TOKEN>/setWebhook?url=${CF_URL}/api/backend/webhook/telegram"
echo -e "    • Discord:   ${CF_URL}/api/backend/webhook/discord"
echo -e "    • Genérico:  ${CF_URL}/api/backend/webhook/test"
echo ""
echo -e "${BOLD}  Pruebas rápidas:${NC}"
echo -e "    Abrir en navegador: ${CF_URL}"
echo -e "    curl -i ${CF_URL}/api/backend/health"
echo ""
echo -e "${GREEN}==================================================================${NC}"
echo -e "${CYAN}Mostrando logs en tiempo real de los contenedores (Ctrl+C para salir)...${NC}\n"

# Transmitir logs de los contenedores para ver tráfico en vivo
docker compose logs -f
