/* eslint-disable @next/next/no-html-link-for-pages -- Native navigation avoids a Vinext production Link runtime failure. */
"use client";

import { useState } from "react";
import { LandingMotion } from "./landing-motion";
import {OnboardingButton} from './onboarding';
import {DISCIPLINES,PLUGIN_CAPABILITIES,type DisciplineId} from './learning-catalog';
import type {PluginType} from './plugin-routing';
import './learning-library.css';

export interface LandingMode {
  id: string;
  name: string;
  description: string;
}

export interface LandingContentProps {
  signedIn?: boolean;
  displayName?: string;
  modes?: LandingMode[];
  studyHref?: string;
}

export function LandingContent({
  signedIn = false,
  displayName,
  modes = [],
  studyHref = "/study",
}: LandingContentProps) {
  const signInHref="/signin-with-chatgpt?return_to="+(studyHref==="/study"?"/study":encodeURIComponent(studyHref));
  const entryHref=signedIn?studyHref:signInHref;
  const [selectedModeId,setActiveTab]=useState<string|null>(null);
  const [discipline,setDiscipline]=useState<DisciplineId>('language');
  const presentations:Record<string,{kind:string;name:string;icon:string}>={
    '@zhixue/plugin-three-stage':{kind:'three-stage',name:'三阶段背词',icon:'📖'},
    '@zhixue/plugin-spelling':{kind:'spelling',name:'拼写',icon:'⌨️'},
    '@zhixue/plugin-flashcard':{kind:'flashcard',name:'闪卡',icon:'🃏'},
    '@zhixue/plugin-quiz':{kind:'choice',name:'单选',icon:'🔘'},
    '@zhixue/plugin-recall':{kind:'recall',name:'回忆',icon:'💡'},
    '@zhixue/plugin-calculation':{kind:'calculation',name:'计算',icon:'🧮'},
    '@zhixue/plugin-code':{kind:'code',name:'代码',icon:'💻'},
  };
  const tabs=Array.from(new Map(modes.map(mode=>[mode.id,mode])).values()).map(mode=>({
    ...mode,...(presentations[mode.id]??{kind:'custom',name:mode.name,icon:'🧩'}),
  }));
  const visibleTabs=tabs.filter(mode=>{const ability=PLUGIN_CAPABILITIES[mode.id.replace('@zhixue/plugin-','') as PluginType];return !ability||ability.disciplines.includes('all')||ability.disciplines.includes(discipline);});
  const preferredKind={language:'three-stage',computing:'code',math:'calculation',courses:'recall',other:'recall'}[discipline];
  const activeMode=visibleTabs.find(tab=>tab.id===selectedModeId)??visibleTabs.find(tab=>tab.kind===preferredKind)??visibleTabs[0];
  const activeTab=activeMode?.id,activeKind=activeMode?.kind;
  const example={
    language:{question:'单词 retain 的常见含义是什么？请给一个例子。',reference:'保留；保持；继续拥有。例如 retain information。',choice:'retain information 中 retain 最接近哪种含义？',options:['删除信息','保留信息','修改信息','寻找信息']},
    computing:{question:'训练集、验证集和测试集分别用于什么？为什么不应拿测试集调参？',reference:'训练集拟合模型；验证集辅助选择设置；测试集用于最终评估。',choice:'调节模型超参数时，应主要依据哪一部分数据？',options:['测试集','验证集','只看一张样本','将三部分混合']},
    math:{question:'导数有什么几何意义？它如何帮助判断函数的单调性？',reference:'导数表示切线斜率与瞬时变化率；在区间内导数恒正时，函数递增。',choice:'若 2x + 3 = 11，那么 x 等于多少？',options:['2','4','8','11']},
    courses:{question:'简述植物光合作用的光反应阶段主要步骤与产物。',reference:'核对水的光解、电子传递，以及 ATP 和 NADPH 的形成。',choice:'光反应释放的氧气主要来自哪种物质？',options:['二氧化碳','水','葡萄糖','叶绿素']},
    other:{question:'解释当前知识点，并给出一个例子和一个适用边界。',reference:'回到原始材料，核对定义、证据和适用条件。',choice:'哪种方式更能检验自己是否理解了一个知识点？',options:['只记得看过','闭卷解释并举例，再核对原文','只重复朗读标题','只看完成进度']},
  }[discipline];
  return (
    <div className="c-landing-root">
      {/* 顶部深色导航栏 */}
      <header className="c-landing-nav">
        <div className="c-nav-inner">
          <div className="c-nav-left">
            <a href="/" className="c-nav-logo">知学</a>
          </div>

          <nav className="c-nav-center" aria-label="主要导航">
            <a href="#hero" className="c-nav-link active">产品</a>
            <a href="#modes" className="c-nav-link">学习方式</a>
            <a href="#data-info" className="c-nav-link">数据说明</a>
          </nav>

          <div className="c-nav-right">
            <OnboardingButton/>
            {signedIn ? (
              <a className="c-nav-login-btn" href={entryHref}>
                {displayName ? `${displayName} · 学习空间` : "进入学习"}
              </a>
            ) : (
              <a className="c-nav-login-btn" href={signInHref}>
                登录
              </a>
            )}
          </div>
        </div>
      </header>

      {/* 1. 深海军蓝首屏 Hero */}
      <section className="c-hero-section" id="hero">
        <div className="c-hero-wrapper">
          <div className="c-hero-copy">
            <h1 className="c-hero-heading">
              让自己的资料，<br />
              成为每天的学习。
            </h1>
            <p className="c-hero-lead">
              用你的资料，训练你的学习系统。按学科进度安排任务，在练习中理解，回忆与巩固。网站相同，学习空间各自独立。
            </p>

            <div className="c-hero-buttons">
              {signedIn ? (
                <>
                  <a className="c-btn-orange" href={entryHref}>
                    继续学习 <span className="c-btn-arrow" aria-hidden="true">→</span>
                  </a>
                  <a className="c-btn-transparent" href="#loop">
                    看看如何学习 <span className="c-btn-arrow" aria-hidden="true">→</span>
                  </a>
                </>
              ) : (
                <>
                  <a className="c-btn-orange" href={signInHref}>
                    登录并创建私人空间 <span className="c-btn-arrow" aria-hidden="true">→</span>
                  </a>
                  <a className="c-btn-transparent" href="#loop">
                    看看如何学习 <span className="c-btn-arrow" aria-hidden="true">→</span>
                  </a>
                </>
              )}
            </div>

            <div className="c-hero-footnote">
              <a href={entryHref} className="c-hero-sample-link">{signedIn?'进入学习 >':'登录后体验 >'}</a>
              <span className="c-hero-footnote-text">
                {signedIn
                  ? `已识别为 ${displayName || "学习者"} · 继续我的学习`
                  : "先浏览首页，登录后进入自己的学习空间。"}
              </span>
            </div>
          </div>

          <div className="c-hero-graphic">
            <LandingMotion>
              <div className="c-hero-perspective-grid">
                {/* 卡片 1: 单词记忆 */}
                <div className="c-3d-card c-card-vocab">
                  <div className="c-3d-card-header">
                    <span className="c-3d-title">单词记忆</span>
                    <span className="c-3d-sample">示例</span>
                  </div>
                  <div className="c-vocab-body">
                    <div className="c-vocab-word">retain</div>
                    <div className="c-vocab-phonetic">{"/rɪ'teɪn/"}</div>
                    <div className="c-vocab-meaning">v. 保留；保持；继续拥有</div>
                  </div>
                  <span className="c-card-example-caption">释义示例</span>
                </div>

                {/* 卡片 2: Python 练习 */}
                <div className="c-3d-card c-card-code">
                  <div className="c-3d-card-header">
                    <span className="c-3d-title">Python 练习</span>
                    <span className="c-3d-sample">示例</span>
                  </div>
                  <div className="c-code-body">
                    <pre className="c-code-text">
                      <code>
                        <span className="kw">def</span> <span className="fn">is_prime</span>(n):{"\n"}
                        {"  "}<span className="kw">if</span> n &lt; 2:{"\n"}
                        {"    "}<span className="kw">return</span> <span className="bool">False</span>{"\n"}
                        {"  "}<span className="kw">for</span> i <span className="kw">in</span> range(2, int(n**0.5) + 1):{"\n"}
                        {"    "}<span className="kw">if</span> n % i == 0:{"\n"}
                        {"      "}<span className="kw">return</span> <span className="bool">False</span>{"\n"}
                        {"  "}<span className="kw">return</span> <span className="bool">True</span>
                      </code>
                    </pre>
                  </div>
                  <span className="c-card-example-caption">代码示例 · 此处不运行</span>
                </div>

                {/* 卡片 3: 今日学习计划 */}
                <div className="c-3d-card c-card-plan">
                  <div className="c-3d-card-header">
                    <span className="c-3d-title">今日学习计划</span>
                    <span className="c-3d-sample">示例</span>
                  </div>
                  <div className="c-plan-item-row">
                    <div>
                      <div className="c-plan-item-name">新词 20</div>
                      <div className="c-plan-item-stat">已完成 8 / 20</div>
                    </div>
                    <span className="c-plan-arrow">&gt;</span>
                  </div>
                  <div className="c-plan-divider" />
                  <div className="c-plan-item-row">
                    <div>
                      <div className="c-plan-item-name">必做复习</div>
                      <div className="c-plan-item-stat">待完成 6 项</div>
                    </div>
                    <span className="c-plan-arrow">&gt;</span>
                  </div>
                </div>

                {/* 卡片 4: 学习记录 */}
                <div className="c-3d-card c-card-sync">
                  <div className="c-3d-card-header">
                    <span className="c-3d-title">学习记录</span>
                    <span className="c-3d-sample">示例</span>
                  </div>
                  <div className="c-sync-body">
                    <div className="c-sync-title">已完成练习</div>
                    <div className="c-sync-count">4 项</div>
                    <div className="c-sync-desc">
                      记录回到学习库<br />由 Companion 完成
                    </div>
                  </div>
                  <div className="c-sync-folder-icon" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
                    </svg>
                  </div>
                </div>
              </div>
            </LandingMotion>
          </div>
        </div>
      </section>

      {/* 2. 从资料，到练习，再回到知识库 */}
      <section className="c-white-section" id="loop">
        <div className="c-section-inner">
          <div className="c-section-heading-box">
            <h2 className="c-section-title">从资料，到练习，再回到知识库。</h2>
          </div>

          {/* 上层 3 步圆形流程 */}
          <div className="c-steps-flow">
            <div className="c-step-node">
              <div className="c-step-circle-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                  <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242M12 12v9m-4-4 4-4 4 4" />
                </svg>
              </div>
              <div className="c-step-text">
                <div className="c-step-label">01 连接资料</div>
                <div className="c-step-desc">从知识库或文件导入，建立属于你的知识题库。</div>
              </div>
            </div>

            <div className="c-step-dashed-arrow" aria-hidden="true">
              <span className="c-dashed-line" />
              <span className="c-dashed-arrow-head">&gt;</span>
            </div>

            <div className="c-step-node">
              <div className="c-step-circle-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                  <rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
              </div>
              <div className="c-step-text">
                <div className="c-step-label">02 按计划学习</div>
                <div className="c-step-desc">按学科进度生成任务，在练习中理解与巩固。</div>
              </div>
            </div>

            <div className="c-step-dashed-arrow" aria-hidden="true">
              <span className="c-dashed-line" />
              <span className="c-dashed-arrow-head">&gt;</span>
            </div>

            <div className="c-step-node">
              <div className="c-step-circle-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" /><path d="M6 6h10M6 10h10" />
                </svg>
              </div>
              <div className="c-step-text">
                <div className="c-step-label">03 留下学习记录</div>
                <div className="c-step-desc">学习记录自动写回，资料始终为你所用。</div>
              </div>
            </div>
          </div>

          {/* 下层 3 张带连接箭头的卡片 */}
          <div className="c-flow-cards-container">
            {/* 卡片 1: 连接自己的资料 */}
            <div className="c-flow-card">
              <div className="c-flow-card-head">
                <span className="c-flow-card-title">连接自己的资料</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-flow-card-inner">
                <div className="c-flow-word-term">retain</div>
                <div className="c-flow-word-def">v. 保留；保持；继续拥有</div>
                <div className="c-flow-word-buttons" aria-hidden="true">
                  <span className="c-btn-subtle">取消</span>
                  <span className="c-btn-blue-sm">导入</span>
                </div>
              </div>
            </div>

            {/* 蓝色连接箭头 1 */}
            <div className="c-flow-blue-arrow" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5">
                <path d="M5 12h14m-6-6 6 6-6 6"/>
              </svg>
            </div>

            {/* 卡片 2: 今日学习计划 */}
            <div className="c-flow-card">
              <div className="c-flow-card-head">
                <span className="c-flow-card-title">今日学习计划</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-flow-card-inner">
                <div className="c-flow-plan-row">
                  <div>
                    <div className="c-flow-plan-title">新词 20</div>
                    <div className="c-flow-plan-sub">已完成 8 / 20</div>
                  </div>
                  <span className="c-flow-arrow-gray">&gt;</span>
                </div>
                <div className="c-flow-plan-row">
                  <div>
                    <div className="c-flow-plan-title">必做复习</div>
                    <div className="c-flow-plan-sub">待完成 6 项</div>
                  </div>
                  <span className="c-flow-arrow-gray">&gt;</span>
                </div>
              </div>
            </div>

            {/* 蓝色连接箭头 2 */}
            <div className="c-flow-blue-arrow" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5">
                <path d="M5 12h14m-6-6 6 6-6 6"/>
              </svg>
            </div>

            {/* 卡片 3: 学习记录 */}
            <div className="c-flow-card">
              <div className="c-flow-card-head">
                <span className="c-flow-card-title">学习记录</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-flow-card-inner c-flow-record-inner">
                <div className="c-flow-record-main">
                  <div className="c-flow-record-title">已完成练习 4 项</div>
                  <div className="c-flow-record-sub">记录回到学习库<br />由 Companion 完成</div>
                </div>
                <div className="c-flow-record-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. 一种学习目标，多种练习方式 */}
      <section className="c-gray-section" id="modes">
        <div className="c-section-inner">
          <div className="c-section-heading-box">
            <h2 className="c-section-title">先选学科，再选学习任务。</h2>
            <p className="c-section-subtitle">不同内容，不同练习。理解、回忆与巩固，一起发生。</p>
          </div>

          <div className="c-practice-showcase-layout">
            {/* 学科筛选与横向练习选择，语义和各视口布局一致。 */}
            <div className="c-learning-discipline-picker" aria-label="选择学习学科">{Object.entries(DISCIPLINES).map(([id,value])=><button key={id} aria-pressed={discipline===id} onClick={()=>{setDiscipline(id as DisciplineId);setActiveTab(null);}}>{value.label}</button>)}</div>
            <div className="c-practice-tabs" role="tablist" aria-label="练习方式切换" aria-orientation="horizontal">
              {tabs.map((tab) => {
                const index=visibleTabs.indexOf(tab);
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`tab-${tab.id}`}
                    type="button"
                    hidden={index<0}
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={isActive ? 0 : -1}
                    className={`c-practice-tab-btn ${isActive ? "active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                        e.preventDefault();
                        const next = visibleTabs[(index + 1) % visibleTabs.length];
                        setActiveTab(next.id);
                        document.getElementById(`tab-${next.id}`)?.focus();
                      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                        e.preventDefault();
                        const prev = visibleTabs[(index - 1 + visibleTabs.length) % visibleTabs.length];
                        setActiveTab(prev.id);
                        document.getElementById(`tab-${prev.id}`)?.focus();
                      }
                    }}
                  >
                    <span className="c-tab-btn-icon">{tab.icon}</span>
                    <span className="c-tab-btn-name">{tab.name}</span>
                  </button>
                );
              })}
            </div>

            {/* 右侧对应练习方式的真实示例卡片 */}
            {activeMode ? <div
              role="tabpanel"
              id={`panel-${activeTab}`}
              aria-labelledby={`tab-${activeTab}`}
              className="c-practice-tabpanel"
            >
              {activeKind === "three-stage" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">三阶段背词 · 阶段 1</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-practice-vocab-content">
                      <div className="c-practice-vocab-word">retain</div>
                      <div className="c-practice-vocab-phonetic">{"/rɪ'teɪn/"}</div>
                      <div className="c-practice-vocab-def">v. 保留；保持；继续拥有</div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill">不认识</span>
                      <span className="c-sample-pill">模糊</span>
                      <span className="c-sample-pill c-sample-pill-blue">认识 (示例)</span>
                    </div>
                  </div>
                  <div className="c-practice-card c-practice-card-sub">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">阶段流转逻辑</span>
                      <span className="c-badge-sample">规则说明</span>
                    </div>
                    <ul className="c-practice-steps-list">
                      <li><strong>阶段 1 认义：</strong>先尝试认义，再核对释义</li>
                      <li><strong>阶段 2 语境：</strong>根据例句语境推测含义</li>
                      <li><strong>阶段 3 自评：</strong>闭卷自评，巩固长期记忆</li>
                    </ul>
                  </div>
                </div>
              )}

              {activeKind === "spelling" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">拼写练习</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-practice-spelling-content">
                      <p className="c-practice-prompt">中文释义：<strong>v. 保留；保持；继续拥有</strong></p>
                      <div className="c-spelling-slots">
                        <span className="c-slot-filled">r</span>
                        <span className="c-slot-filled">e</span>
                        <span className="c-slot-filled">t</span>
                        <span className="c-slot-cursor">a</span>
                        <span className="c-slot-empty">_</span>
                        <span className="c-slot-empty">_</span>
                      </div>
                      <p className="c-practice-hint">输入时逐字核对拼写，完成后按页面反馈继续</p>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill c-sample-pill-blue">逐字核对 (示例)</span>
                      <span className="c-sample-pill">发音朗读 (示例)</span>
                    </div>
                  </div>
                </div>
              )}

              {activeKind === "flashcard" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">翻转闪卡</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-flashcard-content">
                      <p className="c-flashcard-q"><strong>正面：</strong>{example.question}</p>
                      <div className="c-flashcard-a-box">
                        <p><strong>背面：</strong>{example.reference}</p>
                      </div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill">忘记</span>
                      <span className="c-sample-pill">困难</span>
                      <span className="c-sample-pill c-sample-pill-blue">良好</span><span className="c-sample-pill">轻松</span>
                    </div>
                  </div>
                </div>
              )}

              {activeKind === "choice" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">单选题</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-choice-content">
                      <p className="c-choice-q">{example.choice}</p>
                      <div className="c-choice-options">
                        {example.options.map((option,i)=><div key={option} className={'c-choice-opt'+(i===1?' selected':'')}>{String.fromCharCode(65+i)}. {option}{i===1?' ✓':''}</div>)}
                      </div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill c-sample-pill-blue">确认选择 (示例)</span>
                    </div>
                  </div>
                </div>
              )}

              {activeKind === "recall" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">回忆练习</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-practice-recall-content">
                      <p className="c-recall-question">
                        {example.question}
                      </p>
                      <div className="c-recall-textarea-placeholder">
                        {example.reference}
                      </div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill c-sample-pill-blue">查看参考要点 (示例)</span>
                    </div>
                  </div>
                </div>
              )}

              {activeKind === "calculation" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">计算练习</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-calculation-content">
                      <p className="c-calculation-q">
                        {discipline==='computing'?'输入图像尺寸为 32×32×3，使用 16 个 5×5 卷积核（stride=1, padding=0），输出特征图的维度是多少？':'解方程：2x + 3 = 11。请先列出步骤，再核对结果。'}
                      </p>
                      <div className="c-calc-formula">
                        {discipline==='computing'?'公式：O = (W - K + 2P)/S + 1 = (32 - 5 + 0)/1 + 1 = 28':'两边减 3，得到 2x = 8；再两边除以 2。'}<br />
                        输出结果：<strong>{discipline==='computing'?'28 × 28 × 16':'x = 4'}</strong>
                      </div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill c-sample-pill-blue">查看逐步推导 (示例)</span>
                    </div>
                  </div>
                </div>
              )}

              {activeKind === "code" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">代码练习</span>
                      <span className="c-badge-sample">静态示例预览</span>
                    </div>
                    <div className="c-practice-code-content">
                      <pre className="c-practice-code-snippet">
                        <code>
                          <span className="kw">def</span> <span className="fn">is_even</span>(n):{"\n"}
                          {"  "}<span className="str">{`"""返回 n 是否为偶数"""`}</span>{"\n"}
                          {"  "}<span className="kw">if</span> n % 2 == 0:{"\n"}
                          {"    "}<span className="kw">return</span> <span className="bool">True</span>{"\n"}
                          {"  "}<span className="kw">else</span>:{"\n"}
                          {"    "}<span className="kw">return</span> <span className="bool">False</span>
                        </code>
                      </pre>
                      <div className="c-practice-code-meta">
                        输入示例: 4 &nbsp;&nbsp; 输出: True
                      </div>
                    </div>
                    <div className="c-practice-actions-row">
                      <span className="c-sample-pill c-sample-pill-blue">运行测试 (示例)</span>
                      <span className="c-sample-pill">修改后重试 (示例)</span>
                    </div>
                  </div>
                </div>
              )}

              {/* 自定义动态扩展插件预览 */}
              {activeKind === "custom" && (
                <div className="c-practice-card-group">
                  <div className="c-practice-card">
                    <div className="c-practice-card-header">
                      <span className="c-practice-type">{activeMode.name}</span>
                      <span className="c-badge-sample">已注册插件</span>
                    </div>
                    <div className="c-practice-plugin-content p-4">
                      <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
                        {activeMode.description}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="c-practice-demo-note">
                💡 首页仅展示练习方式的静态交互预览。真实作答、判题与阶段流转在个人学习空间中运行。
              </div>
            </div> : <p className="c-practice-demo-note">暂无可用的学习方式，登记插件后再展示。</p>}
          </div>

          <div className="c-section-trailing-note">
            更多练习方式，按内容与阶段灵活呈现。
          </div>
        </div>
      </section>

      {/* 4. 每天该学什么，一眼清楚 */}
      <section className="c-white-section" id="plan">
        <div className="c-section-inner">
          <div className="c-plan-header-flex">
            <div>
              <h2 className="c-section-title c-text-left">每天该学什么，一眼清楚。</h2>
              <p className="c-section-subtitle c-text-left">新词与复习分开看，学习目标更明确。</p>
            </div>
            <a href={entryHref} className="c-btn-plan-adjust">调整学习计划</a>
          </div>

          <div className="c-plan-three-grid">
            {/* 列 1: 新词学习 */}
            <div className="c-plan-col-card">
              <div className="c-plan-col-head">
                <span className="c-plan-col-name">新词学习（独立）</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-plan-col-body">
                <div className="c-plan-col-metric">新词 20</div>
                <div className="c-progress-track">
                  <div className="c-progress-fill-orange" style={{ width: "40%" }} />
                </div>
                <div className="c-plan-col-link">
                  <span>已完成 8 / 20</span>
                  <span className="c-plan-arrow-right">&gt;</span>
                </div>
              </div>
            </div>

            {/* 列 2: 必做复习 */}
            <div className="c-plan-col-card">
              <div className="c-plan-col-head">
                <span className="c-plan-col-name">必做复习（独立）</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-plan-col-body">
                <div className="c-plan-col-metric">待完成 6 项</div>
                <div className="c-plan-col-link c-link-spacer">
                  <span>&nbsp;</span>
                  <span className="c-plan-arrow-right">&gt;</span>
                </div>
              </div>
            </div>

            {/* 列 3: 学科目标任务 */}
            <div className="c-plan-col-card">
              <div className="c-plan-col-head">
                <span className="c-plan-col-name">学科目标任务</span>
                <span className="c-badge-sample">示例</span>
              </div>
              <div className="c-plan-col-body c-task-list-container">
                <div className="c-task-item">
                  <span className="c-task-item-name">Python 练习</span>
                  <span className="c-task-item-status">进行中 3 项 &gt;</span>
                </div>
                <div className="c-task-item">
                  <span className="c-task-item-name">论文阅读</span>
                  <span className="c-task-item-status">进行中 2 项 &gt;</span>
                </div>
              </div>
            </div>
          </div>

          <div className="c-plan-info-banner">
            <span className="c-info-icon" aria-hidden="true">ⓘ</span>
            <span>时间可以灵活，复习不会被新活动替代。</span>
          </div>
        </div>
      </section>

      {/* 5. 手机接着学，记录回到自己的知识库 */}
      <section className="c-gray-section" id="sync">
        <div className="c-section-inner">
          <div className="c-sync-split-layout">
            {/* 左侧文字与数据流图 */}
            <div className="c-sync-info-column">
              <h2 className="c-section-title c-text-left">
                手机接着学，<br />
                记录回到自己的知识库。
              </h2>
              <p className="c-section-subtitle c-text-left">
                电脑与手机都能学习，记录统一回到你的知识库。
              </p>

              {/* 数据流三节点横向指示图 */}
              <div className="c-sync-dataflow">
                <div className="c-dataflow-item">
                  <div className="c-dataflow-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                      <ellipse cx="12" cy="5" rx="9" ry="3"/>
                      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                    </svg>
                  </div>
                  <div className="c-dataflow-name">账号题库</div>
                </div>

                <div className="c-dataflow-arrow" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                    <path d="M5 12h14m-6-6 6 6-6 6"/>
                  </svg>
                </div>

                <div className="c-dataflow-item">
                  <div className="c-dataflow-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                  </div>
                  <div className="c-dataflow-name">作答记录</div>
                </div>

                <div className="c-dataflow-arrow" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2">
                    <path d="M5 12h14m-6-6 6 6-6 6"/>
                  </svg>
                </div>

                <div className="c-dataflow-item">
                  <div className="c-dataflow-circle">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2">
                      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
                      <path d="M6 6h10M6 10h10"/>
                    </svg>
                  </div>
                  <div className="c-dataflow-name">学习知识库</div>
                  <div className="c-dataflow-sub">(你的资料持续可用)</div>
                </div>
              </div>

              {/* 规则边界说明卡片 */}
              <div className="c-companion-callout">
                <div className="c-callout-header">
                  <span className="c-callout-icon" aria-hidden="true">💻</span>
                  <strong className="c-callout-title">电脑端 Companion 在线后完成知识库写回。</strong>
                </div>
                <p className="c-callout-text">
                  本地原始资料与在账号题库中登记的题目是两个范畴，需要登记的题目由账号题库提供与管理。支持配置自己的 AI 密钥，透明可控。
                </p>
              </div>
            </div>

            {/* 右侧设备模拟与说明 */}
            <div className="c-sync-visual-column">
              <div className="c-devices-mockup-wrapper">
                {/* 电脑 Mockup */}
                <div className="c-laptop-shell">
                  <div className="c-laptop-screen">
                    <div className="c-laptop-window-bar">
                      <span className="c-win-dot dot-red" />
                      <span className="c-win-dot dot-yellow" />
                      <span className="c-win-dot dot-green" />
                      <span className="c-win-title">知学</span>
                    </div>
                    <div className="c-laptop-screen-content">
                      <div className="c-mini-screen-grid">
                        <div className="c-mini-card">
                          <div className="c-mini-card-head">今日学习计划 <span className="c-mini-badge">示例</span></div>
                          <div className="c-mini-stat">新词 20</div>
                          <div className="c-mini-sub">已完成 8 / 20 &gt;</div>
                          <div className="c-mini-stat mt-2">必做复习</div>
                          <div className="c-mini-sub">待完成 6 项 &gt;</div>
                        </div>
                        <div className="c-mini-card">
                          <div className="c-mini-card-head">学习记录 <span className="c-mini-badge">示例</span></div>
                          <div className="c-mini-stat">已完成练习 4 项</div>
                          <div className="c-mini-note">记录回到学习库<br />由 Companion 完成</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="c-laptop-deck" />
                </div>

                {/* 手机 Mockup */}
                <div className="c-phone-shell">
                  <div className="c-phone-screen">
                    <div className="c-phone-notch" />
                    <div className="c-phone-header">
                      <span>知学</span>
                    </div>
                    <div className="c-phone-body">
                      <div className="c-phone-card">
                        <div className="c-phone-card-title">今日学习计划</div>
                        <div className="c-phone-card-val">新词 20</div>
                        <div className="c-phone-card-sub">已完成 8 / 20 &gt;</div>
                      </div>
                      <div className="c-phone-card">
                        <div className="c-phone-card-title">学科目标任务</div>
                        <div className="c-phone-card-val">Python 练习</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 设备下方双列说明 */}
              <div className="c-devices-labels-row">
                <div className="c-device-label-item">
                  <div className="c-device-label-icon">💻</div>
                  <div className="c-device-label-text">
                    <strong>电脑</strong>
                    <p>安装并登录 Windows Companion，学习记录在线时写回到知识库。</p>
                  </div>
                </div>
                <div className="c-device-label-item">
                  <div className="c-device-label-icon">📱</div>
                  <div className="c-device-label-text">
                    <strong>手机</strong>
                    <p>通过浏览器登录账号，随时随地继续学习。</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. Companion 的完整数据声明与使用条件 */}
      <section className="c-gray-section" id="data-info">
        <div className="c-section-inner" id="data-details">
          <div className="c-section-heading-box">
            <h2 className="c-section-title">Companion 的完整数据声明</h2>
            <p className="c-section-subtitle">了解原始资料、账号题库与 AI 的分离边界，掌握在线与离线工作机制。</p>
          </div>

          <details className="c-data-details" open>
            <summary className="c-data-details-summary">
              <span className="c-data-details-title">点击展开或折叠详细使用条件与数据流转声明</span>
            </summary>
            <div className="c-data-grid">
              <article className="c-data-card">
                <h3>支持的来源</h3>
                <p>可授权 Obsidian Vault、本地笔记目录，或指定 Markdown、TXT、PDF 文件。Companion 只读取已配置的范围，不自动搜索其他磁盘或个人目录。</p>
              </article>
              <article className="c-data-card">
                <h3>本机保存</h3>
                <p>本机模式的网页进度保存在当前浏览器，Companion 的配对、会话和学习事件保存在本机 SQLite。原始资料保持在自己的资料库中。</p>
              </article>
              <article className="c-data-card">
                <h3>AI 数据流与费用</h3>
                <p>配置本机 AI 后，所选资料片段会发送给对应服务。账号云 AI 需另行填写自己的密钥并确认费用，不自动复制本机凭据。</p>
              </article>
              <article className="c-data-card">
                <h3>可选账号题库</h3>
                <p>账号题库默认关闭，需明确启用。启用后上传已登记词卡，以及练习所需题干、答案、解析和代码素材；不会上传未登记原笔记或本机路径。</p>
              </article>
              <article className="c-data-card">
                <h3>Windows 安装条件</h3>
                <p>当前安装包仅支持 Windows 电脑，已附带运行环境，无需预装 Python。已有 Companion 可直接启动并配对，首次使用才需安装。手机通过浏览器使用已发布的账号题库，无需安装 Windows 程序。</p>
              </article>
              <article className="c-data-card">
                <h3>同步与共用设备</h3>
                <p>关闭 Companion 后，手机仍可学习已发布的题目，新记录等待电脑恢复后写回。共用电脑时请使用不同的 Windows 账户或浏览器 Profile，不在不可信设备连接私人知识库。</p>
              </article>
            </div>
          </details>
        </div>
      </section>

      {/* 7. 页尾收束 Banner 与页脚 */}
      <footer className="c-dark-footer-section" id="footer">
        <div className="c-footer-wrapper">
          {/* 大深色 CTA 横幅 */}
          <div className="c-cta-banner-box">
            <div className="c-cta-banner-left">
              <h2 className="c-cta-banner-title">
                把下一次学习，<br />
                交给一个清楚的开始。
              </h2>
            </div>
            <div className="c-cta-banner-right">
              {signedIn ? (
                <a className="c-btn-banner-orange" href={entryHref}>
                  继续学习 <span className="c-btn-arrow" aria-hidden="true">→</span>
                </a>
              ) : (
                <a className="c-btn-banner-orange" href={signInHref}>
                  登录并创建私人空间 <span className="c-btn-arrow" aria-hidden="true">→</span>
                </a>
              )}
            </div>
          </div>

          {/* 三列支持与特性说明 */}
          <div className="c-footer-columns-row">
            <div className="c-footer-col">
              <div className="c-footer-col-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </div>
              <div className="c-footer-col-content">
                <h4 className="c-footer-col-title">一键安装或更新 Windows Companion</h4>
                <p className="c-footer-col-sub">仅支持 Windows 电脑，已附带运行环境，无需预装 Python · 连接 Obsidian 与普通笔记</p>
                <div style={{ display: "flex", gap: "12px", marginTop: "4px" }}>
                  <a href="/downloads/Zhixue-Companion-Setup.exe" style={{ color: "var(--c-orange-500)", fontSize: "0.8125rem", textDecoration: "underline" }}>下载安装包</a><a href="/companion-guide" className="underline underline-offset-4 text-sm mt-3 inline-block">安装与更新指南 →</a>
                  <a href={signedIn?(studyHref.includes("?")?studyHref:"/study?pair=1"):signInHref} style={{ color: "#94a3b8", fontSize: "0.8125rem", textDecoration: "underline" }}>启动或配对已有 Companion</a>
                </div>
              </div>
            </div>

            <div className="c-footer-col">
              <div className="c-footer-col-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect width="18" height="18" x="3" y="3" rx="2"/>
                  <path d="M12 8v8m-4-4h8"/>
                </svg>
              </div>
              <div className="c-footer-col-content">
                <h4 className="c-footer-col-title">Companion 的完整数据声明</h4>
                <p className="c-footer-col-sub">了解原始资料与账号题库的分离边界，账号题库默认关闭，透明可控。</p>
                <div style={{ marginTop: "4px" }}>
                  <a href="#data-info" style={{ color: "var(--c-orange-500)", fontSize: "0.8125rem", textDecoration: "underline" }}>查看完整数据声明与使用条件 →</a>
                </div>
              </div>
            </div>

            <div className="c-footer-col">
              <div className="c-footer-col-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
                  <path d="M12 18h.01"/>
                </svg>
              </div>
              <div className="c-footer-col-content">
                <h4 className="c-footer-col-title">手机通过浏览器学习</h4>
                <p className="c-footer-col-sub">无需安装 Windows 程序，打开浏览器即可练习账号题库</p>
              </div>
            </div>
          </div>

          {/* 底部版权与导航 */}
          <div className="c-footer-bottom-bar">
            <div className="c-footer-brand-meta">
              <div className="c-footer-brand-logo">知学</div>
              <div className="c-footer-brand-motto">让自己的资料，成为每天的学习。</div>
            </div>

            <div className="c-footer-bottom-links">
              <a href="#hero">产品</a>
              <a href="#modes">学习方式</a>
              <a href="#data-info">数据说明</a>
              <a href="/updates">更新说明</a>
              <a href="/help">使用帮助</a>
              {signedIn ? <a href={entryHref}>继续学习</a> : <a href={signInHref}>登录</a>}
              <span className="c-footer-copyright">© 知学 &nbsp;&nbsp; 保留所有权利</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
