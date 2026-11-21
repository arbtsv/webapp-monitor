---
name: pr-ship-procedure
description: >
  Ship a change from a git branch to main in this repository: open a pull
  request, wait on CI, self-review, and squash-merge. Use whenever the user
  wants to "open a PR", "ship this branch", "merge this", or asks "what do I do
  after committing" / "what's next" once a branch has commits. Also trigger when
  `gh pr checks --required` fails with `no required checks reported`. The
  top-level rule — changes reach `main` only through a branch and a PR — lives
  in CONTRIBUTING.md; this file gives the command steps.
---

# PR Ship Procedure

Правка едет в `main` только через ветку и PR (branch protection на уровне
GitHub). Процесс в двух словах и ссылки — [CONTRIBUTING.md](../../CONTRIBUTING.md);
здесь — шаги команды и ловушки. Мерж — только squash, после явного
подтверждения пользователя.

**Шаги 1–5 идут без пауз** — просьба «открыть PR» / «отправь ветку» — согласие
на всю цепочку до вопроса о мерже. Остановки: красная джоба CI, кроме
ожидаемо `skipped` `self-review-marker` на черновике (причина вне ветки —
инфраструктура, флак — остановка с отчётом; в изменениях ветки — правится
коммитом без вопроса); конфликт с `main`, разрешение которого требует выбора
между правками сторон; подтверждение мержа (шаг 6).

## Процедура: ветка → PR → CI → self-review → squash-merge

1. **Ветка** от актуального `main`: `git checkout -b <имя> origin/main`.
2. **Коммиты** на ветку. Pre-commit хук (husky + lint-staged) прогоняет
   ESLint/Prettier по staged-файлам области линта — см. CONTRIBUTING.md.
3. **`gh pr create --draft`.** Черновик именно затем, чтобы `self-review-marker`
   не давал ожидаемо-красный сигнал на первом, заведомо не готовом прогоне.
   В неинтерактивном режиме gh требует `--title` и `--body` (или `--fill`);
   тело удобно передать через `--body-file`.
4. **Дождаться зелёного CI**: `gh pr checks <номер> --watch`. На черновике
   `self-review-marker` — `skipped`, не красный: PR ещё черновик, условие
   `draft == false` не выполнено. Если `--watch` вышел по skipped-маркеру раньше
   времени, смотреть снимок из раздела «CI внутри PR-потока» ниже.
5. **Self-review** диффа PR: `gh pr diff <номер>` — оценка по критериям баги,
   безопасность, качество. **Затем безусловно** — комментарий PR с итогом ревью
   и отдельной строкой-маркером `Reviewed at: <полный head SHA>`; SHA — из
   `gh pr view <номер> --json headRefOid --jq .headRefOid`, а НЕ из
   `git rev-parse HEAD`, и публиковать ДО push принятой правки, если она есть:
   маркер означает «ревью на этом SHA состоялось». Любой новый коммит меняет
   head SHA — для нового head нужен новый маркер после ревью дельты
   `git diff <A> <B>`, где `<A>` — SHA из последней строки `Reviewed at:`.

   - **PR черновик (`isDraft: true`)**: `gh pr ready <номер>` — обязателен
     (`gh pr merge` черновик не мержит) и запускает свежий прогон всех джоб.
   - **PR не черновик**: маркер на текущем прогоне упал по-настоящему —
     комментарий опубликован постфактум, новый прогон сам не запустился.
     Перезапуск: `gh run rerun <id> --failed`, затем `gh pr checks <номер>
--watch`. Id прогона: `gh run list --commit <head sha> --workflow CI
--json databaseId,event --jq '[.[] | select(.event == "pull_request")][0].databaseId'`.

   Разбор находок: принимается дефект с потерей данных, неверным результатом
   или тихим сбоем в документированном сценарии; правка минимальна и
   проходит ревью дельты. Отклонённые находки — одной строкой с причиной в
   комментарии PR, нового раунда не порождают. Повторный раунд — только после
   принятой правки; пустой результат — ветка готова к мержу.

