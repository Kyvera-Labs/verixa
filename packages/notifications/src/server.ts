import http from "node:http";

import { Result } from "@verixa/shared-kernel";

import {
  InMemoryNotificationDispatcher,
  NotificationService,
  type SendNotificationInput,
} from "./types.js";

const PORT = Number.parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const dispatcher = new InMemoryNotificationDispatcher();
const notificationService = new NotificationService(dispatcher);

export function createNotificationsServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "notifications" }));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/send" || url.pathname === "/notifications")) {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || "{}") as SendNotificationInput;
            const result = await notificationService.send(parsed);

            if (Result.isOk(result)) {
              res.writeHead(202, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, receipt: result.value }));
            } else {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: result.error.message }));
            }
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Invalid JSON payload" }));
          }
        })();
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });
}

export function startServer(): http.Server {
  const server = createNotificationsServer();

  server.listen(PORT, HOST, () => {
    console.log(`[notifications] standalone service listening on ${HOST}:${PORT}`);
  });

  const shutdown = () => {
    console.log("[notifications] shutting down service gracefully...");
    server.close(() => {
      console.log("[notifications] service stopped.");
      process.exit(0);
    });

    setTimeout(() => {
      console.error("[notifications] forced exit after timeout.");
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}

const argv1 = process.argv[1];
const isMain =
  argv1 !== undefined &&
  (import.meta.url.endsWith(argv1.replace(/\\/g, "/")) ||
    argv1.endsWith("server.js") ||
    argv1.endsWith("server.ts"));

if (process.env.NODE_ENV !== "test" && isMain) {
  startServer();
}
