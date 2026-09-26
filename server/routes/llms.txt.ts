import { defineEventHandler, setResponseHeader } from 'h3'
// Относительным путём, а не `#shared/faq`: этот файл импортирует юнит-тест, а в нём псевдоним Nuxt
// не работает. Nitro сам относительный путь разрешает верно — ломается он только у кода `app/`.
import { buildLlmsTxt } from '../../shared/faq'
import { publicBaseUrl } from '../utils/env'

/**
 * `/llms.txt` — the same help as `/help`, as plain text for the customer's AI assistant.
 *
 * ⚠ Отдаётся маршрутом из того же источника, что и страница (`shared/faq.ts`), а не файлом
 * в `public/`. Файл пришлось бы собирать отдельным шагом сборки, и у соседнего проекта именно этот
 * шаг однажды тихо выпал: юнит-тест собирателя оставался зелёным, а на сайте был 404, по которому
 * помощник клиента отвечал своими догадками. У маршрута такого шага нет — нечему выпадать.
 *
 * Ссылки в тексте — по публичному адресу приложения. Он не задан — ссылок нет вовсе: относительная
 * ссылка в документе, который читает чужой помощник, ведёт в никуда.
 *
 * ⚠ Файл без суффикса метода (`llms.txt.ts`, а не `.get.ts`), и это не небрежность: с суффиксом
 * маршрут отвечал только на GET, а `HEAD /llms.txt` проваливался в SPA и получал 200 с HTML —
 * проверяльщик ссылок решал, что текста здесь нет. Имя файла и есть адрес: переименовав его,
 * мы получили бы 404 на `/llms.txt` — это держит `tests/unit/llms-route.test.ts`. Нашёл `/review`.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  return buildLlmsTxt(publicBaseUrl())
})
