import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  let user;
  try {
    user = await getChatGPTUser();
  } catch {
    return Response.json({ error: "Failed to authenticate session" }, { status: 500 });
  }

  return Response.json({
    authenticated: Boolean(user),
    user: user
      ? {
          userId: user.userId,
          displayName: user.displayName,
          email: user.email,
        }
      : null,
  });
}
