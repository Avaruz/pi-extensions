# pi-ollama-local

Descubre automáticamente los modelos chat de un servidor **Ollama** y los
registra como el provider `ollama-local` en pi. Nunca más hay que editar
`models.json` a mano para agregarse un modelo: pi consulta `/v1/models` y
`/api/show` del servidor en cada arranque.

## Qué hace

- Lista los modelos del servidor (`/v1/models`)
- Detecta capacidades reales por modelo vía `/api/show`: **vision** (input de
  imagen), **thinking** (reasoning) y ventana de contexto real
- Descarta modelos no-chat (embeddings, etc.)
- Cachea el catálogo 60 s, con timeout de 5 s y fallback a la última lista
  buena si el servidor no responde
- Respeta `--offline` / `PI_OFFLINE` (arranque sin red)

## Instalar

```bash
git clone https://github.com/Avaruz/pi-extensions && cd pi-extensions/pi-ollama-local
pi install .
```

O desde git sin clonar:

```bash
pi install git:github.com/Avaruz/pi-extensions@<branch>
```

## Configurar la URL del servidor

En orden de prioridad (gana la primera que exista):

1. Variable de entorno `OLLAMA_BASE_URL`, p. ej. `http://192.168.1.50:11434`
2. Archivo `~/.pi/agent/ollama-local.json` con la URL:

   ```json
   { "baseUrl": "http://192.168.138.9:11434" }
   ```

3. Por defecto: `http://127.0.0.1:11434` (Ollama en la misma máquina)

## Ajustes por modelo

En `index.ts`, el objeto `MODEL_OVERRIDES` permite forzar metadatos por modelo
(`contextWindow`, `maxTokens`, `input`, `reasoning`). Las claves son los IDs
completos de Ollama, p. ej. `"qwen3.8:latest"`.

## Requisitos / notas

- Necesita un Ollama que exponga la API (puerto 11434 por defecto); sin
  autenticación (la extensión usa una API key dummy que Ollama ignora)
- Si tenías un provider `ollama-local` (u otro) definido en `models.json`,
  quítalo: la lista estática se mezcla con los modelos descubiertos
- No dupliquen la extensión: o como archivo suelto en
  `~/.pi/agent/extensions/` **o** como este paquete, no ambos (pi rechazará
  el segundo registro del mismo provider)
