import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  campaignEditAsBuilt,
  describeCampaignIssues,
  newCampaignAsBuilt,
} from "@/lib/campaigns/builder-rules";
import {
  createCampaign,
  createCampaignSchema,
  editIssues,
  updateCampaign,
  updateCampaignSchema,
} from "@/lib/campaigns/campaign";
import {
  getCampaign,
  getCampaignAccount,
  getCampaignForEdit,
  listCampaigns,
  listFailedDms,
  newCampaignDetails,
} from "@/lib/campaigns/queries";
import { campaignTarget, chosenTargetSchema, targetFlags } from "@/lib/campaigns/target";
import {
  getConversation,
  InboxRefusal,
  listConversationsNeedingReply,
  listRecentConversations,
  MESSAGING_WINDOW_HOURS,
  sendReply,
} from "@/lib/inbox/conversations";
import { MetaApiError, TokenExpiredError } from "@/lib/meta/client";
import { findAccountPost, listRecentPosts } from "@/lib/instagram/recent-posts";
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

const NO_SUCH_CAMPAIGN = "No campaign with that id in this workspace.";

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
    if (error instanceof ToolRefusal || error instanceof InboxRefusal) return refused(error.message);
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

const target = chosenTargetSchema.describe(
  "Which comments trigger the campaign: those on one post or reel of the campaign's account (type post), on any post (type any_post), or on the next reel posted, which it attaches to once it is up (type next_reel). On an existing campaign, next_reel attaches to the first reel posted after the campaign was created, which can be a reel already up."
);

// Field rules come from the dashboard's own schemas, create's for
// create_campaign and update's for update_campaign, so each tool enforces the
// same limits as its dashboard counterpart; only the descriptions are added here.
const FIELD_DESCRIPTIONS = {
  name: "Campaign name, shown in the dashboard; Campaign for @account when blank",
  goal: "Optional note on what the campaign is for",
  keywords:
    "Words that trigger the campaign when a comment contains one (up to 10). Ignored when matchAnyWord is true",
  matchAnyWord: "Trigger on every comment, whatever it says, instead of on keywords",
  wholeWordMatch:
    "Match keywords only as whole words (the default); false also matches them inside longer words",
  dmTriggerEnabled: "Also trigger when someone sends one of the keywords by DM",
  dmMessage:
    "The private DM a commenter gets. {username} becomes their name. With a link set, the link arrives as a button under this text, and {link}, where the link shows if the button cannot be sent, is added at the end unless the text has it",
  openingDmEnabled:
    "Send an opening DM with a button first; the DM with the link follows once they tap it",
  openingDmMessage: "The opening DM's text, required with openingDmEnabled",
  openingDmButtonLabel: "The opening DM's button label, required with openingDmEnabled",
  linkButtonLabel: "Label of the link button; Open link when blank",
  trackedDestinationUrl:
    "Where the link button goes; clicks are counted. An empty string removes the link",
  secondaryDestinationUrl:
    "Where an optional second link button goes; it needs the first link. An empty string removes it",
  secondaryButtonLabel: "Label of the second link button; Open link when blank",
  requireFollow:
    "Only send the link to people who follow the account; others get the follow prompt first",
  followPromptMessage: "The follow prompt's text, with requireFollow",
  followPromptButtonLabel: "The follow prompt's button label, with requireFollow; i'm following when blank",
  followUpEnabled: "Send a follow-up message after the link is delivered",
  followUpMessage: "The follow-up's text, with followUpEnabled",
  followUpDelayMinutes: "Minutes to wait before the follow-up, 0 to 1440",
  publicReplyEnabled: "Also reply publicly under the comment",
  publicReplyMessages:
    "Public reply texts (up to 10); one is picked for each comment so replies vary",
} as const;

type CampaignField = keyof typeof FIELD_DESCRIPTIONS;

/** A schema's campaign fields, each with its description. */
function describedFields<Shape extends Record<CampaignField, z.ZodType>>(shape: Shape) {
  return Object.fromEntries(
    Object.entries(FIELD_DESCRIPTIONS).map(([key, description]) => [
      key,
      shape[key as CampaignField].describe(description),
    ])
  ) as { [K in CampaignField]: Shape[K] };
}

const createInput = z
  .object({
    instagramAccount,
    target,
    ...describedFields(createCampaignSchema.shape),
  })
  .strict();

