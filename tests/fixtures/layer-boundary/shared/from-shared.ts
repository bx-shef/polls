// Нарушение намеренное: `shared/` Nuxt 4 отдаёт и на клиент тоже, поэтому серверный
// модуль отсюда уедет в браузер ровно так же, как из `app/`.
import { logger } from '../server/utils/logger'

export const log = logger
