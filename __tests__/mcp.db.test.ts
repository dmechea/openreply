/**
 * The MCP endpoint driven by a real MCP SDK client, over the OAuth tokens a
 * real handshake issues, against a real Postgres and an Instagram faked at
 * fetch: which tools each scope combination sees, what every tool does,
 * workspace isolation, and the 401s for a missing, malformed, expired or
 * revoked token. Needs TEST_DATABASE_URL; see docs/testing.md.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTestDatabase, openTestDatabase, type TestDatabase } from "./support/database";
import { signInAs } from "./support/session";
import { connectInstagramAccount, createOwner, importCampaign } from "./support/fixtures";
import { createFakeInstagram, hoursAgo, type FakeInstagram } from "./support/instagram";
import { ALL_SCOPES, BASE_URL, connect, MCP_URL } from "./support/oauth";

vi.mock("@/lib/db/client", async () => (await import("./support/database")).prismaModule);
vi.mock("@/lib/auth", async () => (await import("./support/session")).authModule);

import { handleMcpRequest } from "../lib/mcp/handler";
import { POST as dashboardCreate } from "../app/api/automations/route";
import { createCampaignSchema } from "../lib/campaigns/campaign";
import { getCampaignAsCreateInput } from "../lib/campaigns/queries";
import { TRACKED_LINK_ORDER } from "../lib/tracking/link-order";

const READ_TOOLS = [
  "get_campaign",
  "get_conversation",
  "list_campaigns",
  "list_conversations_needing_reply",
  "list_failed_dms",
  "list_posts",
  "list_recent_conversations",
];
const CAMPAIGN_TOOLS = ["create_campaign", "update_campaign"];
const SEND_TOOLS = ["send_reply"];

const PLACEHOLDER =
  "[No text: a story reply, reaction, photo, voice message or other attachment]";

let db: TestDatabase;
let instagram: FakeInstagram;
let owner = { id: "" };
let workspaceId = "";
let main = { id: "", instagramId: "ig_main", username: "glowwithmia" };
let second = { id: "", instagramId: "ig_second", username: "miasecond" };
let stranger = { id: "", workspaceId: "", accountId: "", campaignId: "" };
const conversations: Record<string, string> = {};
const clients: Client[] = [];

type Answer = { status: number; challenge: string | null };

/** A transport straight into the endpoint, noting each answer it gets back. */
function transport(headers: Record<string, string>, answers: Answer[] = []) {
  return new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: async (url, init) => {
      const response = await handleMcpRequest(new Request(url, init));
      answers.push({ status: response.status, challenge: response.headers.get("www-authenticate") });
      return response;
    },
    requestInit: { headers },
  });
}

async function mcpClient(accessToken: string, answers?: Answer[]) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport({ Authorization: `Bearer ${accessToken}` }, answers));
  clients.push(client);
  return client;
}

