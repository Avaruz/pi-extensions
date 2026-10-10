# pi-remote

Remote control para una sesión de **pi** corriendo en otra máquina, estilo
antigravity / claude.dev: ve al agente trabajar en vivo desde el navegador o
tu terminal remota, mándale prompts, detén el run y aprueba comandos peligrosos.

## Qué incluye

| Pieza | Descripción |
|---|---|
| `/remote` command | `/remote start [puerto]` · `/remote status` · `/remote stop` |
| Gateway WS | HTTP + WebSocket dentro del proceso de pi, PIN de 6 dígitos, ring-buffer de replays |
| UI web | Navegador: pantalla de PIN, chat con streaming, botón Stop, Steer, aprobaciones |
| `pi-remote` CLI | TUI minimalista desde tu otra máquina (mismo protocolo WS) |
| Túnel opcional | Detecta `cloudflared` o `ngrok` en PATH y sube un túnel con URL pública |
| Aprobación remota | Bash peligroso (`rm -rf`, `sudo`, `git push -f`…) se pregunta primero a los clientes remotos y cae al diálogo local si no responden |

## Instalar

```bash
cd packages/pi-remote
npm install            # dependencias mínimas (solo `ws`)

# uso rápido (desarrollo):
pi --extension ./packages/pi-remote/index.ts

# o instalado como paquete de pi:
pi install ./packages/pi-remote
```

## Uso

En la máquina donde corre pi:

```
/remote start            # default: http://127.0.0.1:8787
```

pi muestra en la terminal: URL local, PIN de 6 dígitos y (si cloudflared/ngrok
están instalados) la URL del túnel.

Desde la otra máquina:

```bash
# navegador: abre la URL del túnel y escribe el PIN
# o TUI:
pi-remote https://abc.trycloudflare.com 482913
pi-remote 192.168.1.20:8787 482913      # LAN
```

Dentro de la TUI: escribe prompts para pi; `stop` aborta el run; `status`
consulta; `allow`/`deny` responden aprobaciones; `.exit` sale.

## Protocolo (JSON sobre WS en `/ws`)

1. Handshake: primera msg `{"type":"auth","pin":"123456"}` (10 s).
2. Servidor responde `hello {session, replay[]}`.
3. Evento: `event {ev}` — `agent_start`, `message`, `ass_update` (streaming),
   `tool_start/update/end`, `model`, `waiting_ui`…
4. Cliente: `prompt {text, steer?}` · `stop` · `status` · `approve {id, decision}`.

Notas de seguridad: bind a `127.0.0.1`, PIN con TTL de 30 min desde el último
auth, y aviso explícito cuando no hay túnel HTTPS (PIN en claro → solo LAN de
confianza).

## Tests

```bash
npm test                                  # smoke: gateway + WS + web estático
node test/integration.mjs                 # integra: pi real (--mode rpc) + WS
```

El test de integración hace un model call mínimo (caliente + un prompt vía WS).
