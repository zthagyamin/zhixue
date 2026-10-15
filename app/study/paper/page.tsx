import {redirect} from 'next/navigation';
import {getChatGPTUser} from '../../chatgpt-auth';
import {companionEndpointFromSearch} from '../../companion-endpoint';
import StudyDashboard from '../../study-dashboard';

export const dynamic='force-dynamic';
export default async function PaperReadingRoute({searchParams}:{searchParams?:Promise<Record<string,string|string[]|undefined>>}={}){
    const query=await searchParams;
    const rawPort=typeof query?.companionPort==='string'?query.companionPort:query?.pair==='1'?'43121':undefined;
    const homeHref=typeof rawPort==='string'?'/?companionPort='+new URL(companionEndpointFromSearch(new URLSearchParams({companionPort:rawPort}).toString())).port:'/';
    return <AuthenticatedPaper homeHref={homeHref}/>;
}
async function AuthenticatedPaper({homeHref}:{homeHref:string}){
    const user=await getChatGPTUser();
    if(!user)redirect(homeHref);
    return <StudyDashboard paperReading/>;
}
