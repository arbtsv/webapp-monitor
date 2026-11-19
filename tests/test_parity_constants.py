"""Синхронность констант `scripts/common.mjs` с TS-эквивалентами.

Скрипты `scripts/*.mjs` работают без сборки TypeScript, поэтому пути и другие
константы, уже объявленные в `helpers/*.ts`, повторены текстом в `common.mjs`. Этот
модуль сверяет: одноимённые однострочные `export const` между `common.mjs` и
`helpers/*.ts`; пары json/html-выходов в `playwright.config.ts` с
`LAST_RUN_JSON`/`LAST_RUN_RECHECK_JSON`/`REPORT_DIR`/`REPORT_RECHECK_DIR` в
`common.mjs`; суффикс перепроверки `RECHECK_SUFFIX` в `common.mjs` с его копией в
`helpers/global-setup.ts`.
Автоматически НЕ ловится: константа, повторённая под другим именем, или та же константа,
встроенная литералом в новом месте, — такую пару нужно дописать в тест руками.
"""

from __future__ import annotations

import re
from pathlib import Path

_BUNDLE = Path(__file__).parent.parent

_EXPORT_RE = re.compile(r"^export const (\w+) = (.+);$", re.M)

# Разные по построению, не дрейф: ESM import.meta.url в common.mjs против CJS
# __dirname в helpers/config.ts.
_DIFFERENT_BY_CONSTRUCTION = {
    "BUNDLE_ROOT": "ESM import.meta.url (common.mjs) против CJS __dirname (helpers/config.ts)",
}

# Минимум одноимённых констант, которые обязаны сверяться — защита от пустого
# прохода, если регэксп однострочного экспорта перестанет что-либо находить.
_EXPECTED_SHARED_FLOOR = {
    "ARTIFACTS_DIR",
    "CSV_PATH",
    "RUN_ID_PATH",
    "RUNS_CSV_PATH",
    "SCREENSHOT_DIR",
}


def _exports(text: str) -> dict[str, str]:
    """Однострочные `export const NAME = RHS;`; хвост ` as const` снят с RHS.

    Многострочные объявления (массив `ENTRY_RESERVE_RUNS_COLUMNS`, объект
    `OLYMP_METRIC_LABELS`) и типизированные (`NAME: Type = ...`) не захватываются:
    регэксп разбирает только однострочный экспорт без аннотации типа.
    """
    result: dict[str, str] = {}
    for name, rhs in _EXPORT_RE.findall(text):
        if rhs.endswith(" as const"):
            rhs = rhs[: -len(" as const")]
        result[name] = rhs
    return result


def _helper_texts() -> dict[str, str]:
    return {f"helpers/{p.name}": p.read_text(encoding="utf-8") for p in sorted((_BUNDLE / "helpers").glob("*.ts"))}


def _shared_mismatches(common_text: str, helper_texts: dict[str, str]) -> tuple[set[str], list[str]]:
    """Общие однострочные экспорты common.mjs и helpers/*.ts плюс список расхождений.

    `helper_texts` — {относительный путь: текст файла}. Падает через assert, если
    одно имя однострочно экспортировано в двух РАЗНЫХ файлах helpers.
    """
    common_exports = _exports(common_text)

    helper_exports: dict[str, tuple[str, str]] = {}
    for relative, text in helper_texts.items():
        for name, rhs in _exports(text).items():
            if name in helper_exports and helper_exports[name][0] != relative:
                raise AssertionError(
                    f"{name}: однострочный export const определён в двух файлах helpers — "
                    f"{helper_exports[name][0]} и {relative}"
                )
            helper_exports[name] = (relative, rhs)

    shared = (set(common_exports) & set(helper_exports)) - set(_DIFFERENT_BY_CONSTRUCTION)

    mismatches: list[str] = []
    for name in sorted(shared):
        common_rhs = common_exports[name]
        helper_file, helper_rhs = helper_exports[name]
        if common_rhs != helper_rhs:
            mismatches.append(f"{name}: common.mjs = {common_rhs!r}, {helper_file} = {helper_rhs!r}")

    return shared, mismatches


