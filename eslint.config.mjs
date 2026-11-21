// ESLint 10, плоский конфиг. Область — только файлы бандла (единый белый
// список scope ниже дублируется в .prettierignore и package.json -> lint-staged;
// менять в трёх местах сразу). Батники, package-lock.json и *.py намеренно
// снаружи: .bat — cmd-специфика и CRLF, lock-файл — генерируемый, Python гейтит
// pytest в CI. Раннер бандла ставится через install.bat без dev-окружения, поэтому
// конфиг не тянет ничего, что нужно только гейтам: все зависимости этого файла —
// devDependencies (npm ci --omit=dev бандлу не нужен, но и не мешает).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Белый список области линта — копия 1 из 3 (см. шапку файла). */
const tsScope = [
  'helpers/**/*.ts',
  'reporters/**/*.ts',
  'specs/**/*.ts',
  'tests/**/*.ts',
  'playwright.config.ts'
];
const mjsScope = ['scripts/**/*.mjs'];

export default tseslint.config(
  {
    ignores: ['artifacts/**', 'node/**', 'node_modules/**']
  },
  {
    files: [...tsScope, ...mjsScope],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Точечный console в helpers/specs/tests — только через disable-
      // директиву перед строкой (так уже писано в коде); свободный console
      // разрешён ниже, в scripts/ и reporters/.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // scripts/*.mjs — консольный вывод инструмента (не отладка) и стиль бандла
    // с var: оба запрета здесь ложноположительны.
    files: mjsScope,
    rules: {
      'no-console': 'off',
      'no-var': 'off'
    }
  },
  {
    // reporters/live.ts рисует живой вывод прогона в консоль.
    files: ['reporters/**/*.ts'],
    rules: {
      'no-console': 'off'
    }
  }
);
