import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse("Not Found", { status: 404 });
  }
  
  const returnTo = request.nextUrl.searchParams.get("return_to") || "/";
  const cookieStore = await cookies();
  cookieStore.delete("local-dev-mock-auth");
  
  return NextResponse.redirect(new URL(returnTo, request.url));
}
