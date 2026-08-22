import { buildLlmsFullTxt } from '~core/client/help'

/** `/llms-full.txt` — вся справка одним markdown-файлом (см. `llms.txt.get.ts`). */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=3600')
  return buildLlmsFullTxt()
})
