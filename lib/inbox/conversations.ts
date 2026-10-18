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
import type {
  InstagramConversation,
  InstagramMessage,
  InstagramParticipant,
} from "@/lib/meta/client";

/**
 * The account's Instagram DM inbox, read live from Instagram every time and
 * never stored. The only judgement made here is the mechanical one: a
 * conversation needs a reply when the other person sent the last message.
 * Whether it is a real inquiry is left to whoever reads it.
 */

/** An account the inbox can be read for: what Instagram needs, plus who it is. */
export type InboxAccount = ProviderAccount & Pick<InstagramAccount, "id" | "username">;

/** A request OpenReply itself turns down, not Instagram, with the reason to give. */
export class InboxRefusal extends Error {}

/** Instagram allows a reply only within this long of the person's last message. */
export const MESSAGING_WINDOW_HOURS = 24;
const WINDOW_MS = MESSAGING_WINDOW_HOURS * 60 * 60 * 1000;

/** Both providers return at most a thread's 20 most recent messages. */
const THREAD_LIMIT = 20;

const NO_TEXT_PLACEHOLDER =
  "[No text: a story reply, reaction, photo, voice message or other attachment]";

/**
 * Instagram's conversation ids are base64 text (letters and digits, with
 * - _ = in its URL-safe form) and Zernio's are database ids. Anything else is
 * refused before it becomes part of a request path, so no slash, dot, ? or #
 * can point the request somewhere else.
 */
const CONVERSATION_ID = /^[A-Za-z0-9_=-]{1,512}$/;

function checkConversationId(conversationId: string) {
  if (!CONVERSATION_ID.test(conversationId)) {
    throw new InboxRefusal(
      "That is not a conversation id. Use the conversationId a conversation was listed with."
    );
  }
}

export type MessagingWindow = {
  open: boolean;
  /** When the window closes, or closed; null when they have not written. */
  closesAt: string | null;
  /** Rounded down to a tenth of an hour, so it never overstates the time left. */
  hoursLeft: number;
};

/** A thread's window, which the thread cannot always show: then all is null. */
type ThreadWindow = MessagingWindow | { open: null; closesAt: null; hoursLeft: null };

