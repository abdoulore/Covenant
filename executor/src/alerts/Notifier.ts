/**
 * Where alerts go.
 *
 * Telegram when it is configured, the log otherwise. A keeper without alert credentials still
 * reconciles and still logs every problem; it just cannot reach a phone, and says so once at start.
 *
 * The bot token is a credential: anyone holding it can post as the bot and read what is sent to it.
 * It is part of the request URL, so it must never reach a log line or an error message, including
 * the ones fetch itself produces, which quote the URL. Every error thrown here is built from the
 * status and Telegram's own description, never from the request.
 */

export interface Notifier {
  /** Where messages go, for the startup log. Never includes a credential. */
  readonly describe: string;
  send(text: string): Promise<void>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** Injected for tests. */
  fetchFn?: FetchLike;
}

/** Telegram's hard limit on a message. Longer ones are refused outright, so trim instead. */
const TELEGRAM_MAX = 4096;

export class TelegramNotifier implements Notifier {
  readonly describe: string;
  private readonly url: string;
  private readonly chatId: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: TelegramOptions) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(opts.token)) {
      throw new Error("TELEGRAM_BOT_TOKEN does not look like a bot token (expected <digits>:<secret>).");
    }
    this.url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
    this.chatId = opts.chatId;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.describe = `Telegram chat ${opts.chatId}`;
  }

  async send(text: string): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 1)}…` : text,
      // Explorer links would otherwise each unfurl into a preview card.
      disable_web_page_preview: true,
    });
    let res;
    try {
      res = await this.fetchFn(this.url, { method: "POST", headers: { "content-type": "application/json" }, body });
    } catch {
      // Deliberately not the caught error: fetch's messages can quote the URL, and the URL holds the token.
      throw new Error("Could not reach Telegram (network error).");
    }
    if (!res.ok) {
      const detail = await res.json().then((j) => (j as { description?: string }).description).catch(() => undefined);
      throw new Error(`Telegram refused the message (${res.status}${detail ? `: ${detail}` : ""}).`);
    }
  }
}

/** The fallback: every alert still lands in the log, where an operator reading it will see it. */
export class LogNotifier implements Notifier {
  readonly describe = "the log only (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not both set)";
  constructor(private readonly log: (message: string) => void = (m) => console.warn(m)) {}
  async send(text: string): Promise<void> {
    this.log(`ALERT ${text.replace(/\n/g, " | ")}`);
  }
}

export function notifierFromEnv(env: Record<string, string | undefined> = process.env, log?: (m: string) => void): Notifier {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) return new TelegramNotifier({ token, chatId });
  return new LogNotifier(log);
}
