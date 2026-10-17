import { NextResponse, type NextRequest } from "next/server";
import {
  listWorkspaceConnections,
  revokeWorkspaceConnection,
} from "@/lib/oauth/connections";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

// Settings → Connected apps: the workspace's working connections.
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const connections = await listWorkspaceConnections(context.workspaceId);
  return NextResponse.json(
    {
      success: true,
      data: { connections, canManage: canManageWorkspace(context.role) },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

// Revoke a connection. Its tokens stop working on their next request.
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can revoke connected apps" },
      { status: 403 }
    );
  }

  const connectionId = request.nextUrl.searchParams.get("id");
  if (!connectionId) {
    return NextResponse.json(
      { success: false, error: "Missing connection ID" },
      { status: 400 }
    );
  }

  const revoked = await revokeWorkspaceConnection(context.workspaceId, connectionId);
  if (!revoked) {
    return NextResponse.json(
      { success: false, error: "Connection not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, data: { revoked: true } });
}
