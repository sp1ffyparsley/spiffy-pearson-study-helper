import {
  BRIDGE_PORTS,
  EXTENSION_VERSION,
  STUDY_HELPER_PROTOCOL,
  type StudyImage,
} from "../shared/protocol";

interface BridgeState {
  port: number;
  token: string;
}

interface BridgeHello {
  app?: string;
  compatible?: boolean;
  studyHelperProtocol?: number;
}

interface BridgeReply {
  response?: string;
  conversationId?: string | null;
  error?: string;
}

const STORAGE_KEY = "studyBridge.v1";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

function headers(token?: string): HeadersInit {
  const value: Record<string, string> = {
    "content-type": "application/json",
    "x-extension-version": EXTENSION_VERSION,
    "x-extension-protocol": String(STUDY_HELPER_PROTOCOL),
  };
  if (token) value.authorization = `Bearer ${token}`;
  return value;
}

async function hello(port: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/study-helper/hello`, {
      method: "GET",
      headers: headers(),
    }, 900);
    if (!response.ok) return false;
    const body = await response.json() as BridgeHello;
    return body.app === "chat-on-steroids" && body.compatible === true && body.studyHelperProtocol === STUDY_HELPER_PROTOCOL;
  } catch {
    return false;
  }
}

async function discoverPort(preferred?: number): Promise<number> {
  if (preferred && BRIDGE_PORTS.includes(preferred as (typeof BRIDGE_PORTS)[number]) && await hello(preferred)) return preferred;
  const probes = await Promise.all(BRIDGE_PORTS.map(async (port) => ({ port, ok: await hello(port) })));
  const found = probes.find((probe) => probe.ok)?.port;
  if (!found) {
    console.warn("[Spiffy Pearson] bridge.unavailable", { ports: BRIDGE_PORTS });
    throw new Error("Chat On Steroids study bridge is unavailable. Build/restart Chat On Steroids with the Pearson study bridge enabled, then try again.");
  }
  console.debug("[Spiffy Pearson] bridge.port", { port: found });
  return found;
}

async function readStoredState(): Promise<BridgeState | null> {
  const raw = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Partial<BridgeState> | undefined;
  return raw && Number.isInteger(raw.port) && typeof raw.token === "string" && raw.token.length >= 20
    ? { port: raw.port as number, token: raw.token }
    : null;
}

async function pair(port: number): Promise<BridgeState> {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/study-helper/pair`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ client: "spiffy-pearson-study-helper" }),
  }, 3000);
  const body = await response.json().catch(() => ({})) as { token?: string; error?: string };
  if (!response.ok || typeof body.token !== "string") throw new Error(body.error || `Chat On Steroids pairing failed (${response.status}).`);
  const state = { port, token: body.token };
  console.debug("[Spiffy Pearson] bridge.paired", { port });
  await browser.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

async function ensureBridge(forcePair = false): Promise<BridgeState> {
  const stored = await readStoredState();
  const port = await discoverPort(stored?.port);
  if (!forcePair && stored?.port === port && stored.token) return stored;
  return pair(port);
}

export async function askStudyBridge(input: {
  sessionKey: string;
  prompt: string;
  images: StudyImage[];
  freshChat?: boolean;
}): Promise<{ response: string; conversationId: string | null }> {
  console.debug("[Spiffy Pearson] bridge.ask.start", {
    imageCount: input.images.length,
    promptChars: input.prompt.length,
  });
  let state = await ensureBridge(false);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(`http://127.0.0.1:${state.port}/study-helper/ask`, {
      method: "POST",
      headers: headers(state.token),
      body: JSON.stringify(input),
    }, 185_000);
    const body = await response.json().catch(() => ({})) as BridgeReply;
    if (response.status === 401 && attempt === 0) {
      state = await ensureBridge(true);
      continue;
    }
    if (!response.ok || typeof body.response !== "string") {
      const friendly: Record<string, string> = {
        chatgpt_busy: "ChatGPT is already handling another helper request. Try again when that response finishes.",
        chatgpt_rate_limited: "ChatGPT temporarily rate-limited helper requests. Try again shortly.",
        chatgpt_timeout: "ChatGPT did not finish this screenshot request before the local timeout.",
        chatgpt_send_unconfirmed: "ChatGPT may have received the request, but delivery could not be confirmed. Check the helper chat before retrying.",
      };
      const code = typeof body.error === "string" && /^[a-z0-9._-]{1,64}$/.test(body.error)
        ? body.error
        : "bridge_error";
      console.error("[Spiffy Pearson] bridge.ask.failed", { status: response.status, code });
      throw new Error(friendly[body.error || ""] || body.error || `Chat On Steroids request failed (${response.status}).`);
    }
    console.debug("[Spiffy Pearson] bridge.ask.complete", { responseChars: body.response.length });
    return { response: body.response, conversationId: typeof body.conversationId === "string" ? body.conversationId : null };
  }
  throw new Error("Chat On Steroids pairing could not be repaired.");
}
