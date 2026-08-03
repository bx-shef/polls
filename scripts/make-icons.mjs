// Генерация растровых иконок из единственного мастера public/favicon.svg.  Запуск: pnpm icons
//
// Зачем: Маркет требует иконку решения — квадрат 250–650 px, JPEG или PNG **без прозрачного фона**.
// Мастер — скруглённая плитка, то есть у любого прямого экспорта углы прозрачны, и заявку отклонят
// на модерации, когда она уже подана. В соседних приложениях семейства эта дыра вскрылась ровно так.
//
// Выход (закоммиченные статические файлы):
//   icon-market-512.png    512×512, НЕПРОЗРАЧНАЯ — иконка карточки Маркета
//   icons.stamp.json       sha256 исходного svg + полученной иконки
//
// Штамп хэширует ИСХОДНИК, а не только результат: хэш одного вывода сравнивал бы два файла, которые
// пишет один и тот же скрипт, — правка знака без прогона генератора оставила бы их одинаково
// устаревшими и согласованными между собой.
//
// Остальные размеры (favicon-16/32, apple-touch, PWA, maskable) добавляются одной строкой на файл,
// когда на них появятся ссылки.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUB = join(ROOT, 'public')

/** Цвет плитки знака — им же заливается непрозрачная подложка, чтобы углы стали квадратными. */
const PLATE = '#0b1220'

async function render(page, svg, size, { background = 'transparent' } = {}) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; } body { width: ${size}px; height: ${size}px; background: ${background}; }
    img { width: ${size}px; height: ${size}px; }
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(html, { waitUntil: 'load' })
  return page.screenshot({ type: 'png', omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } })
}

const svg = await readFile(join(PUB, 'favicon.svg'), 'utf8')
const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(PUB, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })

  // Подложка цвета самой плитки: углы просто становятся квадратными, глиф не трогаем.
  const market = await render(page, svg, 512, { background: PLATE })
  await writeFile(join(PUB, 'icon-market-512.png'), market)

  const sha = b => createHash('sha256').update(b).digest('hex')
  await writeFile(join(PUB, 'icons.stamp.json'), `${JSON.stringify({
    source: sha(svg),
    iconMarket512: sha(market)
  }, null, 2)}\n`)

  console.log('✓ icon-market-512.png, icons.stamp.json')
} finally {
  await browser.close()
}
