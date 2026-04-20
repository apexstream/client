/** Event names for `ApexStreamClient.prototype.on` / `off`. */
export type ApexStreamEvent = "open" | "close" | "error" | "message";

export type ApexStreamClientOptions = {
  /** WebSocket base URL (e.g. `wss://gateway.example.com/v1/ws`) — without query; the client appends `api_key` for the handshake. */
  url: string;
  /**
   * API key for the gateway (sent as `api_key` query on the WebSocket URL; browsers cannot set custom headers on `WebSocket`).
   * Do not log the full URL after connect in production.
   */
  apiKey: string;
  /**
   * When true, allows `ws://` to hosts other than localhost (LAN/dev only). Production should use `wss://`.
   */
  allowInsecureTransport?: boolean;
};

type OpenHandler = () => void;
type CloseHandler = (ev: CloseEvent) => void;
type ErrorHandler = (ev: Event) => void;
type MessageHandler = (data: unknown, raw: MessageEvent) => void;

type ListenerMap = {
  [E in ApexStreamEvent]: E extends "open"
    ? Set<OpenHandler>
    : E extends "close"
      ? Set<CloseHandler>
      : E extends "error"
        ? Set<ErrorHandler>
        : Set<MessageHandler>;
};

const PROTO = {
  subscribe: "subscribe",
  unsubscribe: "unsubscribe",
  publish: "publish",
  message: "message",
  replay: "replay",
  reliableAck: "reliable_ack",
} as const;

/** Optional metadata on inbound channel `message` frames (extended realtime). */
export type ChannelMessageMeta = {
  reliableMessageId?: string;
  /** Durable row id when the publish was stored for replay (same as `replay_event` cursors). */
  durableEventId?: string;
};

export type ReplayRequest = {
  /** Durable cursor from a previous `replay_event` payload (`event_id`). */
  afterEventId?: string;
  /** ISO8601 lower bound when no cursor exists yet (e.g. last disconnect time). */
  fromTimestamp?: string;
  limit?: number;
};

function parseWebSocketURL(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("ApexStreamClient url must be absolute (ws:// or wss://)");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("ApexStreamClient url must use ws:// or wss://");
  }
  return parsed;
}

function assertSecureTransport(wsURL: URL, allowInsecureTransport?: boolean): void {
  if (allowInsecureTransport) {
    return;
  }
  const host = wsURL.hostname.trim().toLowerCase();
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!isLocalhost && wsURL.protocol !== "wss:") {
    throw new Error("ApexStreamClient requires wss:// for non-local hosts (or set allowInsecureTransport for LAN dev)");
  }
}

