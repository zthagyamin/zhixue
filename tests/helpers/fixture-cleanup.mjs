export async function withFixtureCleanup(run,cleanup) {
  let result,primary,failed=false;
  try { result=await run(); }
  catch(error) { primary=error;failed=true; }
  try { await cleanup(); }
  catch(error) {
    if(failed)throw new AggregateError([primary,error],'Fixture execution and cleanup both failed');
    throw error;
  }
  if(failed)throw primary;
  return result;
}
