/**
 * shared/transport.ts — the localhost HTTP backbone.
 *
 * Each session (hub, android) runs a tiny node:http server bound to 127.0.0.1 on
 * a port. They POST JSON TransportMessages to each other. Every request carries
 * the shared token in the `x-pi4b-token` header, checked on receipt.
 * Mismatched/absent token => 401.
 *
 * PORT AUTO-FALLBACK: createTransportServer takes a PREFERRED port and, if it is
 * occupied (EADDRINUSE), transparently retries the next port up to a small bound.
 * The handle exposes the RESOLVED port (`.port`). This is what makes the spec's
 * port propagation work: the hub passes its resolved port to the spoke via the
 * HUB_PORT spawn env, and the spoke reports its own resolved port back via the
 * `register` message (so neither side has to trust the configured value).
 *
 * Exports:
 *   - createTransportServer(opts): start a server that auto-falls-back to a free
 *     port, validates the token, and dispatches by message.type to typed handlers.
 *   - post(targetPort, message): typed client POST with requestId correlation.
 *   - postToHub / postToSpoke / postToRole: convenience wrappers using config ports.
 *
 * Uses only node: built-ins + shared/{types,config}. No pi runtime dependency.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { getHost, getPort, getToken } from "./config.ts";
import type {
  HeartbeatMessage,
  IntentMessage,
  IntentResultMessage,
  RegisterMessage,
  ResetMessage,
  ResumeMessage,
  Role,
  ShutdownMessage,
  SpokeRole,
  StatusMessage,
  TransportMessage,
} from "./types.ts";

/** HTTP header that carries the shared token. */
export const TOKEN_HEADER = "x-pi4b-token";

/** Path all transport POSTs target. */
export const TRANSPORT_PATH = "/pi4b";

/** How many consecutive ports to try (preferred, +1, +2, …) before giving up. */
export const PORT_FALLBACK_TRIES = 20;

/**
 * Per-message-type handler map. Each handler receives the narrowed message and
 * may optionally return a JSON-serializable value sent back as the 200 body.
 * Unhandled types fall through to onUnhandled (or a 200 ack).
 */
export interface TransportHandlers {
  register?: (msg: RegisterMessage) => unknown | Promise<unknown>;
  heartbeat?: (msg: HeartbeatMessage) => unknown | Promise<unknown>;
  intent?: (msg: IntentMessage) => unknown | Promise<unknown>;
  intentResult?: (msg: IntentResultMessage) => unknown | Promise<unknown>;
  status?: (msg: StatusMessage) => unknown | Promise<unknown>;
  resume?: (msg: ResumeMessage) => unknown | Promise<unknown>;
  reset?: (msg: ResetMessage) => unknown | Promise<unknown>;
  shutdown?: (msg: ShutdownMessage) => unknown | Promise<unknown>;
  /** Called for any type without a specific handler. */
  onUnhandled?: (msg: TransportMessage) => unknown | Promise<unknown>;
  /** Called on parse/dispatch errors (logging hook). Does not affect the response. */
  onError?: (err: Error, raw: string) => void;
}

/** Options for createTransportServer. */
export interface TransportServerOptions {
  /** PREFERRED port to bind (127.0.0.1). Auto-falls-back to the next free port. */
  port: number;
  /** Shared token to validate. Defaults to config token. */
  token?: string;
  /** Message handlers. */
  handlers: TransportHandlers;
  /** Bind host. Defaults to config host (127.0.0.1). */
  host?: string;
  /**
   * Max consecutive ports to try on EADDRINUSE (preferred, +1, …). Defaults to
   * PORT_FALLBACK_TRIES. Set to 1 to disable fallback (fail if the port is busy).
   */
  fallbackTries?: number;
}

/** A running transport server handle. */
export interface TransportServer {
  /** The underlying node http.Server. */
  server: http.Server;
  /** The RESOLVED bound port (may differ from the preferred port after fallback). */
  port: number;
  /** Stop listening. */
  close: () => Promise<void>;
}

/** Read an entire request body as a UTF-8 string (bounded by node defaults). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Send a JSON response with a status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? { ok: true });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Dispatch a parsed message to the matching handler. */
async function dispatch(
  msg: TransportMessage,
  handlers: TransportHandlers,
): Promise<unknown> {
  switch (msg.type) {
    case "register":
      return handlers.register?.(msg) ?? handlers.onUnhandled?.(msg);
    case "heartbeat":
      return handlers.heartbeat?.(msg) ?? handlers.onUnhandled?.(msg);
    case "intent":
      return handlers.intent?.(msg) ?? handlers.onUnhandled?.(msg);
    case "intent_result":
      return handlers.intentResult?.(msg) ?? handlers.onUnhandled?.(msg);
    case "status":
      return handlers.status?.(msg) ?? handlers.onUnhandled?.(msg);
    case "resume":
      return handlers.resume?.(msg) ?? handlers.onUnhandled?.(msg);
    case "reset":
      return handlers.reset?.(msg) ?? handlers.onUnhandled?.(msg);
    case "shutdown":
      return handlers.shutdown?.(msg) ?? handlers.onUnhandled?.(msg);
    default: {
      // Exhaustiveness guard: if a new message type is added without a case,
      // this still forwards it to onUnhandled rather than throwing.
      return handlers.onUnhandled?.(msg as TransportMessage);
    }
  }
}

