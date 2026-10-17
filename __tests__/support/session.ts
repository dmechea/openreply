/**
 * The signed-in user, faked at `@/lib/auth` so route handlers see whoever a
 * test signs in as. Everything that builds on it, such as the workspace-access
 * rules in `@/lib/workspace-access`, stays real. A suite installs it with:
 *
 *   vi.mock("@/lib/auth", async () => (await import("./support/session")).authModule);
 */
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { getTestPrisma } from "./database";

const session = { userId: null as string | null };

export function signInAs(userId: string) {
  session.userId = userId;
}

export function signOut() {
  session.userId = null;
}

async function getCurrentUserId() {
  return session.userId;
}

// The same steps as the real getCurrentWorkspaceId, over the faked session.
async function getCurrentWorkspaceId() {
  const userId = session.userId;
  if (!userId) return null;
  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;
  const user = await getTestPrisma().user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return (await ensureWorkspaceForUser(userId, user?.email)).id;
}

export const authModule = {
  EMAIL_PROVIDER_ID: "resend",
  authConfig: {},
  handlers: {},
  auth: async () =>
    session.userId
      ? {
          user: { id: session.userId },
          expires: new Date(Date.now() + 86_400_000).toISOString(),
        }
      : null,
  getCurrentUserId,
  getCurrentWorkspaceId,
  signIn: async () => {
    throw new Error("signIn is not available in tests");
  },
  signOut: async () => {
    session.userId = null;
  },
};
