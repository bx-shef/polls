// Нарушение намеренное: относительный путь наружу из app/ в server/.
import { logger } from '../../server/utils/logger'

export const useLogger = () => logger
