'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {StudyAIProvider,StudyAISettings as Settings} from '../../ai/study-ai-types';
import {suggestedStudyAIModel,studyAIErrorMessage} from '../../ai/study-ai-errors';
import {studyAIModelChoices} from '../../ai/study-ai-models';
import {useStudyAIWorkspace} from './study-ai-workspace';
export function StudyAISettings(){
 const {settings,error,reload}=useStudyAIWorkspace();
 if(!settings)return <div className="study-ai-settings"><h3>连接你的 AI</h3><p role="status">{error||'正在读取配置…'}</p>{error&&<button type="button" onClick={()=>void reload()}>重新连接</button>}</div>;
 return <SettingsForm key={`${settings.revision}:${settings.provider}`}/>;
}
function SettingsForm(){
 const {settings:loaded,service,setSettings,scope,reload,connection,testConnection}=useStudyAIWorkspace(),settings=loaded!;
 const suggested=suggestedStudyAIModel(settings.provider,settings.model,settings.baseUrl);
 const [provider,setProvider]=useState(settings.provider),[model,setModel]=useState(suggested??settings.model),[baseUrl,setBaseUrl]=useState(settings.baseUrl);
 const [key,setKey]=useState(''),[enabled,setEnabled]=useState(settings.enabled),[confirmCosts,setConfirmCosts]=useState(settings.enabled),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[clear,setClear]=useState(false);
 const [dailyRequests,setDailyRequests]=useState(settings.dailyRequestLimit),[dailyTokens,setDailyTokens]=useState(settings.dailyTokenLimit),[outputTokens,setOutputTokens]=useState(settings.maxOutputTokens);
 const [unlimited,setUnlimited]=useState(settings.unlimitedDailyUsage??false);
 const [models,setModels]=useState<string[]>([]),[readingModels,setReadingModels]=useState(false);
 const modelRequest=useRef<AbortController|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;modelRequest.current?.abort();};},[]);
 const choices=studyAIModelChoices(provider,baseUrl,models,model);
 const changed=unlimited!==(settings.unlimitedDailyUsage??false)||provider!==settings.provider||model!==settings.model||baseUrl!==settings.baseUrl||Boolean(key)||clear||enabled!==settings.enabled||dailyRequests!==settings.dailyRequestLimit||dailyTokens!==settings.dailyTokenLimit||outputTokens!==settings.maxOutputTokens;
 const testing=connection?.state==='testing';
 const changeProvider=(value:StudyAIProvider)=>{modelRequest.current?.abort();setReadingModels(false);setProvider(value);const saved=settings.providers[value];setModel(suggestedStudyAIModel(value,saved.model,saved.baseUrl)??saved.model);setBaseUrl(saved.baseUrl);setKey('');setClear(false);setModels([]);setMessage('');setConfirmCosts(false);};
 async function readModels(){
  modelRequest.current?.abort();const controller=new AbortController();modelRequest.current=controller;setReadingModels(true);setMessage('');
  try{const ids=await service.models({provider,baseUrl:baseUrl.trim(),expectedRevision:settings.revision,...(key.trim()?{providerKey:key.trim()}:{})},controller.signal);if(controller.signal.aborted)return;setModels(ids);setMessage(`已读取 ${ids.length} 个模型，请从列表选择。`);}
  catch(error){if(!controller.signal.aborted)setMessage(studyAIErrorMessage(error));}finally{if(!controller.signal.aborted)setReadingModels(false);}
 }
 async function save(event:FormEvent,runTest:boolean){
  event.preventDefault();const form=event.currentTarget instanceof HTMLFormElement?event.currentTarget:event.currentTarget.closest('form');if(form&&!form.reportValidity())return;setBusy(true);setMessage('');
  try{const next=await service.configure({provider,model,baseUrl:baseUrl.trim(),enabled,expectedRevision:settings.revision,confirmCosts,...(scope.mode==='account'?{unlimitedDailyUsage:unlimited}:{}),...(key.trim()?{providerKey:key.trim()}:{}),...(clear?{clearProviderKey:true}:{}),dailyRequestLimit:dailyRequests,dailyTokenLimit:dailyTokens,concurrentLimit:settings.concurrentLimit,maxOutputTokens:outputTokens});
    if(!alive.current)return;setKey('');setSettings(next);if(runTest)await testConnection(next);
  }catch(error){if(alive.current){setKey('');setMessage(studyAIErrorMessage(error));}}finally{if(alive.current)setBusy(false);}
 }
 function statusText(value:Settings){if(!value.configured)return '尚未保存密钥';if(!value.enabled)return '已保存 · 未启用';return connection?.state==='connected'?`连接成功 · ${connection.model} · ${connection.latencyMs} ms`:connection?.state==='testing'?'正在测试实际模型回复…':connection?.state==='error'?connection.message:'配置已保存 · 尚未测试';}
 return <form className="study-ai-settings" onSubmit={event=>void save(event,false)}>
  <p className="study-ai-eyebrow">MODEL CONNECTION</p><h3>连接你的 AI</h3><p>选择模型，保存后测试。ChatGPT 选项使用 OpenAI API，网页登录不会提供 API 额度。</p>
  <div className="study-ai-connection-status" data-state={connection?.state??'idle'} role="status"><span aria-hidden="true">{connection?.state==='connected'?'✓':connection?.state==='error'?'!':'●'}</span>{statusText(settings)}</div>
  <label>提供商<select value={provider} disabled={busy||testing} onChange={event=>changeProvider(event.target.value as StudyAIProvider)}><option value="deepseek">DeepSeek</option><option value="chatgpt">ChatGPT · OpenAI API</option></select></label>
  <label>{settings.providers[provider].configured?'API 密钥（留空保留）':'API 密钥'}<input type="password" autoComplete="new-password" value={key} maxLength={512} onChange={event=>setKey(event.target.value)} disabled={clear||busy} placeholder={settings.providers[provider].configured?'已保存，不会回显':'粘贴此提供商的密钥'}/></label>
  <small>{scope.mode==='account'?'加密保存在账号服务中':'保存在本机系统凭据库中'}，不会进入对话记录。</small>
  <label>模型<select aria-label="选择模型" value={model} disabled={busy||testing} onChange={event=>setModel(event.target.value)} required={enabled}><option value="">{choices.length?'请选择模型':'先读取可用模型'}</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>
  <div className="study-ai-model-help"><small>{model||'选择后自动填写准确的 API 标识'}</small><button type="button" disabled={readingModels||busy||clear} onClick={()=>void readModels()}>{readingModels?'读取中…':'读取可用模型'}</button></div>
  {suggested&&<p className="study-ai-inline-note">旧配置使用了展示名称。已选中对应的标准模型，保存后生效。</p>}
  <details className="study-ai-advanced"><summary>接口地址与用量限制</summary>
   <label>API Base URL<input type="url" value={baseUrl} disabled={busy} onChange={event=>{modelRequest.current?.abort();setReadingModels(false);setBaseUrl(event.target.value);setModels([]);setConfirmCosts(false);}} required/></label><small>填写基础地址，不包含 /chat/completions。新地址读取模型时需填写对应密钥。</small>
   {scope.mode==='account'&&<><label className="study-ai-check"><input type="checkbox" checked={unlimited} onChange={event=>setUnlimited(event.target.checked)}/>不设每日上限</label><p>模型费用由你填写的 API Key 所属账户承担。供应商余额与速率限制仍然适用。</p><div className="study-ai-budget-fields"><label>每日请求上限<input type="number" min={1} max={10} disabled={unlimited} value={dailyRequests} onChange={event=>setDailyRequests(Number(event.target.value))}/></label><label>每日 tokens 上限<input type="number" min={100} max={20000} step={100} disabled={unlimited} value={dailyTokens} onChange={event=>setDailyTokens(Number(event.target.value))}/></label><label>单次输出上限<input type="number" min={100} max={2000} step={100} value={outputTokens} onChange={event=>setOutputTokens(Number(event.target.value))}/></label></div><button type="button" onClick={()=>{setUnlimited(false);setDailyRequests(10);setDailyTokens(20000);setOutputTokens(2000);}}>采用轻量对话额度：10 次 / 2 万 tokens</button><p>连接测试也会调用模型。用量调整需保存；单次输出和同时请求数仍有上限。</p></>}
   <label className="study-ai-check"><input type="checkbox" checked={clear} onChange={event=>{setClear(event.target.checked);if(event.target.checked){setEnabled(false);setKey('');}}}/>清除此提供商的密钥</label>
  </details>
  {scope.mode==='account'&&!unlimited&&dailyRequests<=3&&<p className="study-ai-inline-note">当前每日仅 {dailyRequests} 次。多轮对话可展开上方用量限制调整。</p>}
  <label className="study-ai-check"><input type="checkbox" checked={enabled} disabled={clear||busy} onChange={event=>setEnabled(event.target.checked)}/>启用当前提供商</label>
  <label className="study-ai-check"><input type="checkbox" checked={confirmCosts} onChange={event=>setConfirmCosts(event.target.checked)}/>我确认会将提问与所引用内容发送给此 API，且可能产生费用</label>
  <div className="study-ai-settings-actions"><button className="study-ai-primary" type="button" disabled={busy||testing||!enabled||!model||!confirmCosts||clear} onClick={event=>void save(event,true)}>{busy?'保存中…':'保存并测试'}</button><button type="submit" disabled={busy||testing||(enabled&&(!model||!confirmCosts))}>仅保存</button><button type="button" disabled={busy||testing||changed||!settings.configured||!settings.enabled||!settings.model} onClick={()=>void testConnection()}>测试已保存配置</button><button type="button" disabled={busy||testing} onClick={()=>void reload()}>重新读取</button></div>
  <small>测试只发送固定的连接检查问题，不发送当前学习页面，也不会记录为练习。</small>
  {message&&<p className="study-ai-error" role="alert">{message}</p>}
 </form>;
}
