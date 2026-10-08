'use client';
import {createContext,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {readStudyIdentity} from './account-study-load-state';
import {shouldAutoOpenOnboarding,initialOnboarding,chooseOnboardingProgress,readOnboarding,saveOnboarding,cancelOnboardingLogin,onboardingStudyHref,prepareOnboardingLogin,consumeOnboardingLogin,ONBOARDING_STEP_COUNT,type OnboardingProgress} from './onboarding-state';
import './onboarding.css';
import './study-first-visit.css';
import announcements from './release-announcements.json';
import {createStudyVisitSession,type StudyVisitDecision} from './study-visit-state';
import {useManagedDialog} from './use-managed-dialog';

const TutorialContext=createContext<(()=>void)|null>(null);
type StudyArrival={scope:string|null;visit:StudyVisitDecision|null;tutorialOpen:boolean;dismissWelcome:()=>void};
const StudyArrivalContext=createContext<StudyArrival>({scope:null,visit:null,tutorialOpen:false,dismissWelcome:()=>{}});
export const useStudyArrival=()=>useContext(StudyArrivalContext);
export function StudyWelcome({scope,isDemo}:{scope:string;isDemo:boolean}){
  const arrival=useStudyArrival();
  if(arrival.scope!==scope||!arrival.visit?.showWelcome||arrival.tutorialOpen)return null;
  return <aside className="study-first-visit" aria-label="知学入门指引">
    <details className="study-first-visit-explanation">
      <summary><strong>{isDemo?'先用自己的笔记试学':'从下方今日安排开始'}</strong></summary>
      <p>{isDemo?'粘贴一段正文，先答三题，再决定是否保存。':'先查看下方今日安排；尚未安排时，生成草稿并确认。想自己选内容，可进入按学科学习。'}</p>
    </details>
    <div className="study-first-visit-actions">
      <OnboardingButton/><button type="button" aria-label="收起入门指引" onClick={arrival.dismissWelcome}>收起</button>
    </div>
  </aside>;
}
/** Only one automatic modal may own the screen. A dialog that is already open — for example the
 * release announcement shown once in the workspace — keeps the tutorial closed until the learner
 * opens it from a visible control, so dismissing one modal never reveals another underneath. */
function automaticModalBlocked(){return typeof document!=='undefined'&&document.querySelector('dialog[open]')!==null;}
const titles=['欢迎来到知学','先认识你的知识库','选择你的起点','先用自己的笔记试三题','AI 与不同设备','完成第一次学习','准备好了，就从一小步开始'];
export function OnboardingButton({className=''}:{className?:string}){const open=useContext(TutorialContext);return <button type="button" className={'onboarding-launcher '+className} onClick={()=>open?.()}>新手教学</button>;}
export function OnboardingProvider({children}:{children:ReactNode}){
  const [progress,setProgress]=useState(initialOnboarding),[open,setOpen]=useState(false),[userId,setUserId]=useState<string|null>(null),[storageError,setStorageError]=useState(false);
  const [destinations,setDestinations]=useState({study:'/study',setup:'/study?pair=1'});
  const scope=useRef<string|null>(null),manual=useRef(false),latest=useRef(initialOnboarding());
  const visitSession=useRef<ReturnType<typeof createStudyVisitSession>|null>(null);
  const [visit,setVisit]=useState<StudyVisitDecision|null>(null);
  function dismissWelcome(){visitSession.current?.dismissWelcome();setVisit(current=>current?{...current,showWelcome:false}:current);}
  function persist(value:OnboardingProgress){try{cancelOnboardingLogin(sessionStorage);}catch{/* Continue without browser storage. */}latest.current=value;setProgress(value);if(scope.current){try{if(!saveOnboarding(localStorage,scope.current,value))setStorageError(true);}catch{setStorageError(true);}}}
  useEffect(()=>{if(window.location.pathname.replace(/\/$/,'')==='/companion-guide')return;const controller=new AbortController();void fetch('/api/session',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}).then(readStudyIdentity).catch(()=>null).then(user=>{
    if(controller.signal.aborted)return;const id=user?.userId??null,current=id?'account:'+id:'guest';scope.current=current;setUserId(id);setDestinations({study:onboardingStudyHref(window.location.search),setup:onboardingStudyHref(window.location.search,true)});
    let saved:OnboardingProgress|null=null,handoff:OnboardingProgress|null=null;
    try{saved=readOnboarding(localStorage,current);handoff=consumeOnboardingLogin(sessionStorage,id);}catch{/* The public teaching still works without browser storage. */}
    const next=manual.current?latest.current:chooseOnboardingProgress(saved,handoff);latest.current=next;setProgress(next);
    if(manual.current||handoff){try{if(!saveOnboarding(localStorage,current,next))setStorageError(true);}catch{setStorageError(true);}}
    const studyPath=/^\/study(?:\/|$)/.test(window.location.pathname);
    if(id&&studyPath){
      const session=createStudyVisitSession(()=>window.localStorage,current);visitSession.current=session;
      setVisit(session.enter(announcements[0].version,next.status!=='active'));
    }
    if(!manual.current)setOpen(shouldAutoOpenOnboarding(next,Boolean(id),window.location.pathname,Boolean(saved||handoff))&&!automaticModalBlocked());
  });return()=>controller.abort();},[]);
  function launch(){setDestinations({study:onboardingStudyHref(window.location.search),setup:onboardingStudyHref(window.location.search,true)});manual.current=true;const next={...latest.current,step:latest.current.status==='completed'?0:latest.current.step};persist(next);setOpen(true);}
  function acknowledge(status:'skipped'|'completed'){dismissWelcome();manual.current=true;const next={...latest.current,status};persist(next);if(!userId){try{prepareOnboardingLogin(sessionStorage,next);}catch{/* Current-page dismissal still works. */}}setOpen(false);}
  function skip(){acknowledge('skipped');}
  function change(value:Partial<OnboardingProgress>){manual.current=true;persist({...latest.current,...value});}
  function finish(){acknowledge('completed');}
  function signIn(complete=false){const next={...latest.current,status:complete?'completed' as const:'active' as const};persist(next);try{prepareOnboardingLogin(sessionStorage,next);}catch{/* Login remains available. */}window.location.assign('/signin-with-chatgpt?return_to='+encodeURIComponent(onboardingStudyHref(window.location.search)+(complete?'#note-trial':'')));}
  return <StudyArrivalContext.Provider value={{scope:userId?'account:'+userId:null,visit,tutorialOpen:open,dismissWelcome}}><TutorialContext.Provider value={launch}>{children}{open&&<OnboardingDialog progress={progress} signedIn={!!userId} storageError={storageError} studyHref={destinations.study} setupHref={destinations.setup} onSkip={skip} onChange={change} onFinish={finish} onSignIn={signIn}/>}</TutorialContext.Provider></StudyArrivalContext.Provider>;
}

