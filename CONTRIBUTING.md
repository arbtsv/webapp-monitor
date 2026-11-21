# Контрибьютору

Переносимый мониторинговый сьют веб-кабинета. Правка едет в `main` только через
ветку и PR — это фиксирует branch protection на уровне GitHub, плюс CI гейт
саморевью (ниже). Пользователям бандла этот файл не нужен: установка и запуск —
в [README](README.md).

## Процесс: ветка → PR → CI → self-review → squash-merge

1. **Ветка** от актуального `main`: `git checkout -b <имя> origin/main`.
2. **Коммиты** на ветку. Хуки (husky + lint-staged) прогоняют ESLint и
   Prettier по staged-файлам области линта — см. «Область линтов» ниже.
3. **Черновик PR**: `gh pr create --draft`. Черновик не гейтится маркером
   саморевью — первый прогон заведомо ещё без ревью.
4. **Зелёный CI**: `gh pr checks <номер> --watch`. На черновике джоба
   `self-review-marker` — `skipped`, это нормально, остальные джобы зелёные.
5. **Self-review** диффа PR: `gh pr diff <номер>`. Затем — комментарий PR с
   итогом ревью и отдельной строкой-маркером `Reviewed at: <head sha>`,
   SHA — из `gh pr view <номер> --json headRefOid --jq .headRefOid`, не из
   `git rev-parse HEAD`. Маркер означает «ревью на этом SHA состоялось», а не
   «дефектов нет»: каждый новый коммит меняет head SHA, и для нового head
   нужен новый маркер после ревью его дельты. Маркер проверяет джоба
   `self-review-marker` в CI.
6. **`gh pr ready <номер>`** — переводит PR из черновика и перезапускает
   прогон; джоба маркера на нём уже должна быть зелёной.
7. **Squash-merge**: `gh pr merge <номер> --squash`. Подтверждение мержа —
   у владельца; мержить красный CI нельзя.

Полная командная процедура с разбором симптомов и ловушек —
Skill [pr-ship-procedure](.agents/skills/pr-ship-procedure/SKILL.md).

## Локальное окружение разработчика

Node.js >= 20 (бандл ставится через `install.bat`, dev-окружение — через npm):

```sh
npm ci          # dev-зависимости + prepare: husky ставит pre-commit хук
npm run lint    # ESLint по области линта (белый список — eslint.config.mjs)
npm run format  # Prettier --write по той же области + *.json/*.md/*.yml
npm run format:check
```

Тесты (офлайн, без живого кабинета; Windows — bat-обвязка идёт через cmd.exe;
прогоны строго по очереди, у фиктивного кабинета фиксированный порт):

```sh
npm run test:unit          # все *.unit.ts
npm run test:smoke         # конвейер замеров и отчёта на фиктивном кабинете
npm run test:bat           # shim-случаи monitor.bat
npm run test:install-bat   # shim-случаи install.bat
python -m pytest tests     # сверки дублей test_parity_*.py (нужен pytest)
```

Детали обвязки — [tests/README.md](tests/README.md).

## Область линтов

Линтятся и форматируются **только файлы бандла**: `helpers/`, `reporters/`,
`specs/`, `scripts/` (`*.mjs`), `tests/` (`*.ts`), `playwright.config.ts`,
плюс корневые `*.json` / `*.md` / `*.yml` для Prettier. Белый список
продублирован в трёх местах — `eslint.config.mjs`, `.prettierignore`,
`package.json` (`lint-staged`): менять надо везде сразу, иначе покрытие
молча разъедется.

Снаружи области намеренно:

- `*.bat` — cmd-специфика и принудительный CRLF (`.gitattributes`);
  форматтерами и линтерами не проходят;
- `package-lock.json` — генерируемый файл;
- `*.py` — гейтит `pytest`/`ruff` в CI, а не JS-линтеры.

## Соглашения

- Язык комментариев, сообщений об ошибках, README и документации — русский
  или английский, как удобнее автору правки; в рамках одного файла не
  смешивать без причины.
- Конфиги контуров `env*.json` содержат пароль — в репозиторий коммитится
  только `env.example.json` с плейсхолдерами (правило уже в `.gitignore`).
- Лицензия — MIT, см. [LICENSE](LICENSE).
