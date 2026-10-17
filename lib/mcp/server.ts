import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createCampaign,
  createCampaignSchema,
  updateCampaign,
  updateCampaignSchema,
} from "@/lib/campaigns/campaign";
import {
  getCampaign,
  getCampaignAsCreateInput,
  listCampaigns,
  listFailedDms,
} from "@/lib/campaigns/queries";
import {
  getConversation,
  listConversationsNeedingReply,
  listRecentConversations,
  MESSAGING_WINDOW_HOURS,
  sendReply,
} from "@/lib/inbox/conversations";
import { MetaApiError, TokenExpiredError } from "@/lib/meta/client";
import { listRecentPosts } from "@/lib/instagram/recent-posts";
import { ZernioApiError } from "@/lib/zernio/client";
import type { McpCaller } from "@/lib/oauth/connections";
import { listWorkspaceInstagramAccounts, resolveInstagramAccount } from "@/lib/mcp/accounts";

/**
 * The MCP server for one connection, built fresh for every request. Only the
 * tools the connection's scopes allow are registered, so a connection without
 * a scope does not see its tools at all. Handlers stay thin: they check input
 * and call lib/ functions with the connection's workspace.
 */

/** A refusal the person should read, as opposed to a server fault. */
class ToolRefusal extends Error {}

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function refused(message: string, data?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    ...(data ? { structuredContent: data } : {}),
  };
}

async function run(operation: () => Promise<CallToolResult | Record<string, unknown>>) {
  try {
    const result = await operation();
    return "content" in result ? (result as CallToolResult) : ok(result);
  } catch (error) {
    if (error instanceof ToolRefusal) return refused(error.message);
    if (error instanceof TokenExpiredError) {
      return refused(
        "Instagram no longer accepts this account's login. Reconnect the account in OpenReply's Settings."
      );
    }
    if (error instanceof MetaApiError || error instanceof ZernioApiError) {
      return refused(`Instagram refused the request: ${error.message}`);
    }
    console.error("[MCP] Tool failed", error);
    return refused("The request failed on the OpenReply server.");
  }
}

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const READ_INSTAGRAM: ToolAnnotations = { ...READ, openWorldHint: true };
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const SEND: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const instagramAccount = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe(
    "Which connected Instagram account to use, by username (with or without @) or id. Leave out for the main account."
  );

const target = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("post"),
      postId: z.string().min(1).describe("The post's or reel's id, from list_posts"),
      postUrl: z
        .string()
        .url()
        .optional()
        .describe("Its permalink from list_posts, shown in the dashboard"),
    }),
    z.object({ type: z.literal("any_post") }),
    z.object({ type: z.literal("next_reel") }),
  ])
  .describe(
    "Which comments trigger the campaign: those on one post or reel (type post), on any post (type any_post), or on the next reel posted, which it attaches to once it is up (type next_reel)."
  );

// Field rules come from the dashboard's own schemas, so both enforce the same
// limits; only the descriptions are added here.
const fields = updateCampaignSchema.shape;
const FIELD_DESCRIPTIONS = {
  name: "Campaign name, shown in the dashboard",
  goal: "Optional note on what the campaign is for",
  keywords:
    "Words that trigger the campaign when a comment contains one (up to 10). Ignored when matchAnyWord is true",
  matchAnyWord: "Trigger on every comment, whatever it says, instead of on keywords",
  wholeWordMatch:
    "Match keywords only as whole words (the default); false also matches them inside longer words",
  dmTriggerEnabled: "Also trigger when someone sends one of the keywords by DM",
  dmMessage:
    "The private DM a commenter gets. {username} becomes their name. With a link set, the link arrives as a button under this text",
  openingDmEnabled:
    "Send an opening DM with a button first; the DM with the link follows once they tap it",
  openingDmMessage: "The opening DM's text, required with openingDmEnabled",
  openingDmButtonLabel: "The opening DM's button label, required with openingDmEnabled",
  linkButtonLabel: "Label of the link button (shown as Open link when empty)",
  trackedDestinationUrl:
    "Where the link button goes; clicks are counted. An empty string removes the link",
  secondaryDestinationUrl:
    "Where an optional second link button goes. An empty string removes it",
  secondaryButtonLabel: "Label of the second link button",
  requireFollow:
    "Only send the link to people who follow the account; others get the follow prompt first",
  followPromptMessage: "The follow prompt's text, with requireFollow",
  followPromptButtonLabel: "The follow prompt's button label, with requireFollow",
  followUpEnabled: "Send a follow-up message after the link is delivered",
  followUpMessage: "The follow-up's text, with followUpEnabled",
  followUpDelayMinutes: "Minutes to wait before the follow-up, 0 to 1440",
  publicReplyEnabled: "Also reply publicly under the comment",
  publicReplyMessages:
    "Public reply texts (up to 10); one is picked for each comment so replies vary",
} as const;

