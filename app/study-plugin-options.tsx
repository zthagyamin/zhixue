'use client';
import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';

type OptionsHost = {target: HTMLDivElement | null; attach: (element: HTMLDivElement | null) => void};
const OptionsContext = createContext<OptionsHost | null>(null);

/** A portal keeps live controls owned by the plugin; no duplicate draft hooks or event bus. */
export function StudyPluginOptionsProvider({children}: {children: ReactNode}) {
  const [target, attach] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({target, attach}), [target]);
  return <OptionsContext.Provider value={value}>{children}</OptionsContext.Provider>;
}
export function StudyPluginOptionsSlot() {
  const host = useContext(OptionsContext);
  return host ? <div className="study-plugin-options-slot" ref={element => { host.attach(element); }}/> : null;
}
export function StudyPluginOptions({children}: {children: ReactNode}) {
  const host = useContext(OptionsContext);
  if (host) return host.target ? createPortal(children, host.target) : null;
  return <details className="study-context-options"><summary>练习设置</summary>{children}</details>;
}
