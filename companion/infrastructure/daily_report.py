"""Legacy compatibility implementation with explicit composition-root inputs."""
from __future__ import annotations

from pathlib import Path
from datetime import date
from typing import Any
from application.activity_values import clean_markdown_cell


def render_daily_report(day: date, events: list[dict[str, Any]], *, learning_vault_path, now) -> Path:
    report_dir = learning_vault_path(f"_System/Reports/Daily/{day.year}")
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"{day.isoformat()} 学习同步.md"
    minutes = sum(int(item.get("durationMin", 0)) for item in events)
    domain_counts: dict[str, int] = {}
    for item in events:
        domain = str(item.get("domain", "other"))
        domain_counts[domain] = domain_counts.get(domain, 0) + 1
    lines = [
        "---",
        "type: daily-learning-report",
        f"date: {day.isoformat()}",
        "status: derived",
        "source: study-loop",
        f"activity_count: {len(events)}",
        f"duration_min: {minutes}",
        f"updated: {now().date().isoformat()}",
        "tags:",
        "  - 学习系统/日报",
        "  - 系统/同步",
        "---",
        "",
        f"# {day.isoformat()}｜学习同步",
        "",
        "> [!info] 派生记录",
        "> 本页由 Study Loop 根据网站练习事件与 Agent 学习会话生成，不是课程进度或掌握程度的事实源。修改掌握状态仍以 learning-state 和真实证据为准。",
        "",
        "## 当日汇总",
        "",
        f"- 学习活动：{len(events)}",
        f"- 记录时长：{minutes} 分钟",
        "- 领域：" + ("、".join(f"{key} × {value}" for key, value in sorted(domain_counts.items())) or "暂无"),
        "",
        "## 学习活动",
        "",
        "| 时间 | 领域 | 内容 | 结果 | 证据 |",
        "|---|---|---|---|---|",
    ]
    for item in events:
        source_note = clean_markdown_cell(item.get("sourceNote") or item.get("relatedNote"), 240)
        state_ref = clean_markdown_cell(item.get("stateRef"), 240)
        evidence_parts = []
        if source_note:
            evidence_parts.append(f"[[{source_note.removesuffix('.md')}|来源]]")
        if state_ref:
            evidence_parts.append(f"[[{state_ref.removesuffix('.md')}|状态目标]]")
        evidence = " / ".join(evidence_parts) or "—"
        lines.append(
            f"| {clean_markdown_cell(item.get('occurredAt'), 25)[11:16]} | "
            f"{clean_markdown_cell(item.get('domain'))} | {clean_markdown_cell(item.get('title'))} | "
            f"{clean_markdown_cell(item.get('outcome'))} | {evidence} |"
        )
    lines.extend([
        "",
        "## 权威进度入口",
        "",
        "- [[01 学习/学习计划/00 学习计划总览|学习计划总览]]",
        "- [[_System/Integrations/Study Loop/README|Study Loop 同步中心]]",
        "",
    ])
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path
