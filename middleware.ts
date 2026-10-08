import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Only apply mock login in development
  if (process.env.NODE_ENV === "development") {
    // If user tries to hit the login endpoint, automatically redirect them with auth cookies
    if (request.nextUrl.pathname.startsWith("/signin-with-chatgpt")) {
      const returnTo = request.nextUrl.searchParams.get("return_to") || "/study";
      const response = NextResponse.redirect(new URL(returnTo, request.url));
      // Set a fake cookie to remember we're "logged in" locally
      response.cookies.set("local-dev-mock-auth", "1");
      return response;
    }

    if (request.nextUrl.pathname.startsWith("/signout-with-chatgpt")) {
      const returnTo = request.nextUrl.searchParams.get("return_to") || "/";
      const response = NextResponse.redirect(new URL(returnTo, request.url));
      response.cookies.delete("local-dev-mock-auth");
      return response;
    }

    // Inject fake headers if the mock auth cookie is present
    if (request.cookies.has("local-dev-mock-auth")) {
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set("oai-authenticated-user-id", "local-dev-user-123");
      requestHeaders.set("oai-authenticated-user-email", "developer@local.host");
      requestHeaders.set("oai-authenticated-user-full-name", encodeURIComponent("本地开发者"));
      requestHeaders.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
      
      return NextResponse.next({
        request: {
          headers: requestHeaders,
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
