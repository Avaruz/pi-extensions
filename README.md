# pi-extensions

Colección de extensiones para [pi](https://pi.dev) (pi-coding-agent).

| Paquete | Descripción |
|---|---|
| [`pi-remote/`](pi-remote/) | Remote control de una sesión de pi: UI web + cliente TUI sobre WebSocket, PIN, túnel opcional |
| [`pi-ollama-local/`](pi-ollama-local/) | Auto-descubre los modelos chat de un servidor Ollama (sin editar `models.json`) |

## Instalar un paquete en un equipo

```bash
git clone <este-repo> pi-extensions && cd pi-extensions

# pi-remote (tiene dependencias):
cd pi-remote
npm pkg delete peerDependencies   # opcional: evita auto-instalar los peers pesados
npm install
pi install .

# pi-ollama-local (sin dependencias):
cd ../pi-ollama-local
pi install .
```

Desde cualquier proyecto queda disponible `/remote start · status · stop`
y el cliente `pi-remote <host|url> <PIN>`.

## Guía para Pi Agent

Usa estas extensiones según lo que pida la persona:

- **Usar modelos locales de Ollama:** `pi-ollama-local` registra el provider
	`ollama-local` al iniciar pi y descubre automáticamente sus modelos chat.
	Comprueba que Ollama esté activo; si está en otra máquina, configura
	`OLLAMA_BASE_URL` o `~/.pi/agent/ollama-local.json`. No hace falta editar
	`models.json`. Después, selecciona el modelo descubierto desde el selector
	de modelos de pi.
- **Controlar una sesión de pi desde otro dispositivo:** con `pi-remote`
	instalado, ejecuta `/remote start` en la sesión que se compartirá. Para
	detenerlo o consultar su estado, usa `/remote stop` o `/remote status`.
	Conecta desde el navegador o ejecuta `pi-remote <host|url> <PIN>` en el
	dispositivo cliente.

No confundas ambos usos: `pi-ollama-local` agrega modelos al inicio; `pi-remote`
expone una sesión activa. El PIN permite enviar prompts y responder
aprobaciones, así que compártelo solo con personas de confianza. Sin un túnel
HTTPS, limita el acceso a una LAN de confianza.

## Publicar un paquete a npm

```bash
cd pi-remote
npm publish --access public   # la etiqueta "pi-package" lo lleva al gallery de pi
```
