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

## Publicar un paquete a npm

```bash
cd pi-remote
npm publish --access public   # la etiqueta "pi-package" lo lleva al gallery de pi
```
