import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeRelativeReturnPath } from '../../src/domain/auth-return';

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse("Not Found", { status: 404 });
  }
  
  const returnTo = safeRelativeReturnPath(request.nextUrl.searchParams.get("return_to") || "/study");
  const cookieStore = await cookies();
  cookieStore.set("local-dev-mock-auth", "1", { path: "/" });
  
  return NextResponse.redirect(new URL(returnTo, request.url));
}
