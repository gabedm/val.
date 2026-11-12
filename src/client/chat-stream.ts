import type {
  SubscriptionIngestionEvent,
  SubscriptionIngestionProgress,
  ValChatReply,
} from "../shared/subscriptions";

/** Consume real tool progress, including UTF-8 characters and lines split across network chunks. */
export async function readIngestionStream(
  response: Response,
  onProgress: (event: SubscriptionIngestionProgress) => void,
): Promise<ValChatReply> {
  if (!response.body) throw new Error("Val couldn’t open the subscription check. Please try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply: ValChatReply | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: SubscriptionIngestionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Val couldn’t finish reading your subscriptions. Please try again.");
    }
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result") reply = event.reply;
    else if (event.type === "stage" || event.type === "subscription") onProgress(event);
    else throw new Error("Val returned an unreadable subscription check.");
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 256_000) throw new Error("Val returned an unreadable subscription check.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    consume(buffer);
    if (!reply) throw new Error("The subscription check was interrupted. Please try again.");
    return reply;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