type DialogProps={progress:OnboardingProgress;signedIn:boolean;storageError:boolean;studyHref?:string;setupHref?:string;onSkip:()=>void;onChange:(value:Partial<OnboardingProgress>)=>void;onFinish:()=>void;onSignIn:(complete?:boolean)=>void};
export function OnboardingDialog({progress,signedIn,storageError,studyHref='/study',setupHref='/study?pair=1',onSkip,onChange,onFinish,onSignIn}:DialogProps){
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null),id=useId();
  const managed=useManagedDialog(dialog,true,onSkip);
  useEffect(()=>{heading.current?.focus({preventScroll:true});dialog.current?.querySelector('.onboarding-body')?.scrollTo(0,0);},[progress.step]);
  const last=progress.step===ONBOARDING_STEP_COUNT-1;
  return <dialog ref={dialog} className="site-onboarding" aria-labelledby={id} data-ai-private onClose={managed.onNativeClose} onCancel={event=>{event.preventDefault();managed.close();}}>
    <header><span>知学 · 新手教学</span><button type="button" onClick={onSkip} aria-label="跳过新手教学，稍后再看">稍后再看</button></header>
    <div className="onboarding-body"><p className="onboarding-counter">第 {progress.step+1} / {ONBOARDING_STEP_COUNT} 步 · 约 3 分钟</p><h2 ref={heading} tabIndex={-1} id={id}>{titles[progress.step]}</h2>
      <ol className="onboarding-track" aria-label="教学进度">{titles.map((title,index)=><li key={title} data-current={index===progress.step} data-done={index<progress.step} aria-label={`${index+1} ${title}`}/>)}</ol>
      <OnboardingLesson step={progress.step} path={progress.path} onPath={path=>onChange({path})}/>
      {!last&&<div className="onboarding-start">{signedIn?<a className="onboarding-primary" href={`${studyHref}#note-trial`} onClick={onFinish}>现在用自己的笔记试三题</a>:<button type="button" className="onboarding-primary" onClick={()=>onSignIn(true)}>登录后用自己的笔记试三题</button>}<p>无需安装 Companion 或配置 AI；也可以继续阅读教学。</p></div>}
      {last&&<div className="onboarding-start"><p>教学看完了，但还没有产生任何练习成绩。粘贴一段自己的笔记，完成三题后可保存到本机材料列表。</p>{signedIn?<a className="onboarding-primary" href={`${studyHref}#note-trial`} onClick={onFinish}>用自己的笔记试三题</a>:<button type="button" className="onboarding-primary" onClick={()=>onSignIn(true)}>登录后用自己的笔记试三题</button>}{signedIn&&<a href={setupHref} onClick={onFinish}>需要持续同步？连接资料</a>}</div>}
      {storageError&&<p role="status">浏览器暂时无法保存阅读进度，下次可能再次显示；这不影响继续使用网站。</p>}
    </div>
    <footer><button type="button" disabled={progress.step===0} onClick={()=>onChange({step:progress.step-1})}>上一步</button><span>可跳过，也可在设置中重新打开</span>{last?<button type="button" onClick={onFinish}>完成教学</button>:<button type="button" className="onboarding-primary" onClick={()=>onChange({step:progress.step+1})}>下一步</button>}</footer>
    {!signedIn&&!last&&<div className="onboarding-login"><button type="button" onClick={()=>onSignIn(false)}>现在登录，接着看教学</button></div>}
  </dialog>;
}