function parseTime(value: string | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function messagingWindow(theirLastMessageAt: Date | null, now = new Date()): MessagingWindow {
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

/**
 * Maps every item with at most `limit` calls in flight, keeping the items'
 * order. Each worker takes the next item as soon as its last one is done, so
 * one slow call holds up only its own worker.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await map(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Up to 50 recent conversations, newest first, each with its last message.
 * When Instagram's list leaves a conversation's last message out (a broken
 * expansion, or a provider whose list has none), its thread is read instead.
 * With skipQuiet, a conversation quiet for longer than the reply window is
 * not read: whoever wrote last, it can no longer be replied to. Those are
 * counted, not listed.
 */
async function readInbox(
  account: InboxAccount,
  context: InstagramContext,
  { skipQuiet = false }: { skipQuiet?: boolean } = {}
) {
  const quietSince = Date.now() - WINDOW_MS;

  async function summarise(conversation: InstagramConversation): Promise<ConversationSummary | null> {
    let last: InstagramMessage | null = conversation.messages?.data?.[0] ?? null;
    if (!last) {
      const updated = parseTime(conversation.updated_time);
      if (skipQuiet && updated && updated.getTime() <= quietSince) return null;
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
  }

  const conversations = await getConversations({ context, igUserId: account.instagramId });
  const rows = await mapWithConcurrency(conversations, 5, summarise);
  return {
    conversations: rows.filter((row): row is ConversationSummary => row !== null),
    uncheckedCount: rows.filter((row) => row === null).length,
  };
}

export async function listRecentConversations(account: InboxAccount) {
  const context = await createInstagramContext(account);
  return (await readInbox(account, context)).conversations;
}

/**
 * Conversations whose last message is from the other person, soonest to
 * close first. Closed windows are left out unless asked for, and then come
 * after the open ones, most recently closed first. Without closed windows
 * asked for, a thread quiet for longer than the window is not worth reading.
 */
export async function listConversationsNeedingReply(
  account: InboxAccount,
  { includeClosed = false }: { includeClosed?: boolean } = {}
) {
  const now = new Date();
  const context = await createInstagramContext(account);
  const { conversations: inbox, uncheckedCount } = await readInbox(account, context, {
    skipQuiet: !includeClosed,
  });
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
    // Conversations quiet for longer than the window whose last message the
    // list left out, so they were not read. Whoever wrote last, their window
    // has closed.
    uncheckedCount,
  };
}

function theirLatest(messages: InstagramMessage[], account: InboxAccount) {
  // Instagram returns a thread newest first.
  return messages.find((m) => m.from?.id && m.from.id !== account.instagramId) ?? null;
}

/**
 * The reply window as a thread shows it, set by their latest message. A
 * thread with none of theirs that is shorter than Instagram returns is the
 * whole conversation, so they never wrote. Otherwise their last message is
 * older than the messages returned: when the oldest of those is already past
 * the window, theirs is too, and when not, the thread cannot tell.
 */
function threadWindow(
  messages: InstagramMessage[],
  theirs: InstagramMessage | null,
  now = new Date()
): ThreadWindow {
  if (theirs || messages.length < THREAD_LIMIT) {
    return messagingWindow(parseTime(theirs?.created_time), now);
  }
  const oldest = parseTime(messages[messages.length - 1].created_time);
  if (oldest && now.getTime() - oldest.getTime() >= WINDOW_MS) return messagingWindow(null, now);
  return { open: null, closesAt: null, hoursLeft: null };
}

/**
 * A conversation's messages, newest first. With Meta each account reads with
 * its own token, so Instagram itself refuses another account's thread, and
 * the thread is all that is read. One Zernio key reads every account's
 * threads, so there only the account's own conversation list says whose a
 * conversation is: one missing from it is refused, and nothing read from the
 * thread is used. The list is read at the same time as the thread; if Zernio
 * refuses either, that refusal is what is reported. The list also names the
 * other person, which Zernio's thread alone may not.
 */
async function readThread(account: InboxAccount, context: InstagramContext, conversationId: string) {
  if (context.provider !== "ZERNIO") {
    return { messages: await getConversationMessages({ context, conversationId }), listed: null };
  }
  const [conversations, messages] = await Promise.all([
    getConversations({ context, igUserId: account.instagramId }),
    getConversationMessages({ context, conversationId }),
  ]);
  const conversation = conversations.find((c) => c.id === conversationId);
  if (!conversation) {
    throw new InboxRefusal(
      `That conversation is not among @${account.username}'s 50 most recent conversations. Use the account it was listed for.`
    );
  }
  return {
    messages,
    listed: conversation.participants?.data?.find((p) => p.id !== account.instagramId) ?? null,
  };
}

/** The other person: who last wrote to the account, who it wrote to, or who the list names. */
function threadContact(
  messages: InstagramMessage[],
  account: InboxAccount,
  listed: InstagramParticipant | null
) {
  const theirs = theirLatest(messages, account);
  const mine = messages.find((m) => m.from?.id === account.instagramId);
  return toContact(theirs?.from ?? mine?.to?.data?.[0] ?? listed);
}

/**
 * A thread, oldest to newest. Instagram returns its 20 most recent messages.
 * window.open is null when those do not show whether a reply can be sent.
 */
export async function getConversation(account: InboxAccount, conversationId: string) {
  checkConversationId(conversationId);
  const context = await createInstagramContext(account);
  const { messages, listed } = await readThread(account, context, conversationId);

  return {
    conversationId,
    contact: threadContact(messages, account, listed),
    window: threadWindow(messages, theirLatest(messages, account)),
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
 * fresh read of the thread first, and a closed one sends nothing. When the
 * thread cannot show the window, Instagram decides, and a refusal for a
 * closed window comes back as rejected. Instagram is asked once: a refusal is
 * reported as one, and anything that leaves the outcome unknown is reported
 * as unconfirmed, never retried, so nobody gets the same message twice.
 */
export async function sendReply(
  account: InboxAccount,
  conversationId: string,
  text: string
): Promise<SendReplyResult> {
  checkConversationId(conversationId);
  const context = await createInstagramContext(account);
  const { messages, listed } = await readThread(account, context, conversationId);
  const theirs = theirLatest(messages, account);
  const window = threadWindow(messages, theirs);
  if (window.open === false) {
    return {
      status: "window_closed",
      theirLastMessageAt: parseTime(theirs?.created_time)?.toISOString() ?? null,
      closedAt: window.closesAt,
    };
  }
  const recipient = threadContact(messages, account, listed)?.id;
  if (!recipient) {
    throw new InboxRefusal("Not sent: Instagram did not say who the other person in this conversation is.");
  }

  try {
    const result = await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: recipient,
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
