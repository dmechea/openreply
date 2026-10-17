import type { InstagramAccount } from "@/app/generated/prisma/client";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import {
  createInstagramContext,
  getConversationMessages,
  getConversations,
  sendDirectMessage,
  type InstagramContext,
  type ProviderAccount,
} from "@/lib/instagram/provider";
import type { InstagramMessage, InstagramParticipant } from "@/lib/meta/client";

/**
 * The account's Instagram DM inbox, read live from Instagram every time and
 * never stored. The only judgement made here is the mechanical one: a
 * conversation needs a reply when the other person sent the last message.
 * Whether it is a real inquiry is left to whoever reads it.
 */

/** An account the inbox can be read for: what Instagram needs, plus who it is. */
export type InboxAccount = ProviderAccount & Pick<InstagramAccount, "id" | "username">;

/** Instagram allows a reply only within this long of the person's last message. */
export const MESSAGING_WINDOW_HOURS = 24;
const WINDOW_MS = MESSAGING_WINDOW_HOURS * 60 * 60 * 1000;

export const NO_TEXT_PLACEHOLDER =
  "[No text: a story reply, reaction, photo, voice message or other attachment]";

export type MessagingWindow = {
  open: boolean;
  /** When the window closes, or closed; null when they have not written. */
  closesAt: string | null;
  /** Rounded down to a tenth of an hour, so it never overstates the time left. */
  hoursLeft: number;
};

function parseTime(value: string | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

export function messagingWindow(theirLastMessageAt: Date | null, now = new Date()): MessagingWindow {
  if (!theirLastMessageAt) return { open: false, closesAt: null, hoursLeft: 0 };
  const closesAt = new Date(theirLastMessageAt.getTime() + WINDOW_MS);
  const msLeft = closesAt.getTime() - now.getTime();
  return {
    open: msLeft > 0,
    closesAt: closesAt.toISOString(),
    hoursLeft: msLeft > 0 ? Math.floor(msLeft / 360_000) / 10 : 0,
  };
}

function messageText(message: InstagramMessage) {
  return message.message ? message.message : NO_TEXT_PLACEHOLDER;
}

type Contact = { id: string; username: string | null };

function toContact(person: InstagramParticipant | undefined | null): Contact | null {
  return person?.id ? { id: person.id, username: person.username ?? null } : null;
}

export type ConversationSummary = {
  conversationId: string;
  contact: Contact | null;
  lastMessage: {
    text: string;
    fromMe: boolean;
    sentAt: string | null;
  } | null;
};

async function mapInBatches<T, R>(items: T[], size: number, map: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(map))));
  }
  return results;
}

/**
 * Up to 50 recent conversations, newest first, each with its last message.
 * When Instagram's list leaves a conversation's last message out (a broken
 * expansion, or a provider whose list has none), its thread is read instead.
 */
async function readInbox(account: InboxAccount, context: InstagramContext) {
  const conversations = await getConversations({ context, igUserId: account.instagramId });
  return mapInBatches(conversations, 5, async (conversation): Promise<ConversationSummary> => {
    let last: InstagramMessage | null = conversation.messages?.data?.[0] ?? null;
    if (!last) {
      try {
        last = (await getConversationMessages({ context, conversationId: conversation.id }))[0] ?? null;
      } catch {
        last = null;
      }
    }
    const participant = conversation.participants?.data?.find(
      (p) => p.id !== account.instagramId
    );
    const fromMe = last?.from?.id === account.instagramId;
    return {
      conversationId: conversation.id,
      contact: toContact(participant ?? (last && !fromMe ? last.from : last?.to?.data?.[0])),
      lastMessage: last
        ? { text: messageText(last), fromMe, sentAt: parseTime(last.created_time)?.toISOString() ?? null }
        : null,
    };
  });
}

export async function listRecentConversations(account: InboxAccount) {
  const context = await createInstagramContext(account);
  return readInbox(account, context);
}

