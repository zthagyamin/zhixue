"""Pure legacy activity text normalization, unchanged for compatibility."""
from typing import Any
import re

def clean_markdown_cell(value: Any, limit: int = 180) -> str:
    return re.sub(r"\s+", " ", str(value or "")).replace("|", "\\|")[:limit].strip()