const updateFields = updateCampaignSchema.shape;
const updateInput = z
  .object({
    campaignId: z.string().min(1),
    target: target.optional(),
    ...describedFields(updateFields),
    isActive: updateFields.isActive.describe(
      "true switches the campaign on, so it starts sending DMs; false switches it off"
    ),
    reportShareEnabled: updateFields.reportShareEnabled.describe(
      "Whether the campaign's shareable report link works"
    ),
  })
  .strict();

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** What the connection is told when it connects, naming only the tools its scopes give it. */
async function serverInstructions({ workspaceId, scopes }: McpCaller) {
  const accounts = await listWorkspaceInstagramAccounts(workspaceId);
  return [
    "OpenReply runs Instagram comment-to-DM campaigns and reads the Instagram DM inbox.",
    accounts.length
      ? `Connected Instagram accounts: ${accounts.map((a, i) => `@${a.username}${i === 0 ? " (main)" : ""}`).join(", ")}. Tools use the main account unless told otherwise.`
      : "No Instagram account is connected yet.",
    `Instagram only allows a reply within ${MESSAGING_WINDOW_HOURS} hours of the person's last message.`,
    ...(scopes.includes("messages:send")
      ? ["Before send_reply, show the person the exact reply and send it only once they approve it."]
      : []),
    ...(scopes.includes("campaigns:write")
      ? ["New campaigns start switched off: read the settings back and switch one on only when the person says so."]
      : []),
  ].join(" ");
}

/**
 * `initializing` says whether the request is the client's initialize. Only
 * the answer to it carries the instructions, so only then are they built.
 */
