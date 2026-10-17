/**
 * Instagram, faked at `fetch` where the app reaches the Graph API. It holds
 * each account's conversations and posts and answers the requests
 * lib/meta/client.ts makes, checking the access token the way Instagram does,
 * so one account's token never reads another's inbox. Sends are recorded and
 * never leave the machine; any request the fake does not know fails the test.
 *
 *   const instagram = createFakeInstagram();
 *   vi.stubGlobal("fetch", instagram.fetch);
 */
import type { InstagramMedia } from "@/lib/meta/client";

const GRAPH_HOST = "graph.instagram.com";

type Person = { id: string; username?: string };

type StoredMessage = {
  id: string;
  from: Person;
  to: Person;
  text?: string;
  createdTime: Date;
};

type StoredConversation = {
  id: string;
  account: Person;
  contact: Person;
  messages: StoredMessage[];
};

type SendOutcome =
  | { kind: "reject"; status: number; code: number; message: string }
  | { kind: "lose" }
  | { kind: "garble" };

/** Instagram's own timestamp format, e.g. 2026-10-17T10:00:00+0000. */
function graphTime(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "+0000");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphError(status: number, code: number, message: string) {
  return json({ error: { message, type: "OAuthException", code, fbtrace_id: "fake" } }, status);
}

export function createFakeInstagram() {
  const accounts = new Map<string, Person>();
  const conversations = new Map<string, StoredConversation>();
  const media = new Map<string, InstagramMedia[]>();
  const sends: { accountId: string; recipientId: string; text: string }[] = [];
  const requests: { method: string; url: string }[] = [];
  const sendOutcomes: SendOutcome[] = [];
  let counter = 0;

  function nextId(prefix: string) {
    counter += 1;
    return `${prefix}_${counter}`;
  }

  function accountFor(token: string | null) {
    return token ? accounts.get(token) : undefined;
  }

  function messageView(message: StoredMessage) {
    return {
      id: message.id,
      created_time: graphTime(message.createdTime),
      from: message.from,
      to: { data: [message.to] },
      ...(message.text === undefined ? {} : { message: message.text }),
    };
  }

  function listConversations(account: Person) {
    const rows = [...conversations.values()]
      .filter((c) => c.account.id === account.id)
      .sort(
        (a, b) =>
          b.messages[b.messages.length - 1].createdTime.getTime() -
          a.messages[a.messages.length - 1].createdTime.getTime()
      )
      .slice(0, 50);
    return json({
      data: rows.map((c) => {
        const last = c.messages[c.messages.length - 1];
        return {
          id: c.id,
          updated_time: graphTime(last.createdTime),
          participants: { data: [c.account, c.contact] },
          messages: { data: [messageView(last)] },
        };
      }),
    });
  }

  function readConversation(account: Person, conversationId: string) {
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.account.id !== account.id) {
      return graphError(
        400,
        100,
        `Unsupported get request. Object with ID '${conversationId}' does not exist`
      );
    }
    return json({
      id: conversation.id,
      messages: {
        data: [...conversation.messages].reverse().slice(0, 20).map(messageView),
      },
    });
  }

  async function send(account: Person, body: unknown) {
    const { recipient, message } = body as {
      recipient?: { id?: string };
      message?: { text?: string };
    };
    if (!recipient?.id || typeof message?.text !== "string") {
      return graphError(400, 100, "Invalid parameter");
    }

    const outcome = sendOutcomes.shift();
    if (outcome?.kind === "reject") {
      return graphError(outcome.status, outcome.code, outcome.message);
    }
    if (outcome?.kind === "lose") throw new TypeError("fetch failed");
    if (outcome?.kind === "garble") return new Response("<html>bad gateway</html>", { status: 502 });

    const conversation = [...conversations.values()].find(
      (c) => c.account.id === account.id && c.contact.id === recipient.id
    );
    if (!conversation) {
      return graphError(400, 100, "No matching user found");
    }
    const sent: StoredMessage = {
      id: nextId("mid"),
      from: account,
      to: conversation.contact,
      text: message.text,
      createdTime: new Date(),
    };
    conversation.messages.push(sent);
    sends.push({ accountId: account.id, recipientId: recipient.id, text: message.text });
    return json({ recipient_id: recipient.id, message_id: sent.id });
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, url: request.url });
    if (url.hostname !== GRAPH_HOST) {
      throw new Error(`Unexpected network request in a test: ${request.method} ${request.url}`);
    }

    const bearer = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
    const account = accountFor(bearer ?? url.searchParams.get("access_token"));
    if (!account) return graphError(400, 190, "Invalid OAuth access token");

    const [, , objectId, edge] = url.pathname.split("/");
    if (request.method === "GET" && objectId === "me" && edge === "media") {
      const limit = Number(url.searchParams.get("limit") ?? 25);
      return json({ data: (media.get(account.id) ?? []).slice(0, limit) });
    }
    if (request.method === "GET" && edge === "conversations" && objectId === account.id) {
      return listConversations(account);
    }
    if (request.method === "GET" && !edge && url.searchParams.get("fields")?.startsWith("messages")) {
      return readConversation(account, objectId);
    }
    if (request.method === "POST" && edge === "messages") {
      if (objectId !== account.id) return graphError(400, 100, "Invalid account");
      return send(account, await request.json());
    }
    throw new Error(`The fake Instagram does not know ${request.method} ${request.url}`);
  }

  return {
    fetch: fetchImpl as typeof fetch,
    /** Every request the app made, in order. */
    requests,
    /** Messages the app sent, in order. */
    sends,

    addAccount(account: { instagramId: string; username: string; accessToken: string }) {
      accounts.set(account.accessToken, { id: account.instagramId, username: account.username });
    },

    /**
     * A thread between an account and one person. Messages are given oldest
     * first; a message without text stands for a story reply, reaction or
     * attachment.
     */
    addConversation({
      accountId,
      contact,
      messages,
    }: {
      accountId: string;
      contact: { id: string; username: string };
      messages: { fromMe: boolean; text?: string; at: Date }[];
    }) {
      const account = [...accounts.values()].find((a) => a.id === accountId);
      if (!account) throw new Error(`Add account ${accountId} before its conversations`);
      const id = nextId("conversation");
      conversations.set(id, {
        id,
        account,
        contact,
        messages: messages.map((m) => ({
          id: nextId("mid"),
          from: m.fromMe ? account : contact,
          to: m.fromMe ? contact : account,
          text: m.text,
          createdTime: m.at,
        })),
      });
      return id;
    },

    addMedia(accountId: string, items: InstagramMedia[]) {
      media.set(accountId, items);
    },

    /** Make the next send fail the way Instagram refuses one. */
    rejectNextSend(status: number, code: number, message: string) {
      sendOutcomes.push({ kind: "reject", status, code, message });
    },
    /** Make the next send fail after it may have reached Instagram. */
    loseNextSend() {
      sendOutcomes.push({ kind: "lose" });
    },
    /** Make the next send come back as something other than Instagram's answer. */
    garbleNextSend() {
      sendOutcomes.push({ kind: "garble" });
    },

    countRequests(method: string, pathEnd: string) {
      return requests.filter(
        (r) => r.method === method && new URL(r.url).pathname.endsWith(pathEnd)
      ).length;
    },
  };
}

export type FakeInstagram = ReturnType<typeof createFakeInstagram>;

export function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000);
}
