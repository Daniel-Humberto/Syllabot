# 📚 Índice General de la Suite de Documentación de Syllabot

> La documentación de Syllabot ha sido modularizada en guías especializadas para diferentes audiencias y necesidades técnicas, sustituyendo el documento monolítico anterior.

Selecciona el documento correspondiente según tu interés:

---

### 1. 🧭 [Visión, Filosofía Pedagógica y Experiencia de Usuario](VISION_NARRATIVA.md)
- **Audiencia:** Jueces de producto, diseñadores instruccionales y evaluadores pedagógicos.
- **Contenido:**
  - Tesis central: *"El usuario no se adapta a la plataforma; la plataforma se adapta a su contexto de vida"*.
  - Los 4 contextos de vida del estudiante (en movimiento, en el trabajo, frente al escritorio, micro-momentos).
  - Historias de usuario y casos de uso reales (Carlos, Ana, David).
  - Tabla comparativa frente a LMS tradicionales y chatbots convencionales.

---

### 2. 🏗️ [Arquitectura Técnica y Deep Dive de Ingeniería](ARQUITECTURA_TECNICA.md)
- **Audiencia:** Ingenieros de software, arquitectos de sistemas y desarrolladores backend.
- **Contenido:**
  - Matriz técnica de los **7 contenedores Docker** interconectados en `hackathon-net`.
  - Motor de síntesis de audio conversacional a dos voces (Alex y Sofía) y streaming HTTP 206 RFC 7233.
  - Pipeline de verificación determinista de videos con microservicio FastAPI (`services/transcript/`).
  - Triple persistencia políglota: DDL en PostgreSQL 18, modelo Cypher en Neo4j 5 y colecciones en Qdrant.
  - Topología de red, túnel HTTP/2 de Cloudflare y proxy SSH.

---

### 3. 🤖 [Orquestación de Agentes, Tool Calling y Omnicanalidad](AGENTES_Y_MULTICANAL.md)
- **Audiencia:** Desarrolladores de IA, integradores de bots e ingenieros de prompts.
- **Contenido:**
  - Paradigma multi-agente: Agente Planificador (*Planner*) y Agente Curador (*Curator*).
  - Catálogo completo de herramientas (*Tool Calling*): `generate_podcast`, `generate_voice_note`, `create_learning_route`, `searxng_search`, `vector_search`, `graph_query`, `request_approval`.
  - Adaptadores nativos de mensajería: Telegram (`sendAudio` nativo, inline keyboards), Discord y Slack.
  - Runtime de CopilotKit y compositor de diapositivas interactivas.
  - Vinculación criptográfica de identidades cross-channel (`/start <token>`) y flujo Human-in-the-Loop (HITL).

---

### 4. 🚀 [Guía Práctica, Despliegue y Manual de Operaciones](GUIA_PRACTICA_Y_DESPLIEGUE.md)
- **Audiencia:** DevOps, operadores de infraestructura y hackers que deseen probar el proyecto localmente.
- **Contenido:**
  - Inicio rápido en 3 minutos con `./start-dev.sh`.
  - Matriz exhaustiva de variables de entorno (`.env`).
  - Comandos operativos de Docker Compose (reconstrucción, monitoreo de logs, reinicios).
  - Recetario de pruebas con `curl` para cada servicio (streaming, transcripciones, agentes).
  - Guía de despliegue con Cloudflare Tunnel y solución para WiFis restringidos en eventos.
  - Diagnóstico y resolución de incidencias frecuentes.

---

Para volver a la vista ejecutiva general, consulta el [README principal del proyecto](../README.md).
