# pi-failover

Registra el modelo virtual `failover/codigo` en pi. Usa un modelo primario y,
si este falla por un límite o problema del proveedor, cambia automáticamente
a modelos de respaldo en el orden configurado. También vuelve a probar el
primario periódicamente.

## Configuración actual

En [`index.ts`](./index.ts) están definidos el modelo primario y los fallbacks:

| Rol | Provider | Modelo |
|---|---|---|
| Primario | `cloudflare-workers-ai` | `@cf/qwen/qwen3.8-27b` |
| Fallback 1 | `ollama` | `qwen3.8:latest` |
| Fallback 2 | `ollama` | `qwen3.8:27b` |

Antes de usar la extensión, configura en pi las credenciales del proveedor
primario y asegúrate de que Ollama esté disponible con los modelos de respaldo
descargados. Para cambiar modelos, edita `PRIMARY` y `FALLBACKS` en `index.ts`;
el orden de `FALLBACKS` determina el orden de selección.

## Instalar

Desde este repositorio:

```bash
git clone https://github.com/Avaruz/pi-extensions
cd pi-extensions/pi-failover
pi install .
```

Después de instalar, reinicia pi y selecciona `failover/codigo` desde el
selector de modelos o con:

```bash
pi --model failover/codigo
```

## Comportamiento

- En condiciones normales, las solicitudes van al modelo primario.
- Si el proveedor falla con un error reconocido —por ejemplo, `429`,
  `rate limit`, cuota o presupuesto agotado, timeout, `502`/`503` o
  indisponibilidad—, pi intenta los fallbacks en orden.
- Mientras está usando un fallback, continúa con ese modelo. Ante un error
  reconocido como fallo del proveedor, avanza al siguiente fallback; al llegar
  al último, vuelve a intentarlo.
- Tras cinco minutos desde el último fallo del primario, la siguiente solicitud
  vuelve a probar el primario.
- Los errores que no coinciden con los patrones de failover se devuelven al
  primario. Esto evita cambiar de modelo ante errores como un desbordamiento de
  contexto.
- El nivel de razonamiento seleccionado en pi se conserva al cambiar de modelo.

La extensión registra un solo modelo virtual, `failover/codigo`, con niveles de
razonamiento `off`, `low`, `medium` y `high`.