6. **Подтверждение пользователя, затем `gh pr merge <номер> --squash
--match-head-commit <SHA>`.** Тишина и зелёный CI подтверждением не
   являются — без адресного ответа мерж не вызывается. Предусловие — все
   коммиты ветки запушены (squash берёт только запушенное): сверить head PR с
   локальной веткой. `--match-head-commit` — head PR на момент мержа; перед ним
   сверка маркера тем же вызовом, что гоняет CI:
   ```
   git fetch origin && HEAD_SHA=$(gh pr view <номер> --json headRefOid --jq .headRefOid) &&
     gh pr view <номер> --json comments --jq '.comments[].body' > /tmp/pr-comments.txt &&
     COMMENTS_FILE=/tmp/pr-comments.txt HEAD_SHA="$HEAD_SHA" sh tools/ci/check-review-marker.sh
   ```
   Ненулевой код — возврат к шагу 5 (ревью дельты). **Ненулевой выход
   `gh pr merge` не доказывает, что мерж не прошёл** — прежде чем повторять,
   `gh pr view <номер> --json state --jq .state`: `MERGED` — команду не
   повторять, `OPEN` — разбирать сообщение gh.

## CI внутри PR-потока

Джобы независимы, без `needs`. Все, кроме `self-review-marker`, идут на обоих
триггерах (`pull_request`/`push` на `main`). `self-review-marker` пропущена на
`push` в `main`, а на `pull_request` — пока PR черновик. Состав: `lint`,
`tests`, `parity` — см. `.github/workflows/ci.yml` и CONTRIBUTING.md.

`gh pr checks <номер> --required` отвечает `no required checks reported` —
GitHub считает проверку «обязательной» только через branch protection; пока
настройка на репозитории не заведена, обязательность держит процедура, а
работающий рецепт ожидания — `gh pr checks <номер> --watch`.

Снимок — единственный рецепт на вопрос «все ли джобы, кроме
`self-review-marker`, зелёные», одинаковый на черновике и нет:

```
gh pr checks <номер> --json name,bucket --jq '[.[] | select(.name != "self-review-marker")] | length > 0 and all(.bucket == "pass")'
```

Зелёно — только литерал `true`. `false` — пустой список, `pending`/`fail`/
`cancel`/`skipping` у какой-то джобы; какая именно — покажет `gh pr checks
<номер>`. Пустой вывод с ошибкой `no checks reported` — проверки на новом SHA
ещё не зарегистрированы; повторить позже. Дольше минуты — `gh pr view <номер>
--json mergeable --jq .mergeable`: при `CONFLICTING` слить `origin/main` в
ветку (merge, не rebase), разрешить, запушить; `MERGEABLE`/затянувшийся
`UNKNOWN` — сбой вне ветки, остановка с отчётом.

Маркер исключён по имени: его состояние задаёт процедура self-review, а не код
ветки (`skipped` на черновике, `fail` до перезапуска, `pass` после); его
дожидается `--watch` итогового раунда шага 5.

## Симптомные ловушки

1. **`gh pr checks --required` → `no required checks reported`.** Флаг в этом
   репозитории не работает ни при каких обстоятельствах — рабочая замена
   `--watch` и снимок выше.
2. **`git push` в `main` отклонён сервером.** Branch protection требует PR:
   путь — ветка, `gh pr create --draft`, шаги процедуры выше. Аварийный
   обход на уровне GitHub возможен только админу (отключение правила); это
   принятый остаточный риск, названный прямо.
3. **Self-review — только ревью диффа PR**, не репозитория: `gh pr diff
<номер>`, критерии — баги, безопасность, качество. Итог и маркер
   доставляются только ручным `gh pr comment` — встроенный постинг инструментов
   ревью ненадёжен; двойной комментарий (их плюс ручной) — приемлемо: джоба
   ищет маркер среди ВСЕХ комментариев PR.
4. **Правки по находкам ревью едут под маркером нового SHA.** Признак —
   `gh pr view <номер> --json headRefOid --jq .headRefOid` отличается от SHA в
   последней строке `Reviewed at:`. Лечение — ревью дельты и новый маркер,
   шаг 5.

Full reference: [CONTRIBUTING.md](../../CONTRIBUTING.md) in the repository root.
Related: [tests/README.md](../../tests/README.md) (локальные прогоны обвязки).