/**
 * Conversations whose last message is from the other person, soonest to
 * close first. Closed windows are left out unless asked for, and then come
 * after the open ones, most recently closed first.
 */
export async function listConversationsNeedingReply(
  account: InboxAccount,
  { includeClosed = false }: { includeClosed?: boolean } = {}
) {
  const now = new Date();
  const inbox = await listRecentConversations(account);
  const waiting = inbox
    .filter((c) => c.lastMessage && !c.lastMessage.fromMe)
    .map((c) => ({
      ...c,
      window: messagingWindow(parseTime(c.lastMessage?.sentAt ?? undefined), now),
    }));

  const open = waiting
    .filter((c) => c.window.open)
    .sort((a, b) => Date.parse(a.window.closesAt!) - Date.parse(b.window.closesAt!));
  const closed = waiting
    .filter((c) => !c.window.open)
    .sort((a, b) => Date.parse(b.window.closesAt ?? "0") - Date.parse(a.window.closesAt ?? "0"));

  return {
    conversations: includeClosed ? [...open, ...closed] : open,
    closedWindowCount: closed.length,
    // Conversations whose last message Instagram would not return, so whether
    // they wait for a reply is unknown.
    unreadableCount: inbox.filter((c) => !c.lastMessage).length,
  };
}

function theirLatest(messages: InstagramMessage[], account: InboxAccount) {
  // Instagram returns a thread newest first.
  return messages.find((m) => m.from?.id && m.from.id !== account.instagramId) ?? null;
}

/** A thread, oldest to newest. Instagram returns its 20 most recent messages. */
export async function getConversation(account: InboxAccount, conversationId: string) {
  const context = await createInstagramContext(account);
  const messages = await getConversationMessages({ context, conversationId });
  const theirs = theirLatest(messages, account);
  const mine = messages.find((m) => m.from?.id === account.instagramId);

  return {
    conversationId,
    contact: toContact(theirs?.from ?? mine?.to?.data?.[0]),
    window: messagingWindow(parseTime(theirs?.created_time)),
    messages: [...messages].reverse().map((m) => ({
      id: m.id,
      from: m.from?.id === account.instagramId ? ("me" as const) : ("them" as const),
      sentAt: parseTime(m.created_time)?.toISOString() ?? null,
      text: messageText(m),
    })),
  };
}

export type SendReplyResult =
  | { status: "sent"; messageId: string }
  | { status: "window_closed"; theirLastMessageAt: string | null; closedAt: string | null }
  | { status: "rejected"; reason: string }
  | { status: "unconfirmed"; reason: string };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send a text reply into an existing conversation. The window is checked on a
 * fresh read of the thread first, and a closed one sends nothing. Instagram is
 * asked once: a refusal is reported as one, and anything that leaves the
 * outcome unknown is reported as unconfirmed, never retried, so nobody gets
 * the same message twice.
 */
export async function sendReply(
  account: InboxAccount,
  conversationId: string,
  text: string
): Promise<SendReplyResult> {
  const context = await createInstagramContext(account);
  const messages = await getConversationMessages({ context, conversationId });
  const theirs = theirLatest(messages, account);
  const theirLastMessageAt = parseTime(theirs?.created_time);
  const window = messagingWindow(theirLastMessageAt);
  if (!theirs?.from || !window.open) {
    return {
      status: "window_closed",
      theirLastMessageAt: theirLastMessageAt?.toISOString() ?? null,
      closedAt: window.closesAt,
    };
  }

  try {
    const result = await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: theirs.from.id,
      message: text,
    });
    if (!result?.message_id) {
      return { status: "unconfirmed", reason: "Instagram did not return a message id" };
    }
    return { status: "sent", messageId: result.message_id };
  } catch (error) {
    if (isConfirmedSendRejection(error)) {
      return { status: "rejected", reason: errorMessage(error) };
    }
    return { status: "unconfirmed", reason: errorMessage(error) };
  }
}
