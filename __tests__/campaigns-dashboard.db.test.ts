/**
 * The dashboard's campaign create, update and on/off, pinned through its own
 * route handlers against a real Postgres. These were written before the logic
 * moved out of app/api/automations/route.ts into lib/campaigns/campaign.ts and
 * must keep passing unchanged: they are what proves the dashboard still
 * behaves exactly as before. Needs TEST_DATABASE_URL; see docs/testing.md.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTestDatabase,
  openTestDatabase,
  type TestDatabase,
} from "./support/database";
import { signInAs, signOut } from "./support/session";
import { addMember, connectInstagramAccount, createOwner } from "./support/fixtures";

vi.mock("@/lib/db/client", async () => (await import("./support/database")).prismaModule);
vi.mock("@/lib/auth", async () => (await import("./support/session")).authModule);

import { PATCH, POST } from "../app/api/automations/route";
import { TRACKED_LINK_ORDER } from "../lib/tracking/link-order";

let db: TestDatabase;
let ownerId = "";
let workspaceId = "";
let olderAccountId = "";
let newerAccountId = "";

function request(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const create = (body: unknown) =>
  POST(request("POST", "http://localhost/api/automations", body));
const update = (id: string | null, body: unknown) =>
  PATCH(
    request(
      "PATCH",
      id === null ? "http://localhost/api/automations" : `http://localhost/api/automations?id=${id}`,
      body
    )
  );

const minimal = {
  name: "Guide",
  matchAnyPost: true,
  keywords: ["GUIDE"],
  dmMessage: "Here it is {link}",
};

async function createdId(body: unknown) {
  const res = await create(body);
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

function stored(id: string) {
  return db.prisma.automation.findUniqueOrThrow({ where: { id } });
}

function storedLinks(automationId: string) {
  return db.prisma.trackedLink.findMany({
    where: { automationId },
    orderBy: TRACKED_LINK_ORDER,
    select: { label: true, destinationUrl: true, position: true },
  });
}

describe.skipIf(!hasTestDatabase)("dashboard campaign routes", () => {
  beforeAll(async () => {
    db = await openTestDatabase("dashboard_campaigns");
    const { user, workspace } = await createOwner(db.prisma, "creator");
    ownerId = user.id;
    workspaceId = workspace.id;
    olderAccountId = (
      await connectInstagramAccount(db.prisma, workspaceId, {
        username: "older",
        connectedAt: new Date("2026-01-01T00:00:00Z"),
      })
    ).id;
    newerAccountId = (
      await connectInstagramAccount(db.prisma, workspaceId, {
        username: "newer",
        connectedAt: new Date("2026-06-01T00:00:00Z"),
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    signInAs(ownerId);
  });

  describe("create", () => {
    it("refuses a visitor who is not signed in", async () => {
      signOut();
      const res = await create(minimal);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
    });

    it("refuses a member who cannot manage the workspace", async () => {
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const res = await create(minimal);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        success: false,
        error: "Only owners and admins can create campaigns",
      });
    });

    it("lets an admin create one", async () => {
      const admin = await addMember(db.prisma, workspaceId, "ADMIN");
      signInAs(admin.id);
      expect((await create(minimal)).status).toBe(201);
    });

    it.each([
      ["no target", { ...minimal, matchAnyPost: false }, "postId", "Choose which post(s) trigger the campaign"],
      ["no keywords", { ...minimal, keywords: [] }, "keywords", "Add at least one keyword, or match any word"],
      [
        "an opening DM without a button",
        { ...minimal, openingDmEnabled: true, openingDmMessage: "Tap below" },
        "openingDmMessage",
        "Opening DM needs a message and a button label",
      ],
    ])("rejects %s with the reason", async (_case, body, field, message) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error).toBe("Invalid input");
      expect(payload.details.fieldErrors[field]).toEqual([message]);
    });

    it.each([
      ["more than ten keywords", { keywords: Array.from({ length: 11 }, (_, i) => `K${i}`) }, "keywords"],
      ["a keyword longer than 50 characters", { keywords: ["x".repeat(51)] }, "keywords"],
      ["a DM longer than 1000 characters", { dmMessage: "x".repeat(1001) }, "dmMessage"],
      ["an empty DM", { dmMessage: "" }, "dmMessage"],
      ["a bad link URL", { trackedDestinationUrl: "not a url" }, "trackedDestinationUrl"],
      ["a bad second link URL", { secondaryDestinationUrl: "nope" }, "secondaryDestinationUrl"],
      ["a button label over 20 characters", { linkButtonLabel: "x".repeat(21) }, "linkButtonLabel"],
      ["a follow-up delay over a day", { followUpDelayMinutes: 1441 }, "followUpDelayMinutes"],
      ["more than ten public replies", { publicReplyMessages: Array.from({ length: 11 }, () => "Sent!") }, "publicReplyMessages"],
      ["a missing name", { name: "" }, "name"],
    ])("rejects %s", async (_case, change, field) => {
      const res = await create({ ...minimal, ...change });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toBe("Invalid input");
      expect(Object.keys(payload.details.fieldErrors)).toContain(field);
    });

    it("needs a connected Instagram account in this workspace", async () => {
      const other = await createOwner(db.prisma, "no-instagram");
      signInAs(other.user.id);
      const res = await create(minimal);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: "Connect Instagram before creating campaigns",
      });
    });

    it("refuses an Instagram account from another workspace", async () => {
      const other = await createOwner(db.prisma, "elsewhere");
      const foreign = await connectInstagramAccount(db.prisma, other.workspace.id, {
        username: "foreign",
      });
      const res = await create({ ...minimal, instagramAccountId: foreign.id });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Connect Instagram before creating campaigns");
    });

    it("uses the most recently connected account unless one is named", async () => {
      expect((await stored(await createdId(minimal))).instagramAccountId).toBe(newerAccountId);
      expect(
        (await stored(await createdId({ ...minimal, instagramAccountId: olderAccountId })))
          .instagramAccountId
      ).toBe(olderAccountId);
      expect(
        (await stored(await createdId({ ...minimal, instagramAccountId: "all" })))
          .instagramAccountId
      ).toBe(newerAccountId);
    });

    it("stores a minimal campaign with the defaults filled in", async () => {
      const res = await create(minimal);
      expect(res.status).toBe(201);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.data.trackedLinks).toEqual([]);

      const campaign = await stored(payload.data.id);
      expect(campaign).toMatchObject({
        workspaceId,
        name: "Guide",
        goal: null,
        postId: null,
        postUrl: null,
        pendingNextReel: false,
        matchAnyPost: true,
        keywords: ["GUIDE"],
        matchAnyWord: false,
        dmTriggerEnabled: false,
        dmMessage: "Here it is {link}",
        openingDmEnabled: false,
        openingDmMessage: null,
        openingDmButtonLabel: null,
        linkButtonLabel: null,
        requireFollow: false,
        followPromptMessage: null,
        followPromptButtonLabel: null,
        followUpEnabled: false,
        followUpMessage: null,
        followUpDelayMinutes: 0,
        publicReplyEnabled: false,
        publicReplyMessage: null,
        publicReplyMessages: [],
        isActive: true,
        wholeWordMatch: true,
        reportShareEnabled: true,
      });
      expect(campaign.reportShareSlug).toMatch(/^[A-Za-z0-9_-]{12}$/);
    });

    it("stores every option the builder sends", async () => {
      const res = await create({
        name: "Full",
        goal: "Grow the list",
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abc/",
        keywords: ["LINK", "SEND"],
        wholeWordMatch: false,
        dmTriggerEnabled: true,
        dmMessage: "Here you go {link}",
        openingDmEnabled: true,
        openingDmMessage: "Want the link?",
        openingDmButtonLabel: "Yes please",
        linkButtonLabel: "Get it",
        trackedDestinationUrl: "https://example.com/one",
        secondaryDestinationUrl: "https://example.com/two",
        secondaryButtonLabel: "Read more",
        requireFollow: true,
        followPromptMessage: "Follow first",
        followPromptButtonLabel: "Following",
        followUpEnabled: true,
        followUpMessage: "Did it help?",
        followUpDelayMinutes: 30,
        publicReplyEnabled: true,
        publicReplyMessages: ["  Sent!  ", "", "Check your DMs"],
        isActive: false,
      });
      expect(res.status).toBe(201);
      const payload = await res.json();
      const campaign = await stored(payload.data.id);
      expect(campaign).toMatchObject({
        goal: "Grow the list",
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abc/",
        matchAnyPost: false,
        pendingNextReel: false,
        keywords: ["LINK", "SEND"],
        wholeWordMatch: false,
        dmTriggerEnabled: true,
        openingDmEnabled: true,
        openingDmMessage: "Want the link?",
        openingDmButtonLabel: "Yes please",
        linkButtonLabel: "Get it",
        requireFollow: true,
        followPromptMessage: "Follow first",
        followPromptButtonLabel: "Following",
        followUpEnabled: true,
        followUpMessage: "Did it help?",
        followUpDelayMinutes: 30,
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent!", "Check your DMs"],
        publicReplyMessage: "Sent!",
        isActive: false,
      });
      expect(await storedLinks(campaign.id)).toEqual([
        { label: "Primary campaign link", destinationUrl: "https://example.com/one", position: 0 },
        { label: "Read more", destinationUrl: "https://example.com/two", position: 1 },
      ]);
      expect(payload.data.trackedLinks).toHaveLength(2);
    });

    it("drops the options a switched-off section would carry", async () => {
      const id = await createdId({
        ...minimal,
        matchAnyWord: true,
        keywords: ["IGNORED"],
        openingDmEnabled: false,
        openingDmMessage: "ignored",
        openingDmButtonLabel: "ignored",
        linkButtonLabel: "",
        requireFollow: false,
        followPromptMessage: "ignored",
        followPromptButtonLabel: "ignored",
        followUpEnabled: false,
        followUpMessage: "ignored",
        followUpDelayMinutes: 90,
        publicReplyEnabled: false,
        publicReplyMessages: ["ignored"],
        trackedDestinationUrl: "",
        secondaryDestinationUrl: "",
      });
      expect(await stored(id)).toMatchObject({
        matchAnyWord: true,
        keywords: [],
        openingDmMessage: null,
        openingDmButtonLabel: null,
        linkButtonLabel: null,
        followPromptMessage: null,
        followPromptButtonLabel: null,
        followUpMessage: null,
        followUpDelayMinutes: 0,
        publicReplyMessages: [],
        publicReplyMessage: null,
      });
      expect(await storedLinks(id)).toEqual([]);
    });

    it("keeps a post only for the specific-post target", async () => {
      const anyPost = await createdId({
        ...minimal,
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abc/",
      });
      expect(await stored(anyPost)).toMatchObject({ postId: null, postUrl: null, matchAnyPost: true });

      const nextReel = await createdId({
        ...minimal,
        matchAnyPost: false,
        pendingNextReel: true,
        postId: "media_1",
      });
      expect(await stored(nextReel)).toMatchObject({
        postId: null,
        postUrl: null,
        pendingNextReel: true,
        matchAnyPost: false,
      });
    });

    it("takes a single legacy public reply when no list is sent", async () => {
      const id = await createdId({
        ...minimal,
        publicReplyEnabled: true,
        publicReplyMessage: "  Sent you a DM  ",
      });
      expect(await stored(id)).toMatchObject({
        publicReplyMessages: ["Sent you a DM"],
        publicReplyMessage: "Sent you a DM",
      });
    });

    it("labels a second link 'Open link' when it has no label", async () => {
      const id = await createdId({
        ...minimal,
        secondaryDestinationUrl: "https://example.com/two",
        secondaryButtonLabel: "  ",
      });
      expect(await storedLinks(id)).toEqual([
        { label: "Open link", destinationUrl: "https://example.com/two", position: 0 },
      ]);
    });
  });

  describe("update", () => {
    it("refuses a visitor who is not signed in", async () => {
      const id = await createdId(minimal);
      signOut();
      const res = await update(id, { name: "New" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
    });

    it("refuses a member who cannot manage the workspace", async () => {
      const id = await createdId(minimal);
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      const res = await update(id, { name: "New" });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        success: false,
        error: "Only owners and admins can update campaigns",
      });
    });

    it("needs a campaign id", async () => {
      const res = await update(null, { name: "New" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: "Missing campaign ID" });
    });

    it("rejects invalid fields", async () => {
      const id = await createdId(minimal);
      const res = await update(id, { dmMessage: "", keywords: ["x".repeat(51)] });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toBe("Invalid input");
      expect(Object.keys(payload.details.fieldErrors).sort()).toEqual(["dmMessage", "keywords"]);
    });

    it("cannot reach another workspace's campaign", async () => {
      const other = await createOwner(db.prisma, "other");
      await connectInstagramAccount(db.prisma, other.workspace.id, { username: "theirs" });
      signInAs(other.user.id);
      const theirs = await createdId(minimal);

      signInAs(ownerId);
      const res = await update(theirs, { name: "Hijacked" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: "Campaign not found" });
      expect((await stored(theirs)).name).toBe("Guide");
    });

    it("changes only the fields it is sent", async () => {
      const id = await createdId({
        ...minimal,
        trackedDestinationUrl: "https://example.com/one",
        linkButtonLabel: "Get it",
      });
      const before = await stored(id);

      const res = await update(id, { name: "Renamed", keywords: ["NEW"] });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.data).toMatchObject({ id, name: "Renamed", keywords: ["NEW"] });
      expect(payload.data.trackedLinks).toBeUndefined();

      const after = await stored(id);
      expect({ ...after, updatedAt: before.updatedAt }).toEqual({
        ...before,
        name: "Renamed",
        keywords: ["NEW"],
      });
      expect(await storedLinks(id)).toEqual([
        { label: "Primary campaign link", destinationUrl: "https://example.com/one", position: 0 },
      ]);
    });

    it("clears what a switched-off section carried", async () => {
      const id = await createdId({
        name: "Everything",
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abc/",
        keywords: ["LINK"],
        dmMessage: "Here",
        openingDmEnabled: true,
        openingDmMessage: "Want it?",
        openingDmButtonLabel: "Yes",
        requireFollow: true,
        followPromptMessage: "Follow first",
        followPromptButtonLabel: "Following",
        followUpEnabled: true,
        followUpMessage: "Thanks",
        followUpDelayMinutes: 15,
        publicReplyEnabled: true,
        publicReplyMessages: ["Sent!"],
      });

      await update(id, {
        matchAnyWord: true,
        openingDmEnabled: false,
        requireFollow: false,
        followUpEnabled: false,
        publicReplyEnabled: false,
        matchAnyPost: true,
      });
      expect(await stored(id)).toMatchObject({
        matchAnyWord: true,
        keywords: [],
        openingDmEnabled: false,
        openingDmMessage: null,
        openingDmButtonLabel: null,
        requireFollow: false,
        followPromptMessage: null,
        followPromptButtonLabel: null,
        followUpEnabled: false,
        followUpMessage: null,
        followUpDelayMinutes: 0,
        publicReplyEnabled: false,
        publicReplyMessages: [],
        publicReplyMessage: null,
        matchAnyPost: true,
        postId: null,
        postUrl: null,
      });
    });

    it("moves a campaign to the next reel and back to a post", async () => {
      const id = await createdId({
        ...minimal,
        matchAnyPost: false,
        postId: "media_1",
        postUrl: "https://www.instagram.com/p/abc/",
      });

      await update(id, { pendingNextReel: true });
      expect(await stored(id)).toMatchObject({ pendingNextReel: true, postId: null, postUrl: null });

      await update(id, {
        pendingNextReel: false,
        matchAnyPost: false,
        postId: "media_2",
        postUrl: "https://www.instagram.com/reel/xyz/",
      });
      expect(await stored(id)).toMatchObject({
        pendingNextReel: false,
        matchAnyPost: false,
        postId: "media_2",
        postUrl: "https://www.instagram.com/reel/xyz/",
      });
    });

    it("trims public reply variations and keeps the legacy field in step", async () => {
      const id = await createdId(minimal);
      await update(id, {
        publicReplyEnabled: true,
        publicReplyMessages: ["  One  ", "", " Two"],
      });
      expect(await stored(id)).toMatchObject({
        publicReplyEnabled: true,
        publicReplyMessages: ["One", "Two"],
        publicReplyMessage: "One",
      });

      await update(id, { publicReplyMessages: [] });
      expect(await stored(id)).toMatchObject({ publicReplyMessages: [], publicReplyMessage: null });
    });

    it("adds, changes and removes the tracked links", async () => {
      const id = await createdId(minimal);

      await update(id, {
        trackedDestinationUrl: "https://example.com/one",
        secondaryDestinationUrl: "https://example.com/two",
        secondaryButtonLabel: "More",
      });
      expect(await storedLinks(id)).toEqual([
        { label: "Primary campaign link", destinationUrl: "https://example.com/one", position: 0 },
        { label: "More", destinationUrl: "https://example.com/two", position: 1 },
      ]);

      await update(id, { trackedDestinationUrl: "https://example.com/uno" });
      expect(await storedLinks(id)).toEqual([
        { label: "Primary campaign link", destinationUrl: "https://example.com/uno", position: 0 },
        { label: "More", destinationUrl: "https://example.com/two", position: 1 },
      ]);

      await update(id, { trackedDestinationUrl: "" });
      expect(await storedLinks(id)).toEqual([
        { label: "More", destinationUrl: "https://example.com/two", position: 0 },
      ]);

      // With the first link gone, the remaining one is now the first button,
      // so clearing the second changes nothing and clearing the first removes it.
      await update(id, { secondaryDestinationUrl: "" });
      expect(await storedLinks(id)).toEqual([
        { label: "More", destinationUrl: "https://example.com/two", position: 0 },
      ]);
      await update(id, { trackedDestinationUrl: "" });
      expect(await storedLinks(id)).toEqual([]);
    });

    it("switches report sharing off", async () => {
      const id = await createdId(minimal);
      await update(id, { reportShareEnabled: false });
      expect((await stored(id)).reportShareEnabled).toBe(false);
    });
  });

  describe("on and off", () => {
    it("switches a campaign off and on without touching anything else", async () => {
      const id = await createdId({
        ...minimal,
        trackedDestinationUrl: "https://example.com/one",
      });
      const before = await stored(id);
      expect(before.isActive).toBe(true);

      const off = await update(id, { isActive: false });
      expect(off.status).toBe(200);
      expect((await off.json()).data.isActive).toBe(false);
      const paused = await stored(id);
      expect({ ...paused, updatedAt: before.updatedAt }).toEqual({ ...before, isActive: false });

      const on = await update(id, { isActive: true });
      expect((await on.json()).data.isActive).toBe(true);
      const live = await stored(id);
      expect({ ...live, updatedAt: before.updatedAt }).toEqual(before);
      expect(await storedLinks(id)).toEqual([
        { label: "Primary campaign link", destinationUrl: "https://example.com/one", position: 0 },
      ]);
    });

    it("refuses a member who cannot manage the workspace", async () => {
      const id = await createdId(minimal);
      const member = await addMember(db.prisma, workspaceId, "MEMBER");
      signInAs(member.id);
      expect((await update(id, { isActive: false })).status).toBe(403);
      expect((await stored(id)).isActive).toBe(true);
    });
  });
});