const campaignFields = Object.fromEntries(
  Object.entries(FIELD_DESCRIPTIONS).map(([key, description]) => [
    key,
    fields[key as keyof typeof FIELD_DESCRIPTIONS].describe(description),
  ])
) as { [K in keyof typeof FIELD_DESCRIPTIONS]: (typeof fields)[K] };

const createInput = z
  .object({
    instagramAccount,
    target,
    ...campaignFields,
    name: campaignFields.name.unwrap().describe(FIELD_DESCRIPTIONS.name),
    dmMessage: campaignFields.dmMessage.unwrap().describe(FIELD_DESCRIPTIONS.dmMessage),
  })
  .strict();

const updateInput = z
  .object({
    campaignId: z.string().min(1),
    target: target.optional(),
    ...campaignFields,
    isActive: fields.isActive.describe(
      "true switches the campaign on, so it starts sending DMs; false switches it off"
    ),
    reportShareEnabled: fields.reportShareEnabled.describe(
      "Whether the campaign's shareable report link works"
    ),
  })
  .strict();

function targetFields(value: z.infer<typeof target>) {
  switch (value.type) {
    case "post":
      return {
        postId: value.postId,
        postUrl: value.postUrl ?? null,
        matchAnyPost: false,
        pendingNextReel: false,
      };
    case "any_post":
      return { matchAnyPost: true, pendingNextReel: false };
    case "next_reel":
      return { pendingNextReel: true, matchAnyPost: false };
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** Zod's issues as one sentence per field, for the person to correct. */
function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

export async function createMcpServer(caller: McpCaller): Promise<McpServer> {
  const { workspaceId, scopes } = caller;
  const accounts = await listWorkspaceInstagramAccounts(workspaceId);

  const server = new McpServer(
    { name: "openreply", version: "1.0.0" },
    {
      instructions: [
        "OpenReply runs Instagram comment-to-DM campaigns and reads the Instagram DM inbox.",
        accounts.length
          ? `Connected Instagram accounts: ${accounts.map((a, i) => `@${a.username}${i === 0 ? " (main)" : ""}`).join(", ")}. Tools use the main account unless told otherwise.`
          : "No Instagram account is connected yet.",
        `Instagram only allows a reply within ${MESSAGING_WINDOW_HOURS} hours of the person's last message.`,
        "Before send_reply, show the person the exact reply and send it only once they approve it.",
        "New campaigns start switched off: read the settings back and switch one on only when the person says so.",
      ].join(" "),
    }
  );

  async function account(identifier?: string) {
    const found = await resolveInstagramAccount(workspaceId, identifier);
    if (!found) {
      throw new ToolRefusal(
        identifier
          ? `No connected Instagram account matches ${identifier}.`
          : "No Instagram account is connected yet. Connect one in OpenReply's Settings first."
      );
    }
    return found;
  }

  const accountSummary = (a: { id: string; username: string }) => ({ id: a.id, username: a.username });

  server.registerTool(
    "list_conversations_needing_reply",
    {
      description: `DM conversations waiting for a reply: those whose last message is from the other person. Each has the contact, a preview and time of their last message, and how many hours are left in Instagram's ${MESSAGING_WINDOW_HOURS}-hour reply window, soonest to close first. Closed windows are left out unless includeClosed is true; closedWindowCount says how many. Read live from Instagram's 50 most recent conversations. Whether a conversation is a real inquiry or just a thank-you is for you to judge.`,
      inputSchema: z
        .object({
          instagramAccount,
          includeClosed: z
            .boolean()
            .optional()
            .describe("Also list conversations whose reply window has closed"),
        })
        .strict(),
      annotations: READ_INSTAGRAM,
    },
    async (input) =>
      run(async () => {
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          ...(await listConversationsNeedingReply(selected, { includeClosed: input.includeClosed })),
        };
      })
  );

  server.registerTool(
    "list_recent_conversations",
    {
      description:
        "The 50 most recent DM conversations, answered or not, newest first, each with the contact and its last message, including whether that message was mine (fromMe). Read live from Instagram.",
      inputSchema: z.object({ instagramAccount }).strict(),
      annotations: READ_INSTAGRAM,
    },
    async (input) =>
      run(async () => {
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          conversations: await listRecentConversations(selected),
        };
      })
  );

  server.registerTool(
    "get_conversation",
    {
      description: `One DM conversation's messages, oldest to newest (Instagram returns the 20 most recent), each from "me" or "them" with its time and text. Messages without text, such as story replies, reactions and attachments, show as a placeholder. window says whether a reply can still be sent and until when.`,
      inputSchema: z
        .object({
          conversationId: z
            .string()
            .min(1)
            .describe("The conversationId from list_conversations_needing_reply or list_recent_conversations"),
          instagramAccount,
        })
        .strict(),
      annotations: READ_INSTAGRAM,
    },
    async (input) =>
      run(async () => {
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          ...(await getConversation(selected, input.conversationId)),
        };
      })
  );

  server.registerTool(
    "list_posts",
    {
      description:
        "Recent posts and reels, newest first, with id, type (reel, video, image or carousel), caption, date, permalink and thumbnail. Use the id and permalink as a campaign's target post.",
      inputSchema: z
        .object({
          instagramAccount,
          limit: z.number().int().min(1).max(50).optional().describe("How many, default 25"),
        })
        .strict(),
      annotations: READ_INSTAGRAM,
    },
    async (input) =>
      run(async () => {
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          posts: await listRecentPosts(selected, input.limit ?? 25),
        };
      })
  );

  server.registerTool(
    "list_campaigns",
    {
      description:
        "The account's comment-to-DM campaigns, newest first: name, whether it is on (isActive), target, keywords, and stats (DMs sent, failed and skipped, unique link clicks).",
      inputSchema: z.object({ instagramAccount }).strict(),
      annotations: READ,
    },
    async (input) =>
      run(async () => {
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          campaigns: await listCampaigns(workspaceId, selected.id),
        };
      })
  );

  server.registerTool(
    "get_campaign",
    {
      description:
        "One campaign's full settings, in the same field names update_campaign takes, with its tracked links and stats: DMs sent, failed and skipped, unique link clicks and click-through rate.",
      inputSchema: z.object({ campaignId: z.string().min(1) }).strict(),
      annotations: READ,
    },
    async (input) =>
      run(async () => {
        const campaign = await getCampaign(workspaceId, input.campaignId);
        if (!campaign) throw new ToolRefusal("No campaign with that id in this workspace.");
        return { campaign };
      })
  );

  server.registerTool(
    "list_failed_dms",
    {
      description:
        "DMs that failed, newest first, with the campaign, the commenter, their comment, Instagram's reason and when. For one campaign with campaignId, otherwise for the whole account.",
      inputSchema: z
        .object({
          instagramAccount,
          campaignId: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional().describe("How many, default 25"),
        })
        .strict(),
      annotations: READ,
    },
    async (input) =>
      run(async () => {
        const limit = input.limit ?? 25;
        if (input.campaignId) {
          const campaign = await getCampaign(workspaceId, input.campaignId);
          if (!campaign) throw new ToolRefusal("No campaign with that id in this workspace.");
          return { failedDms: await listFailedDms(workspaceId, { campaignId: campaign.id }, limit) };
        }
        const selected = await account(input.instagramAccount);
        return {
          account: accountSummary(selected),
          failedDms: await listFailedDms(workspaceId, { instagramAccountId: selected.id }, limit),
        };
      })
  );

  if (scopes.includes("campaigns:write")) {
    server.registerTool(
      "create_campaign",
      {
        description:
          "Create a comment-to-DM campaign with any of the dashboard's options. It is always created switched off: read the settings back to the person, and switch it on with update_campaign (isActive true) only when they say go. Invalid settings are refused with the reason.",
        inputSchema: createInput,
        annotations: WRITE,
      },
      async (input) =>
        run(async () => {
          const selected = await account(input.instagramAccount);
          // The create schema drops keys it does not know, such as instagramAccount.
          const { target: chosen, ...rest } = input;
          const parsed = createCampaignSchema.safeParse({
            ...withoutUndefined(rest),
            ...targetFields(chosen),
            instagramAccountId: selected.id,
            isActive: false,
          });
          if (!parsed.success) throw new ToolRefusal(describeIssues(parsed.error));
          const created = await createCampaign(workspaceId, parsed.data);
          if (!created.ok) throw new ToolRefusal(created.message);
          return { campaign: await getCampaign(workspaceId, created.campaign.id) };
        })
    );

    server.registerTool(
      "update_campaign",
      {
        description:
          "Change any of a campaign's settings, including switching it on (isActive true) or off (false). Only the fields given change. The campaign that would result must still follow the create rules, or nothing is changed and the reason is returned. Campaigns cannot be deleted from here.",
        inputSchema: updateInput,
        annotations: WRITE,
      },
      async (input) =>
        run(async () => {
          const { campaignId, target: chosen, ...rest } = input;
          const changes = withoutUndefined({
            ...rest,
            ...(chosen ? targetFields(chosen) : {}),
          });
          const current = await getCampaignAsCreateInput(workspaceId, campaignId);
          if (!current) throw new ToolRefusal("No campaign with that id in this workspace.");
          const merged = createCampaignSchema.safeParse({ ...current, ...changes });
          if (!merged.success) throw new ToolRefusal(describeIssues(merged.error));

          const parsed = updateCampaignSchema.safeParse(changes);
          if (!parsed.success) throw new ToolRefusal(describeIssues(parsed.error));
          const updated = await updateCampaign(workspaceId, campaignId, parsed.data);
          if (!updated.ok) throw new ToolRefusal(updated.message);
          return { campaign: await getCampaign(workspaceId, campaignId) };
        })
    );
  }

  if (scopes.includes("messages:send")) {
    server.registerTool(
      "send_reply",
      {
        description: `Send a text DM into an existing conversation, from the account. Always show the person the exact text and send only after they approve it. The ${MESSAGING_WINDOW_HOURS}-hour window is checked again first: if it has closed nothing is sent and status is window_closed. If Instagram refuses, status is rejected with its reason. If the outcome is unknown, status is unconfirmed: it may or may not have arrived, so check the conversation with get_conversation before ever sending again. Never retried automatically.`,
        inputSchema: z
          .object({
            conversationId: z.string().min(1),
            text: z.string().trim().min(1).max(1000).describe("The reply, as the person approved it"),
            instagramAccount,
          })
          .strict(),
        annotations: SEND,
      },
      async (input) =>
        run(async () => {
          const selected = await account(input.instagramAccount);
          const result = await sendReply(selected, input.conversationId, input.text);
          const data = { account: accountSummary(selected), ...result };
          switch (result.status) {
            case "sent":
              return ok(data);
            case "window_closed":
              return refused(
                `Not sent: the ${MESSAGING_WINDOW_HOURS}-hour reply window has closed${result.closedAt ? ` (it closed at ${result.closedAt})` : ""}.`,
                data
              );
            case "rejected":
              return refused(`Not sent: Instagram refused it. ${result.reason}`, data);
            case "unconfirmed":
              return refused(
                `Unconfirmed: Instagram did not confirm the message, so it may or may not have arrived. Check the conversation before sending again. ${result.reason}`,
                data
              );
          }
        })
    );
  }

  return server;
}
