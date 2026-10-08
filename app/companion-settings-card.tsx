'use client';
import {useState} from 'react';
import {companionSignInLink} from './companion-endpoint';
import './companion-settings-card.css';
import {StudyTermHelp} from './study-term-help';
type Props={endpoint:string;signedIn:boolean;paired:boolean;connected:boolean;detected:string;version:string|null;message:string;code:string;refreshing:boolean;onCode:(value:string)=>void;onLaunch:()=>void;onDetect:()=>void;onPair:()=>void;onSync:()=>void};
export function CompanionSettingsCard(p:Props){
 const port=new URL(p.endpoint).port;const [enteredPort,setEnteredPort]=useState(port);const valid=/^\d{4,5}$/.test(enteredPort)&&Number(enteredPort)>=1024&&Number(enteredPort)<=65535;
 const reachable=p.connected||p.detected==='online';
 const parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(p.version??'');
 const needsDayUpdate=parts&&(Number(parts[1])<1||Number(parts[1])===1&&(Number(parts[2])<38||Number(parts[2])===38&&Number(parts[3])<1));
 return <section className="companion-settings-card" id="companion-pairing" aria-labelledby="companion-settings-title">
  <div className="companion-settings-heading"><div><span className="settings-step">01 · 本机连接</span><h3 id="companion-settings-title">本地资料助手（Companion）</h3><p>读取你选中的笔记，并将学习记录写回。<StudyTermHelp term="companion"/></p></div><span className={'companion-connection-state '+(reachable?'is-ready':'')}>{p.detected==='checking'?'正在检测':reachable?(p.paired?'已配对，可连接':'已运行，待配对'):'网页尚未连接'}</span></div>
  <div className="companion-main-actions"><a className="companion-update" href="/downloads/Zhixue-Companion-Setup.exe" download>下载更新 Companion</a><a className="companion-action" href="zhixue-companion://start" onClick={p.onLaunch}>启动已安装 Companion</a><button type="button" className="companion-action" onClick={p.onDetect} disabled={p.detected==='checking'}>检测连接</button>{p.paired&&<button type="button" className="companion-action" disabled={p.refreshing} onClick={p.onSync}>{p.refreshing?'正在同步…':'立即同步资料'}</button>}</div>
  <p className="companion-update-note">网页用于学习；Companion 连接本机资料与 Notion。账号同步是可选的跨设备功能；使用 AI 时，相关内容会按配置发送给所选服务。</p>
  <p className="companion-update-note">首次安装与更新使用同一安装包。下载后运行，在原目录更新，保留资料和配对；完成后启动程序，再点“检测连接”。</p>
  <div className="companion-runtime-line"><span>当前连接端口：<strong>{port}</strong></span><span>运行版本：{p.version??'检测后显示'}</span><a href="/companion-guide" target="_blank" rel="noreferrer">安装与更新指南 ↗</a></div>
  {!p.signedIn?<p className="companion-pair-row"><a href={companionSignInLink(p.endpoint)}>登录后配对</a><span>可先检测程序是否已启动。</span></p>:!p.paired&&reachable?<div className="companion-pair-row"><label>当前窗口的配对码<input value={p.code} onChange={e=>p.onCode(e.target.value)} autoComplete="one-time-code" placeholder="输入一次性配对码"/></label><button type="button" className="companion-action" onClick={p.onPair} disabled={!p.code.trim()}>立即配对</button></div>:null}
  {needsDayUpdate&&<p className="companion-result" role="status">凌晨跨日同步需要 Companion 1.38.1 或更新版本，请更新后继续；已有资料与待同步记录保留。</p>}
  {p.message&&<p className="companion-result" role="status">{p.message}</p>}
  <details className="companion-help"><summary>点了启动没反应，或网页连不上？</summary><ol><li>请在安装 Companion 的 Windows 电脑上操作。手机或其他电脑无法连接这台电脑的本机地址。</li><li>若没有程序窗口，从开始菜单启动“知学 Companion”，或在原目录双击 start-companion.cmd。首次使用先运行上方安装包。</li><li>窗口有端口和配对码后，允许浏览器询问的“本地网络访问”和“打开本地应用”。两项权限不同；若曾拒绝，可在该网站的浏览器权限设置中恢复。</li><li><a href={p.endpoint+'/v1/health'} target="_blank" rel="noreferrer">打开本机状态页 ↗</a>：若能看到包含 StudyLoopCompanion 的状态信息而本页检测失败，检查网站本地网络权限；若状态页也打不开，检查程序和端口。</li></ol><div className="companion-port-control"><label>程序窗口显示的端口<input inputMode="numeric" value={enteredPort} onChange={e=>setEnteredPort(e.target.value)} maxLength={5}/></label>{valid&&enteredPort!==port&&<a href={'/study?pair=1&companionPort='+Number(enteredPort)}>使用此端口重新连接 →</a>}</div><p>记录程序窗口的第一条错误或网页检测提示，反馈时不要包含配对码、令牌或个人资料。</p></details>
 </section>;
}