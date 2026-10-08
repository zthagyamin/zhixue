import { getChatGPTUser } from "./chatgpt-auth";
import { RegisteredLandingContent } from "./landing-registered-content";
import "./landing.css";
import "./landing-hierarchy.css";
import {companionEndpointFromSearch} from "./companion-endpoint";

export const dynamic = "force-dynamic";

export default async function LandingPage({searchParams}: {searchParams?: Promise<Record<string,string|string[]|undefined>>} = {}) {
  const query=await searchParams;
  const rawPort=query?.companionPort;
  const port=typeof rawPort==="string"?new URL(companionEndpointFromSearch(new URLSearchParams({companionPort:rawPort}).toString())).port:null;
  const studyHref=port?"/study?pair=1&companionPort="+port:"/study";
  let user = null;
  try {
    user = await getChatGPTUser();
  } catch (e) {
    console.error("Failed to authenticate session on landing page:", e);
  }

  return <RegisteredLandingContent studyHref={studyHref} signedIn={Boolean(user)} displayName={user?.displayName} />;
}
