// Isolated preview only. Real handlers and stores, synthetic identity, in-memory D1, no providers.
import {createHash,randomBytes} from 'node:crypto';
import {openD1} from '../helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../../db/account-study-access-store.ts';
import {AccountStudyStore} from '../../db/account-study-store.ts';
import {AccountStudyReceiptStore} from '../../db/account-study-receipt-store.ts';
import {AccountAssistanceStore} from '../../db/account-assistance-store.ts';
import {AccountStudyPlanStore} from '../../db/account-study-plan-store.ts';
import {AccountLongTermPlanStore} from '../../db/account-long-term-plan-store.ts';
import {AccountStudyAiStore} from '../../db/account-study-ai-store.ts';
import {AccountStudyContentDecisionStore} from '../../db/account-study-content-decision-store.ts';
import {createAccountStudyHandlers} from '../../app/account-study-api.ts';
import {sealStudyItem,sealStudySnapshot} from '../../app/account-study-content.ts';
import {sealStudyRecord} from '../../app/account-study-record.ts';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudTaskPlan,sealCloudPlanningFacts} from '../../app/account-study-planning.ts';
import {editTaskPlan} from '../../app/task-plan-edit.ts';
import {composeAccountPlanningInput} from '../../app/account-study-planning-projection.ts';
import {generateTaskPlan} from '../../app/task-plan-engine.ts';
import {wordBody,quizBody,snapshotBody,recordBody} from './account-study-fixtures.mjs';
import {attempt} from './task-event-fixtures.mjs';
import {D1LearningAttemptStore} from '../../src/infrastructure/learning-attempt/index.ts';
import {D1PracticeEvidenceStore} from '../../src/infrastructure/practice-evidence/index.ts';
import {courseEvidenceOriginal} from '../../src/application/course-study/index.ts';
import {D1MathMappingStore} from '../../src/infrastructure/math-study/index.ts';
import {reviewedCases} from './math-mapping-fixtures.mjs';
import {studyDay} from '../../src/domain/planning/index.ts';

const dictionary=[
  ['disturb','打扰；使不安','Notifications can disturb your concentration.'],
  ['retain','保留；记住','A short review helps us retain new ideas.'],
  ['reflect','思考；反映','Take a moment to reflect on the question.'],
  ['subtle','细微的；不易察觉的','There is a subtle difference between the two ideas.'],
  ['coherent','连贯的；一致的','The paragraph presents a coherent argument.'],
  ['evidence','证据；依据','The conclusion needs stronger evidence.'],
  ['recall','回想；回忆','Try to recall the meaning before looking.'],
  ['explore','探索；探究','We explore a new topic every week.'],
  ['observe','观察；注意到','Observe how the pattern changes.'],
  ['clarify','澄清；阐明','An example can clarify the main point.'],
  ['precise','精确的','Use a precise description of the result.'],
  ['relate','联系；叙述','Relate the new idea to something you know.'],
  ['adapt','适应；调整','We adapt the plan to our progress.'],
  ['contrast','对比；差异','Contrast the two explanations.'],
  ['sustain','保持；维持','Small habits can sustain long-term learning.'],
  ['focus','专注','Focus on one question at a time.'],['measure','测量','Measure the change carefully.'],
  ['connect','连接','Connect the ideas together.'],['reason','推理；原因','Explain the reason for your answer.'],
  ['review','复习','Review the material tomorrow.'],['pattern','模式','Find a pattern in the data.'],
  ['context','语境','Context helps explain the sentence.'],['method','方法','Try a different method.'],
  ['concept','概念','Explain this concept in your own words.'],['develop','发展','Develop a clear understanding.'],
  ['approach','方法；接近','Consider another approach.'],['define','定义','Define the term carefully.'],
  ['analyse','分析','Analyse the main argument.'],['apply','应用','Apply the idea to a new example.'],
  ['resolve','解决','Resolve the question with evidence.'],
];