def _artifact_literal(name: str, rhs: str) -> str:
    """Литерал имени файла из `path.join(ARTIFACTS_DIR, '<литерал>')`."""
    m = re.fullmatch(r"path\.join\(ARTIFACTS_DIR, '([^']+)'\)", rhs)
    assert m, f"{name}: RHS не в форме path.join(ARTIFACTS_DIR, '<литерал>'): {rhs!r}"
    return m.group(1)


def test_same_named_exports_match():
    common_text = (_BUNDLE / "scripts" / "common.mjs").read_text(encoding="utf-8")
    shared, mismatches = _shared_mismatches(common_text, _helper_texts())

    missing_floor = _EXPECTED_SHARED_FLOOR - shared
    assert not missing_floor, (
        "Ожидаемые общие константы не найдены как одноимённые однострочные export const "
        f"в common.mjs и helpers/*.ts: {sorted(missing_floor)}"
    )
    assert not mismatches, "Расхождение общих констант:\n" + "\n".join(mismatches)


def test_drift_is_detected():
    common_text = (_BUNDLE / "scripts" / "common.mjs").read_text(encoding="utf-8")

    occurrences = common_text.count("'runs.csv'")
    assert occurrences == 1, f"Ожидалось ровно одно вхождение 'runs.csv' в common.mjs, найдено {occurrences}"
    drifted_text = common_text.replace("'runs.csv'", "'runs-drift.csv'", 1)

    _, mismatches = _shared_mismatches(drifted_text, _helper_texts())
    assert len(mismatches) == 1, f"Ожидалось ровно одно расхождение на внесённом дрейфе, найдено: {mismatches}"
    assert "RUNS_CSV_PATH" in mismatches[0], f"Расхождение не называет RUNS_CSV_PATH: {mismatches[0]}"


def test_playwright_outputs_match_common():
    common_text = (_BUNDLE / "scripts" / "common.mjs").read_text(encoding="utf-8")
    common_exports = _exports(common_text)

    playwright_text = (_BUNDLE / "playwright.config.ts").read_text(encoding="utf-8")
    pattern = re.compile(
        r"(jsonOutputFile|htmlOutputFolder) = path\.join\(ARTIFACTS_DIR, isRecheck \? '([^']+)' : '([^']+)'\)"
    )
    found = pattern.findall(playwright_text)
    assert len(found) == 2, f"playwright.config.ts: ожидалось 2 тернарника вывода, найдено {len(found)}"

    by_name = {name: (recheck_literal, plain_literal) for name, recheck_literal, plain_literal in found}
    assert set(by_name) == {"jsonOutputFile", "htmlOutputFolder"}, (
        f"playwright.config.ts: ожидались jsonOutputFile и htmlOutputFolder, найдено {sorted(by_name)}"
    )

    json_recheck, json_plain = by_name["jsonOutputFile"]
    html_recheck, html_plain = by_name["htmlOutputFolder"]

    assert json_plain == _artifact_literal("LAST_RUN_JSON", common_exports["LAST_RUN_JSON"])
    assert json_recheck == _artifact_literal("LAST_RUN_RECHECK_JSON", common_exports["LAST_RUN_RECHECK_JSON"])
    assert html_plain == _artifact_literal("REPORT_DIR", common_exports["REPORT_DIR"])
    assert html_recheck == _artifact_literal("REPORT_RECHECK_DIR", common_exports["REPORT_RECHECK_DIR"])


def test_recheck_suffix_matches():
    common_text = (_BUNDLE / "scripts" / "common.mjs").read_text(encoding="utf-8")
    common_exports = _exports(common_text)

    m = re.fullmatch(r"'([^']+)'", common_exports["RECHECK_SUFFIX"])
    assert m, f"RECHECK_SUFFIX RHS не строковый литерал: {common_exports['RECHECK_SUFFIX']!r}"
    common_suffix = m.group(1)

    global_setup_text = (_BUNDLE / "helpers" / "global-setup.ts").read_text(encoding="utf-8")
    found_ts = re.findall(r"`\$\{RECHECK_OF\}([^`$]+)`", global_setup_text)
    assert len(found_ts) == 1, f"global-setup.ts: ожидался один суффикс `${{RECHECK_OF}}...`, найдено {len(found_ts)}"
    assert found_ts[0] == common_suffix, f"global-setup.ts: суффикс {found_ts[0]!r} != RECHECK_SUFFIX {common_suffix!r}"


