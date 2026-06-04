import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryAvailable, runCommand } from "./process.mjs";

const SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID";
// Plugin root (…/plugins/copilot) is two levels up from scripts/lib/.
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SDK_PACKAGE = "@github/copilot-sdk@^0.3.0";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const TASK_SESSION_PREFIX = "Copilot Companion Task";

let _client = null;

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function isModuleNotFound(err) {
  return (
    err?.code === "ERR_MODULE_NOT_FOUND" ||
    /Cannot find package '@github\/copilot-sdk'/.test(String(err?.message ?? ""))
  );
}

function provisionSdk() {
  // Claude Code does not npm-install plugin dependencies, so the SDK is absent
  // after a fresh install/update and on new machines. Install it into the plugin
  // root on demand. npm resolves the correct per-OS Copilot binary, so this works
  // cross-platform (unlike vendoring node_modules into git).
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["install", SDK_PACKAGE, "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: PLUGIN_ROOT, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to provision ${SDK_PACKAGE}. Run \`npm install ${SDK_PACKAGE}\` in ${PLUGIN_ROOT}, then retry.`
    );
  }
}

async function getCopilotClient() {
  // Lazy import; self-heal the dependency if the plugin dir has no node_modules yet.
  try {
    const { CopilotClient } = await import("@github/copilot-sdk");
    return CopilotClient;
  } catch (err) {
    if (!isModuleNotFound(err)) throw err;
    process.stderr.write("Provisioning @github/copilot-sdk (one-time, this may take a moment)...\n");
    provisionSdk();
    const { CopilotClient } = await import("@github/copilot-sdk");
    return CopilotClient;
  }
}

export async function ensureClient() {
  if (!_client) {
    const CopilotClient = await getCopilotClient();
    _client = new CopilotClient();
    await _client.start();
  }
  return _client;
}

export async function shutdownClient() {
  if (_client) {
    await _client.stop();
    _client = null;
  }
}

export async function createSession(options = {}) {
  const client = await ensureClient();
  return client.createSession({
    model: options.model || undefined,
    streaming: true,
    sessionId: options.sessionId || undefined,
    systemMessage: options.systemMessage || undefined,
    tools: options.tools || undefined,
    onPermissionRequest: async () => ({ kind: "approved" }),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {})
  });
}

export async function runPrompt(session, prompt, options = {}) {
  const { onProgress } = options;
  const chunks = [];
  const reasoning = [];

  session.on((event) => {
    const eventType = event.type?.value ?? event.type;
    switch (eventType) {
      case "assistant.message_delta":
        chunks.push(event.data.deltaContent || "");
        onProgress?.({
          message: `Streaming response...`,
          phase: "running",
          stderrMessage: null,
          logTitle: null,
          logBody: null
        });
        break;
      case "assistant.reasoning_delta":
        reasoning.push(event.data.deltaContent || "");
        break;
      case "tool.execution_start":
        onProgress?.({
          message: `Running tool: ${event.data.toolName}.`,
          phase: "investigating",
          stderrMessage: `Running tool: ${event.data.toolName}`,
          logTitle: null,
          logBody: null
        });
        break;
      case "tool.execution_complete": {
        const status = event.data.success ? "completed" : "failed";
        onProgress?.({
          message: `Tool ${event.data.toolName} ${status}.`,
          phase: "running",
          stderrMessage: `Tool ${event.data.toolName} ${status}`,
          logTitle: null,
          logBody: null
        });
        break;
      }
      case "session.idle":
        onProgress?.({
          message: "Turn completed.",
          phase: "finalizing",
          stderrMessage: null,
          logTitle: null,
          logBody: null
        });
        break;
      default:
        break;
    }
  });

  // sendAndWait's default idle timeout is only 60s; agentic reviews/tasks (which
  // use tools, web fetches, etc.) routinely run longer and would otherwise abort
  // with "Timeout after 60000ms waiting for session.idle". Use a generous,
  // overridable timeout instead.
  const idleTimeoutMs = Number(process.env.COPILOT_COMPANION_IDLE_TIMEOUT_MS) || 600000;
  const response = await session.sendAndWait({ prompt }, idleTimeoutMs);
  const content = response?.data?.content ?? chunks.join("");

  return {
    content,
    reasoning: reasoning.join(""),
    sessionId: session.config?.sessionId ?? null
  };
}

export async function abortSession(session) {
  await session.abort();
}

export function getCopilotAvailability(cwd) {
  return binaryAvailable("copilot", ["--version"], { cwd });
}

export function getSessionRuntimeStatus(env = process.env) {
  return {
    mode: "sdk",
    label: "SDK managed",
    detail: "Copilot CLI process managed by @github/copilot-sdk."
  };
}

export function getCopilotLoginStatus(cwd) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }
  return { available: true, loggedIn: true, detail: "assumed authenticated" };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Copilot did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }
  try {
    return { parsed: JSON.parse(rawOutput), parseError: null, rawOutput, ...fallback };
  } catch (error) {
    return { parsed: null, parseError: error.message, rawOutput, ...fallback };
  }
}

export function buildPersistentTaskSessionId(prompt) {
  const excerpt = shorten(prompt, 56);
  const slug = excerpt
    ? excerpt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  const prefix = TASK_SESSION_PREFIX.toLowerCase().replace(/\s+/g, "-");
  return slug ? `${prefix}-${slug}` : prefix;
}

export { DEFAULT_CONTINUE_PROMPT, TASK_SESSION_PREFIX, SESSION_ID_ENV };
