export function vocabularyInput(count=30) {
  const sourceHash='a'.repeat(64);
  const words=Array.from({length:count},(_,i)=>({
    itemKey:`word:${i}`,subjectId:'vocab',word:`term${i}`,language:'en',sourceHash,completionRule:'three-stage',
  }));
  return {day:'2026-08-31',catalog:{schemaVersion:1,sourceHash,diagnostics:[],subjects:[{
    subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',words,units:[],goals:[],
  }]},words:words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'unseen'})),
  reviews:[],completions:[],previous:null};
}
export function courseSubject(count=6,goalOverrides={}) {
  const sourceHash='b'.repeat(64);
  const units=Array.from({length:count},(_,i)=>({unitId:`course:u${i}`,subjectId:'course',title:`Lesson ${i}`,order:i,
    sourceHash,prerequisites:[],action:{kind:'open-note',contentRef:`[[subjects/course/u${i}]]`},
    completionRule:'self-report',formalComplete:false}));
  return {subjectId:'course',name:'Course',priority:3,planningStatus:'ready',words:[],units,goals:[{
    goalId:'course:daily',subjectId:'course',title:'Read lessons',kind:'daily',targetCount:2,unitIds:units.map(u=>u.unitId),
    startOn:'2026-08-31',priority:3,required:true,completionBasis:'self-report',...goalOverrides,
  }]};
}