export async function createAccountPreview({origin,scenario='approved-15',userId='study-preview-account',longReading=false,syntheticAi=false,stage3=false,stage3Mapping=false,stage3Semantic=false,stage3Stress=false,manyReviews=false,groupedStudy=false,vagueRecall=false,reviewTarget=6,day=studyDay(new Date().toISOString())}){
  const url=new URL(origin);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:')throw new Error('Preview requires localhost');
  if(!['no-plan','draft-15','approved-15','completed-15','partial-15','all-plugins','account-writeback','visual-reference'].includes(scenario))throw new Error('Unknown preview scenario');
  const {sqlite,binding}=await openD1(),token=randomBytes(32).toString('base64url');
  const access=new AccountStudyAccessStore(binding),study=new AccountStudyStore(binding),plans=new AccountStudyPlanStore(binding),receipts=new AccountStudyReceiptStore(binding);
  const ai=new AccountStudyAiStore(binding,randomBytes(32).toString('base64url')),content=new AccountStudyContentDecisionStore(binding),assistance=new AccountAssistanceStore(binding);
  const mappings=new D1MathMappingStore(binding,study),reviewed=reviewedCases[1];
  let lastAIContext=null;
  const unavailable=async()=>{throw new Error('Preview never calls an external AI provider');};
  const make=browser=>createAccountStudyHandlers({enabled:true,getBrowserUser:async()=>browser?{userId}:null,
    ...(stage3?{getPracticeEvidenceStore:async service=>new D1PracticeEvidenceStore(binding,courseEvidenceOriginal(study,new D1LearningAttemptStore(binding)),{service,mapping:mappings}),
      getMathMappingStore:async()=>mappings,getPracticeEvidenceMapping:async()=>mappings}:{}),
    ...(stage3Semantic?{getPracticeAi:async()=>({async run(kind,input,trace){
      if(kind!=='math-step')throw Error('Synthetic step fixture only');
      return {output:{diagnostic:{answerRevision:input.answerRevision,stepRevision:input.stepRevision,stepId:input.source.support.step.stepId,
        sourceVersion:input.binding.contentHash,status:'incorrect',source:'model',explanation:'这一步写成了99；来源这一步的参考值为2。'},
        evidence:{sourceQuote:'2',answerQuote:'99',reason:'The saved intermediate value differs from the source step.'}},trace:{...trace},usageTokens:10};
    }})}:{}),
    getAccessStore:async()=>access,getStudyStore:async()=>study,getReceiptStore:async()=>receipts,getAssistanceStore:async()=>assistance,getPlanStore:async()=>plans,getLongTermStore:async()=>new AccountLongTermPlanStore(binding),getAiStore:async()=>ai,getAttemptStore:async()=>new D1LearningAttemptStore(binding),getContentDecisionStore:async()=>content,
    getPlanAi:unavailable,getQuestionAi:unavailable,getPlanAiTrace:()=>({modelId:'synthetic-model',promptVersion:'plan-ai-json-v1',ruleVersion:'plan-ai-selection-v1'}),getQuestionAiTrace:()=>({modelId:'synthetic-model',promptVersion:'question-ai-json-v1',ruleVersion:'question-ai-answer-binding-v1'}),
    getAiModels:syntheticAi?async(_scope,selection)=>[selection.provider==='deepseek'?'deepseek-v4-flash':'synthetic-chatgpt','synthetic-denied-model']:unavailable,
    getChatAi:syntheticAi?async scope=>({async *stream(request,_tokens,signal){const settings=await ai.getSettings(scope);lastAIContext={title:request.context.title,kind:request.context.pageKind??null,pageCharacters:request.context.pageText?.length??0,question:!!request.context.question,code:!!request.context.code,answer:!!request.context.learnerAnswer,probe:request.context.id==='connection-test'};if(settings.model==='synthetic-denied-model')throw new Error('ai-provider-model');for(const text of ['## 从你的尝试继续\n\n','这是隔离预览的固定回答。先检查你的假设，再核对结果。\n\n','公式：$a^2+b^2=c^2$\n\n','```python\ndef add(a, b):\n    return a + b\n```']){signal.throwIfAborted();yield{type:'delta',text};}yield{type:'done',provider:settings.provider,model:settings.model,usageTokens:10};}}):unavailable,planAiAvailable:()=>syntheticAi});
  const browser=make(true),device=make(false);
  const request=(action,body,machine=false)=>new Request(origin+'/api/account-study',{method:'POST',headers:{'content-type':'application/json',Origin:origin,...(machine?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({action,...body})});
  async function post(action,body={},machine=false){const r=await (machine?device:browser).POST(request(action,body,machine));const value=await r.json();if(!r.ok)throw new Error(`Preview seed ${action}: ${r.status} ${JSON.stringify(value)}`);return value;}
  const surface={day,userId,handle:async request=>{const target=new URL(request.url);if(target.origin!==origin)return Response.json({error:'preview-origin-blocked'},{status:403});return request.method==='GET'?browser.GET(request):request.method==='POST'?browser.POST(request):Response.json({error:'method-not-allowed'},{status:405});},
    inspect:()=>({scenario,lastAIContext,aiRequests:sqlite.prepare('SELECT provider_id AS provider,status,count(*) AS count FROM account_study_ai_requests GROUP BY provider_id,status').all(),records:sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,assistance:sqlite.prepare('SELECT count(*) AS n FROM account_study_assistance').get().n,assistanceReceipts:sqlite.prepare('SELECT count(*) AS n FROM account_study_assistance_receipts').get().n}),close:()=>sqlite.close()};
  try{
    if(scenario==='account-writeback')return{...surface,registerDevice:registration=>post('register-grant',{...registration,expectedProfileRevision:0,replaceLibrary:false})};
    const sourceHash='a'.repeat(64),items=[];
    for(const [index,[word,meaning,example]] of (groupedStudy?dictionary.slice(0,3):dictionary).entries())items.push(await sealStudyItem(wordBody({itemKey:`word:${index}`,title:word,
      word:{word,meaning,phonetic:word==='disturb'?'/dɪˈstɜːb/':'',context:'隔离演示 · 阅读与思考',example,source:'演示词库',level:'Academic',distractors:['记忆','语境']}})));
    const readingPrompt=(longReading?Array.from({length:16},(_,index)=>`Paragraph ${index+1}. This synthetic passage tests readable long material. The reader pauses to connect each claim with its evidence, then returns to the text with renewed attention. No personal learning record is used here.`).join('\n\n')+'\n\n':'')+'A short break helps the reader return with greater focus. What is the main benefit?';
    items.push(await sealStudyItem(quizBody({title:longReading?'长文理解预览':'短文理解',practice:{...quizBody().practice,prompt:readingPrompt,options:['Improved concentration','A longer reading list'],answer:0,explanation:'The sentence describes returning with greater focus.',sourceLabel:'隔离阅读示例'}})));
    if(groupedStudy)for(const name of ['A','B'])items.push(await sealStudyItem(quizBody({itemKey:`recall-${name}`,title:`回忆练习 ${name}`,
      practice:{itemId:`recall-${name}`,abilityId:`recall-${name}`,domain:'course',questionType:'recall',prompt:vagueRecall&&name==='A'?'请闭卷回忆「材料标题」的核心要点，并说明相关概念、依据或适用条件。':`回忆练习 ${name}：请说明适用条件。`,explanation:`合成参考 ${name}：需要独立样本和清晰边界。`,sourceLabel:'隔离回忆材料'}})));
    if(scenario==='all-plugins'||scenario==='visual-reference'){
      const stressContext=stage3Stress?'\n\n'+Array.from({length:12},(_,i)=>`条件说明 ${i+1}：先核对已知量与目标量，保留变量的取值范围。State the given values and the requested result; keep each assumption explicit so that the explanation remains independently readable.`).join('\n\n'):'';
      const wideFormula=stage3Stress?'\n\n$$\\left(\\frac{a_1}{b_1}+\\frac{a_2}{b_2}+\\frac{a_3}{b_3}+\\frac{a_4}{b_4}+\\frac{a_5}{b_5}+\\frac{a_6}{b_6}+\\frac{a_7}{b_7}+\\frac{a_8}{b_8}\\right)^2=\\sum_{i=1}^{8}\\frac{a_i^2}{b_i^2}+2\\sum_{1\\leq i<j\\leq8}\\frac{a_i a_j}{b_i b_j}$$\n各分母非零；此恒等式仅作公式排版检查，本题结果仍由题干给定量核对。':'';
      const stressCode=stage3Stress?Array.from({length:70},(_,i)=>`# 注释 ${i+1}: 两个参数都参与计算，保留完整代码。 Keep both operands and return their sum; the example checks ${i%2?'negative':'positive'} values.`).join('\n')+'\n\n':'';
      items.push(await sealStudyItem(quizBody({itemKey:'practice:calculation',subjectId:'math',title:'基础计算',
        ...(stage3?{schemaVersion:2,learningSupport:{schemaVersion:2,type:'calculation',mode:'numeric',domain:'real',variables:[],tolerance:'0',
          units:'无量纲',...(stage3Mapping?{variantMappingId:'reviewed-sqrt-sign',conditions:reviewed.conditions}:{}),
          step:{stepId:stage3Mapping?'square-value':'add-two',prompt:stage3Mapping?'先计算 $x^2$。':'先计算 $1+1$。',reference:stage3Mapping?'9':'2',mode:stage3Semantic?'semantic':'numeric'}}}:{}),
        practice:{itemId:'calculation',abilityId:stage3Mapping?'sqrt-sign':'calculation',domain:'paper',questionType:'calculation',prompt:(stage3Mapping?reviewed.prompt:'$1 + 2 = ?$')+stressContext+wideFormula,answer:'3',explanation:(stage3Mapping?'主平方根非负，$\\sqrt{(-3)^2}=3$。':'三个单位相加。')+stressContext+wideFormula,sourceLabel:'隔离计算示例'}})));
      items.push(await sealStudyItem(quizBody({itemKey:'practice:code',subjectId:'coding',eventKind:'python',title:'实现加法',
        ...(stage3?{schemaVersion:2,learningSupport:{schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'positive',functionName:'add',args:[1,2],expected:3,hint:'检查两个参数是否都参与了求和。'},{id:'negative',functionName:'add',args:[-1,2],expected:1,hint:'返回值需要处理负数输入。'}]}}:{}),
        practice:{itemId:'code',abilityId:'code',domain:'python',questionType:'code',prompt:'实现 add(a, b)，返回两数之和。'+stressContext,initialCode:stressCode+'def add(a, b):\n    pass',testCode:stage3?'':'assert add(1, 2) == 3',solutionCode:stressCode+'def add(a, b):\n    return a + b',explanation:'return 把结果返回给调用者。'+stressContext+(stage3Stress?'\n\n```python\ndef add(a, b):\n    return a + b\n```':''),sourceLabel:'隔离代码示例'}})));
    }
    const snapshot=await sealStudySnapshot(snapshotBody(items,{generatedAt:new Date().toISOString()}));
    await post('register-grant',{grantId:'preview-grant',libraryId:'library-a',tokenHash:createHash('sha256').update(token).digest('hex'),label:'隔离预览',expectedProfileRevision:0,replaceLibrary:false});
    await post('activate-grant',{},true);if(syntheticAi){for(const [revision,provider]of [[0,'deepseek'],[1,'chatgpt']])await ai.configure({userId,libraryId:'library-a'},{provider,model:`synthetic-${provider}`,enabled:true,dailyRequestLimit:10,dailyTokenLimit:20000,maxOutputTokens:1000,expectedRevision:revision,confirmCosts:true,providerKey:`synthetic-${provider}-not-a-real-key`});}await post('begin-snapshot',{snapshot},true);
    for(let position=0;position<items.length;position+=20)await post('stage-items',{snapshotId:snapshot.snapshotId,entries:items.slice(position,position+20).map((item,index)=>({position:position+index,item}))},true);
    await post('complete-snapshot',{snapshotId:snapshot.snapshotId,expectedRevision:0},true);
    if(stage3Mapping){
      const item=items.find(row=>row.itemKey==='practice:calculation');
      await post('math-mapping-publish',{preparation:{schemaVersion:1,snapshotId:snapshot.snapshotId,
        mapping:{schemaVersion:1,mappingId:'reviewed-sqrt-sign',parentItemKey:item.itemKey,parentContentHash:item.contentHash,hashKind:'content',templateVersion:1,templateId:'sqrt-sign',sourceConditions:reviewed.conditions,parameters:reviewed.parameters},
        review:{sourceQuote:reviewed.sourceQuote,rationale:reviewed.rationale}}},true);
    }
    const words=items.filter(item=>item.kind==='word').map(item=>({itemKey:item.itemKey,subjectId:'vocab',word:item.word.word,language:'en',sourceHash,completionRule:'three-stage'}));
    const native={schemaVersion:1,sourceHash,diagnostics:[],subjects:[{subjectId:'vocab',name:'学术英语',priority:3,planningStatus:'none',words,units:[],goals:[]},{subjectId:'reading',name:'阅读理解',priority:3,planningStatus:'none',words:[],units:[],goals:[]}]};
    if(scenario==='all-plugins'||scenario==='visual-reference')for(const [subjectId,name]of [['math','基础计算'],['coding','代码练习']])native.subjects.push({subjectId,name,priority:3,planningStatus:'none',words:[],units:[],goals:[]});
    native.practiceSources=items.filter(item=>item.kind==='practice').map(item=>({itemKey:item.itemKey,subjectId:item.subjectId,title:item.title,sourceHash:item.sourceHash,completionRule:item.completionRule}));
    if(scenario==='visual-reference'){
      for(const [subjectId,name,title,itemKey] of [['reading','论文阅读','论文阅读 · 第 2 节','question-one'],['coding','Python','Python · 第 03 课','practice:code']]){
        const subject=native.subjects.find(row=>row.subjectId===subjectId);subject.name=name;subject.planningStatus='ready';
        subject.units=[{unitId:`${subjectId}:unit`,subjectId,title,order:1,sourceHash,prerequisites:[],action:{kind:'practice',itemKeys:[itemKey]},completionRule:'graded-practice',formalComplete:false}];
      }
    }
    const {catalog}=await toCloudPlanningCatalog(native,{snapshot,items});
    await post('publish-planning-catalog',{catalog},true);
    const facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,catalogHash:catalog.catalogHash,observedAt:new Date().toISOString(),nativePlanRevision:0,sourceReviews:manyReviews?[...catalog.subjects.flatMap(subject=>subject.words),...catalog.practiceSources].map(source=>({itemKey:source.itemKey,subjectId:source.subjectId,sourceHash:source.sourceHash,completionRule:source.completionRule,state:{enabled:true,dueAt:day+'T00:00:00+08:00'}})):[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
    await post('publish-planning-facts',{facts},true);
    if(!['no-plan','all-plugins'].includes(scenario)){
      let plan=await generateTaskPlan({day,catalog:await toEnginePlanningCatalog(catalog),words:words.slice(0,scenario==='visual-reference'?20:15).map(word=>({lexemeKey:`en:${word.word}`,itemKeys:[word.itemKey],status:'unseen'})),reviews:[],completions:[],previous:null});
      if(manyReviews){const composed=await composeAccountPlanningInput({day,catalog,facts,bundle:{snapshot,items},bundles:[{snapshot,items}],records:[],eventThrough:0,taskThrough:0,previous:null});plan=await generateTaskPlan(groupedStudy?{...composed.input,longTermAllocation:{schemaVersion:1,planId:'group-fixture',day,vocabularyTarget:0,items:[],reviewTarget}}:composed.input);}
      if(groupedStudy){
        const key=task=>task.action.kind==='practice'?task.action.itemKeys[0]:'';
        const rank=task=>key(task).startsWith('recall-')?0:key(task).startsWith('word:')?1:2;
        const ordered=[...plan.tasks].sort((a,b)=>rank(a)-rank(b)||key(a).localeCompare(key(b))),engine=await toEnginePlanningCatalog(catalog);
        for(let index=ordered.length-1;index>=0;index--)plan=await editTaskPlan(plan,{type:'move',taskId:ordered[index].taskId,beforeTaskId:ordered[index+1]?.taskId??null},engine);
      }
      if(scenario==='visual-reference'){
        const engine=await toEnginePlanningCatalog(catalog);
        for(const subjectId of ['coding','reading']){
          const unit=engine.subjects.find(subject=>subject.subjectId===subjectId).units[0];
          if(!plan.tasks.some(task=>task.unitIds.includes(unit.unitId)))plan=await editTaskPlan(plan,{type:'upsert',task:{taskId:`preview:${subjectId}`,subjectId,title:unit.title,category:'subject',origin:'manual',required:false,unitIds:[unit.unitId],quantity:1,action:unit.action,completionRule:unit.completionRule,sourceHash:unit.sourceHash}},engine);
        }
      }
      const cloud=await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:facts.factsHash,eventThrough:0,taskThrough:0,nativeBaseRevision:0});
      await post('mutate-plan',{mutation:{action:'save',operationId:'preview-save',expectedRevision:0,plan:cloud}});
      if(scenario!=='draft-15')await post('mutate-plan',{mutation:{action:'approve',operationId:'preview-approve',expectedRevision:1,day,planHash:cloud.cloudPlanHash,predecessorOperationId:null}});
      if(scenario==='completed-15'||scenario==='partial-15'||scenario==='visual-reference'){
        for(const [index,item] of items.slice(0,scenario==='partial-15'?1:scenario==='visual-reference'?8:15).entries()){
          let parent=null;
          for(let stage=0;stage<3;stage++){
            const eventId=`preview-event-${index}-${stage}`,event=await attempt(eventId,new Date().toISOString(),stage,stage+1,true,{item:{kind:'word',key:item.itemKey}});
            const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,roundId:`preview-round-${index}`,attemptId:`preview-attempt-${index}-${stage}`,parentEventId:parent,event}));
            const result=await post('append-records',{records:[record]});if(!result.results[0].durable)throw new Error('Preview record rejected: '+JSON.stringify(result.results[0]));parent=eventId;
          }
        }
      }
    }
    return surface;
  }catch(error){sqlite.close();throw error;}
}
