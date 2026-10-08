"""Safely update machine-owned regions in user-authored Markdown."""

from __future__ import annotations

import re


def _newline_for(text: str) -> str:
    return "\r\n" if "\r\n" in text else "\n"


def render_managed_block(begin: str, end: str, body: str, newline: str = "\n") -> str:
    normalized = body.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    return newline.join((begin, normalized, end))


def replace_managed_block(text: str, begin: str, end: str, body: str) -> str:
    """Replace one managed block, or insert it immediately after the first H1.

    All text outside the markers is retained byte-for-byte. Ambiguous marker
    states are rejected instead of guessing which user content may be owned.
    """

    begin_count = text.count(begin)
    end_count = text.count(end)
    if begin_count > 1 or end_count > 1:
        raise ValueError("duplicate-managed-block")
    if begin_count != end_count:
        raise ValueError("unbalanced-managed-block")

    newline = _newline_for(text)
    replacement = render_managed_block(begin, end, body, newline)
    if begin_count == 1:
        start = text.index(begin)
        finish = text.index(end, start + len(begin)) + len(end)
        return text[:start] + replacement + text[finish:]

    h1 = re.search(r"(?m)^# [^\r\n]*(?:\r?\n|$)", text)
    if h1:
        position = h1.end()
        return text[:position] + newline + replacement + newline + text[position:]
    frontmatter = re.match(r"\A(?:\ufeff)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)", text)
    if frontmatter:
        position = frontmatter.end()
        separator = newline if text[:position].endswith(('\n', '\r')) else newline + newline
        return text[:position] + separator + replacement + newline + text[position:]
    if not text:
        return replacement + newline
    return replacement + newline + newline + text
