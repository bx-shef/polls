import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: [
    // Приманка для гейта границы слоёв: файлы нарушают правило намеренно,
    // линтеру и проверке типов их видеть незачем.
    'tests/fixtures/**',
  ],
})
