"""Коммит state.json с retry-on-conflict.

Логика:
1. git pull --rebase --autostash
2. fail-loud: если остались unmerged paths после autostash unstash — raise
3. git add state.json
4. fail-loud: если staged state.json не парсится как JSON — raise
5. git commit -m "..."  (no-op если нечего коммитить)
6. git push origin <current-branch>
7. На push-rejection — retry с pull+rebase, до 3 попыток

Гарантия: коммит с conflict-маркерами (`<<<<<<<` / `=======` / `>>>>>>>`)
в state.json физически невозможен — детектится двумя независимыми
проверками до `git commit`. Это закрывает регрессию из коммита 09020ac
(10 мая 2026), когда autostash оставил конфликт, скрипт его не заметил,
state.json с маркерами был запушен → следующий run загрузил дефолт и
стёр трёх user'ов.

В CI работает через GITHUB_TOKEN (permissions: contents: write).
Локально — через системный git с пользовательскими credentials.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path

# Префиксы из `git status --porcelain`, означающие unmerged path.
# UU=both modified, AA=both added, DD=both deleted, AU/UA/DU/UD=одна сторона modified, другая deleted.
_UNMERGED_PREFIXES: frozenset[str] = frozenset({"UU", "AA", "DD", "AU", "UA", "DU", "UD"})

log = logging.getLogger(__name__)


class GitSyncError(RuntimeError):
    pass


def commit_and_push(
    repo_root: Path,
    file_to_commit: str,
    *,
    message: str,
    max_retries: int = 3,
    branch: str | None = None,
) -> None:
    """Коммитит и пушит указанный файл с retry на конфликт.

    Если в CI настроены GIT_AUTHOR_NAME/EMAIL — они подхватятся автоматически.
    Если файл не изменился — выйдет тихо (no-op).
    """
    if branch is None:
        branch = _current_branch(repo_root)

    delay = 2.0
    last_exc: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            _run(repo_root, ["git", "pull", "--rebase", "--autostash", "origin", branch])
            _assert_no_unmerged_paths(repo_root)
            _run(repo_root, ["git", "add", file_to_commit])
            # Проверим, есть ли что коммитить
            staged = _run(repo_root, ["git", "diff", "--cached", "--name-only"]).strip()
            if not staged:
                log.info("Нет изменений в %s — push не нужен", file_to_commit)
                return
            _assert_staged_file_valid_json(repo_root, file_to_commit)
            _run(repo_root, ["git", "commit", "-m", message])
            _run(repo_root, ["git", "push", "origin", branch])
            return
        except GitSyncError as exc:
            last_exc = exc
            log.warning("git sync attempt %d failed: %s", attempt, exc)
            if attempt < max_retries:
                time.sleep(delay)
                delay *= 2

    assert last_exc is not None
    raise GitSyncError(f"All {max_retries} attempts failed: {last_exc}") from last_exc


def _assert_no_unmerged_paths(repo_root: Path) -> None:
    """Проверяет что после git pull --rebase --autostash нет конфликтов.

    Если autostash не смог unstash локальные изменения чисто, в рабочем дереве
    останутся unmerged paths с conflict-маркерами. Без этой проверки скрипт
    радостно сделает `git add` + `git commit` + `git push` файла с маркерами
    внутри — что и произошло в коммите 09020ac.
    """
    status = _run(repo_root, ["git", "status", "--porcelain"])
    bad = [line for line in status.splitlines() if line[:2] in _UNMERGED_PREFIXES]
    if bad:
        raise GitSyncError(
            "После git pull --rebase --autostash остались unmerged paths "
            "(autostash unstash вызвал конфликт): " + "; ".join(bad)
        )


def _assert_staged_file_valid_json(repo_root: Path, file_path: str) -> None:
    """Если коммитим .json — убедимся что staged-версия парсится.

    Вторая линия защиты: даже если git status почему-то соврал, мы прочитаем
    staged blob и попробуем распарсить. JSON с conflict-маркерами или просто
    битый не пройдёт.
    """
    if not file_path.endswith(".json"):
        return
    content = _run(repo_root, ["git", "show", f":{file_path}"])
    try:
        json.loads(content)
    except json.JSONDecodeError as exc:
        raise GitSyncError(
            f"Staged {file_path} не валидный JSON: {exc}"
        ) from exc


def _current_branch(repo_root: Path) -> str:
    out = _run(repo_root, ["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip()
    if not out or out == "HEAD":
        raise GitSyncError("Не удалось определить текущую ветку")
    return out


def _run(repo_root: Path, args: list[str]) -> str:
    """Выполнить git-команду в repo_root, вернуть stdout."""
    result = subprocess.run(
        args,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise GitSyncError(
            f"{' '.join(args)} → exit {result.returncode}: {result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout
