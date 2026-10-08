// @ts-expect-error TS5097: also executed directly by Node's contract tests.
import {groupSubjects,isDiscipline} from './learning-catalog.ts';
import type {CatalogSubject,SubjectOrganization} from './learning-catalog';

/** Untrusted local preferences affect grouping only, never the original subjects. */
export function readSubjectOrganization(raw:unknown):{value:SubjectOrganization;recovered:boolean}{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return {value:{},recovered:true};
  const entries=Object.entries(raw),valid=entries.filter((entry):entry is [string,SubjectOrganization[string]]=>isDiscipline(entry[1]));
  return {value:Object.fromEntries(valid),recovered:valid.length!==entries.length};
}

export function visibleLibraryGroups<T extends CatalogSubject>(subjects:readonly T[],organization:SubjectOrganization,query:string){
  const keyword=query.trim().toLowerCase();
  return groupSubjects(subjects,organization).map(group=>({
    ...group,total:group.subjects.length,
    subjects:group.subjects.filter(subject=>subject.name.toLowerCase().includes(keyword)),
  })).filter(group=>group.subjects.length>0);
}
