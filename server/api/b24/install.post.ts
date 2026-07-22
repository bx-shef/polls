// POST /api/b24/install — установка приложения на портал Bitrix24 (#17). Bitrix присылает установку
// либо install-страницей (плоские поля формы AUTH_ID/REFRESH_ID/member_id, DOMAIN в query), либо
// событием ONAPPINSTALL (auth.access_token). parseInstallEvent понимает оба формата.
//
// Конвейер: merge(query, body) → parseInstallEvent → handleInstall(сохранить токены PortalTokenStore →
// зарегистрировать робот+плейсменты B24OAuth). Ответ — HTML, вызывающий BX24.installFinish() (портал
// помечает установку завершённой); на ошибке — HTML с текстом. Fail-closed: без конфига/БД/ключа — 503.
import { parseInstallEvent, installToB24Params, handleInstall } from '~core/bitrix24/install'
import { b24AppConfig, usePortalTokenStore, registerIntegrations } from '../../utils/portal'
import { logger } from '../../utils/api'

function html(event: any, status: number, body: string): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return body
}

/** Страница, завершающая установку в портале (BX24.installFinish). */
const FINISH_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<script src="//api.bitrix24.com/api/v1/"></script></head>
<body><p>Приложение установлено. Можно закрыть это окно.</p>
<script>try{BX24.init(function(){BX24.installFinish();});}catch(e){}</script></body></html>`

const errorHtml = (msg: string): string =>
  `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"></head><body><p>Установка не завершена: ${msg}</p></body></html>`

export default defineEventHandler(async (event) => {
  // DOMAIN install-страницы приходит в query; токены — в теле. Объединяем.
  const body = await readBody(event).catch(() => ({}))
  const merged = { ...getQuery(event), ...(body && typeof body === 'object' ? body : {}) }

  const auth = parseInstallEvent(merged)
  if (!auth) {
    // Диагностика: какие ключи реально прислал портал (значения-секреты НЕ логируем).
    logger.warn('b24_install_parse_fail', { msg: `Неизвестный формат установки; ключи: ${Object.keys(merged).join(',')}` })
    return html(event, 400, errorHtml('некорректные параметры установки'))
  }

  const cfg = b24AppConfig()
  const tokenStore = await usePortalTokenStore()
  if (!cfg || !tokenStore) {
    return html(event, 503, errorHtml('интеграция не сконфигурирована на сервере'))
  }

  try {
    await handleInstall(auth, {
      // save → Promise<boolean> (тумбстоун-гард). Тумбстоун-гард здесь ещё не активен
      // (install-страница не несёт top-level `ts`); включится с events-эндпоинтом (§2.1).
      saveTokens: async (tokens) => {
        await tokenStore.save(tokens)
      },
      registerIntegrations: () => registerIntegrations(installToB24Params(auth), cfg)
    })
    logger.info('b24_install_ok', { msg: `Установка портала ${auth.memberId} завершена` })
    return html(event, 200, FINISH_HTML)
  } catch (e) {
    logger.warn('b24_install_fail', { msg: `Установка не завершена: ${(e as Error).message}` })
    return html(event, 502, errorHtml('ошибка при сохранении/регистрации'))
  }
})
