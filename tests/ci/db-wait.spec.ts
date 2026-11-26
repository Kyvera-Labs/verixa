import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { postgresAnswers as answers } from "../../scripts/db-wait.mjs";

const servers: Server[] = [];
const sockets: Socket[] = [];

async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    onConnection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  // server.close() waits for open connections, so end them first.
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("db-wait: postgresAnswers", () => {
  it("is ready when the server answers the SSLRequest like Postgres does", async () => {
    const port = await listen((socket) => {
      socket.once("data", (request) => {
        // The 8-byte SSLRequest: length 8, code 80877103.
        expect([...request]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
        socket.end("N");
      });
    });

    await expect(answers("127.0.0.1", port)).resolves.toBe(true);
  });

  it("is not ready when something accepts the connection but hangs up (Docker's port proxy before Postgres listens)", async () => {
    const port = await listen((socket) => socket.end());

    await expect(answers("127.0.0.1", port)).resolves.toBe(false);
  });

  it("is not ready when the listener never replies", async () => {
    const port = await listen(() => undefined);

    await expect(answers("127.0.0.1", port, 200)).resolves.toBe(false);
  });

  it("is not ready when nothing listens on the port", async () => {
    const port = await listen(() => undefined);
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    await expect(answers("127.0.0.1", port)).resolves.toBe(false);
  });
});
