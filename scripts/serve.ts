/**
 * Демо-сервер для ручной проверки HTTP-слоя: `pnpm serve` (PORT=8080 по умолчанию).
 * Поднимает MemoryStore с демо-данными (src/demo/seed.ts) и печатает curl-примеры.
 */
import { createApi } from '../src/api/handlers'
import { startServer } from '../src/server/node'
import { buildDemo, SURVEY_KEY } from '../src/demo/seed'

const store = await buildDemo()
const api = createApi({ store })
const { port } = await startServer({ api, port: Number(process.env.PORT ?? 8080) })

console.log(`Опрос «${SURVEY_KEY}» (версии 1–2) слушает на http://127.0.0.1:${port}
Примеры:
  curl http://127.0.0.1:${port}/api/session
  curl -X POST http://127.0.0.1:${port}/api/submit -H 'content-type: application/json' -d '{
    "schema_version": 1, "nonce": "<из /api/session>", "hp": "",
    "surveyKey": "${SURVEY_KEY}", "versionNo": 2,
    "answers": { "q_nps": { "values": ["n9"] }, "q_csat": { "values": ["s4"] }, "q_liked": { "values": ["speed"] } }
  }'`)