/** Gateway accepts `api_key` / `apiKey` on the upgrade URL (see server `authenticateAPIKey`). */
function websocketUrlWithApiKey(parsed: URL, apiKey: string): string {
  const next = new URL(parsed.toString());
  const key = apiKey.trim();
  if (!key) {
    return next.toString();
  }
  if (!next.searchParams.has("api_key") && !next.searchParams.has("apiKey")) {
    next.searchParams.set("api_key", key);
  }
  return next.toString();
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Lightweight browser/Node 18+ WebSocket client for ApexStream-style gateways.
 *
 * Wire format (JSON text frames), subject to server evolution:
 * - Client → server: `subscribe`, `publish`, optional `replay`, `reliable_ack` (extended realtime).
 * - Server → client: `message` (optional `reliable_message_id`), `replay_event`, `welcome`, presence frames, etc.
 */
export class ApexStreamClient {
  readonly url: string;
  readonly apiKey: string;

  /** Resolved gateway WebSocket URL (after parse + security checks). */
  private resolvedWsUrl: string;
  private socket: WebSocket | null = null;
  private listeners: ListenerMap = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    message: new Set(),
  };
  private channelHandlers = new Map<string, Set<(payload: unknown, meta?: ChannelMessageMeta) => void>>();

  constructor(options: ApexStreamClientOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    const parsedURL = parseWebSocketURL(options.url);
    assertSecureTransport(parsedURL, options.allowInsecureTransport);
    this.resolvedWsUrl = websocketUrlWithApiKey(parsedURL, options.apiKey);
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  on(event: "open", handler: OpenHandler): void;
  on(event: "close", handler: CloseHandler): void;
  on(event: "error", handler: ErrorHandler): void;
  on(event: "message", handler: MessageHandler): void;
  on(event: ApexStreamEvent, handler: OpenHandler | CloseHandler | ErrorHandler | MessageHandler): void {
    this.applyListenerChange("add", event, handler);
  }

  off(event: "open", handler: OpenHandler): void;
  off(event: "close", handler: CloseHandler): void;
  off(event: "error", handler: ErrorHandler): void;
  off(event: "message", handler: MessageHandler): void;
  off(event: ApexStreamEvent, handler: OpenHandler | CloseHandler | ErrorHandler | MessageHandler): void {
    this.applyListenerChange("remove", event, handler);
  }

  private applyListenerChange(
    mode: "add" | "remove",
    event: ApexStreamEvent,
    handler: OpenHandler | CloseHandler | ErrorHandler | MessageHandler,
  ): void {
    const run = <T>(set: Set<T>, h: T): void => {
      if (mode === "add") {
        set.add(h);
      } else {
        set.delete(h);
      }
    };
    switch (event) {
      case "open":
        run(this.listeners.open, handler as OpenHandler);
        break;
      case "close":
        run(this.listeners.close, handler as CloseHandler);
        break;
      case "error":
        run(this.listeners.error, handler as ErrorHandler);
        break;
      case "message":
        run(this.listeners.message, handler as MessageHandler);
        break;
    }
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.resolvedWsUrl);
    this.socket = ws;

    ws.addEventListener("open", () => {
      for (const channel of this.channelHandlers.keys()) {
        this.sendJson({ type: PROTO.subscribe, channel });
      }
      for (const fn of this.listeners.open) fn();
    });

    ws.addEventListener("close", (ev) => {
      for (const fn of this.listeners.close) fn(ev);
    });

    ws.addEventListener("error", (ev) => {
      for (const fn of this.listeners.error) fn(ev);
    });

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? safeJsonParse(ev.data) : ev.data;
      for (const fn of this.listeners.message) fn(data, ev);

      if (data && typeof data === "object" && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        if (obj.type === PROTO.message && typeof obj.channel === "string") {
          const handlers = this.channelHandlers.get(obj.channel);
          if (handlers) {
            const payload = "payload" in obj ? obj.payload : undefined;
            const reliableRaw = obj.reliable_message_id;
            const durableRaw = obj.durable_event_id;
            const hasReliable = typeof reliableRaw === "string" && reliableRaw.trim() !== "";
            const hasDurable = typeof durableRaw === "string" && durableRaw.trim() !== "";
            const meta: ChannelMessageMeta | undefined =
              hasReliable || hasDurable
                ? {
                    ...(hasReliable ? { reliableMessageId: reliableRaw.trim() } : {}),
                    ...(hasDurable ? { durableEventId: durableRaw.trim() } : {}),
                  }
                : undefined;
            for (const fn of handlers) fn(payload, meta);
          }
        }
      }
    });
  }

  disconnect(code = 1000, reason?: string): void {
    const ws = this.socket;
    this.socket = null;
    ws?.close(code, reason);
  }

  subscribe(channel: string, handler: (payload: unknown, meta?: ChannelMessageMeta) => void): () => void {
    let set = this.channelHandlers.get(channel);
    if (!set) {
      set = new Set();
      this.channelHandlers.set(channel, set);
    }
    set.add(handler);

    if (this.connected) {
      this.sendJson({ type: PROTO.subscribe, channel });
    }

    return () => {
      const handlers = this.channelHandlers.get(channel);
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        this.channelHandlers.delete(channel);
        if (this.connected) {
          this.sendJson({ type: PROTO.unsubscribe, channel });
        }
      }
    };
  }

  publish(channel: string, payload: unknown): void {
    if (!this.connected) {
      throw new Error("ApexStreamClient is not connected");
    }
    this.sendJson({ type: PROTO.publish, channel, payload });
  }

  /**
   * Request durable history for a channel (requires extended realtime + retention on the app).
   * Server responds with `replay_started` then zero or more `replay_event` frames on this connection.
   */
  replay(channel: string, req: ReplayRequest = {}): void {
    if (!this.connected) {
      throw new Error("ApexStreamClient is not connected");
    }
    const payload: Record<string, unknown> = {};
    if (req.afterEventId != null && req.afterEventId !== "") {
      payload.after_event_id = req.afterEventId;
    }
    if (req.fromTimestamp != null && req.fromTimestamp !== "") {
      payload.from_timestamp = req.fromTimestamp;
    }
    if (req.limit != null && req.limit > 0) {
      payload.limit = req.limit;
    }
    this.sendJson({ type: PROTO.replay, channel, payload });
  }

  /** Ack a reliable delivery (`reliable_message_id` from an inbound `message`). Extended realtime only. */
  reliableAck(messageId: string): void {
    if (!this.connected) {
      throw new Error("ApexStreamClient is not connected");
    }
    const mid = messageId.trim();
    if (!mid) {
      throw new Error("reliableAck requires message_id");
    }
    this.sendJson({ type: PROTO.reliableAck, payload: { message_id: mid } });
  }

  private sendJson(message: Record<string, unknown>): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("ApexStreamClient is not connected");
    }
    ws.send(JSON.stringify(message));
  }
}
