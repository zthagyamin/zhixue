import type { ReactNode, SVGProps } from "react";

type WorkspaceIconName = "book" | "today" | "subjects" | "progress" | "settings" | "chevron" | "arrow" | "close";
type WorkspaceIconProps = SVGProps<SVGSVGElement> & { name: WorkspaceIconName; size?: number };

const iconPaths: Record<WorkspaceIconName, ReactNode> = {
  book: <><path d="M12 6.5C9.6 4.8 6.2 4.2 3.5 5v13c2.8-.8 6.1-.2 8.5 1.5 2.4-1.7 5.7-2.3 8.5-1.5V5c-2.7-.8-6.1-.2-8.5 1.5Z" /><path d="M12 6.5v13" /></>,
  today: <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h3M8 17h5" /></>,
  subjects: <><rect x="3.5" y="4" width="6.5" height="16" rx="1.5" /><path d="M6.75 8h.01M6.75 16h.01" /><path d="m12.7 5.2 4.2-1.1a1.5 1.5 0 0 1 1.8 1.1l3.1 12.4a1.5 1.5 0 0 1-1.1 1.8l-4.2 1.1Z" /><path d="m14 9 5.7-1.5" /></>,
  progress: <><path d="M4 4.5v15h16M8 15v-4M12.5 15V7M17 15v-6" /></>,
  settings: <><path d="m9.5 3-.7 2.3-2.1 1.2-2.3-.5-2 3.5 1.6 1.8v2.4L2.4 15l2 3.5 2.3-.5 2.1 1.2.7 2.3h4.1l.7-2.3 2.1-1.2 2.3.5 2-3.5-1.6-1.8v-2.4l1.6-1.8-2-3.5-2.3.5-2.1-1.2-.7-2.3Z" /><circle cx="11.55" cy="12.25" r="3" /></>,
  chevron: <path d="m8 10 4 4 4-4" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export function WorkspaceIcon({ name, size = 20, ...props }: WorkspaceIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{iconPaths[name]}</svg>;
}
