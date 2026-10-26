"use client";

import { type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { WorkspaceIcon } from "../src/features/workspace-ui";

type NavigationProps = {
  activeId: string;
  homeHref?: string;
  subjects: ReadonlyArray<{ id: string; name: string }>;
  hidden?: boolean;
  settingsCount?: number;
  onNavigate: (id: string) => void;
  onSettings: () => void;
  onLibrary?: () => void;
  accountSection?: ReactNode;
  aiSection?: ReactNode;
  paperEntry?: ReactNode;
};

export function StudyWorkspaceNavigation({
  activeId, homeHref = "/", subjects, hidden, settingsCount = 0,
  onNavigate, onSettings, onLibrary, accountSection, aiSection, paperEntry,
}: NavigationProps) {
  const subjectSelected = subjects.some(subject => subject.id === activeId);

  function closeSubjects(event: MouseEvent<HTMLElement>) {
    const disclosure = event.currentTarget.closest("header")?.querySelector<HTMLDetailsElement>("details.c-subject-disclosure");
    disclosure?.removeAttribute("open");
    return disclosure;
  }

  function chooseSubject(event: MouseEvent<HTMLButtonElement>, id: string) {
    event.currentTarget.closest("details")?.removeAttribute("open");
    onNavigate(id);
  }

  function closeOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !(event.target instanceof Element)) return;
    const disclosure = event.target.closest<HTMLDetailsElement>("details[open]");
    if (!disclosure) return;
    disclosure.removeAttribute("open");
    disclosure.querySelector("summary")?.focus();
    event.preventDefault();
  }

  return <header data-ai-private className="study-workspace-nav workspace-navigation" hidden={hidden}>
    <a href={homeHref} className="c-workspace-brand" aria-label="返回首页" title="返回网站首页">
      <span className="workspace-brand-mark"><WorkspaceIcon name="book" size={23} /></span>
      <span className="workspace-brand-copy"><strong>知学</strong><small>LEARNING WORKSPACE</small></span>
    </a>
    <span className="workspace-nav-caption" aria-hidden="true">学习空间</span>
    <nav className="c-workspace-tabs" aria-label="主导航">
      <button type="button" data-study-return="today" className="c-workspace-tab" aria-label="今日" aria-current={activeId === "today" ? "page" : undefined} onClick={event => { closeSubjects(event); onNavigate("today"); }}>
        <WorkspaceIcon name="today" /><span>今日</span><span className="workspace-nav-current-mark" aria-hidden="true" />
      </button>
      <details className="c-subject-disclosure">
        <summary onKeyDown={closeOnEscape} className="c-workspace-tab" aria-label="学科" aria-current={subjectSelected ? "page" : undefined}>
          <WorkspaceIcon name="subjects" /><span>学科</span><WorkspaceIcon name="chevron" size={14} className="workspace-subject-chevron" />
        </summary>
        <div className="c-subject-popover" aria-label="今日学习模块"><div role="presentation" onKeyDown={closeOnEscape}>
          <div className="workspace-subject-heading"><span>我的学习内容</span>
            <button type="button" className="workspace-subject-close" aria-label="收起学科" onClick={event => { closeSubjects(event)?.querySelector("summary")?.focus(); }}><WorkspaceIcon name="close" size={18} /></button>
          </div>
          {onLibrary && <button type="button" className="workspace-library-link" onClick={event => { closeSubjects(event); onLibrary(); }}><WorkspaceIcon name="subjects" size={17} /><span>浏览学科库</span><WorkspaceIcon name="arrow" size={16} /></button>}
          <div className="workspace-subject-list">
            {subjects.length ? subjects.map(subject => <button type="button" data-study-return={`nav:${subject.id}`} key={subject.id} aria-label={subject.name} aria-current={activeId === subject.id ? "page" : undefined} onClick={event => chooseSubject(event, subject.id)}>
              <span className="workspace-subject-dot" aria-hidden="true" /><span>{subject.name}</span><WorkspaceIcon name="arrow" size={15} />
            </button>) : <p>暂无可学习的学科</p>}
          </div>
          {paperEntry && <div className="c-paper-nav-entry">{paperEntry}</div>}
        </div></div>
      </details>
      <button type="button" className="c-workspace-tab" aria-label="学习进度" aria-current={activeId === "progress" ? "page" : undefined} onClick={event => { closeSubjects(event); onNavigate("progress"); }}>
        <WorkspaceIcon name="progress" /><span>进度</span><span className="workspace-nav-current-mark" aria-hidden="true" />
      </button>
      <button type="button" className="c-workspace-tab c-workspace-settings" aria-label="数据与设置" aria-current={activeId === "sources" ? "page" : undefined} onClick={event => { closeSubjects(event); onSettings(); }}>
        <WorkspaceIcon name="settings" /><span>设置</span>{settingsCount > 0 && <b className="c-nav-count">{settingsCount}</b>}
      </button>
    </nav>
    <div className="workspace-nav-footer">
      <div className="workspace-nav-footer-note" aria-hidden="true"><span className="workspace-footer-rule" /><span>让每一步学习都有积累</span></div>
      <div className="c-workspace-right-controls">{aiSection}{accountSection}</div>
    </div>
  </header>;
}
