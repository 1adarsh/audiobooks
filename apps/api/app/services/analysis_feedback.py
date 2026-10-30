"""Persist reader corrections for reuse in later analysis of the same book."""

import os
import sqlite3
from contextlib import closing
from pathlib import Path


def _database_path() -> Path:
    configured_directory = os.environ.get("STORYBOOK_DATA_DIR")
    data_directory = (
        Path(configured_directory).expanduser()
        if configured_directory
        else Path.home() / ".local" / "share" / "storybook-audio"
    )
    data_directory.mkdir(parents=True, exist_ok=True)
    return data_directory / "feedback.sqlite3"


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_database_path())
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS analysis_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            category TEXT NOT NULL,
            target_text TEXT NOT NULL,
            corrected_value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    return connection


def save_feedback(book_id: str, category: str, target_text: str, value: str) -> None:
    normalized_book_id = book_id.strip().casefold()
    if not normalized_book_id:
        raise ValueError("Book ID cannot be empty.")

    with closing(_connect()) as connection:
        with connection:
            connection.execute(
                """
                INSERT INTO analysis_feedback (book_id, category, target_text, corrected_value)
                VALUES (?, ?, ?, ?)
                """,
                (normalized_book_id, category, target_text, value),
            )


def get_feedback(book_id: str) -> dict[str, dict[str, str]]:
    normalized_book_id = book_id.strip().casefold()
    with closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT category, target_text, corrected_value
            FROM analysis_feedback
            WHERE book_id = ?
            ORDER BY id
            """,
            (normalized_book_id,),
        ).fetchall()

    corrections: dict[str, dict[str, str]] = {}
    for row in rows:
        category = str(row["category"])
        corrections.setdefault(category, {})[str(row["target_text"])] = str(
            row["corrected_value"]
        )
    return corrections
