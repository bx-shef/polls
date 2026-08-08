// Генерация обложки для соцсетей: public/og.png, 1200×630.  Запуск: pnpm og
//
// Картинка — закоммиченный бинарник, поэтому её пересобирают руками после правки текстов лендинга
// или вёрстки карточки. Разметка живёт в scripts/lib/ogTemplate.mjs — её строит и этот генератор,
// и проверка свежести, чтобы обе стороны собирали одну и ту же строку.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// `@playwright/test`, а не `playwright`: отдельного пакета `playwright` в зависимостях нет, и
// `pnpm og` падал на ERR_MODULE_NOT_FOUND. Тестовый пакет реэкспортирует тот же `chromium`.
import { chromium } from '@playwright/test'
import { resolveChromium } from './lib/chromium.mjs'
import { HEIGHT, WIDTH, buildOgHtml } from './lib/ogTemplate.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUB = join(ROOT, 'public')

const html = await buildOgHtml()
const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(PUB, { recursive: true })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
  await writeFile(join(PUB, 'og.png'), png)

  // Штамп хранит хэш и разметки, и самих байт: правка вёрстки без пересборки и подмена картинки
  // мимо генератора — это две разные беды, и ловить их нужно по отдельности.
  const sha = b => createHash('sha256').update(b).digest('hex')
  await writeFile(join(PUB, 'og.stamp.json'), `${JSON.stringify({
    hash: sha(html),
    png: sha(png)
  }, null, 2)}\n`)

  console.log('✓ og.png, og.stamp.json')
} finally {
  await browser.close()
}
