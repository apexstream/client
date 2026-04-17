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

You bring your own **gateway URL** and **API key** (from the ApexStream dashboard for that deployment). The SDK does **not** read `.env` files; wire values from `import.meta.env` (Vite), `process.env` (Node), or your host’s secret store.

**Keys:** use the **publishable** key (`pk_live_…`) in browser code. The **secret** key (`sk_live_…`) also works for the WebSocket, but the string is added to the URL as `api_key=…` — treat it as sensitive and avoid shipping it in public frontends.

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

- **`url`** — WebSocket URL of the gateway, ending with **`/v1/ws`** (single slash before `v1`), **without** query string — e.g. `wss://gateway.example.com/v1/ws` or `ws://192.168.1.10:30081/v1/ws`. The client appends **`api_key=…`** for the browser `WebSocket` handshake.
- **`apiKey`** — dashboard **publishable** (`pk_live_…`) or **secret** (`sk_live_…`) for that app/environment.
- **`allowInsecureTransport`** (optional) — set **`true`** when using **`ws://`** to anything other than **localhost / 127.0.0.1** (typical LAN or k8s NodePort). Omit or **`false`** when using **`wss://`** in production.

The SDK **does not** load `.env` by itself. Exposed names depend on your bundler (**`VITE_`** = Vite only; **`REACT_APP_`** = CRA; **`NEXT_PUBLIC_`** = Next.js client; plain **`process.env`** in Node). See **`.env.example`** in this package for commented variable names.

### Browser `Origin` and the gateway

The browser sends an **`Origin`** header (e.g. `http://localhost:5173`) that must be allowed by your **gateway** deployment. Self‑hosted gateways support **`APEXSTREAM_GATEWAY_ALLOW_ORIGINS`** (comma‑separated full origins, or `*` for debugging only). If the SPA runs at **`http://localhost:5173`** but the WebSocket host is a **LAN IP** or NodePort, those origins differ — configure the gateway accordingly (see your ApexStream / k8s docs).

### DevTools noise

After **reconnect** or **React Strict Mode**, Chrome may still print a red **“WebSocket … failed”** line for an **old** socket while the **current** connection succeeds — check **Network → WS** for status **101** and incoming frames.

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
