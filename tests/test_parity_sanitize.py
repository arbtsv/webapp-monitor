"""Две копии `sanitize` в бандле обязаны совпадать.

`helpers/artifacts.ts` строит имя снимка, `scripts/common.mjs` отбирает снимки
прогона по тому же префиксу. `.mjs` не импортирует `.ts` без сборки, поэтому
функция повторена; разойдись классы символов — отчёт молча перестанет находить
и упаковывать снимки.
"""

from __future__ import annotations

import re
from pathlib import Path

_BUNDLE = Path(__file__).parent.parent
_SANITIZE = re.compile(r"function sanitize\([^)]*\)[^{]*\{\s*return value\.replace\((/[^\n]*?/g), '_'\);")


def _sanitize_regex(relative: str) -> str:
    text = (_BUNDLE / relative).read_text(encoding="utf-8")
    found = _SANITIZE.findall(text)
    assert len(found) == 1, f"{relative}: ожидалась ровно одна функция sanitize, найдено {len(found)}"
    return found[0]


def test_sanitize_copies_match():
    assert _sanitize_regex("helpers/artifacts.ts") == _sanitize_regex("scripts/common.mjs")
