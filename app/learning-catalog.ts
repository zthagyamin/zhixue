import type {PluginType} from './plugin-routing';
export const DISCIPLINES={language:{label:'语言学习',description:'词汇、理解与表达'},computing:{label:'计算机与人工智能',description:'编程、算法与模型'},math:{label:'数学与统计',description:'概念、推导与计算'},courses:{label:'专业课程',description:'按课程理解、练习与复习'},other:{label:'其他与待分类',description:'保留全部材料，可调整归属'}} as const;
export type DisciplineId=keyof typeof DISCIPLINES;
export type SubjectOrganization=Record<string,DisciplineId>;
export type CatalogSubject={id:string;name:string;domain?:string;pluginType?:string;disciplineId?:string};
export function isDiscipline(value:unknown):value is DisciplineId{return typeof value==='string'&&Object.hasOwn(DISCIPLINES,value);}
export function classifySubject(subject:CatalogSubject,override?:DisciplineId):DisciplineId{
 if(isDiscipline(override))return override;if(isDiscipline(subject.disciplineId))return subject.disciplineId;
 const label=subject.name.toLowerCase(),domain=(subject.domain??'').toLowerCase();
 if(/英语|雅思|托福|外语|日语|法语|德语|语言|ielts|toefl|english|vocab/.test(label)||/^(ielts|language|academic-english|vocabulary)/.test(domain))return'language';
 if(/python|计算机|机器学习|人工智能|深度学习|算法|数据结构|计算机视觉|cs229|cs231|编程|软件工程|computer|machine.learning/.test(label)||/^(python|code|computer|machine-learning|ai)$/.test(domain))return'computing';
 if(/数学|代数|微积分|概率|统计|数理|mathematics|calculus|statistics/.test(label)||/^(math|mathematics|statistics)$/.test(domain))return'math';
 return /course|课程/.test(domain)?'courses':'other';
}
export function groupSubjects<T extends CatalogSubject>(subjects:readonly T[],overrides:SubjectOrganization={}){return(Object.keys(DISCIPLINES) as DisciplineId[]).map(id=>({id,...DISCIPLINES[id],subjects:subjects.filter(s=>classifySubject(s,overrides[s.id])===id)}));}
export const PLUGIN_CAPABILITIES:Record<PluginType,{task:string;description:string;disciplines:readonly (DisciplineId|'all')[]}>={
 'three-stage':{task:'记住新词',description:'认义 → 语境 → 闭卷自评',disciplines:['language']},spelling:{task:'练习拼写',description:'看释义，独立拼出单词',disciplines:['language']},
 recall:{task:'解释概念',description:'用自己的话回答，再核对要点',disciplines:['all']},quiz:{task:'辨析与判断',description:'通过选项比较相近概念',disciplines:['all']},flashcard:{task:'快速自测',description:'先回忆，再翻面核对',disciplines:['all']},
 calculation:{task:'推导与计算',description:'列式、求解并检查结果',disciplines:['math','computing','courses']},code:{task:'动手编程',description:'编写并运行代码，检查测试结果',disciplines:['computing','courses']},paper:{task:'阅读论文',description:'精读原文、选词、整理机制与证据',disciplines:['all']},
};
export const FUTURE_LEARNING_CAPABILITIES=[{discipline:'语言学习',tasks:'听力精听、口语模拟、写作修改'},{discipline:'计算机与人工智能',tasks:'代码阅读、实验复现、结果比较'},{discipline:'数学与统计',tasks:'证明训练、推导检查、错题变式'},{discipline:'专业课程',tasks:'图表解读、案例分析、专题复习'},{discipline:'跨学科研究',tasks:'论文比较、主张与证据整理'}] as const;
