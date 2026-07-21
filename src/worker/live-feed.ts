import { DurableObject } from "cloudflare:workers"
import { Effect, Schema } from "effect"

import { LiveUpdateEventSchema } from "./domain"

const MAX_CONNECTIONS = 1_000
const MAX_CONNECTIONS_PER_IP = 8

const attachmentConnectionKey = (input: unknown): string | null => {
  if (
    typeof input === "object" &&
    input !== null &&
    "connectionKey" in input &&
    typeof input.connectionKey === "string"
  ) {
    return input.connectionKey
  }
  return null
}

const connectionKeyFor = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export class LiveFeed extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")
    const localRequest = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (
      (!localRequest && origin === null) ||
      (origin !== null && (!URL.canParse(origin) || new URL(origin).host !== url.host))
    ) {
      return new Response("Origin not allowed", { status: 403 })
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
    const sockets = this.ctx.getWebSockets()
    if (sockets.length >= MAX_CONNECTIONS) {
      return new Response("Live feed is at capacity", { status: 503 })
    }

    const clientAddress = request.headers.get("cf-connecting-ip") ?? `local:${url.hostname}`
    const connectionKey = await connectionKeyFor(clientAddress)
    const connectionsForClient = sockets.reduce(
      (count, socket) =>
        count + (attachmentConnectionKey(socket.deserializeAttachment()) === connectionKey ? 1 : 0),
      0
    )
    if (connectionsForClient >= MAX_CONNECTIONS_PER_IP) {
      return new Response("Too many live connections", { status: 429 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.serializeAttachment({ connectionKey })
    this.ctx.acceptWebSocket(server)

    return new Response(null, {
      status: 101,
      webSocket: client
    })
  }

  async broadcast(wireMessage: string): Promise<number> {
    const update = await Effect.runPromise(
      Effect.try({
        try: (): unknown => JSON.parse(wireMessage),
        catch: (cause) => cause
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(LiveUpdateEventSchema))
      )
    )
    const outgoingMessage = JSON.stringify(update)
    let delivered = 0

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(outgoingMessage)
        delivered += 1
      } catch {
        socket.close(1011, "Broadcast failed")
      }
    }

    return delivered
  }

  webSocketMessage(socket: WebSocket, _message: ArrayBuffer | string): void {
    socket.close(1008, "Client messages are not supported")
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason)
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error")
  }
}
