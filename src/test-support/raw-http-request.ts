import net from "node:net";

export type RawHttpResult = {
  statusLine: string;
  body: string;
  closedByServer: boolean;
};

function decodeChunkedBody(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(raw.toString("latin1", offset, lineEnd).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export async function postRawWebhook(params: {
  url: string;
  body: string;
  headers?: Record<string, string>;
  contentLength?: number;
  idleTimeoutMs?: number;
}): Promise<RawHttpResult> {
  const target = new URL(params.url);
  const port = Number(target.port);
  const payload = Buffer.from(params.body, "utf8");
  const headerLines = Object.entries(params.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head =
    `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.hostname}:${port}\r\n` +
    headerLines +
    `Content-Length: ${params.contentLength ?? payload.length}\r\n\r\n`;

  return await new Promise<RawHttpResult>((resolve) => {
    const socket = net.connect(port, target.hostname);
    const received: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (closedByServer: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      const raw = Buffer.concat(received);
      const headerEnd = raw.indexOf("\r\n\r\n", 0, "latin1");
      const headBlock =
        headerEnd === -1 ? raw.toString("latin1") : raw.toString("latin1", 0, headerEnd);
      const rawBody = headerEnd === -1 ? Buffer.alloc(0) : raw.subarray(headerEnd + 4);
      resolve({
        statusLine: (headBlock.split("\r\n")[0] ?? "").trim(),
        body: (/transfer-encoding:\s*chunked/iu.test(headBlock)
          ? decodeChunkedBody(rawBody)
          : rawBody
        ).toString("utf8"),
        closedByServer,
      });
    };

    socket.on("connect", () => {
      socket.write(head);
      socket.write(payload);
      timer = setTimeout(() => settle(false), params.idleTimeoutMs ?? 2_000);
      timer.unref?.();
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => settle(true));
  });
}
