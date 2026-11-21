#!/bin/sh
# Предикат маркера self-review: решает джоба `self-review-marker` в CI и сверка
# перед мержем в Skill `.agents/skills/pr-ship-procedure` — один и тот же
# вызов, не две копии правила.
#
# Вход (переменные окружения; сеть скрипт не трогает):
#   COMMENTS_FILE — файл с телами комментариев PR, по одному комментарию подряд,
#                   в хронологическом порядке (`gh pr view <N> --json comments
#                   --jq '.comments[].body'`);
#   HEAD_SHA      — head PR, ровно 40 символов [0-9a-f].
#
# Правило ровно одно: подстрока `Reviewed at: <HEAD_SHA>` в любом месте
# комментариев — принято; всё остальное — отказ. Каждая правка после ревью
# меняет head SHA, и доказательство ревью для нового head — только новый маркер
# после ревью дельты (Skill pr-ship-procedure, шаг self-review); git скрипту
# не нужен.
#
# Коды выхода: 0 — принято; 1 — отказ (последней строкой — `::error::…`);
# 2 — ошибка использования (нет или битый HEAD_SHA, нечитаемый COMMENTS_FILE).

usage() {
	echo "usage: COMMENTS_FILE=<file> HEAD_SHA=<40 hex> sh tools/ci/check-review-marker.sh" >&2
	exit 2
}

# 40 символов, все из [0-9a-f]; проверка до любых других действий.
is_sha() {
	case "$1" in
	*[!0-9a-f]*) return 1 ;;
	esac
	[ "${#1}" -eq 40 ]
}

reject() {
	echo "self-review marker rejected: $1"
	echo "::error::No self-review comment found for head SHA ${HEAD_SHA}. Post a PR comment containing 'Reviewed at: ${HEAD_SHA}' and rerun this job."
	exit 1
}

HEAD_SHA="${HEAD_SHA:-}"
COMMENTS_FILE="${COMMENTS_FILE:-}"

is_sha "$HEAD_SHA" || usage
if [ -z "$COMMENTS_FILE" ] || [ ! -f "$COMMENTS_FILE" ] || [ ! -r "$COMMENTS_FILE" ]; then
	usage
fi

if grep -qF "Reviewed at: ${HEAD_SHA}" "$COMMENTS_FILE"; then
	echo "self-review marker found for head SHA ${HEAD_SHA}"
	exit 0
fi

reject "no marker for head SHA"
