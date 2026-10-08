import packageInfo from '../../../package.json';
export const dynamic='force-dynamic';
export async function GET(){
  return Response.json({schemaVersion:1,version:packageInfo.version},{headers:{'Cache-Control':'no-store, max-age=0'}});
}
