# apexstream

Official **JavaScript / TypeScript** SDK for **[ApexStream](https://github.com/apexstream)** — connect your app to the realtime **WebSocket gateway**, subscribe to named channels, and publish JSON payloads. Designed for browser apps and **Node.js 18+** (uses the native `WebSocket` API).

| | |
|---|---|
| **Repository** | [`github.com/apexstream/client`](https://github.com/apexstream/client) |
| **Issues** | [github.com/apexstream/client/issues](https://github.com/apexstream/client/issues) |

## Description

**ApexStream** is a WebSocket-centric platform: a control-plane API issues app keys, and a **gateway** exposes `GET /v1/ws` for authenticated clients. This package implements a small **`ApexStreamClient`** that:

- opens a **WebSocket** to your gateway URL (typically `wss://…/v1/ws` in production);
- sends **subscribe** / **unsubscribe** / **publish** messages as JSON text frames;
- delivers **message** events to your handlers per channel.

You bring your own **gateway URL** and **API key** (created in the ApexStream dashboard for that deployment). The SDK does **not** read `.env` files; wire values from `import.meta.env` (Vite), `process.env` (Node), or your host’s secret store.

**MIT licensed.**

## Features

- **Subscribe / publish** on named channels with per-channel callbacks  
- **Connection lifecycle** hooks: `open`, `close`, `error`, `message`  
- **Secure by default** for non-localhost hosts: requires `wss://` outside localhost  
- **ESM + CJS** builds and TypeScript typings included  

## Install

```bash
npm install apexstream
```

## Configuration

You must pass:

- **`url`** — WebSocket URL of the gateway, ending with **`/v1/ws`**, without query (e.g. `wss://your-domain/v1/ws` or `ws://127.0.0.1:8081/v1/ws`). The client appends `api_key=…` for the browser `WebSocket` handshake.
- **`apiKey`** — from the dashboard for that deployment.
- **`allowInsecureTransport`** (optional) — set `true` for **`ws://` to a LAN IP** in dev; production should use **`wss://`**.

The SDK **does not** load `.env` by itself. Exposed names depend on your bundler (**`VITE_`** = Vite only; **`REACT_APP_`** = CRA; **`NEXT_PUBLIC_`** = Next.js client; plain **`process.env`** in Node). See **`.env.example`** in this package for commented variable names.

## Usage

```ts
import { ApexStreamClient } from "apexstream";

const client = new ApexStreamClient({
  url: "wss://your-gateway.example.com/v1/ws",
  apiKey: "<secret or publishable key from dashboard>",
});

client.on("open", () => console.log("connected"));
client.on("close", (ev) => console.log("closed", ev.code, ev.reason));
client.on("error", (ev) => console.error("socket error", ev));
client.on("message", (data) => console.log("raw frame", data));

const unsubscribe = client.subscribe("orders", (payload) => {
  console.log("orders event", payload);
});

client.connect();

// After the socket is open:
client.publish("orders", { kind: "placed", id: "ord_123" });

// Later:
unsubscribe();
client.disconnect();
```

## Wire format (draft)

Messages are JSON text frames.

**Client → server**

- Subscribe: `{ "type": "subscribe", "channel": "orders" }`
- Unsubscribe: `{ "type": "unsubscribe", "channel": "orders" }`
- Publish: `{ "type": "publish", "channel": "orders", "payload": { ... } }`

**Server → client**

- Delivery: `{ "type": "message", "channel": "orders", "payload": { ... } }`

The gateway authenticates the socket using **`api_key` on the WebSocket URL** (see **Configuration** above). Do not log the full URL after connect in production; use **`wss://`** outside localhost.

## Build from source

In **[apexstream/client](https://github.com/apexstream/client)** (this package at the repo root):

```bash
npm install
npm run build
```

## License

MIT