/** Build the http.Server (request handler) for a given token. */
function buildServer(token: string, handlers: TransportHandlers): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST" || req.url !== TRANSPORT_PATH) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const got = req.headers[TOKEN_HEADER];
        const provided = Array.isArray(got) ? got[0] : got;
        if (provided !== token) {
          sendJson(res, 401, { error: "bad token" });
          return;
        }
        const raw = await readBody(req);
        let msg: TransportMessage;
        try {
          msg = JSON.parse(raw) as TransportMessage;
        } catch (err) {
          handlers.onError?.(err as Error, raw);
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const result = await dispatch(msg, handlers);
        sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        handlers.onError?.(err as Error, "");
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });
}

/** Try to listen on one specific port; resolve true on success, false on EADDRINUSE. */
function tryListen(
  server: http.Server,
  port: number,
  host: string,
): Promise<boolean> {
  return new Promise<boolean>((resolveTry, rejectTry) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        resolveTry(false); // occupied — caller advances to the next port
      } else {
        rejectTry(err); // a real error (permissions, etc.) — surface it
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveTry(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Start a transport server on the PREFERRED port, auto-falling-back to the next
 * free port (preferred, +1, +2, …, up to fallbackTries) if it is occupied.
 * Validates the token header, parses the JSON body, and dispatches by
 * message.type. Returns a handle whose `.port` is the RESOLVED bound port.
 */
export async function createTransportServer(
  opts: TransportServerOptions,
): Promise<TransportServer> {
  const token = opts.token ?? getToken();
  const host = opts.host ?? getHost();
  const tries = Math.max(1, opts.fallbackTries ?? PORT_FALLBACK_TRIES);
  const server = buildServer(token, opts.handlers);

  let bound = false;
  let lastPort = opts.port;
  for (let i = 0; i < tries; i++) {
    lastPort = opts.port + i;
    // eslint-disable-next-line no-await-in-loop
    if (await tryListen(server, lastPort, host)) {
      bound = true;
      break;
    }
  }
  if (!bound) {
    throw new Error(
      `transport: no free port in [${opts.port}, ${opts.port + tries - 1}] on ${host}`,
    );
  }

  const addr = server.address() as AddressInfo | null;
  const port = addr ? addr.port : lastPort;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((res, rej) =>
        server.close((e) => (e ? rej(e) : res())),
      ),
  };
}

/** Result of a client post. */
export interface PostResult {
  /** HTTP status code. */
  status: number;
  /** Parsed JSON response body, or null. */
  body: unknown;
  /** True for 2xx. */
  ok: boolean;
}

/** Options for the post client. */
export interface PostOptions {
  /** Shared token. Defaults to config token. */
  token?: string;
  /** Target host. Defaults to config host (127.0.0.1). */
  host?: string;
  /** Request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}

/**
 * POST a TransportMessage to a target port over the localhost transport.
 * Resolves with the response; rejects on network error or timeout.
 *
 * REQUEST CORRELATION lives in the payload, not here: messages that expect a
 * reply (intent) carry a `requestId` the responder echoes on its reply message
 * (intent_result). The transport itself is fire-and-forward; the hub matches
 * requestId -> pending promise. This POST's own response is just a transport ack.
 */
export function post(
  targetPort: number,
  message: TransportMessage,
  options: PostOptions = {},
): Promise<PostResult> {
  const token = options.token ?? getToken();
  const host = options.host ?? getHost();
  const timeoutMs = options.timeoutMs ?? 5000;
  const payload = JSON.stringify(message);

  return new Promise<PostResult>((resolvePost, rejectPost) => {
    const req = http.request(
      {
        host,
        port: targetPort,
        path: TRANSPORT_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          [TOKEN_HEADER]: token,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const status = res.statusCode ?? 0;
          resolvePost({ status, body, ok: status >= 200 && status < 300 });
        });
      },
    );
    req.on("error", rejectPost);
    req.on("timeout", () => {
      req.destroy(new Error(`post to ${host}:${targetPort} timed out after ${timeoutMs}ms`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Convenience: POST a message to the hub at the given port. Pass the hub's
 * RESOLVED port (from the HUB_PORT spawn env) when known; otherwise this falls
 * back to the preferred port from config.
 */
export function postToHub(
  message: TransportMessage,
  options: PostOptions & { port?: number } = {},
): Promise<PostResult> {
  const { port, ...rest } = options;
  return post(port ?? getPort("hub"), message, rest);
}

/**
 * Convenience: POST a message to a spoke. Pass the spoke's RESOLVED port (learned
 * from its register message) when known; otherwise falls back to the preferred
 * port from config.
 */
export function postToSpoke(
  role: SpokeRole,
  message: TransportMessage,
  options: PostOptions & { port?: number } = {},
): Promise<PostResult> {
  const { port, ...rest } = options;
  return post(port ?? getPort(role), message, rest);
}

/** Convenience: POST to any role by name (preferred config port). */
export function postToRole(
  role: Role,
  message: TransportMessage,
  options: PostOptions & { port?: number } = {},
): Promise<PostResult> {
  const { port, ...rest } = options;
  return post(port ?? getPort(role), message, rest);
}