async function clientFor(userId: string, grants = ALL_SCOPES) {
  const tokens = await connect({ userId, grants });
  return mcpClient(tokens.access_token);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** A tool's structured result, failing the test if the tool reported an error. */
async function data<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function errorText(result: CallToolResult) {
  expect(result.isError).toBe(true);
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join(" ");
}

async function toolNames(client: Client) {
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
}

const minimalCampaign = {
  name: "Guide",
  target: { type: "any_post" },
  keywords: ["GUIDE"],
  dmMessage: "Here is the guide",
};

describe.skipIf(!hasTestDatabase)("the OpenReply MCP endpoint", () => {
  let full: Client;

  beforeAll(async () => {
    db = await openTestDatabase("mcp_tools");
    instagram = createFakeInstagram();
    vi.stubGlobal("fetch", instagram.fetch);

    const created = await createOwner(db.prisma, "mia");
    owner = created.user;
    workspaceId = created.workspace.id;
    const secondAccount = await connectInstagramAccount(db.prisma, workspaceId, {
      ...second,
      connectedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const mainAccount = await connectInstagramAccount(db.prisma, workspaceId, {
      ...main,
      connectedAt: new Date("2026-06-01T00:00:00Z"),
    });
    main = { ...main, id: mainAccount.id };
    second = { ...second, id: secondAccount.id };
    instagram.addAccount({ ...main, accessToken: mainAccount.plainAccessToken });
    instagram.addAccount({ ...second, accessToken: secondAccount.plainAccessToken });

    const other = await createOwner(db.prisma, "stranger");
    const strangerAccount = await connectInstagramAccount(db.prisma, other.workspace.id, {
      username: "strangerbrand",
      instagramId: "ig_stranger",
    });
    instagram.addAccount({
      instagramId: "ig_stranger",
      username: "strangerbrand",
      accessToken: strangerAccount.plainAccessToken,
    });
    const strangerCampaign = await db.prisma.automation.create({
      data: {
        workspaceId: other.workspace.id,
        instagramAccountId: strangerAccount.id,
        name: "Their campaign",
        matchAnyPost: true,
        keywords: ["THEIRS"],
        dmMessage: "Theirs",
      },
    });
    stranger = {
      id: other.user.id,
      workspaceId: other.workspace.id,
      accountId: strangerAccount.id,
      campaignId: strangerCampaign.id,
    };

    const person = (name: string) => ({ id: `igsid_${name}`, username: name });
    conversations.urgent = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("urgent_ana"),
      messages: [{ fromMe: false, text: "Is the course still open?", at: hoursAgo(23) }],
    });
    conversations.fresh = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("fresh_bo"),
      messages: [{ fromMe: false, text: "Love this!", at: hoursAgo(2) }],
    });
    conversations.answered = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("answered_cy"),
      messages: [
        { fromMe: false, text: "GUIDE", at: hoursAgo(3) },
        { fromMe: true, text: "Here is the guide", at: hoursAgo(3) },
      ],
    });
    conversations.closed = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("closed_di"),
      messages: [{ fromMe: false, text: "Hello?", at: hoursAgo(30) }],
    });
    conversations.story = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("story_ed"),
      messages: [{ fromMe: false, at: hoursAgo(1) }],
    });
    conversations.inquiry = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("inquiry_fay"),
      messages: [
        { fromMe: true, text: "Here is your link", at: hoursAgo(6) },
        { fromMe: false, text: "Thanks! Do you do one-to-one coaching?", at: hoursAgo(5) },
      ],
    });
    conversations.onlyMine = instagram.addConversation({
      accountId: main.instagramId,
      contact: person("only_mine_gus"),
      messages: [{ fromMe: true, text: "Thanks for following", at: hoursAgo(1) }],
    });
    conversations.secondAccount = instagram.addConversation({
      accountId: second.instagramId,
      contact: person("second_hal"),
      messages: [{ fromMe: false, text: "Hi second account", at: hoursAgo(4) }],
    });
    conversations.stranger = instagram.addConversation({
      accountId: "ig_stranger",
      contact: person("their_fan"),
      messages: [{ fromMe: false, text: "Private to them", at: hoursAgo(1) }],
    });

    instagram.addMedia(main.instagramId, [
      {
        id: "media_reel",
        caption: "Skincare routine",
        media_type: "VIDEO",
        media_product_type: "REELS",
        thumbnail_url: "https://cdn.example/reel.jpg",
        timestamp: "2026-10-14T09:00:00+0000",
        permalink: "https://www.instagram.com/reel/abc/",
      },
      {
        id: "media_photo",
        caption: "New drop",
        media_type: "IMAGE",
        media_url: "https://cdn.example/photo.jpg",
        timestamp: "2026-10-10T09:00:00+0000",
        permalink: "https://www.instagram.com/p/def/",
      },
    ]);

    full = await clientFor(owner.id);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    vi.unstubAllGlobals();
    await db?.close();
  });

  beforeEach(() => {
    signInAs(owner.id);
  });

  describe("tools offered per scope", () => {
    it.each([
      [["read"], READ_TOOLS],
      [["read", "campaigns:write"], [...READ_TOOLS, ...CAMPAIGN_TOOLS]],
      [["read", "messages:send"], [...READ_TOOLS, ...SEND_TOOLS]],
      [ALL_SCOPES, [...READ_TOOLS, ...CAMPAIGN_TOOLS, ...SEND_TOOLS]],
    ])("a connection granted %j sees exactly its tools", async (grants, expected) => {
      const client = await clientFor(owner.id, grants);
      expect(await toolNames(client)).toEqual([...expected].sort());
    });

    it("offers no way to delete, duplicate or import campaigns", async () => {
      const names = await toolNames(full);
      expect(names.filter((n) => /delete|remove|duplicate|import/.test(n))).toEqual([]);
    });

    it("marks reads read-only and sending destructive", async () => {
      const { tools } = await full.listTools();
      for (const tool of tools) {
        if (READ_TOOLS.includes(tool.name)) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        }
      }
      for (const name of CAMPAIGN_TOOLS) {
        expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });
      }
      expect(tools.find((t) => t.name === "send_reply")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    });

    it("refuses a tool the connection was not granted", async () => {
      const readOnly = await clientFor(owner.id, ["read"]);
      const attempt = await readOnly
        .callTool({ name: "send_reply", arguments: { conversationId: conversations.fresh, text: "hi" } })
        .then((result) => (result as CallToolResult).isError, () => true);
      expect(attempt).toBe(true);
      expect(instagram.sends).toEqual([]);
    });

    it("names the connected accounts and the approval rule in its instructions", () => {
      const instructions = full.getInstructions() ?? "";
      expect(instructions).toContain("@glowwithmia (main)");
      expect(instructions).toContain("@miasecond");
      expect(instructions).not.toContain("strangerbrand");
      expect(instructions).toMatch(/approve/);
    });
  });

  describe("inbox", () => {
    type Waiting = {
      conversations: {
        conversationId: string;
        contact: { username: string };
        lastMessage: { text: string; sentAt: string };
        window: { open: boolean; closesAt: string; hoursLeft: number };
      }[];
      closedWindowCount: number;
      account: { username: string };
    };

    it("lists conversations whose last message is theirs, soonest to close first", async () => {
      const waiting = await data<Waiting>(full, "list_conversations_needing_reply");
      expect(waiting.account.username).toBe("glowwithmia");
      expect(waiting.conversations.map((c) => c.contact.username)).toEqual([
        "urgent_ana",
        "inquiry_fay",
        "fresh_bo",
        "story_ed",
      ]);
      expect(waiting.closedWindowCount).toBe(1);

      const [urgent, inquiry] = waiting.conversations;
      expect(urgent.lastMessage.text).toBe("Is the course still open?");
      expect(urgent.window.open).toBe(true);
      expect(urgent.window.hoursLeft).toBeGreaterThanOrEqual(0.9);
      expect(urgent.window.hoursLeft).toBeLessThanOrEqual(1);
      expect(Date.parse(urgent.window.closesAt) - Date.parse(urgent.lastMessage.sentAt)).toBe(
        24 * 3_600_000
      );
      expect(inquiry.window.hoursLeft).toBeGreaterThan(18.8);
      expect(inquiry.window.hoursLeft).toBeLessThanOrEqual(19);
      expect(waiting.conversations[3].lastMessage.text).toBe(PLACEHOLDER);
    });

    it("adds closed windows only when asked, after the open ones", async () => {
      const waiting = await data<Waiting>(full, "list_conversations_needing_reply", {
        includeClosed: true,
      });
      const usernames = waiting.conversations.map((c) => c.contact.username);
      expect(usernames.at(-1)).toBe("closed_di");
      const closed = waiting.conversations.at(-1)!;
      expect(closed.window).toMatchObject({ open: false, hoursLeft: 0 });
    });

    it("lists recent conversations, answered or not, saying whose the last message was", async () => {
      const recent = await data<{
        conversations: { contact: { username: string }; lastMessage: { fromMe: boolean; text: string } }[];
      }>(full, "list_recent_conversations");
      const byName = Object.fromEntries(recent.conversations.map((c) => [c.contact.username, c.lastMessage]));
      expect(Object.keys(byName).sort()).toEqual(
        ["answered_cy", "closed_di", "fresh_bo", "inquiry_fay", "only_mine_gus", "story_ed", "urgent_ana"]
      );
      expect(byName.answered_cy).toEqual(expect.objectContaining({ fromMe: true, text: "Here is the guide" }));
      expect(byName.fresh_bo.fromMe).toBe(false);
    });

    it("reads a conversation oldest to newest, with a placeholder for messages without text", async () => {
      const thread = await data<{
        contact: { username: string };
        window: { open: boolean; hoursLeft: number };
        messages: { from: string; text: string; sentAt: string }[];
      }>(full, "get_conversation", { conversationId: conversations.inquiry });
      expect(thread.contact.username).toBe("inquiry_fay");
      expect(thread.messages.map((m) => [m.from, m.text])).toEqual([
        ["me", "Here is your link"],
        ["them", "Thanks! Do you do one-to-one coaching?"],
      ]);
      expect(Date.parse(thread.messages[0].sentAt)).toBeLessThan(Date.parse(thread.messages[1].sentAt));
      expect(thread.window.open).toBe(true);

      const story = await data<{ messages: { text: string }[] }>(full, "get_conversation", {
        conversationId: conversations.story,
      });
      expect(story.messages.map((m) => m.text)).toEqual([PLACEHOLDER]);

      const closed = await data<{ window: { open: boolean } }>(full, "get_conversation", {
        conversationId: conversations.closed,
      });
      expect(closed.window.open).toBe(false);
    });

    it("uses another connected account when named", async () => {
      for (const name of ["@miasecond", "MIASECOND", second.id]) {
        const waiting = await data<Waiting>(full, "list_conversations_needing_reply", {
          instagramAccount: name,
        });
        expect(waiting.account.username).toBe("miasecond");
        expect(waiting.conversations.map((c) => c.contact.username)).toEqual(["second_hal"]);
      }
    });
  });

  describe("send_reply", () => {
    it("sends a text reply to the person in the conversation", async () => {
      const result = await data<{ status: string; messageId: string }>(full, "send_reply", {
        conversationId: conversations.fresh,
        text: "Thank you so much!",
      });
      expect(result.status).toBe("sent");
      expect(result.messageId).toBeTruthy();
      expect(instagram.sends.at(-1)).toEqual({
        accountId: main.instagramId,
        recipientId: "igsid_fresh_bo",
        text: "Thank you so much!",
      });
    });

    it("refuses after the window closed without calling Instagram's send", async () => {
      for (const conversationId of [conversations.closed, conversations.onlyMine]) {
        const before = instagram.countRequests("POST", "/messages");
        const result = await call(full, "send_reply", { conversationId, text: "Sorry for the wait" });
        expect(errorText(result)).toMatch(/window has closed/);
        expect(result.structuredContent).toMatchObject({ status: "window_closed" });
        expect(instagram.countRequests("POST", "/messages")).toBe(before);
      }
    });

    it("reports Instagram's refusal as such", async () => {
      instagram.rejectNextSend(400, 10, "This message is sent outside of allowed window");
      const before = instagram.countRequests("POST", "/messages");
      const result = await call(full, "send_reply", {
        conversationId: conversations.urgent,
        text: "Yes it is!",
      });
      expect(errorText(result)).toMatch(/Instagram refused it.*outside of allowed window/);
      expect(result.structuredContent).toMatchObject({ status: "rejected" });
      expect(instagram.countRequests("POST", "/messages")).toBe(before + 1);
    });

    it("reports an unconfirmed delivery and never retries it", async () => {
      for (const failure of [() => instagram.loseNextSend(), () => instagram.garbleNextSend()]) {
        failure();
        const before = instagram.countRequests("POST", "/messages");
        const sentBefore = instagram.sends.length;
        const result = await call(full, "send_reply", {
          conversationId: conversations.inquiry,
          text: "Yes, I do!",
        });
        expect(errorText(result)).toMatch(/Unconfirmed/);
        expect(result.structuredContent).toMatchObject({ status: "unconfirmed" });
        expect(instagram.countRequests("POST", "/messages")).toBe(before + 1);
        expect(instagram.sends.length).toBe(sentBefore);
      }
    });

    it("rejects an empty or overlong reply before reaching Instagram", async () => {
      const before = instagram.countRequests("POST", "/messages");
      for (const text of ["   ", "x".repeat(1001)]) {
        const result = await full
          .callTool({ name: "send_reply", arguments: { conversationId: conversations.fresh, text } })
          .then((r) => (r as CallToolResult).isError, () => true);
        expect(result).toBe(true);
      }
      expect(instagram.countRequests("POST", "/messages")).toBe(before);
    });
  });

  describe("posts", () => {
    it("lists recent posts and reels for picking a target", async () => {
      const { posts } = await data<{ posts: unknown[] }>(full, "list_posts");
      expect(posts).toEqual([
        {
          id: "media_reel",
          type: "reel",
          caption: "Skincare routine",
          postedAt: "2026-10-14T09:00:00+0000",
          permalink: "https://www.instagram.com/reel/abc/",
          thumbnailUrl: "https://cdn.example/reel.jpg",
        },
        {
          id: "media_photo",
          type: "image",
          caption: "New drop",
          postedAt: "2026-10-10T09:00:00+0000",
          permalink: "https://www.instagram.com/p/def/",
          thumbnailUrl: "https://cdn.example/photo.jpg",
        },
      ]);
      expect((await data<{ posts: unknown[] }>(full, "list_posts", { limit: 1 })).posts).toHaveLength(1);
    });
  });

  describe("campaigns", () => {
    type Campaign = Record<string, unknown> & {
      id: string;
      isActive: boolean;
      target: Record<string, unknown>;
      stats: Record<string, number>;
    };

    async function createViaMcp(args: Record<string, unknown> = minimalCampaign) {
      return (await data<{ campaign: Campaign }>(full, "create_campaign", args)).campaign;
    }

    it("creates a campaign switched off, on the main account", async () => {
      const campaign = await createViaMcp();
      expect(campaign.isActive).toBe(false);
      expect(campaign.instagramAccount).toEqual({ id: main.id, username: "glowwithmia" });
      expect(campaign.target).toEqual({ type: "any_post" });
      const stored = await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored).toMatchObject({ isActive: false, workspaceId, instagramAccountId: main.id });
    });

    it("cannot be asked to create one switched on", async () => {
      const result = await full
        .callTool({ name: "create_campaign", arguments: { ...minimalCampaign, isActive: true } })
        .then((r) => (r as CallToolResult).isError, () => true);
      expect(result).toBe(true);
    });

    it("stores exactly what the dashboard stores for the same options", async () => {
      const options = {
        name: "Parity",
        goal: "Leads",
        keywords: ["LINK", "GUIDE"],
        wholeWordMatch: false,
        dmTriggerEnabled: true,
        dmMessage: "Hi {username}, here you go",
        openingDmEnabled: true,
        openingDmMessage: "Want it?",
        openingDmButtonLabel: "Yes please",
        linkButtonLabel: "Get it",
        trackedDestinationUrl: "https://example.com/a",
        secondaryDestinationUrl: "https://example.com/b",
        secondaryButtonLabel: "More",
        requireFollow: true,
        followPromptMessage: "Follow first",
        followPromptButtonLabel: "Following",
        followUpEnabled: true,
        followUpMessage: "Thanks!",
        followUpDelayMinutes: 60,
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent!", " Check your DMs "],
      };
      const viaMcp = await createViaMcp({
        ...options,
        target: { type: "post", postId: "media_reel", postUrl: "https://www.instagram.com/reel/abc/" },
      });

      const res = await dashboardCreate(
        new NextRequest(`${BASE_URL}/api/automations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...options,
            instagramAccountId: main.id,
            postId: "media_reel",
            postUrl: "https://www.instagram.com/reel/abc/",
            matchAnyPost: false,
            pendingNextReel: false,
            isActive: false,
          }),
        })
      );
      expect(res.status).toBe(201);
      const viaDashboard = (await res.json()).data.id as string;

      async function snapshot(id: string) {
        const { id: storedId, createdAt, updatedAt, reportShareSlug, ...row } =
          await db.prisma.automation.findUniqueOrThrow({ where: { id } });
        const links = await db.prisma.trackedLink.findMany({
          where: { automationId: id },
          orderBy: TRACKED_LINK_ORDER,
          select: { label: true, destinationUrl: true, position: true },
        });
        expect([storedId, createdAt, updatedAt, reportShareSlug].every(Boolean)).toBe(true);
        return { ...row, name: "", links };
      }
      expect(await snapshot(viaMcp.id)).toEqual(await snapshot(viaDashboard));
    });

    it.each([
      [{ type: "post", postId: "media_reel" }, { postId: "media_reel", matchAnyPost: false, pendingNextReel: false }],
      [{ type: "any_post" }, { postId: null, matchAnyPost: true, pendingNextReel: false }],
      [{ type: "next_reel" }, { postId: null, matchAnyPost: false, pendingNextReel: true }],
    ])("targets exactly one of a post, any post or the next reel (%j)", async (target, stored) => {
      const campaign = await createViaMcp({ ...minimalCampaign, target });
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject(stored);
    });

    it.each([
      ["no target", { target: undefined }, /target/],
      ["a post target without a post", { target: { type: "post" } }, /postId/],
      ["more than ten keywords", { keywords: Array.from({ length: 11 }, (_, i) => `K${i}`) }, /keywords/],
      ["no keywords", { keywords: [] }, /Add at least one keyword, or match any word/],
      ["a DM over 1000 characters", { dmMessage: "x".repeat(1001) }, /dmMessage/],
      ["a bad link URL", { trackedDestinationUrl: "not a url" }, /trackedDestinationUrl/],
      ["an opening DM without a button", { openingDmEnabled: true, openingDmMessage: "Tap" }, /Opening DM needs a message and a button label/],
      ["a follow-up delay over a day", { followUpDelayMinutes: 2000 }, /followUpDelayMinutes/],
    ])("refuses %s with the reason", async (_case, change, reason) => {
      const before = await db.prisma.automation.count();
      const result = await full
        .callTool({ name: "create_campaign", arguments: { ...minimalCampaign, ...change } })
        .then(
          (r) => (r as CallToolResult),
          (error: Error) => ({ isError: true, content: [{ type: "text", text: error.message }] }) as CallToolResult
        );
      expect(errorText(result)).toMatch(reason);
      expect(await db.prisma.automation.count()).toBe(before);
    });

    it("switches a campaign on and off and edits any setting", async () => {
      const campaign = await createViaMcp({
        ...minimalCampaign,
        target: { type: "post", postId: "media_reel", postUrl: "https://www.instagram.com/reel/abc/" },
      });

      const on = await data<{ campaign: Campaign }>(full, "update_campaign", {
        campaignId: campaign.id,
        isActive: true,
      });
      expect(on.campaign.isActive).toBe(true);

      const edited = await data<{ campaign: Campaign }>(full, "update_campaign", {
        campaignId: campaign.id,
        keywords: ["NEW"],
        dmMessage: "Updated DM",
        trackedDestinationUrl: "https://example.com/new",
        target: { type: "next_reel" },
      });
      expect(edited.campaign).toMatchObject({
        isActive: true,
        keywords: ["NEW"],
        dmMessage: "Updated DM",
        trackedDestinationUrl: "https://example.com/new",
        target: { type: "next_reel" },
      });
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
        postId: null,
        postUrl: null,
        pendingNextReel: true,
      });

      const off = await data<{ campaign: Campaign }>(full, "update_campaign", {
        campaignId: campaign.id,
        isActive: false,
      });
      expect(off.campaign.isActive).toBe(false);
    });

    it("refuses an edit that would leave an invalid campaign, changing nothing", async () => {
      const campaign = await createViaMcp();
      const result = await call(full, "update_campaign", {
        campaignId: campaign.id,
        keywords: [],
      });
      expect(errorText(result)).toMatch(/Add at least one keyword, or match any word/);
      expect((await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).keywords).toEqual([
        "GUIDE",
      ]);

      const opening = await call(full, "update_campaign", {
        campaignId: campaign.id,
        openingDmEnabled: true,
      });
      expect(errorText(opening)).toMatch(/Opening DM needs a message and a button label/);
    });

    describe("an imported campaign that breaks today's create rules", () => {
      // The CSV import stores a postUrl without checking it is a URL.
      async function imported() {
        const campaign = await importCampaign(db.prisma, {
          workspaceId,
          instagramAccountId: main.id,
          postId: "media_imported",
          postUrl: "instagram.com/p/imported",
          isActive: false,
        });
        const asNew = createCampaignSchema.safeParse(await getCampaignAsCreateInput(workspaceId, campaign.id));
        expect(asNew.error?.issues.map((issue) => issue.path.join("."))).toEqual(["postUrl"]);
        return campaign;
      }

      const stored = (id: string) => db.prisma.automation.findUniqueOrThrow({ where: { id } });

      it("can still be switched on and off, and its report link too", async () => {
        const campaign = await imported();

        const on = await data<{ campaign: Campaign }>(full, "update_campaign", {
          campaignId: campaign.id,
          isActive: true,
        });
        expect(on.campaign.isActive).toBe(true);
        expect((await stored(campaign.id)).isActive).toBe(true);

        const off = await data<{ campaign: Campaign }>(full, "update_campaign", {
          campaignId: campaign.id,
          isActive: false,
        });
        expect(off.campaign.isActive).toBe(false);
        expect((await stored(campaign.id)).isActive).toBe(false);

        await data(full, "update_campaign", { campaignId: campaign.id, reportShareEnabled: false });
        expect((await stored(campaign.id)).reportShareEnabled).toBe(false);

        await data(full, "update_campaign", { campaignId: campaign.id, isActive: true, reportShareEnabled: true });
        expect(await stored(campaign.id)).toMatchObject({ isActive: true, reportShareEnabled: true });
      });

      it("refuses any other edit with the reason, changing nothing", async () => {
        const campaign = await imported();
        for (const edit of [{ name: "Renamed" }, { name: "Renamed", isActive: true }]) {
          const result = await call(full, "update_campaign", { campaignId: campaign.id, ...edit });
          expect(errorText(result)).toMatch(/postUrl/);
          expect(await stored(campaign.id)).toEqual(campaign);
        }
      });
    });

    it("reports a campaign's settings and stats", async () => {
      const campaign = await createViaMcp({
        ...minimalCampaign,
        name: "Stats",
        trackedDestinationUrl: "https://example.com/stats",
      });
      const link = await db.prisma.trackedLink.findFirstOrThrow({ where: { automationId: campaign.id } });
      const log = (status: string, n: number, extra: Record<string, unknown> = {}) =>
        Array.from({ length: n }, (_, i) => ({
          workspaceId,
          automationId: campaign.id,
          instagramAccountId: main.id,
          commenterId: `c_${status}_${i}`,
          commenterName: `fan_${i}`,
          commentText: "GUIDE please",
          commentId: `comment_${status}_${i}`,
          status: status as "SENT",
          ...extra,
        }));
      await db.prisma.dmLog.createMany({
        data: [
          ...log("SENT", 3),
          ...log("FAILED", 1, { errorMessage: "User cannot receive messages [code=551]" }),
          ...log("SKIPPED_DEDUP", 1),
        ],
      });
      await db.prisma.linkClick.createMany({
        data: ["r1", "r1", "r2"].map((recipientHash) => ({
          workspaceId,
          automationId: campaign.id,
          instagramAccountId: main.id,
          trackedLinkId: link.id,
          recipientHash,
        })),
      });

      const { campaign: details } = await data<{ campaign: Campaign }>(full, "get_campaign", {
        campaignId: campaign.id,
      });
      expect(details.stats).toEqual({
        dmsSent: 3,
        dmsFailed: 1,
        dmsSkipped: 1,
        linkClicks: 2,
        clickThroughRate: 66.7,
      });
      expect(details).toMatchObject({
        name: "Stats",
        keywords: ["GUIDE"],
        dmMessage: "Here is the guide",
        trackedDestinationUrl: "https://example.com/stats",
        trackedLinks: [{ destinationUrl: "https://example.com/stats", trackedUrl: `${BASE_URL}/r/${link.slug}` }],
      });

      const listed = await data<{ campaigns: Campaign[] }>(full, "list_campaigns");
      expect(listed.campaigns.find((c) => c.id === campaign.id)?.stats.dmsSent).toBe(3);

      const failed = await data<{ failedDms: Record<string, unknown>[] }>(full, "list_failed_dms", {
        campaignId: campaign.id,
      });
      expect(failed.failedDms).toEqual([
        expect.objectContaining({
          campaign: { id: campaign.id, name: "Stats" },
          commenter: "fan_0",
          commentText: "GUIDE please",
          reason: "User cannot receive messages [code=551]",
        }),
      ]);
      const forAccount = await data<{ failedDms: { campaign: { id: string } }[] }>(full, "list_failed_dms");
      expect(forAccount.failedDms.map((f) => f.campaign.id)).toContain(campaign.id);
    });

    it("lists campaigns per account", async () => {
      const onSecond = await createViaMcp({ ...minimalCampaign, name: "Second's", instagramAccount: "miasecond" });
      const mainList = await data<{ campaigns: Campaign[] }>(full, "list_campaigns");
      const secondList = await data<{ campaigns: Campaign[] }>(full, "list_campaigns", {
        instagramAccount: "@miasecond",
      });
      expect(mainList.campaigns.map((c) => c.id)).not.toContain(onSecond.id);
      expect(secondList.campaigns.map((c) => c.id)).toEqual([onSecond.id]);
    });
  });

  describe("workspace isolation", () => {
    it("never reaches another workspace's campaigns, accounts or inbox", async () => {
      expect(errorText(await call(full, "get_campaign", { campaignId: stranger.campaignId }))).toMatch(/No campaign/);
      expect(
        errorText(await call(full, "update_campaign", { campaignId: stranger.campaignId, isActive: true }))
      ).toMatch(/No campaign/);
      expect(errorText(await call(full, "list_failed_dms", { campaignId: stranger.campaignId }))).toMatch(
        /No campaign/
      );
      expect(
        (await db.prisma.automation.findUniqueOrThrow({ where: { id: stranger.campaignId } })).isActive
      ).toBe(true);

      for (const name of ["strangerbrand", stranger.accountId]) {
        expect(
          errorText(await call(full, "list_recent_conversations", { instagramAccount: name }))
        ).toMatch(/No connected Instagram account/);
        expect(
          errorText(await call(full, "create_campaign", { ...minimalCampaign, instagramAccount: name }))
        ).toMatch(/No connected Instagram account/);
      }

      // Their conversation id read with this workspace's token gets nothing.
      const before = instagram.sends.length;
      expect(errorText(await call(full, "get_conversation", { conversationId: conversations.stranger }))).toMatch(
        /Instagram refused/
      );
      expect(
        errorText(await call(full, "send_reply", { conversationId: conversations.stranger, text: "hi" }))
      ).toMatch(/Instagram refused/);
      expect(instagram.sends.length).toBe(before);
    });

    it("gives the other workspace's own connection only its own data", async () => {
      const theirs = await clientFor(stranger.id);
      const { campaigns } = await data<{ campaigns: { id: string }[] }>(theirs, "list_campaigns");
      expect(campaigns.map((c) => c.id)).toEqual([stranger.campaignId]);
      const { conversations: recent } = await data<{ conversations: { contact: { username: string } }[] }>(
        theirs,
        "list_recent_conversations"
      );
      expect(recent.map((c) => c.contact.username)).toEqual(["their_fan"]);
    });
  });

  describe("authentication", () => {
    const REFUSED: Answer = {
      status: 401,
      challenge: expect.stringMatching(/^Bearer .*resource_metadata="/),
    };

    /** A client's attempt to connect sending these headers, and the endpoint's first answer. */
    async function connectWith(headers: Record<string, string>) {
      const answers: Answer[] = [];
      const client = new Client({ name: "intruder", version: "1.0.0" });
      const error = await client.connect(transport(headers, answers)).then(
        () => {
          clients.push(client);
          return null;
        },
        (reason: unknown) => reason
      );
      return { error, answer: answers[0] };
    }

    function expectUnauthorized(error: unknown) {
      expect(error).toBeInstanceOf(StreamableHTTPError);
      expect((error as StreamableHTTPError).code).toBe(401);
    }

    it("lets in a client with a valid token", async () => {
      const tokens = await connect({ userId: owner.id });
      const { error, answer } = await connectWith({ Authorization: `Bearer ${tokens.access_token}` });
      expect(error).toBeNull();
      expect(answer).toEqual({ status: 200, challenge: null });
    });

    it.each<[string, Record<string, string>]>([
      ["no token", {}],
      ["Bearer and no token", { Authorization: "Bearer" }],
      ["a made-up token", { Authorization: "Bearer ora_made_up" }],
    ])("refuses a client with %s with a 401 and a challenge", async (_case, headers) => {
      const { error, answer } = await connectWith(headers);
      expectUnauthorized(error);
      expect(answer).toEqual(REFUSED);
    });

    // A real token in a malformed header, so a lenient parser that dug it out
    // anyway would be caught.
    it.each<[string, (token: string) => string]>([
      ["under the Basic scheme", (token) => `Basic ${token}`],
      ["with more text after it", (token) => `Bearer ${token} extra`],
      ["without a scheme", (token) => token],
    ])("refuses a real token sent %s with a 401 and a challenge", async (_case, header) => {
      const tokens = await connect({ userId: owner.id });
      const { error, answer } = await connectWith({ Authorization: header(tokens.access_token) });
      expectUnauthorized(error);
      expect(answer).toEqual(REFUSED);
    });

    it("refuses an access token once it has expired", async () => {
      const tokens = await connect({ userId: owner.id });
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      expect((await connectWith(headers)).answer.status).toBe(200);

      await db.prisma.oAuthToken.updateMany({
        where: { kind: "ACCESS", connection: { clientId: tokens.clientId } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const { error, answer } = await connectWith(headers);
      expectUnauthorized(error);
      expect(answer).toEqual(REFUSED);
    });

    it("stops a connected client on the request after its connection is revoked", async () => {
      const answers: Answer[] = [];
      const tokens = await connect({ userId: owner.id });
      const client = await mcpClient(tokens.access_token, answers);
      await data(client, "list_campaigns");
      const connection = await db.prisma.oAuthConnection.findFirstOrThrow({
        where: { tokens: { some: {} }, clientId: tokens.clientId },
      });
      await db.prisma.oAuthConnection.update({
        where: { id: connection.id },
        data: { revokedAt: new Date() },
      });

      const before = answers.length;
      const error = await client
        .callTool({ name: "list_campaigns", arguments: {} })
        .then(() => null, (reason: unknown) => reason);
      expectUnauthorized(error);
      expect(answers.slice(before)).toEqual([REFUSED]);
    });
  });
});
