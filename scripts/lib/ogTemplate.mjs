import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND_ACCENT, LANDING_DESCRIPTION, LANDING_METRICS, LANDING_TITLE } from '../../app/utils/landing.ts'

// Разметка обложки для соцсетей, вынесенная из генератора отдельным модулем.
//
// Зачем отдельно: её строит и генератор (`pnpm og`), и проверка свежести — обе стороны обязаны
// собирать одну и ту же строку. Хэшируется готовая разметка, а не только тексты: так проверка
// накрывает и вёрстку, и цвета, и вшитый знак, то есть всё, от чего зависят пиксели. Урок соседнего
// проекта: тексты лендинга однажды поправили, картинку не пересобрали, и в ленте месяц висел
// прежний текст.
//
// Вид карточки — язык семейства: тёмный фон, знак, плашка «Bitrix24 · Приложение», крупный
// заголовок. Различается только акцент.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const WIDTH = 1200
export const HEIGHT = 630

/** Собрать разметку карточки. Асинхронно, потому что знак вшивается data-URI: сети у Chromium нет. */
export async function buildOgHtml() {
  // Заголовок разрезан, чтобы «Bitrix24» держал акцентный цвет независимо от формулировки.
  const [head, tail] = LANDING_TITLE.split(/ в Bitrix24$/).length === 1
    ? [LANDING_TITLE, '']
    : [LANDING_TITLE.replace(/ в Bitrix24$/, ''), ' в <span>Bitrix24</span>']
  const logoSvg = await readFile(join(ROOT, 'public', 'favicon.svg'), 'utf8')
  const logoData = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  .card {
    width: ${WIDTH}px; height: ${HEIGHT}px; padding: 84px 88px;
    background:
      radial-gradient(900px 500px at 12% -10%, rgba(139,92,246,0.22), transparent 60%),
      radial-gradient(700px 500px at 108% 120%, rgba(99,102,241,0.20), transparent 60%),
      #05010f;
    color: #fff; display: flex; flex-direction: column; justify-content: center;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .title { font-size: 76px; font-weight: 800; line-height: 1.05; margin-top: 26px; }
  .title span { color: ${BRAND_ACCENT}; }
  /* Короткое описание, а не подзаголовок страницы: в ленте карточку показывают шириной ~500px,
     и длинный текст превращается в четыре строки мелкого шрифта, которые не читают. */
  .sub { font-size: 37px; color: #cbd5e1; margin-top: 32px; max-width: 1000px; line-height: 1.3; }
  /* Фиксированный отступ, а не margin-top:auto — auto схлопывается, когда текст заполняет карточку,
     и подвал прилипает к последней строке. */
  .foot { font-size: 27px; color: #94a3b8; margin-top: 40px; }
  .head { display: flex; align-items: center; gap: 26px; }
  .logo { width: 88px; height: 88px; border-radius: 20px; }
  .badge {
    display: inline-flex; align-items: center; gap: 18px;
    border: 1px solid color-mix(in oklab, ${BRAND_ACCENT} 40%, transparent);
    background: color-mix(in oklab, ${BRAND_ACCENT} 10%, transparent);
    border-radius: 13px; padding: 13px 26px;
  }
  .badge b { font-size: 31px; font-weight: 700; line-height: 1; color: #c4b5fd; }
  .badge i {
    font-size: 22px; font-weight: 600; font-style: normal; text-transform: uppercase;
    letter-spacing: 0.14em; color: rgba(255,255,255,0.7);
  }
</style></head><body>
  <div class="card">
    <div class="head">
      <img class="logo" src="${logoData}" alt="">
      <span class="badge"><b>Bitrix24</b><i>Приложение</i></span>
    </div>
    <div class="title">${head}${tail}</div>
    <div class="sub">${LANDING_DESCRIPTION}</div>
    <div class="foot">${LANDING_METRICS.join(' · ')}</div>
  </div>
</body></html>`
}