export function OnboardingLesson({step,path,onPath}:{step:number;path:OnboardingProgress['path'];onPath:(path:'existing'|'new')=>void}){
  if(step===0)return <><p>知学把你自己的笔记、课程和阅读材料变成可练习的内容，帮助你从“看过”走到“能够回忆和运用”。</p><div className="onboarding-loop"><span>准备资料</span><b>→</b><span>自己作答</span><b>→</b><span>反馈与复习</span></div><p>这份教学会带你认识知识库、选择接入方式，并找到 AI 和第一次学习的入口。登录前也可以先了解。</p></>;
  if(step===1)return <><p><strong>知识库可以只是一个存放笔记的文件夹。</strong>不必先学复杂插件、标签或自动化。</p><div className="onboarding-examples"><article><h3>原始材料</h3><p>你的课堂笔记、教材片段、词汇表或论文。</p></article><article><h3>练习与记录</h3><p>由材料提取的问题，以及你真正做过的回答和复习。</p></article></div><p>原文与学习记录分开保存。AI 生成摘要、同步成功或下载示例，都不等于你已经掌握。</p></>;
  if(step===2)return <><p>两条路径都可以进入知学，选最接近你现在情况的即可。</p><div className="onboarding-choices"><button type="button" aria-pressed={path==='existing'} onClick={()=>onPath('existing')}><strong>我已有知识库</strong><span>保留原来的 Obsidian 库、Notion 页面或笔记目录，只选少量资料接入。</span></button><button type="button" aria-pressed={path==='new'} onClick={()=>onPath('new')}><strong>我还没有知识库</strong><span>从最小目录、模板和一份材料开始，之后再慢慢扩展。</span></button></div><p>这里的选择只是帮助理解，不会移动、上传或修改任何笔记。</p></>;
  if(step===3)return <><p><strong>先用一小段自己的材料试学，无需安装或配置。</strong></p><ol><li>进入“用自己的笔记试学”，粘贴正文，或选择 Markdown / TXT 文件。</li><li>先自己回答，再查看原文；仍不熟悉的题可标记，结束后只练这些题。</li><li>完成后按学科保存到本机待学材料，下次在学科列表中搜索并重新打开。</li></ol><p>本机材料只在当前设备、当前浏览器保留，不同步到账号或 Obsidian，不计入正式成绩。换设备前请保留原文件。</p><details><summary>之后需要持续同步或写回笔记时</summary><p>在 Windows 安装 Companion，登录配对后，选择 Obsidian、Notion 或本机资料并核对预览。无需提前安装 Python 或 Obsidian。</p><div className="onboarding-resources"><a href="/companion-guide" target="_blank" rel="noreferrer">Companion 安装与更新指南</a><a href="/knowledge-starter-kit/structure.zip" download>下载知识库入门包</a><a href="/knowledge-starter-kit/OBSIDIAN.md" download>Obsidian 从零建库与已有库接入</a><a href="/knowledge-starter-kit/CONNECTIONS.md" download>Notion 与其他来源接入</a></div></details></>;
  if(step===4)return <><p><strong>“问 AI”用于解释、提示和讨论，不替你完成学习。</strong>先说自己的想法，再请求一个小提示，通常更有帮助。</p><ul><li>“数据与设置 → AI 与 API Key 设置”可选择提供商和模型。已关联账号学习库后，手机和平板也能配置账号 AI。</li><li>模型 API 可能收费，由你的 API 账户承担；网页登录不会自动提供 API 额度。不要把密钥发进聊天或笔记。</li><li>“页面布局”可选自动、电脑版、平板版、手机版，并在当前浏览器记住选择。</li></ul><p>未配置 AI 也可以先整理材料、阅读和使用支持自评的练习。你不必先把所有功能都设置完。</p></>;
  if(step===5)return <><p>第一次先做一道题，确认自己理解整个过程。</p><ol><li>找到一条来自所选资料的题目，先不看答案，自己尝试。</li><li>需要时看小提示，最后对照依据，找出差异。</li><li>按实际情况评价，并查看保存或同步提示。</li><li>下一次先回忆仍不熟悉的问题，再开始新内容。</li></ol><p><strong>“已保存”“待同步”“已写回”是不同状态。</strong>等待时保留原记录，不用反复新建题库或补造学习记录。</p></>;
  return <><p>记住三个入口就够了：</p><ul><li><strong>今日：</strong>查看计划或进入学科练习。</li><li><strong>数据与设置：</strong>接入资料、配置 AI、切换布局。</li><li><strong>新手教学 / 知识库入门包：</strong>重新阅读说明、下载模板和排错指南。</li></ul><p>先从一个主题、一份材料和一次真实回答开始。</p></>;
}
