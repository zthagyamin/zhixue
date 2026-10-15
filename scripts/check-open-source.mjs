import {inspectPublicRepository} from './open-source-policy.mjs';

try {
  const {errors, ...summary} = await inspectPublicRepository(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({...summary, publicBoundary: 'passed', manualProvenanceReview: 'required'}));
  }
} catch (error) {
  console.error(`Public boundary check failed: ${error.message}`);
  process.exitCode = 1;
}
