import type {PracticeLearningPort} from '../../application/practice-evidence';
import type {LearningAttempt} from '../../domain/learning-attempt';
import type {CodeRunReportV1} from '../../domain/code-execution';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission} from '../../domain/source-admission/index.ts';

/** Only persisted reports on this original may enter source review; children stay separate. */
export function sourceCodeReports(practice:PracticeLearningPort){
    return async(attempt:LearningAttempt):Promise<readonly CodeRunReportV1[]>=>{
        const saved=practice.readSaved?await practice.readSaved(attempt.attemptId):await (async()=>{
            await practice.refresh();return practice.snapshot();
        })();
        if(!saved)return [];
        if(saved.attemptId!==attempt.attemptId||!sameSourceAdmission(saved.binding,attempt.binding))
            throw Error('source-admission-code-report-binding');
        const {first,latest}=saved.execution??{};
        return first?[first,...(latest&&!sameSourceAdmission(first,latest)?[latest]:[])]:latest?[latest]:[];
    };
}