export async function createMcpServer(
  caller: McpCaller,
  { initializing }: { initializing: boolean }
): Promise<McpServer> {
  const { workspaceId, scopes } = caller;

  const server = new McpServer(
    { name: "openreply", version: "1.0.0" },
    initializing ? { instructions: await serverInstructions(caller) } : {}
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

  /** Runs a tool on the chosen account, its result headed by which account that was. */
  async function forAccount<T extends Record<string, unknown>>(
    identifier: string | undefined,
    tool: (selected: Awaited<ReturnType<typeof account>>) => Promise<T>
  ) {
    const selected = await account(identifier);
    return { account: accountSummary(selected), ...(await tool(selected)) };
  }

  /**
   * A campaign's target post, checked with Instagram to be one of the
   * campaign's account's own posts: a campaign on another account's post
   * would never trigger. Nothing is saved unchecked.
   */
  async function accountPost(selected: Awaited<ReturnType<typeof account>>, postId: string) {
    let post: Awaited<ReturnType<typeof findAccountPost>>;
    try {
      post = await findAccountPost(selected, postId);
    } catch (error) {
      if (error instanceof TokenExpiredError) throw error;
      const reason =
        error instanceof MetaApiError
          ? `Instagram refused the request (${error.message})`
          : "Instagram could not be reached";
      throw new ToolRefusal(
        `${reason}, so the target post could not be checked and nothing was saved. Try again in a moment.`
      );
    }
    if (!post) {
      throw new ToolRefusal(
        `target.postId: ${postId} is not a post or reel of @${selected.username}. Use an id from list_posts for that account.`
      );
    }
    return post;
  }

  server.registerTool(
    "list_conversations_needing_reply",
    {
      description: `DM conversations waiting for a reply: those whose last message is from the other person. Each has the contact, a preview and time of their last message, and how many hours are left in Instagram's ${MESSAGING_WINDOW_HOURS}-hour reply window, soonest to close first. Closed windows are left out unless includeClosed is true; closedWindowCount says how many. Without includeClosed, conversations quiet for over ${MESSAGING_WINDOW_HOURS} hours whose last message Instagram's list leaves out are not opened, as they can no longer be replied to; uncheckedCount says how many. Read live from Instagram's 50 most recent conversations. Whether a conversation is a real inquiry or just a thank-you is for you to judge.`,
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
      run(() =>
        forAccount(input.instagramAccount, (selected) =>
          listConversationsNeedingReply(selected, { includeClosed: input.includeClosed })
        )
      )
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
      run(() =>
        forAccount(input.instagramAccount, async (selected) => ({
          conversations: await listRecentConversations(selected),
        }))
      )
  );

  server.registerTool(
    "get_conversation",
    {
      description: `One DM conversation's messages, oldest to newest (Instagram returns the 20 most recent), each from "me" or "them" with its time and text. Messages without text, such as story replies, reactions and attachments, show as a placeholder. window says whether a reply can still be sent and until when; open is null when the messages returned are all mine and recent, so the person's last message is older than them and the window cannot be told. Use the instagramAccount the conversation was listed with: another account's conversation is refused.`,
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
      run(() =>
        forAccount(input.instagramAccount, (selected) => getConversation(selected, input.conversationId))
      )
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
      run(() =>
        forAccount(input.instagramAccount, async (selected) => ({
          posts: await listRecentPosts(selected, input.limit ?? 25),
        }))
      )
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
      run(() =>
        forAccount(input.instagramAccount, async (selected) => ({
          campaigns: await listCampaigns(workspaceId, selected.id),
        }))
      )
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
        if (!campaign) throw new ToolRefusal(NO_SUCH_CAMPAIGN);
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
          const campaignAccount = await getCampaignAccount(workspaceId, input.campaignId);
          if (!campaignAccount) throw new ToolRefusal(NO_SUCH_CAMPAIGN);
          // A campaign belongs to one account; an account named with it must be that one.
          if (input.instagramAccount) {
            const named = await account(input.instagramAccount);
            if (named.id !== campaignAccount.id) {
              throw new ToolRefusal(
                `That campaign is on @${campaignAccount.username}, not @${named.username}.`
              );
            }
          }
          return {
            account: accountSummary(campaignAccount),
            failedDms: await listFailedDms(workspaceId, { campaignId: input.campaignId }, limit),
          };
        }
        return forAccount(input.instagramAccount, async (selected) => ({
          failedDms: await listFailedDms(workspaceId, { instagramAccountId: selected.id }, limit),
        }));
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
          const built = newCampaignAsBuilt(withoutUndefined(rest), selected.username);
          if (!built.ok) throw new ToolRefusal(built.message);
          const parsed = createCampaignSchema.safeParse({
            ...built.fields,
            ...targetFlags(chosen),
            instagramAccountId: selected.id,
            isActive: false,
          });
          if (!parsed.success) throw new ToolRefusal(describeCampaignIssues(parsed.error.issues));
          if (chosen.type === "post") {
            const post = await accountPost(selected, chosen.postId);
            parsed.data.postUrl = chosen.postUrl ?? post.permalink;
          }
          const created = await createCampaign(workspaceId, parsed.data);
          if (!created.ok) throw new ToolRefusal(created.message);
          return { campaign: newCampaignDetails(created.campaign, accountSummary(selected)) };
        })
    );

    server.registerTool(
      "update_campaign",
      {
        description:
          "Change any of a campaign's settings, including switching it on (isActive true) or off (false). Only the fields given change. An edit that would break a create rule is refused with the reason and nothing is changed; a rule the campaign already breaks (such as an imported campaign's bad post link) does not block an edit that leaves it alone. If the campaign is saved elsewhere meanwhile, nothing is changed: read it again and retry. Campaigns cannot be deleted from here.",
        inputSchema: updateInput,
        annotations: WRITE,
      },
      async (input) =>
        run(async () => {
          const { campaignId, target: chosen, ...rest } = input;
          const stored = await getCampaignForEdit(workspaceId, campaignId);
          if (!stored) throw new ToolRefusal(NO_SUCH_CAMPAIGN);
          const built = campaignEditAsBuilt(
            withoutUndefined({ ...rest, ...(chosen ? targetFlags(chosen) : {}) }),
            stored.settings,
            stored.instagramAccount.username
          );
          if (!built.ok) throw new ToolRefusal(built.message);

          const parsed = updateCampaignSchema.safeParse(built.fields);
          if (!parsed.success) throw new ToolRefusal(describeCampaignIssues(parsed.error.issues));
          const broken = editIssues(stored.settings, parsed.data);
          if (broken.length > 0) throw new ToolRefusal(describeCampaignIssues(broken));
          if (chosen?.type === "post") {
            const current = campaignTarget(stored.settings);
            if (current.type === "post" && current.postId === chosen.postId) {
              // The post the campaign is already on is not looked up again: it
              // may since have dropped out of the recent posts the lookup reads.
              parsed.data.postUrl = chosen.postUrl ?? current.postUrl;
            } else {
              const post = await accountPost(await account(stored.instagramAccount.id), chosen.postId);
              parsed.data.postUrl = chosen.postUrl ?? post.permalink;
            }
          }

          // Written only if nothing saved the campaign since it was read, so
          // the checks above still hold.
          const updated = await updateCampaign(workspaceId, campaignId, parsed.data, {
            unchangedSince: stored.updatedAt,
          });
          if (!updated.ok) throw new ToolRefusal(updated.message);
          return { campaign: await getCampaign(workspaceId, campaignId) };
        })
    );
  }

  if (scopes.includes("messages:send")) {
    server.registerTool(
      "send_reply",
      {
        description: `Send a text DM into an existing conversation, from the account. Always show the person the exact text and send only after they approve it. The ${MESSAGING_WINDOW_HOURS}-hour window is checked again first: if it has closed nothing is sent and status is window_closed. When the conversation cannot show the window, Instagram decides. Use the instagramAccount the conversation was listed with. If Instagram refuses, status is rejected with its reason. If the outcome is unknown, status is unconfirmed: it may or may not have arrived, so check the conversation with get_conversation before ever sending again. Never retried automatically.`,
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
