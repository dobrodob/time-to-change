"""Регрессии для git_sync.commit_and_push.

Конкретно — два инварианта, нарушение которых стёрло user'ов 10 мая 2026:
1. Если после `git pull --rebase --autostash` остался unmerged path —
   мы НЕ должны делать commit (раньше — делали, и пушили файл с маркерами).
2. Если staged state.json не парсится как JSON — мы тоже не должны
   делать commit (вторая линия защиты на случай если git status ничего не показал).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.state import git_sync
from src.state.git_sync import GitSyncError, commit_and_push


class FakeGit:
    """Скриптуемый мок subprocess-обёртки git_sync._run.

    Записываем сценарий response'ов по command-substring, плюс пишем все вызовы
    в `calls` для assertion'ов.
    """

    def __init__(self, responses: dict[str, str | Exception]):
        self.responses = responses
        self.calls: list[list[str]] = []

    def __call__(self, repo_root: Path, args: list[str]) -> str:
        self.calls.append(list(args))
        joined = " ".join(args)
        for needle, response in self.responses.items():
            if needle in joined:
                if isinstance(response, Exception):
                    raise response
                return response
        return ""


def _patch_run(monkeypatch: pytest.MonkeyPatch, fake: FakeGit) -> None:
    monkeypatch.setattr(git_sync, "_run", fake)


def test_commit_aborts_on_unmerged_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """git status --porcelain возвращает UU → raise, без commit/push."""
    fake = FakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "pull --rebase --autostash": "",
        "status --porcelain": "UU state.json\n M other.py\n",
    })
    _patch_run(monkeypatch, fake)

    with pytest.raises(GitSyncError, match="unmerged paths"):
        commit_and_push(tmp_path, "state.json", message="test", max_retries=1)

    # Главное: ни git commit, ни git push не были вызваны
    all_args = [" ".join(c) for c in fake.calls]
    assert not any("commit -m" in c for c in all_args), f"commit вызвался: {all_args}"
    assert not any("push origin" in c for c in all_args), f"push вызвался: {all_args}"


def test_commit_aborts_on_invalid_staged_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """git status чистый, но staged state.json — мусор. Должны упасть до commit."""
    bad_staged = """{
  "schema_version": 3,
<<<<<<< Updated upstream
  "updated_at": "2026-05-10T11:27:50Z",
=======
  "updated_at": "2026-05-10T11:28:22Z",
>>>>>>> Stashed changes
"""
    fake = FakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "pull --rebase --autostash": "",
        "status --porcelain": "",  # git status чистый (не показывает unmerged)
        "add state.json": "",
        "diff --cached --name-only": "state.json\n",
        "show :state.json": bad_staged,
    })
    _patch_run(monkeypatch, fake)

    with pytest.raises(GitSyncError, match="не валидный JSON"):
        commit_and_push(tmp_path, "state.json", message="test", max_retries=1)

    all_args = [" ".join(c) for c in fake.calls]
    assert not any("commit -m" in c for c in all_args), f"commit вызвался: {all_args}"
    assert not any("push origin" in c for c in all_args), f"push вызвался: {all_args}"


def test_commit_skips_when_nothing_staged(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Если staged ничего нет — выходим без commit/push, тихо."""
    fake = FakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "pull --rebase --autostash": "",
        "status --porcelain": "",
        "add state.json": "",
        "diff --cached --name-only": "",
    })
    _patch_run(monkeypatch, fake)

    commit_and_push(tmp_path, "state.json", message="test", max_retries=1)

    all_args = [" ".join(c) for c in fake.calls]
    assert not any("commit -m" in c for c in all_args)
    assert not any("push origin" in c for c in all_args)
    # show тоже не должны были звать (нечего validate)
    assert not any("show :state.json" in c for c in all_args)


def test_commit_happy_path_pushes_valid_json(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Sanity: чистый случай — git status OK + staged JSON валидный → commit+push идут."""
    fake = FakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "pull --rebase --autostash": "",
        "status --porcelain": "",
        "add state.json": "",
        "diff --cached --name-only": "state.json\n",
        "show :state.json": '{"schema_version": 3, "telegram": {"users": []}}',
        "commit -m": "",
        "push origin": "",
    })
    _patch_run(monkeypatch, fake)

    commit_and_push(tmp_path, "state.json", message="chore(state): tick", max_retries=1)

    all_args = [" ".join(c) for c in fake.calls]
    assert any("commit -m chore(state): tick" in c for c in all_args)
    assert any("push origin main" in c for c in all_args)


def test_non_json_file_skips_validation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Файлы не .json не валидируются JSON-парсером — git show не вызывается."""
    fake = FakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "pull --rebase --autostash": "",
        "status --porcelain": "",
        "add README.md": "",
        "diff --cached --name-only": "README.md\n",
        "commit -m": "",
        "push origin": "",
    })
    _patch_run(monkeypatch, fake)

    commit_and_push(tmp_path, "README.md", message="docs", max_retries=1)

    all_args = [" ".join(c) for c in fake.calls]
    assert not any("show :README.md" in c for c in all_args)
    assert any("push origin" in c for c in all_args)
