#!/usr/bin/env node
/**
 * Сообщения установщика — единственное место пользовательского текста. Русские
 * строки + ASCII-транслитерация для консолей без UTF-8: селектор `selectMessages(cp)`
 * отдаёт русский вариант при кодовой странице 65001 и транслит при любой другой или
 * при невозможности её определить — транслит безопасная сторона. Bootstrap-строки
 * до появления Node печатает сам shim.
 *
 * Транслитерация — постоянная замена по буквам: текст читаем, ASCII гарантирован.
 */

/** Постоянная замена кириллицы латиницей (однозначная, без возврата). */
export function translit(text) {
  const MAP = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya'
  };
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = MAP[lower];
    if (mapped === undefined) {
      out += ch;
    } else if (ch === lower) {
      out += mapped;
    } else {
      out += mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
  }
  return out;
}

/**
 * Каталог сообщений: ключ → русская строка. `%s` — подстановка, как в printf.
 * Ключ именован по месту использования; новое сообщение добавляется здесь, не в коде.
 */
export const RU_MESSAGES = {
  'plan.header': 'Будет скачано:',
  'plan.item-node': ' - Node.js v%s (~30 МБ)',
  'plan.item-npm': ' - пакеты npm ci (~42 МБ)',
  'plan.item-browser': ' - браузер для прогонов: отдельная копия Chromium (без окна; ~270 МБ)',
  'plan.item-browser-maybe': ' - браузер для прогонов: отдельная копия Chromium (без окна; ~270 МБ)',
  'plan.into':
    'Всё кладётся внутрь %s, в систему ничего не устанавливается. ' +
    'Ваши браузеры и их данные не затрагиваются.',
  'consent.ask': 'Продолжить и скачать? [Y/n] ',
  'consent.cancelled': 'Отменено, ничего не скачано. Для запуска без подтверждения: install.bat /y',
  'consent.no-console':
    'Нет интерактивной консоли — согласие не спрашивается и ввод не читается. ' +
    'Для запуска без подтверждения: install.bat /y или install.bat /reinstall',
  'key.unknown': 'Неизвестный ключ: %s',
  'usage.line1': 'install.bat [/y] [/reinstall] [/?]',
  'usage.y': '  /y          - согласие на загрузку без вопроса (снос не делает никогда)',
  'usage.reinstall':
    '  /reinstall  - снести node\\ и node_modules и поставить заново без вопроса (подразумевает /y)',
  'usage.help': '  /?          - эта справка',
  'ready.already': 'Окружение уже готово.',
  'ready.reinstall-header': 'Будет скачано при переустановке:',
  'ready.ask-reinstall':
    'Окружение уже готово. Удалить локальные node\\ и node_modules и установить заново? [Y/n] ',
  'step.npm-start': 'Установка пакетов: npm ci --include=dev',
  'step.npm-failed': 'npm ci завершился с ошибкой (код %s).',
  'step.deps-still-wrong': 'Пакеты всё ещё не совпадают с package-lock.json после npm ci.',
  'step.browser-start': 'Установка браузера Playwright (headless shell)...',
  'step.browser-failed':
    'Не удалось установить браузер. Проверьте доступность cdn.playwright.dev и playwright.download.prss.microsoft.com.',
  'step.node-start': 'Загрузка Node.js v%s...',
  'step.node-download-failed': 'Не удалось скачать %s.',
  'step.node-sha-missing': 'В SHASUMS256.txt нет строки про %s.',
  'step.node-sha-mismatch': 'Контрольная сумма SHA-256 не совпала — файл повреждён или подменён.',
  'step.node-unpack-failed': 'Не удалось распаковать архив Node.js.',
  'step.node-no-exe': 'В архиве не найден node.exe после распаковки.',
  'step.node-move-failed': 'Не удалось перенести распакованный Node.js в node\\.',
  'step.node-version-unexpected': 'Node.js в node\\ имеет неожиданную версию: %s',
  'step.node-busy': 'Каталог node\\ занят, не удалось удалить.',
  'final.not-ready': 'Не удалось подготовить окружение полностью (статус: %s).',
  'final.done': 'Готово. Запуск: monitor.bat.',
  'wipe.no-package-json': 'Отказ: в каталоге нет package.json — это не похоже на каталог webapp-monitor.',
  'wipe.not-webapp-monitor': 'Отказ: package.json не похож на package.json webapp-monitor.',
  'wipe.link-refuse':
    'Отказ: node\\ или node_modules\\ — это junction/символьная ссылка. Снос отменён, цель ссылки не тронута.',
  'wipe.node-busy': 'Не удалось удалить node\\ — возможно, каталог занят запущенным monitor.bat.',
  'wipe.node-modules-busy':
    'Не удалось удалить node_modules\\ — возможно, каталог занят запущенным monitor.bat.'
};

/**
 * Набор сообщений под реальную кодовую страницу консоли: 65001 — русский текст,
 * иное или null — транслит. Возвращает функцию `t(key, ...args)`.
 */
export function selectMessages(cp) {
  const ascii = cp !== 65001;
  function t(key, ...args) {
    let text = RU_MESSAGES[key];
    if (text === undefined) {
      throw new Error(`неизвестный ключ сообщения: ${key}`);
    }
    if (ascii) {
      text = translit(text);
    }
    for (const arg of args) {
      text = text.replace('%s', String(arg));
    }
    return text;
  }
  return { t, ascii };
}

/** Список ключей — для самопроверки каталога тестом. */
export function messageKeys() {
  return Object.keys(RU_MESSAGES);
}
