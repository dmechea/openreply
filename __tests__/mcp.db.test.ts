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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/sdk/server/requestBody.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hasTestDatabase, openTestDatabase, type TestDatabase } from "./support/database";
import { signInAs } from "./support/session";
import { connectInstagramAccount, createOwner, importCampaign } from "./support/fixtures";
import { createFakeInstagram, hoursAgo, type FakeInstagram } from "./support/instagram";
import { ALL_SCOPES, BASE_URL, connect, MCP_URL, mcpInitialize } from "./support/oauth";

vi.mock("@/lib/db/client", async () => (await import("./support/database")).prismaModule);
vi.mock("@/lib/auth", async () => (await import("./support/session")).authModule);

import { handleMcpRequest } from "../lib/mcp/handler";
import { POST as dashboardCreate, PATCH as dashboardUpdate } from "../app/api/automations/route";
import { createCampaignSchema, updateCampaign } from "../lib/campaigns/campaign";
import { getCampaignForEdit } from "../lib/campaigns/queries";
import { describeCampaignIssues } from "../lib/campaigns/builder-rules";
import { encryptToken } from "../lib/meta/oauth";
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

    it("advertises create_campaign's fields with the rules of the dashboard's create", async () => {
      const { tools } = await full.listTools();
      const create = tools.find((t) => t.name === "create_campaign");
      const properties = (create?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const fieldNames = Object.keys(properties).filter((key) => key !== "instagramAccount" && key !== "target");
      expect(fieldNames).toContain("wholeWordMatch");
      for (const key of fieldNames) {
        const field = createCampaignSchema.shape[key as keyof typeof createCampaignSchema.shape];
        const rules = z.toJSONSchema(field, { target: "draft-7", io: "input" });
        // Only the description is the tool's own.
        expect({ ...properties[key], description: undefined }, key).toEqual({ ...rules, $schema: undefined });
      }
      expect([...(create?.inputSchema.required ?? [])].sort()).toEqual(["dmMessage", "name", "target"]);
    });

    it("says which reel an existing campaign moved to the next reel attaches to", async () => {
      const { tools } = await full.listTools();
      const update = tools.find((t) => t.name === "update_campaign");
      const target = (update?.inputSchema.properties as Record<string, { description?: string }>).target;
      expect(target.description).toMatch(/first reel posted after the campaign was created/);
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

    it("says the window cannot be told when their last message is older than the messages returned", async () => {
      // They wrote, then the account sent twenty more: Instagram returns only those twenty.
      const flooded = instagram.addConversation({
        accountId: main.instagramId,
        contact: { id: "igsid_flooded_kai", username: "flooded_kai" },
        messages: [
          { fromMe: false, text: "Can I book a call?", at: hoursAgo(3) },
          ...Array.from({ length: 20 }, (_, i) => ({ fromMe: true, text: `Update ${i + 1}`, at: hoursAgo(2 - i / 20) })),
        ],
      });
      const thread = await data<{
        contact: { username: string };
        window: unknown;
        messages: { from: string }[];
      }>(full, "get_conversation", { conversationId: flooded });
      expect(thread.messages).toHaveLength(20);
      expect(thread.messages.every((m) => m.from === "me")).toBe(true);
      expect(thread.contact.username).toBe("flooded_kai");
      expect(thread.window).toEqual({ open: null, closesAt: null, hoursLeft: null });

      // When the twenty returned already reach back past the window, it has closed.
      const stale = instagram.addConversation({
        accountId: main.instagramId,
        contact: { id: "igsid_stale_lu", username: "stale_lu" },
        messages: [
          { fromMe: false, text: "Hello?", at: hoursAgo(60) },
          ...Array.from({ length: 20 }, (_, i) => ({ fromMe: true, text: `Update ${i + 1}`, at: hoursAgo(50 - i) })),
        ],
      });
      const closed = await data<{ window: unknown }>(full, "get_conversation", { conversationId: stale });
      expect(closed.window).toMatchObject({ open: false, hoursLeft: 0 });
    });

    it("reads conversations by ids in Instagram's and Zernio's own formats", async () => {
      for (const [id, name] of [
        // Instagram's: its thread name, base64-encoded.
        [
          "aWdfZAG06MTpJR01lc3NhZA2VUaHJlYWQ6MTc4NDE0MDAwMDAwMDAwMDA6MzQwMjgyMzY2ODQxNzEwMzAxMjQ0Mjc2MDUzOTU4OTIzNTA1ODQy",
          "meta_format_mo",
        ],
        // Zernio's: a database id.
        ["6650f1c2a9e4b0a1b2c3d4e5", "zernio_format_ned"],
      ]) {
        instagram.addConversation({
          id,
          accountId: main.instagramId,
          contact: { id: `igsid_${name}`, username: name },
          messages: [{ fromMe: false, text: "Hi there", at: hoursAgo(1) }],
        });
        const thread = await data<{ contact: { username: string }; messages: { text: string }[] }>(
          full,
          "get_conversation",
          { conversationId: id }
        );
        expect(thread.contact.username).toBe(name);
        expect(thread.messages.map((m) => m.text)).toEqual(["Hi there"]);
      }
    });

    it("refuses a conversation id that cannot be one without asking Instagram", async () => {
      for (const conversationId of [
        "../../me/conversations?platform=instagram",
        "me/../conversation_1",
        "123?fields=messages&method=post",
        "123#fragment",
        "%2e%2e%2fme",
        "conversation 1",
      ]) {
        const before = instagram.requests.length;
        const result = await call(full, "get_conversation", { conversationId });
        expect(errorText(result)).toMatch(/not a conversation id/);
        expect(instagram.requests.length).toBe(before);
      }
    });

    it("gets Instagram's refusal for another account's conversation, and none of it", async () => {
      const theirs = instagram.addConversation({
        accountId: second.instagramId,
        contact: { id: "igsid_shared_ivy", username: "shared_ivy" },
        messages: [{ fromMe: false, text: "Hi second account, Ivy here", at: hoursAgo(2) }],
      });
      const result = await call(full, "get_conversation", { conversationId: theirs });
      expect(errorText(result)).toMatch(/Instagram refused/);
      expect(JSON.stringify(result)).not.toMatch(/Ivy/);

      const thread = await data<{ messages: { text: string }[] }>(full, "get_conversation", {
        conversationId: theirs,
        instagramAccount: "miasecond",
      });
      expect(thread.messages.map((m) => m.text)).toEqual(["Hi second account, Ivy here"]);
    });

    it("opens no thread quiet for longer than the window when looking for waiting conversations", async () => {
      // A list that leaves the last message out, as Zernio's does, means
      // opening each thread to see who wrote last.
      const quiet = instagram.addConversation({
        accountId: second.instagramId,
        contact: { id: "igsid_quiet_lea", username: "quiet_lea" },
        messages: [{ fromMe: false, text: "Still there?", at: hoursAgo(30) }],
        listsLastMessage: false,
      });
      const recent = instagram.addConversation({
        accountId: second.instagramId,
        contact: { id: "igsid_recent_max", username: "recent_max" },
        messages: [{ fromMe: false, text: "Quick question", at: hoursAgo(2) }],
        listsLastMessage: false,
      });
      const reads = (id: string) => instagram.countRequests("GET", `/${id}`);
      const names = (list: { conversations: { contact: { username: string } }[] }) =>
        list.conversations.map((c) => c.contact.username);

      const waiting = await data<Waiting & { uncheckedCount: number }>(full, "list_conversations_needing_reply", {
        instagramAccount: "miasecond",
      });
      expect(names(waiting)).toContain("recent_max");
      expect(names(waiting)).not.toContain("quiet_lea");
      expect(waiting.uncheckedCount).toBe(1);
      expect(reads(recent)).toBe(1);
      expect(reads(quiet)).toBe(0);

      // Asked for closed windows too, or for every recent conversation, it is opened.
      const withClosed = await data<Waiting>(full, "list_conversations_needing_reply", {
        instagramAccount: "miasecond",
        includeClosed: true,
      });
      expect(names(withClosed)).toContain("quiet_lea");
      const everything = await data<Waiting>(full, "list_recent_conversations", { instagramAccount: "miasecond" });
      expect(names(everything)).toContain("quiet_lea");
      expect(reads(quiet)).toBe(2);
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

    it("leaves it to Instagram when the thread does not show their last message", async () => {
      // They wrote, then the account sent twenty more: Instagram returns only those twenty.
      const flooded = instagram.addConversation({
        accountId: main.instagramId,
        contact: { id: "igsid_flooded_ola", username: "flooded_ola" },
        messages: [
          { fromMe: false, text: "Can I book a call?", at: hoursAgo(3) },
          ...Array.from({ length: 20 }, (_, i) => ({ fromMe: true, text: `Update ${i + 1}`, at: hoursAgo(2 - i / 20) })),
        ],
      });
      instagram.rejectNextSend(400, 10, "This message is sent outside of allowed window");
      const refusal = await call(full, "send_reply", { conversationId: flooded, text: "Yes, let's book it" });
      expect(refusal.structuredContent).toMatchObject({ status: "rejected" });

      const sent = await data<{ status: string }>(full, "send_reply", {
        conversationId: flooded,
        text: "Yes, let's book it",
      });
      expect(sent.status).toBe("sent");
      expect(instagram.sends.at(-1)).toMatchObject({ recipientId: "igsid_flooded_ola" });

      // When the twenty returned already reach back past the window, nothing is sent.
      const stale = instagram.addConversation({
        accountId: main.instagramId,
        contact: { id: "igsid_stale_pia", username: "stale_pia" },
        messages: [
          { fromMe: false, text: "Hello?", at: hoursAgo(60) },
          ...Array.from({ length: 20 }, (_, i) => ({ fromMe: true, text: `Update ${i + 1}`, at: hoursAgo(50 - i) })),
        ],
      });
      const before = instagram.countRequests("POST", "/messages");
      const closed = await call(full, "send_reply", { conversationId: stale, text: "Sorry for the wait" });
      expect(closed.structuredContent).toMatchObject({ status: "window_closed" });
      expect(instagram.countRequests("POST", "/messages")).toBe(before);
    });

    it("refuses a conversation id that cannot be one without asking Instagram", async () => {
      for (const conversationId of [
        "../../me/conversations?platform=instagram",
        "123?fields=messages&method=post",
        "%2e%2e%2fme",
      ]) {
        const before = instagram.requests.length;
        const result = await call(full, "send_reply", { conversationId, text: "Hello!" });
        expect(errorText(result)).toMatch(/not a conversation id/);
        expect(instagram.requests.length).toBe(before);
      }
    });

    it("reads and replies to a conversation that is no longer among the 50 most recent", async () => {
      // Each account reads Instagram with its own token, so the thread alone is
      // read: Instagram itself refuses another account's.
      const busy = await createOwner(db.prisma, "busy");
      const busyAccount = await connectInstagramAccount(db.prisma, busy.workspace.id, {
        username: "busybrand",
        instagramId: "ig_busy",
      });
      instagram.addAccount({ instagramId: "ig_busy", username: "busybrand", accessToken: busyAccount.plainAccessToken });
      const ana = instagram.addConversation({
        accountId: "ig_busy",
        contact: { id: "igsid_busy_ana", username: "busy_ana" },
        messages: [{ fromMe: false, text: "Is the course still open?", at: hoursAgo(1) }],
      });
      for (let i = 0; i < 50; i++) {
        instagram.addConversation({
          accountId: "ig_busy",
          contact: { id: `igsid_busy_fan_${i}`, username: `busy_fan_${i}` },
          messages: [{ fromMe: false, text: "Love this!", at: hoursAgo(0.5) }],
        });
      }
      const client = await clientFor(busy.user.id);
      const listReads = instagram.countRequests("GET", "/conversations");

      const thread = await data<{ messages: { text: string }[] }>(client, "get_conversation", {
        conversationId: ana,
      });
      expect(thread.messages.map((m) => m.text)).toEqual(["Is the course still open?"]);
      const sent = await data<{ status: string }>(client, "send_reply", { conversationId: ana, text: "Yes it is!" });
      expect(sent.status).toBe("sent");
      expect(instagram.sends.at(-1)).toEqual({
        accountId: "ig_busy",
        recipientId: "igsid_busy_ana",
        text: "Yes it is!",
      });
      expect(instagram.countRequests("GET", "/conversations")).toBe(listReads);
    });
  });

  describe("an account connected through Zernio", () => {
    // One Zernio key reads every account of the workspace, and a thread read
    // with it is not limited to the account named, so only an account's own
    // conversation list tells whose a conversation is.
    let zernio: Client;
    let ivy = "";

    beforeAll(async () => {
      const team = await createOwner(db.prisma, "zen");
      const apiKey = "zernio_key_zen";
      await db.prisma.zernioConnection.create({
        data: { workspaceId: team.workspace.id, apiKey: encryptToken(apiKey), webhookSecret: "unused" },
      });
      for (const [username, connectedAt] of [
        ["zen_second", new Date("2026-01-01T00:00:00Z")],
        ["zen_main", new Date("2026-06-01T00:00:00Z")],
      ] as const) {
        const instagramId = `ig_${username}`;
        const { id } = await connectInstagramAccount(db.prisma, team.workspace.id, {
          username,
          instagramId,
          connectedAt,
        });
        await db.prisma.instagramAccount.update({
          where: { id },
          data: { provider: "ZERNIO", zernioAccountId: `za_${username}` },
        });
        instagram.addZernioAccount({ instagramId, username, zernioAccountId: `za_${username}`, apiKey });
      }
      ivy = instagram.addConversation({
        id: "6650f1c2a9e4b0a1b2c3d4e6",
        accountId: "ig_zen_second",
        contact: { id: "igsid_zen_ivy", username: "zen_ivy" },
        messages: [{ fromMe: false, text: "Hi second account, Ivy here", at: hoursAgo(2) }],
      });
      zernio = await clientFor(team.user.id);
    });

    it("reads and replies through the account the conversation was listed for", async () => {
      const recent = await data<{ conversations: { conversationId: string }[] }>(
        zernio,
        "list_recent_conversations",
        { instagramAccount: "zen_second" }
      );
      expect(recent.conversations.map((c) => c.conversationId)).toEqual([ivy]);

      const thread = await data<{ messages: { text: string }[] }>(zernio, "get_conversation", {
        conversationId: ivy,
        instagramAccount: "zen_second",
      });
      expect(thread.messages.map((m) => m.text)).toEqual(["Hi second account, Ivy here"]);

      const sent = await data<{ status: string }>(zernio, "send_reply", {
        conversationId: ivy,
        text: "Hi Ivy!",
        instagramAccount: "zen_second",
      });
      expect(sent.status).toBe("sent");
      expect(instagram.sends.at(-1)).toEqual({
        accountId: "ig_zen_second",
        recipientId: "igsid_zen_ivy",
        text: "Hi Ivy!",
      });
    });

    it("refuses another account's conversation, returning none of it", async () => {
      const result = await call(zernio, "get_conversation", { conversationId: ivy });
      expect(errorText(result)).toMatch(/not among @zen_main's 50 most recent conversations/);
      expect(JSON.stringify(result)).not.toMatch(/Ivy/);
    });

    it("sends nothing into another account's conversation", async () => {
      const before = instagram.countRequests("POST", "/messages");
      const result = await call(zernio, "send_reply", { conversationId: ivy, text: "Hello!" });
      expect(errorText(result)).toMatch(/not among @zen_main's 50 most recent conversations/);
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

    it("replies to a create with the campaign as get_campaign reads it", async () => {
      const created = await createViaMcp({
        ...minimalCampaign,
        target: { type: "post", postId: "media_reel" },
        trackedDestinationUrl: "https://example.com/one",
        secondaryDestinationUrl: "https://example.com/two",
        secondaryButtonLabel: "More",
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent!", "Check your DMs"],
      });
      const { campaign: read } = await data<{ campaign: Campaign }>(full, "get_campaign", {
        campaignId: created.id,
      });
      expect(created).toEqual(read);
    });

    it("cannot be asked to create one switched on", async () => {
      const result = await full
        .callTool({ name: "create_campaign", arguments: { ...minimalCampaign, isActive: true } })
        .then((r) => (r as CallToolResult).isError, () => true);
      expect(result).toBe(true);
    });

    it("stores exactly what the dashboard stores for the same options", async () => {
      // The options as the dashboard's builder sends them, so the builder's
      // own checks and defaults, which the tools apply too, change nothing.
      const options = {
        name: "Parity",
        goal: "Leads",
        keywords: ["LINK", "GUIDE"],
        wholeWordMatch: false,
        dmTriggerEnabled: true,
        dmMessage: "Hi {username}, here you go {link}",
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
      ["a target with a key its type does not take", { target: { type: "any_post", postId: "media_reel" } }, /postId/],
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
        dmMessage: "Updated DM {link}",
        trackedDestinationUrl: "https://example.com/new",
        target: { type: "next_reel" },
      });
      expect(edited.campaign).toMatchObject({
        isActive: true,
        keywords: ["NEW"],
        dmMessage: "Updated DM {link}",
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

    it("refuses a target with a key its type does not take, keeping the campaign's own", async () => {
      const campaign = await createViaMcp({ ...minimalCampaign, target: { type: "post", postId: "media_reel" } });
      const result = await full
        .callTool({
          name: "update_campaign",
          arguments: { campaignId: campaign.id, target: { type: "any_post", postId: "media_reel" } },
        })
        .then(
          (r) => r as CallToolResult,
          (error: Error) => ({ isError: true, content: [{ type: "text", text: error.message }] }) as CallToolResult
        );
      expect(errorText(result)).toMatch(/postId/);
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
        postId: "media_reel",
        matchAnyPost: false,
        pendingNextReel: false,
      });
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
        const asNew = createCampaignSchema.safeParse((await getCampaignForEdit(workspaceId, campaign.id))?.settings);
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

      it("takes any other edit that leaves that post link alone", async () => {
        const campaign = await imported();
        await data(full, "update_campaign", { campaignId: campaign.id, name: "Renamed", isActive: true });
        expect(await stored(campaign.id)).toMatchObject({
          name: "Renamed",
          isActive: true,
          postUrl: "instagram.com/p/imported",
        });

        // Switching a feature off cannot break a rule either.
        for (const edit of [
          { publicReplyEnabled: false },
          { followUpEnabled: false },
          { dmTriggerEnabled: false },
          { openingDmEnabled: false },
          { requireFollow: false },
        ]) {
          await data(full, "update_campaign", { campaignId: campaign.id, ...edit });
          expect(await stored(campaign.id)).toMatchObject(edit);
        }
      });

      it("can be moved to another target, which replaces the bad post link", async () => {
        const anyPost = await imported();
        await data(full, "update_campaign", { campaignId: anyPost.id, target: { type: "any_post" } });
        expect(await stored(anyPost.id)).toMatchObject({ matchAnyPost: true, postId: null, postUrl: null });

        const nextReel = await imported();
        await data(full, "update_campaign", { campaignId: nextReel.id, target: { type: "next_reel" } });
        expect(await stored(nextReel.id)).toMatchObject({ pendingNextReel: true, postId: null, postUrl: null });

        const post = await imported();
        await data(full, "update_campaign", { campaignId: post.id, target: { type: "post", postId: "media_photo" } });
        expect(await stored(post.id)).toMatchObject({
          postId: "media_photo",
          postUrl: "https://www.instagram.com/p/def/",
        });
      });

      it("would name a problem with its post as the target the tools take", () => {
        const base = { name: "X", dmMessage: "Hi", keywords: ["A"] };
        const badLink = createCampaignSchema.safeParse({ ...base, postId: "p", postUrl: "instagram.com/p/x" });
        expect(describeCampaignIssues(badLink.error?.issues ?? [])).toBe("target.postUrl: Invalid URL");
        const noTarget = createCampaignSchema.safeParse(base);
        expect(describeCampaignIssues(noTarget.error?.issues ?? [])).toBe(
          "target.postId: Choose which post(s) trigger the campaign"
        );
      });

      it("still refuses an edit that breaks a rule itself, naming only that rule", async () => {
        const campaign = await imported();
        const text = errorText(await call(full, "update_campaign", { campaignId: campaign.id, keywords: [] }));
        expect(text).toMatch(/Add at least one keyword, or match any word/);
        expect(text).not.toMatch(/postUrl/);
        expect(await stored(campaign.id)).toEqual(campaign);
      });

      it("reads its legacy public reply as the list of replies", async () => {
        const campaign = await importCampaign(db.prisma, {
          workspaceId,
          instagramAccountId: main.id,
          postId: "media_imported",
          postUrl: null,
          publicReply: "Check your DMs!",
        });
        const { campaign: details } = await data<{ campaign: Campaign }>(full, "get_campaign", {
          campaignId: campaign.id,
        });
        expect(details).toMatchObject({ publicReplyEnabled: true, publicReplyMessages: ["Check your DMs!"] });
      });
    });

    it("refuses an edit when the campaign was saved meanwhile, keeping that save", async () => {
      const campaign = await createViaMcp({
        ...minimalCampaign,
        target: { type: "post", postId: "media_reel" },
      });
      // The dashboard saves the campaign while the edit checks its post with Instagram.
      instagram.beforeNextMediaRead(async () => {
        const res = await dashboardUpdate(
          new NextRequest(`${BASE_URL}/api/automations?id=${campaign.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Saved in the dashboard" }),
          })
        );
        expect(res.status).toBe(200);
      });
      const edit = { campaignId: campaign.id, name: "From Claude", target: { type: "post", postId: "media_photo" } };
      expect(errorText(await call(full, "update_campaign", edit))).toMatch(/changed meanwhile.*try again/i);
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
        name: "Saved in the dashboard",
        postId: "media_reel",
      });

      await data(full, "update_campaign", edit);
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
        name: "From Claude",
        postId: "media_photo",
      });
    });

    it("counts a save of only a campaign's links as a change to an edit read before it", async () => {
      const campaign = await createViaMcp({
        ...minimalCampaign,
        target: { type: "post", postId: "media_reel" },
        trackedDestinationUrl: "https://example.com/one",
      });
      // Another session removes the first link while this edit checks its post.
      instagram.beforeNextMediaRead(() =>
        data(full, "update_campaign", { campaignId: campaign.id, trackedDestinationUrl: "" })
      );
      const edit = {
        campaignId: campaign.id,
        secondaryDestinationUrl: "https://example.com/two",
        target: { type: "post", postId: "media_photo" },
      };
      expect(errorText(await call(full, "update_campaign", edit))).toMatch(/changed meanwhile.*try again/i);
      expect(await db.prisma.trackedLink.count({ where: { automationId: campaign.id } })).toBe(0);
      expect((await db.prisma.automation.findUniqueOrThrow({ where: { id: campaign.id } })).postId).toBe(
        "media_reel"
      );
    });

    describe("the checks and defaults the dashboard's builder applies", () => {
      const stored = (id: string) => db.prisma.automation.findUniqueOrThrow({ where: { id } });
      const linksOf = (id: string) =>
        db.prisma.trackedLink.findMany({
          where: { automationId: id },
          orderBy: TRACKED_LINK_ORDER,
          select: { label: true, destinationUrl: true },
        });

      async function refusedCreate(args: Record<string, unknown>) {
        const before = await db.prisma.automation.count();
        const text = errorText(await call(full, "create_campaign", args));
        expect(await db.prisma.automation.count()).toBe(before);
        return text;
      }

      it("labels the link button Open link unless a label is given", async () => {
        const campaign = await createViaMcp({ ...minimalCampaign, trackedDestinationUrl: "https://example.com/offer" });
        expect((await stored(campaign.id)).linkButtonLabel).toBe("Open link");

        await data(full, "update_campaign", { campaignId: campaign.id, linkButtonLabel: " Get it " });
        expect((await stored(campaign.id)).linkButtonLabel).toBe("Get it");
        await data(full, "update_campaign", { campaignId: campaign.id, linkButtonLabel: "  " });
        expect((await stored(campaign.id)).linkButtonLabel).toBe("Open link");

        // A link added to a campaign stored without a label gets one too.
        const imported = await importCampaign(db.prisma, {
          workspaceId,
          instagramAccountId: main.id,
          postId: "media_imported",
          postUrl: null,
        });
        expect(imported.linkButtonLabel).toBeNull();
        await data(full, "update_campaign", { campaignId: imported.id, trackedDestinationUrl: "https://example.com/x" });
        expect((await stored(imported.id)).linkButtonLabel).toBe("Open link");
      });

      it("puts the {link} token in the DM when there is a link", async () => {
        const linked = await createViaMcp({ ...minimalCampaign, trackedDestinationUrl: "https://example.com/offer" });
        expect((await stored(linked.id)).dmMessage).toBe("Here is the guide {link}");

        const placed = await createViaMcp({
          ...minimalCampaign,
          dmMessage: "Tap {link} now",
          trackedDestinationUrl: "https://example.com/offer",
        });
        expect((await stored(placed.id)).dmMessage).toBe("Tap {link} now");

        await data(full, "update_campaign", { campaignId: linked.id, dmMessage: "  New text  " });
        expect((await stored(linked.id)).dmMessage).toBe("New text {link}");

        const linkless = await createViaMcp();
        expect((await stored(linkless.id)).dmMessage).toBe("Here is the guide");
        await data(full, "update_campaign", { campaignId: linkless.id, name: "Still no link" });
        expect((await stored(linkless.id)).dmMessage).toBe("Here is the guide");
        await data(full, "update_campaign", { campaignId: linkless.id, trackedDestinationUrl: "https://example.com/x" });
        expect((await stored(linkless.id)).dmMessage).toBe("Here is the guide {link}");
      });

      it("refuses a DM that the {link} token takes past 1000 characters, changing nothing", async () => {
        const campaign = await createViaMcp({ ...minimalCampaign, trackedDestinationUrl: "https://example.com/offer" });
        const text = errorText(
          await call(full, "update_campaign", { campaignId: campaign.id, dmMessage: "x".repeat(1000) })
        );
        expect(text).toMatch(/^dmMessage: /);
        expect((await stored(campaign.id)).dmMessage).toBe("Here is the guide {link}");
      });

      it("refuses a blank DM, changing nothing", async () => {
        expect(await refusedCreate({ ...minimalCampaign, dmMessage: "   " })).toMatch(/dmMessage/);

        const campaign = await createViaMcp();
        expect(errorText(await call(full, "update_campaign", { campaignId: campaign.id, dmMessage: "\n\t " }))).toMatch(
          /dmMessage/
        );
        expect((await stored(campaign.id)).dmMessage).toBe("Here is the guide");
      });

      it("trims keywords and drops blank ones, refusing when none is left", async () => {
        const campaign = await createViaMcp({ ...minimalCampaign, keywords: [" GUIDE ", " ", "LINK"] });
        expect((await stored(campaign.id)).keywords).toEqual(["GUIDE", "LINK"]);

        expect(await refusedCreate({ ...minimalCampaign, keywords: [" "] })).toMatch(
          /Add at least one keyword, or match any word/
        );
        expect(errorText(await call(full, "update_campaign", { campaignId: campaign.id, keywords: ["  "] }))).toMatch(
          /Add at least one keyword, or match any word/
        );
        expect((await stored(campaign.id)).keywords).toEqual(["GUIDE", "LINK"]);
      });

      it("trims the follow prompt and the follow-up, and labels the follow button", async () => {
        const campaign = await createViaMcp({
          ...minimalCampaign,
          requireFollow: true,
          followPromptMessage: "   ",
          followPromptButtonLabel: " ",
          followUpEnabled: true,
          followUpMessage: " Thanks! ",
        });
        expect(await stored(campaign.id)).toMatchObject({
          followPromptMessage: null,
          followPromptButtonLabel: "i'm following",
          followUpMessage: "Thanks!",
        });

        await data(full, "update_campaign", {
          campaignId: campaign.id,
          followPromptMessage: " Follow us first ",
          followPromptButtonLabel: " Done ",
        });
        expect(await stored(campaign.id)).toMatchObject({
          followPromptMessage: "Follow us first",
          followPromptButtonLabel: "Done",
        });
      });

      it("names a campaign without a name after its account", async () => {
        const campaign = await createViaMcp({ ...minimalCampaign, name: "   " });
        expect((await stored(campaign.id)).name).toBe("Campaign for @glowwithmia");
        await data(full, "update_campaign", { campaignId: campaign.id, name: " Renamed " });
        expect((await stored(campaign.id)).name).toBe("Renamed");
      });

      it("changes the second link's label or URL alone, keeping the other", async () => {
        const campaign = await createViaMcp({
          ...minimalCampaign,
          trackedDestinationUrl: "https://example.com/one",
          secondaryDestinationUrl: "https://example.com/two",
          secondaryButtonLabel: "More",
        });

        const renamed = await data<{ campaign: Campaign }>(full, "update_campaign", {
          campaignId: campaign.id,
          secondaryButtonLabel: "Shop now",
        });
        expect(renamed.campaign.secondaryButtonLabel).toBe("Shop now");
        expect(await linksOf(campaign.id)).toEqual([
          { label: "Primary campaign link", destinationUrl: "https://example.com/one" },
          { label: "Shop now", destinationUrl: "https://example.com/two" },
        ]);

        await data(full, "update_campaign", { campaignId: campaign.id, secondaryDestinationUrl: "https://example.com/three" });
        expect(await linksOf(campaign.id)).toEqual([
          { label: "Primary campaign link", destinationUrl: "https://example.com/one" },
          { label: "Shop now", destinationUrl: "https://example.com/three" },
        ]);
      });

      it("refuses a second link without a first one, or a label without a second link", async () => {
        expect(
          await refusedCreate({
            ...minimalCampaign,
            secondaryDestinationUrl: "https://example.com/two",
            secondaryButtonLabel: "Shop",
          })
        ).toMatch(/trackedDestinationUrl/);
        expect(await refusedCreate({ ...minimalCampaign, secondaryButtonLabel: "Shop" })).toMatch(
          /secondaryDestinationUrl/
        );

        const linkless = await createViaMcp();
        for (const edit of [{ secondaryDestinationUrl: "https://example.com/two" }, { secondaryButtonLabel: "Shop" }]) {
          errorText(await call(full, "update_campaign", { campaignId: linkless.id, ...edit }));
          expect(await linksOf(linkless.id)).toEqual([]);
        }

        const twoLinks = await createViaMcp({
          ...minimalCampaign,
          trackedDestinationUrl: "https://example.com/one",
          secondaryDestinationUrl: "https://example.com/two",
        });
        const before = await linksOf(twoLinks.id);
        expect(
          errorText(await call(full, "update_campaign", { campaignId: twoLinks.id, trackedDestinationUrl: "" }))
        ).toMatch(/trackedDestinationUrl/);
        expect(await linksOf(twoLinks.id)).toEqual(before);
        // Removing both together is fine.
        await data(full, "update_campaign", {
          campaignId: twoLinks.id,
          trackedDestinationUrl: "",
          secondaryDestinationUrl: "",
        });
        expect(await linksOf(twoLinks.id)).toEqual([]);
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
        dmMessage: "Here is the guide {link}",
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

    it("lists one campaign's failed DMs under its own account only", async () => {
      const campaign = await createViaMcp();
      const failed = await data<{ account: unknown; failedDms: unknown[] }>(full, "list_failed_dms", {
        campaignId: campaign.id,
      });
      expect(failed).toEqual({ account: { id: main.id, username: "glowwithmia" }, failedDms: [] });
      await data(full, "list_failed_dms", { campaignId: campaign.id, instagramAccount: "@glowwithmia" });

      expect(
        errorText(await call(full, "list_failed_dms", { campaignId: campaign.id, instagramAccount: "miasecond" }))
      ).toMatch(/on @glowwithmia, not @miasecond/);
      expect(
        errorText(await call(full, "list_failed_dms", { campaignId: campaign.id, instagramAccount: "@typo" }))
      ).toMatch(/No connected Instagram account matches @typo/);
    });

    describe("a post target", () => {
      const stored = (id: string) => db.prisma.automation.findUniqueOrThrow({ where: { id } });

      beforeAll(() => {
        instagram.addMedia(second.instagramId, [
          {
            id: "media_second",
            caption: "Second account's post",
            media_type: "IMAGE",
            media_url: "https://cdn.example/second.jpg",
            timestamp: "2026-10-12T09:00:00+0000",
            permalink: "https://www.instagram.com/p/second/",
          },
        ]);
      });

      it("takes its permalink from Instagram when none is given", async () => {
        const campaign = await createViaMcp({ ...minimalCampaign, target: { type: "post", postId: "media_reel" } });
        expect(await stored(campaign.id)).toMatchObject({
          postId: "media_reel",
          postUrl: "https://www.instagram.com/reel/abc/",
        });

        // Naming the same post again without its permalink keeps the link.
        await data(full, "update_campaign", { campaignId: campaign.id, target: { type: "post", postId: "media_reel" } });
        expect((await stored(campaign.id)).postUrl).toBe("https://www.instagram.com/reel/abc/");
      });

      it("takes the post the campaign is already on without looking it up again", async () => {
        // A post older than the recent posts the lookup reads.
        const campaign = await importCampaign(db.prisma, {
          workspaceId,
          instagramAccountId: main.id,
          postId: "media_old",
          postUrl: "https://www.instagram.com/p/old/",
          isActive: false,
        });
        const edit = { campaignId: campaign.id, target: { type: "post", postId: "media_old" } };
        await data(full, "update_campaign", { ...edit, name: "New" });
        expect(await stored(campaign.id)).toMatchObject({
          name: "New",
          postId: "media_old",
          postUrl: "https://www.instagram.com/p/old/",
        });

        // Instagram being down does not stop it either, as it is not asked.
        instagram.beforeNextMediaRead(() => {
          throw new TypeError("fetch failed");
        });
        await data(full, "update_campaign", { ...edit, name: "Newer" });
        expect((await stored(campaign.id)).name).toBe("Newer");
        // The next read of the posts is the one that meets Instagram down.
        expect((await call(full, "list_posts")).isError).toBe(true);
      });

      it("must be a post of the campaign's own account", async () => {
        const before = await db.prisma.automation.count();
        for (const postId of ["media_second", "media_made_up"]) {
          const result = await call(full, "create_campaign", { ...minimalCampaign, target: { type: "post", postId } });
          expect(errorText(result)).toMatch(new RegExp(`${postId} is not a post or reel of @glowwithmia`));
        }
        expect(await db.prisma.automation.count()).toBe(before);

        const onSecond = await createViaMcp({
          ...minimalCampaign,
          instagramAccount: "@miasecond",
          target: { type: "post", postId: "media_second" },
        });
        expect((await stored(onSecond.id)).postUrl).toBe("https://www.instagram.com/p/second/");

        const result = await call(full, "update_campaign", {
          campaignId: onSecond.id,
          target: { type: "post", postId: "media_reel" },
        });
        expect(errorText(result)).toMatch(/media_reel is not a post or reel of @miasecond/);
        expect((await stored(onSecond.id)).postId).toBe("media_second");
      });

      it("is refused, saving nothing, when Instagram cannot be reached to check it", async () => {
        const before = await db.prisma.automation.count();
        instagram.beforeNextMediaRead(() => {
          throw new TypeError("fetch failed");
        });
        const created = await call(full, "create_campaign", {
          ...minimalCampaign,
          target: { type: "post", postId: "media_reel" },
        });
        expect(errorText(created)).toMatch(/could not be reached/);
        expect(await db.prisma.automation.count()).toBe(before);

        const campaign = await createViaMcp();
        instagram.beforeNextMediaRead(() => {
          throw new TypeError("fetch failed");
        });
        const updated = await call(full, "update_campaign", {
          campaignId: campaign.id,
          target: { type: "post", postId: "media_reel" },
        });
        expect(errorText(updated)).toMatch(/could not be reached/);
        expect(await stored(campaign.id)).toMatchObject({ matchAnyPost: true, postId: null });
      });
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

    it("never writes another workspace's campaign, even an edit waiting on its saved version", async () => {
      const theirs = await db.prisma.automation.findUniqueOrThrow({ where: { id: stranger.campaignId } });
      const result = await updateCampaign(
        workspaceId,
        theirs.id,
        { name: "Taken over" },
        { unchangedSince: theirs.updatedAt }
      );
      expect(result.ok).toBe(false);
      expect(await db.prisma.automation.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(theirs);
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

    it.each(["GET", "DELETE"])("answers %s with a 405 before it looks at any token", async (method) => {
      const lookup = vi.spyOn(db.prisma.oAuthToken, "findUnique");
      try {
        for (const headers of [{}, { Authorization: "Bearer ora_made_up" }] as Record<string, string>[]) {
          const res = await handleMcpRequest(new Request(MCP_URL, { method, headers }));
          expect(res.status).toBe(405);
          expect(res.headers.get("allow")).toBe("POST");
        }
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    });

    it("gives the same reason in a 401's body as in its challenge", async () => {
      const refusal = async (headers: Record<string, string>) => {
        const res = await handleMcpRequest(new Request(MCP_URL, { method: "POST", headers }));
        expect(res.status).toBe(401);
        return { body: await res.json(), challenge: res.headers.get("www-authenticate") ?? "" };
      };

      const invalid = await refusal({ Authorization: "Bearer ora_made_up" });
      expect(invalid.body.error).toBe("invalid_token");
      expect(invalid.challenge).toContain(
        `error="${invalid.body.error}", error_description="${invalid.body.error_description}"`
      );

      // A request that sent no token is told to connect, and its challenge names no error.
      const missing = await refusal({});
      expect(missing.body).toEqual({ error: "unauthorized", error_description: expect.any(String) });
      expect(missing.challenge).not.toContain("error=");
    });
  });

  describe("instructions", () => {
    const ALL_TOOLS = [...READ_TOOLS, ...CAMPAIGN_TOOLS, ...SEND_TOOLS];

    it.each([[["read"]], [["read", "campaigns:write"]], [["read", "messages:send"]], [ALL_SCOPES]])(
      "tell a connection granted %j only about the tools it has",
      async (grants) => {
        const client = await clientFor(owner.id, grants);
        const instructions = client.getInstructions() ?? "";
        const tools = await toolNames(client);
        for (const name of ALL_TOOLS.filter((tool) => instructions.includes(tool))) {
          expect(tools, name).toContain(name);
        }
        expect(instructions.includes("send_reply")).toBe(grants.includes("messages:send"));
        expect(/campaigns start switched off/.test(instructions)).toBe(grants.includes("campaigns:write"));
      }
    );
  });

  describe("each request", () => {
    let accessToken = "";

    /** One POST of JSON-RPC messages, as a client that has connected sends it. */
    function post(body: unknown, init: RequestInit = {}) {
      return handleMcpRequest(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
          ...init,
        })
      );
    }

    /** The answer, or "no answer" when there is none within a few seconds. */
    function within(seconds: number, answer: Promise<Response>) {
      return Promise.race([
        answer,
        new Promise<"no answer">((resolve) => setTimeout(() => resolve("no answer"), seconds * 1000)),
      ]);
    }

    /** Instagram that takes every request and never answers it. */
    function silentInstagram() {
      let reached = () => {};
      const asked = new Promise<void>((resolve) => (reached = resolve));
      vi.stubGlobal("fetch", () => {
        reached();
        return new Promise(() => {});
      });
      return asked;
    }

    const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });

    beforeAll(async () => {
      accessToken = (await connect({ userId: owner.id })).access_token;
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.stubGlobal("fetch", instagram.fetch);
      vi.restoreAllMocks();
    });

    it("answers a POST whose request is cancelled in the same POST, without running that request", async () => {
      const before = instagram.sends.length;
      const send = toolCall(2, "send_reply", { conversationId: conversations.fresh, text: "Thanks!" });
      const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } };

      const answered = await within(3, post([toolCall(1, "list_campaigns"), send, cancel]));
      expect(answered).not.toBe("no answer");
      expect((answered as Response).status).toBe(200);
      expect(await (answered as Response).json()).toMatchObject({
        id: 1,
        result: { structuredContent: { campaigns: expect.any(Array) } },
      });

      // With nothing left to answer, the POST is accepted as one of notifications alone is.
      for (const batch of [[send, cancel], [cancel, send]]) {
        const alone = await within(3, post(batch));
        expect(alone).not.toBe("no answer");
        expect((alone as Response).status).toBe(202);
      }
      expect(instagram.sends.length).toBe(before);
    });

    it("answers in time, and closes the server, when a tool never hears back", async () => {
      const closed = vi.spyOn(McpServer.prototype, "close");
      const asked = silentInstagram();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const answer = post(toolCall(7, "list_posts"));
      await asked;
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MSEC);
      const res = await answer;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        error: { code: ErrorCode.RequestTimeout, message: expect.any(String) },
      });
      expect(closed).toHaveBeenCalled();
    });

    it("answers a request that finished with its own answer when the rest of its POST runs out of time", async () => {
      const before = instagram.sends.length;
      let reached = () => {};
      const asked = new Promise<void>((resolve) => (reached = resolve));
      instagram.beforeNextMediaRead(() => {
        reached();
        return new Promise(() => {});
      });
      const sent = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const answer = post([
        toolCall(1, "send_reply", { conversationId: conversations.fresh, text: "Sent before the time ran out" }),
        toolCall(2, "list_posts"),
      ]);
      await asked;
      await vi.waitFor(() =>
        expect(sent.mock.calls.some(([message]) => "id" in message && message.id === 1)).toBe(true)
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MSEC);

      const res = await answer;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          result: expect.objectContaining({ structuredContent: expect.objectContaining({ status: "sent" }) }),
        },
        { jsonrpc: "2.0", id: 2, error: { code: ErrorCode.RequestTimeout, message: expect.any(String) } },
      ]);
      expect(instagram.sends.length).toBe(before + 1);
    });

    it("refuses a body over the limit, declared or not, and closes the connection after", async () => {
      // Whatever of the body is still unread when the refusal goes out would
      // otherwise sit ahead of the next request on a kept-alive connection.
      const size = DEFAULT_MAX_REQUEST_BODY_SIZE + 1;
      const chunk = new Uint8Array(64 * 1024).fill(32);
      function oversized() {
        let sent = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= size) return controller.close();
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
      }
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      };
      for (const declared of [{ "Content-Length": String(size) }, {}]) {
        const res = await post(null, {
          body: oversized(),
          duplex: "half",
          headers: { ...headers, ...declared },
        } as RequestInit);
        expect(res.status).toBe(413);
        expect(res.headers.get("connection")).toBe("close");
      }
    });

    it("refuses a body the client stops sending partway, as it refuses one that is not JSON", async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(encoder.encode('{"jsonrpc":"2.0",')),
        pull: (controller) => controller.error(new Error("The client went away")),
      });
      const res = await post(null, { body, duplex: "half" } as RequestInit);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: ErrorCode.ParseError, message: "Parse error: Invalid JSON" },
        id: null,
      });
    });

    it("stops waiting, and closes the server, once the client goes away", async () => {
      const closed = vi.spyOn(McpServer.prototype, "close");
      const asked = silentInstagram();
      const client = new AbortController();

      const answer = post(toolCall(8, "list_posts"), { signal: client.signal });
      await asked;
      client.abort();
      expect(await within(3, answer)).not.toBe("no answer");
      expect(closed).toHaveBeenCalled();
    });

    it("reads the accounts its instructions name only when the client initializes", async () => {
      const findMany = vi.spyOn(db.prisma.instagramAccount, "findMany");
      const listed = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(listed.status).toBe(200);
      expect(findMany).not.toHaveBeenCalled();

      expect((await mcpInitialize(`Bearer ${accessToken}`)).status).toBe(200);
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("notes a connection's use alongside the request, and only for a request it serves", async () => {
      const tokens = await connect({ userId: owner.id });
      const lastUsedAt = async () =>
        (await db.prisma.oAuthConnection.findFirstOrThrow({ where: { clientId: tokens.clientId } }))
          .lastUsedAt;

      // Refused for coming from another site's page: not a use.
      const foreign = await handleMcpRequest(
        new Request(MCP_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${tokens.access_token}`, Origin: "https://elsewhere.example" },
          body: "{}",
        })
      );
      expect(foreign.status).toBe(403);
      expect(await lastUsedAt()).toBeNull();

      // Served: the server is built while the note is still being written.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const write = db.prisma.oAuthConnection.update.bind(db.prisma.oAuthConnection);
      vi.spyOn(db.prisma.oAuthConnection, "update").mockImplementationOnce((async (
        args: Parameters<typeof write>[0]
      ) => {
        await held;
        return write(args);
      }) as never);
      const findMany = vi.spyOn(db.prisma.instagramAccount, "findMany");

      const answer = mcpInitialize(`Bearer ${tokens.access_token}`);
      try {
        await vi.waitFor(() => expect(findMany).toHaveBeenCalled(), { timeout: 2000 });
      } finally {
        release();
      }
      expect((await answer).status).toBe(200);
      expect(await lastUsedAt()).not.toBeNull();
    });
  });
});
