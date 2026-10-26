'use client';
import type {PaperStudyData} from '../paper-study';
import type {PaperServices} from '../plugins/plugin-paper';
import type {PaperReadingWorkspaceV1} from '../../src/domain/paper-reading';
import {preparePaperReviewCandidate,readingCandidateArtifact} from '../../src/domain/paper-reading';
import {CandidateLauncher} from '../../src/features/remediation';
import {downloadStudyMaterial} from '../../src/infrastructure/artifacts';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
export function PaperReviewCandidate({paper,workspace,services}:{paper:PaperStudyData;workspace:PaperReadingWorkspaceV1;services:PaperServices}){
    const task=workspace.task;if(task?.status!=='ready')return null;
    const section=paper.sections.find(s=>s.id===workspace.unit.source.sectionId);
    const prepared=preparePaperReviewCandidate(workspace.unit,task,{paperId:paper.paperId,sourceNote:paper.sourceNote,sectionLabel:section?.title});
    return <CandidateLauncher source={prepared.source} seeds={prepared.seeds} scope={JSON.stringify([services.owner,services.library,workspace.unit.unitId,task.taskId,task.revision])}
        label="准备复习候选" isCurrent={services.isCurrent} registerGuard={registerStudyNavigationGuard} download={downloadStudyMaterial}
        serialize={async approved=>JSON.stringify(await readingCandidateArtifact(approved,prepared),null,2)+'\n'}/>;
}
