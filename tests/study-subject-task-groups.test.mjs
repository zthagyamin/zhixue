import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {practiceBudgetView} from '../src/domain/planning/index.ts';
const tasks=[{taskId:'word-batch',subjectId:'words',title:'New words',category:'new-word',quantity:20,action:{kind:'practice'}},...Array.from({length:35},(_,i)=>({taskId:`review-${i}`,subjectId:i%2?'python':'paper',title:`Knowledge point ${i}`,category:'review',quantity:1,action:{kind:'practice'}}))];
let api;try{api=await import('../app/study-subject-task-groups-model.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
test('many point tasks become stable subject groups without losing or rewriting task identity',()=>{
 assert.equal(typeof api?.groupStudyTasks,'function');const before=structuredClone(tasks);const groups=api.groupStudyTasks(tasks,{ready:true,completedTaskIds:['review-0'],startedTaskIds:['review-3']});
 assert.equal(groups.length,3);assert.deepEqual(groups.map(group=>group.subjectId),['words','paper','python']);assert.deepEqual(groups.flatMap(group=>group.tasks.map(task=>task.taskId)).sort(),tasks.map(task=>task.taskId).sort());assert.deepEqual(tasks,before);assert.equal(groups[1].completed,1);assert.equal(groups[2].next.taskId,'review-3');
});
test('unknown progress remains unknown, blocked and completed work cannot be a group start target',()=>{
 const source=tasks.map(task=>({...task,blockedReason:task.taskId==='review-1'?'source changed':undefined}));const groups=api.groupStudyTasks(source,{ready:false,completedTaskIds:['review-3'],startedTaskIds:['review-1']});assert.equal(groups[2].completed,null);assert.equal(groups[2].next.taskId,'review-5');
});

test('budget retains an edited task while verified course progress leads continuation in its own round',()=>{
 const rows=['edited','active'].map(taskId=>({taskId,subjectId:'course',title:taskId,category:'review',quantity:1,estimatedMinutes:3,action:{kind:'practice'}}));
 const retained=['edited','active'],visible=practiceBudgetView(rows,undefined,0,[],retained,[],[{id:'course-budget',title:'Course',subjectIds:['course'],minutes:0,defaultItemMinutes:3}]).visible;
 assert.deepEqual(visible.map(task=>task.taskId),['edited','active']);
 const group=api.groupStudyTasks(visible,{ready:true,completedTaskIds:[],startedTaskIds:retained,verifiedStartedTaskIds:['active'],subjects:[{subjectId:'course',kind:'course'}],practiceGroupByTask:{edited:'edited-round',active:'active-round'}})[0];
 assert.equal(group.next.taskId,'active');assert.equal(group.started,true);
 assert.deepEqual(group.tasks,rows);
});

test('positive course evidence never infers missing pending progress or changes vocabulary and unknown-source priority',()=>{
 const base={ready:true,completedTaskIds:[],startedTaskIds:['edited','active'],verifiedStartedTaskIds:['active']};
 for(const patch of [{subjects:[{subjectId:'words',kind:'words'}]},{subjects:[]},{subjects:[{subjectId:'words',kind:'course'}],category:'new-word'}]){
  const rows=['edited','active'].map(taskId=>({taskId,subjectId:'words',title:taskId,category:patch.category??'review',quantity:1,action:{kind:'practice'}}));
  const group=api.groupStudyTasks(rows,{...base,subjects:patch.subjects})[0];assert.equal(group.next.taskId,'edited');
 }
 const pending=[{taskId:'pending',subjectId:'course',title:'Saved pending',category:'review',quantity:1,action:{kind:'practice'}}];
 assert.equal(api.groupStudyTasks(pending,{...base,startedTaskIds:['pending'],verifiedStartedTaskIds:[],subjects:[{subjectId:'course',kind:'course'}]})[0].started,true);
});
test('default UI shows subjects and counts rather than rendering all knowledge point rows',()=>{
 const {StudySubjectTaskGroups}=loadTsx(new URL('../app/study-subject-task-groups.tsx',import.meta.url));
 const html=renderToStaticMarkup(h(StudySubjectTaskGroups,{tasks,subjects:[{subjectId:'words',name:'English'},{subjectId:'paper',name:'Papers'},{subjectId:'python',name:'Python'}],ready:true,completedTaskIds:[],onStart(){throw new Error('Rendering cannot start practice');},renderTask:task=>h('li',{key:task.taskId},task.title)}));
 assert.match(html,/English/);assert.match(html,/Python/);assert.match(html,/Papers/);assert.doesNotMatch(html,/Knowledge point/);assert.equal((html.match(/aria-expanded="false"/g)||[]).length,3);
});
