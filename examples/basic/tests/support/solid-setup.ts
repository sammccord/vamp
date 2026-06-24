import { WebSocket } from "undici";

// jsdom ships a `WebSocket` backed by `ws`, which resolves to its throwing browser
// build under the jsdom "browser" condition ("ws does not work in the browser").
// Force undici's WHATWG `WebSocket` — the same implementation Node exposes globally
// and that the node-environment rpc.test.ts uses — which works here and provides
// the API surface TempoWSChannel/websocket-ts needs (addEventListener, binaryType,
// readyState, send, close). Override unconditionally (jsdom already set one).
(globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
