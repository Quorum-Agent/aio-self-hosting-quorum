import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path";

import { z } from "zod";

import { safeDisplayText, type LocalRuntimeProblem } from "@quorum/core";

import type { AppConfig, ManagedLlamaConfig } from "./config.js";

const modelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/,
    "Model IDs may contain letters, numbers, dot, underscore, colon, slash, plus, and hyphen.",
  );
const managedModelSchema = z.object({
  id: modelIdSchema,
  file: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  contextWindow: z.number().int().min(512).max(1_048_576),
  gpuLayers: z.number().int().min(0).max(999).default(999),
  loadOnStartup: z.boolean().default(false),
});
const managedManifestSchema = z.object({
  version: z.literal(1),
  models: z.array(managedModelSchema).min(1).max(64),
});
const routerModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      status: z
        .object({
          value: z.string(),
          failed: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
});

export interface ManagedLlamaModel {
  id: string;
  file: string;
  sha256?: string;
  contextWindow: number;
  gpuLayers: number;
  loadOnStartup: boolean;
}

export interface ManagedLlamaManifest {
  version: 1;
  models: ManagedLlamaModel[];
}

export interface ManagedLlamaRuntime {
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  /**
   * The context window each model was actually started with, by model ID.
   *
   * The manifest renders `contextWindow` into the preset as `ctx-size`, so this
   * is the server's real configuration rather than an assumption about it.
   * Without exposing it, `withManagedLlamaEndpoint` could only swap the
   * endpoint, leaving `config.local.models[].contextWindow` on whatever
   * `QUORUM_LOCAL_CONTEXT_WINDOW` said — and `fitConversationToContext` would
   * then pack input against a window the server does not have.
   */
  contextWindows: ReadonlyMap<string, number>;
  pid: number;
  stop(): Promise<void>;
}

interface ManagedLlamaProcess {
  child: ChildProcess;
  sessionDirectory: string;
  apiKeyFile: string;
  presetFile: string;
}

const STARTUP_POLL_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;
const LOG_TAIL_LIMIT = 16 * 1024;

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function verifyGgufFile(model: ManagedLlamaModel): Promise<void> {
  const metadata = await stat(model.file);
  if (!metadata.isFile()) {
    throw new ManagedLlamaStartupError(
      "manifest_invalid",
      `Managed model ${model.id} does not reference a file.`,
    );
  }
  const handle = await open(model.file, "r");
  try {
    const magic = Buffer.alloc(4);
    const result = await handle.read(magic, 0, magic.length, 0);
    if (
      result.bytesRead !== magic.length ||
      magic.toString("ascii") !== "GGUF"
    ) {
      throw new ManagedLlamaStartupError(
        "manifest_invalid",
        `Managed model ${model.id} is not a GGUF file.`,
      );
    }
  } finally {
    await handle.close();
  }
  if (model.sha256) {
    const actual = await sha256File(model.file);
    if (actual !== model.sha256.toLowerCase()) {
      throw new ManagedLlamaStartupError(
        "manifest_invalid",
        `Managed model ${model.id} failed SHA-256 verification.`,
      );
    }
  }
}

export async function loadManagedLlamaManifest(
  manifestPath: string,
): Promise<ManagedLlamaManifest> {
  const absoluteManifestPath = resolve(manifestPath);
  const parsed = managedManifestSchema.parse(
    JSON.parse(await readFile(absoluteManifestPath, "utf8")),
  );
  const manifestDirectory = dirname(absoluteManifestPath);
  const seen = new Set<string>();
  const models: ManagedLlamaModel[] = [];

  for (const configured of parsed.models) {
    if (seen.has(configured.id)) {
      throw new ManagedLlamaStartupError(
        "manifest_invalid",
        `Managed model ID ${configured.id} is duplicated.`,
      );
    }
    seen.add(configured.id);
    const file = isAbsolute(configured.file)
      ? configured.file
      : resolve(manifestDirectory, configured.file);
    if (/[\r\n]/.test(file)) {
      throw new ManagedLlamaStartupError(
        "manifest_invalid",
        `Managed model ${configured.id} has an invalid path.`,
      );
    }
    const model: ManagedLlamaModel = {
      id: configured.id,
      file,
      contextWindow: configured.contextWindow,
      gpuLayers: configured.gpuLayers,
      loadOnStartup: configured.loadOnStartup,
      ...(configured.sha256
        ? { sha256: configured.sha256.toLowerCase() }
        : {}),
    };
    await verifyGgufFile(model);
    models.push(model);
  }

  return { version: 1, models };
}

export function renderManagedLlamaPreset(
  manifest: ManagedLlamaManifest,
): string {
  const lines = ["version = 1", ""];
  for (const model of manifest.models) {
    lines.push(
      `[${model.id}]`,
      `model = ${model.file}`,
      `ctx-size = ${model.contextWindow}`,
      `n-gpu-layers = ${model.gpuLayers}`,
      "jinja = true",
      `load-on-startup = ${model.loadOnStartup ? "true" : "false"}`,
      "",
    );
  }
  return lines.join("\n");
}

export function buildManagedLlamaArguments(options: {
  port: number;
  apiKeyFile: string;
  presetFile: string;
}): string[] {
  return [
    "--host",
    "127.0.0.1",
    "--port",
    String(options.port),
    "--api-key-file",
    options.apiKeyFile,
    "--models-preset",
    options.presetFile,
    "--no-models-autoload",
    "--no-webui",
    "--cors-origins",
    "http://127.0.0.1",
    "--no-cors-credentials",
  ];
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new ManagedLlamaStartupError(
      "port_unavailable",
      "Could not reserve a loopback port for llama.cpp.",
    );
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

async function cleanupSessionFiles(process: {
  sessionDirectory: string;
  apiKeyFile: string;
  presetFile: string;
}): Promise<void> {
  await unlink(process.apiKeyFile).catch(() => {});
  await unlink(process.presetFile).catch(() => {});
  await rmdir(process.sessionDirectory).catch(() => {});
}

async function stopProcess(managedProcess: ManagedLlamaProcess): Promise<void> {
  if (managedProcess.child.exitCode === null) {
    managedProcess.child.kill();
    if (!(await waitForExit(managedProcess.child, SHUTDOWN_GRACE_MS))) {
      managedProcess.child.kill("SIGKILL");
      await waitForExit(managedProcess.child, SHUTDOWN_GRACE_MS);
    }
  }
  await cleanupSessionFiles(managedProcess);
}

function appendLogTail(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-LOG_TAIL_LIMIT);
}

async function waitUntilReady(options: {
  child: ChildProcess;
  baseUrl: string;
  apiKey: string;
  manifest: ManagedLlamaManifest;
  timeoutMs: number;
  getLogTail(): string;
  getSpawnError(): Error | undefined;
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const expectedIds = new Set(
    options.manifest.models.map((model) => model.id.toLowerCase()),
  );
  const startupIds = new Set(
    options.manifest.models
      .filter((model) => model.loadOnStartup)
      .map((model) => model.id.toLowerCase()),
  );

  while (Date.now() < deadline) {
    const spawnError = options.getSpawnError();
    if (spawnError) throw spawnError;
    if (options.child.exitCode !== null) {
      throw new ManagedLlamaStartupError(
        "runtime_exited",
        `Managed llama.cpp exited with code ${options.child.exitCode}. ${options.getLogTail()}`.trim(),
      );
    }
    try {
      const requestTimeoutMs = Math.max(
        1,
        Math.min(1_000, deadline - Date.now()),
      );
      const health = await fetch(`${options.baseUrl.replace(/\/v1$/, "")}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const catalog = await fetch(
        `${options.baseUrl.replace(/\/v1$/, "")}/models`,
        {
          headers: { authorization: `Bearer ${options.apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(requestTimeoutMs),
        },
      );
      if (health.ok && catalog.ok) {
        const parsed = routerModelsSchema.parse(await catalog.json());
        const byId = new Map(
          parsed.data.map((entry) => [entry.id.toLowerCase(), entry]),
        );
        const catalogReady = [...expectedIds].every((id) => byId.has(id));
        const startupReady = [...startupIds].every(
          (id) => byId.get(id)?.status?.value === "loaded",
        );
        const startupFailed = [...startupIds].find(
          (id) => byId.get(id)?.status?.failed === true,
        );
        if (startupFailed) {
          throw new ManagedLlamaStartupError(
            "artifact_rejected",
            `Managed model ${startupFailed} failed during startup. ${options.getLogTail()}`.trim(),
          );
        }
        if (catalogReady && startupReady) return;
      }
    } catch (error) {
      if (error instanceof ManagedLlamaStartupError) {
        throw error;
      }
    }
    await delay(STARTUP_POLL_MS);
  }

  throw new ManagedLlamaStartupError(
    "not_ready",
    `Managed llama.cpp did not become ready within ${options.timeoutMs}ms. ${options.getLogTail()}`.trim(),
  );
}

export function withManagedLlamaEndpoint(
  config: AppConfig,
  runtime: Pick<
    ManagedLlamaRuntime,
    "baseUrl" | "apiKey" | "modelIds" | "contextWindows"
  >,
): AppConfig {
  const requiredModels = [
    config.local.promptAnalyzer.name,
    ...config.local.models.map((model) => model.name),
  ];
  const missing = requiredModels.filter(
    (model) => !runtime.modelIds.includes(model),
  );
  if (missing.length > 0) {
    throw new ManagedLlamaStartupError(
      "configuration_mismatch",
      `Managed llama.cpp manifest is missing configured model IDs: ${missing.join(", ")}.`,
    );
  }
  // The manifest wins, and it is not a tie being broken arbitrarily: the
  // manifest's contextWindow was rendered into the preset as `ctx-size`, so it
  // describes what the server is actually running, while
  // QUORUM_LOCAL_CONTEXT_WINDOW only describes what Quorum would otherwise
  // assume. Leaving the assumption in place lets fitConversationToContext pack
  // input against a window that does not exist — the server then either
  // rejects the request or silently shifts context, and it surfaces as a
  // provider fault rather than a misconfiguration.
  //
  // This does not throw on disagreement the way the model-ID check above does.
  // The default of 16,384 is a value nobody chose, so a manifest specifying
  // anything else would fail startup for every user who never touched the
  // setting.
  const reconcile = (name: string, declared: number): number =>
    runtime.contextWindows.get(name) ?? declared;

  return {
    ...config,
    local: {
      ...config.local,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      transport: "openai-compatible",
      models: config.local.models.map((model) => ({
        ...model,
        contextWindow: reconcile(model.name, model.contextWindow),
      })),
      promptAnalyzer: {
        ...config.local.promptAnalyzer,
        contextWindow: reconcile(
          config.local.promptAnalyzer.name,
          config.local.promptAnalyzer.contextWindow,
        ),
      },
    },
  };
}

/**
 * Starts the managed runtime if configured, and degrades instead of dying.
 *
 * Before this, the two local runtimes failed asymmetrically: an absent Ollama
 * leaves the app usable on the scaffold responder, while any managed-runtime
 * problem — missing manifest, deleted model file, digest mismatch, a model that
 * fails to load, startup timeout — threw out of `index.ts` into
 * `process.exit(1)`. A misconfigured optional runtime took down the whole API,
 * which on its own disqualifies it from being the default.
 *
 * Degrading is safe rather than merely convenient. Falling through leaves the
 * configured model names (`quorum-main`, `quorum-prompt`) pointed at whatever
 * `QUORUM_LOCAL_BASE_URL` is, which will not have them, so discovery finds
 * nothing and the runtime reports itself unavailable — the same state as no
 * Ollama. It cannot silently answer from an unintended model.
 */
/**
 * What kind of startup failure this was.
 *
 * Carried on the error rather than recovered from its text. An earlier version
 * of this file gave every failure the same user-facing sentence — "the managed
 * llama.cpp runtime did not start" — which is equally true of a missing binary,
 * a busy port, a readiness timeout and a model file the build cannot parse, and
 * therefore tells an operator nothing about which one they have.
 *
 * The reason it was left that way was a rule about not pattern-matching another
 * project's log output, which is sound and was over-applied: classifying on
 * failures *this codebase raises itself* is not the same as reading llama.cpp's
 * error text, and a tag is not a regex. The raw output still travels verbatim
 * in `detail`; this only decides which sentence sits above it.
 */
export type ManagedLlamaFailureKind =
  | "executable_missing"
  | "manifest_invalid"
  | "configuration_mismatch"
  | "artifact_rejected"
  | "runtime_exited"
  | "not_ready"
  | "port_unavailable";

export class ManagedLlamaStartupError extends Error {
  readonly kind: ManagedLlamaFailureKind;

  constructor(kind: ManagedLlamaFailureKind, message: string) {
    super(message);
    this.name = "ManagedLlamaStartupError";
    this.kind = kind;
  }
}

const FAILURE_SUMMARIES: Record<ManagedLlamaFailureKind, string> = {
  executable_missing:
    "Quorum could not find a llama.cpp server to run, so no local model is being served.",
  manifest_invalid:
    "A model file named by the manifest could not be used, so no local model is being served.",
  configuration_mismatch:
    "The configured model names do not match any the manifest declares, so no local model is being served.",
  // The one the compatibility gate exists for, and the reason a taxonomy is
  // worth having: this failure needs a different action from every other one.
  artifact_rejected:
    "The llama.cpp build Quorum runs rejected a model file, so no local model is being served. The artifact and the runtime are not compatible — replace the file or change the runtime.",
  runtime_exited:
    "The llama.cpp server exited before it was ready, so no local model is being served.",
  not_ready:
    "The llama.cpp server did not become ready in time, so no local model is being served.",
  port_unavailable:
    "Quorum could not reserve a loopback port for llama.cpp, so no local model is being served.",
};

const UNCLASSIFIED_SUMMARY =
  "The managed llama.cpp runtime did not start, so no local model is being served.";

/**
 * The error's own words, without assuming it has any.
 *
 * Total over `unknown` because it is called on whatever the startup path threw,
 * during startup. `String(error)` is not safe on an arbitrary value — an object
 * with a null prototype throws on conversion, as does one whose `toString`
 * throws — and this function failing would turn a reported degradation into an
 * unreported crash.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  try {
    return String(error);
  } catch {
    return "";
  }
}

/**
 * Turn a managed-runtime startup failure into something the interface can show.
 *
 * Separate from `startManagedLlamaOrDegrade` so it can be tested. The wiring in
 * `index.ts` is a composition root with no test around it, so anything with a
 * decision in it — which text is shown, how it is bounded, what happens to a
 * non-`Error` throw — belongs here instead, leaving that file a call.
 *
 * The detail is the runtime's own words rather than a friendlier paraphrase.
 * For a rejected artifact `llama-server` exits and its last output is the
 * reason: *"error loading model hyperparameters: key
 * qwen35.rope.dimension_sections has wrong array length; expected 4, got 3"* —
 * verified against llama.cpp b10192. Matching on that text to say something
 * kinder would be a guess about another project's log format, and would break
 * quietly at their next release; the raw line is more use to whoever has to act
 * on it.
 */
export function managedLlamaProblem(error: unknown): LocalRuntimeProblem {
  const detail = safeDisplayText(errorText(error), 600);
  const summary =
    error instanceof ManagedLlamaStartupError
      ? FAILURE_SUMMARIES[error.kind]
      : UNCLASSIFIED_SUMMARY;
  return {
    summary,
    ...(detail ? { detail } : {}),
  };
}

export async function startManagedLlamaOrDegrade(
  config: AppConfig,
  onDegraded: (message: string, error: unknown) => void,
): Promise<{ config: AppConfig; runtime: ManagedLlamaRuntime | undefined }> {
  if (!config.managedLlama) return { config, runtime: undefined };
  let runtime: ManagedLlamaRuntime | undefined;
  try {
    runtime = await startManagedLlamaRuntime(
      config.managedLlama,
      config.dataDirectory,
    );
    return { config: withManagedLlamaEndpoint(config, runtime), runtime };
  } catch (error) {
    // Stop a process that started but failed a later gate, so a degraded
    // launch cannot leave a llama-server holding VRAM with nothing addressing
    // it.
    if (runtime) {
      try {
        await runtime.stop();
      } catch {
        // Already failing; a stop error must not mask the original cause.
      }
    }
    onDegraded(
      "The managed llama.cpp runtime did not start, so Quorum is running " +
        "without it. Check QUORUM_MANAGED_LLAMA_SERVER points at an existing " +
        "llama-server executable, QUORUM_MANAGED_LLAMA_MODELS points at a " +
        "readable manifest, every 'file' in that manifest exists and matches " +
        "its 'sha256' if one is given, and QUORUM_LOCAL_MODEL and " +
        "QUORUM_LOCAL_PROMPT_MODEL name IDs the manifest declares.",
      error,
    );
    return { config, runtime: undefined };
  }
}

export async function startManagedLlamaRuntime(
  config: ManagedLlamaConfig,
  dataDirectory: string,
): Promise<ManagedLlamaRuntime> {
  const executablePath = resolve(config.executablePath);
  const executable = await stat(executablePath);
  if (!executable.isFile()) {
    throw new ManagedLlamaStartupError(
      "executable_missing",
      "Managed llama.cpp executable path is not a file.",
    );
  }
  const manifest = await loadManagedLlamaManifest(config.manifestPath);
  const port = await reserveLoopbackPort();
  const apiKey = randomBytes(32).toString("base64url");
  const sessionId = randomBytes(12).toString("hex");
  const sessionDirectory = resolve(
    dataDirectory,
    "runtime",
    "llama.cpp",
    sessionId,
  );
  await mkdir(sessionDirectory, { recursive: true });
  const apiKeyFile = resolve(sessionDirectory, "api-key.txt");
  const presetFile = resolve(sessionDirectory, "models.ini");
  let managedProcess: ManagedLlamaProcess | undefined;
  try {
    await writeFile(apiKeyFile, `${apiKey}\n`, { mode: 0o600 });
    await chmod(apiKeyFile, 0o600).catch(() => {});
    await writeFile(presetFile, renderManagedLlamaPreset(manifest), {
      mode: 0o600,
    });
    await chmod(presetFile, 0o600).catch(() => {});

    const child = spawn(
      executablePath,
      buildManagedLlamaArguments({ port, apiKeyFile, presetFile }),
      {
        cwd: dirname(executablePath),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    managedProcess = { child, sessionDirectory, apiKeyFile, presetFile };
    let logTail = "";
    let spawnError: Error | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      logTail = appendLogTail(logTail, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      logTail = appendLogTail(logTail, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    await waitUntilReady({
      child,
      baseUrl,
      apiKey,
      manifest,
      timeoutMs: config.startupTimeoutMs,
      getLogTail: () => logTail,
      getSpawnError: () => spawnError,
    });

    return {
      baseUrl,
      apiKey,
      modelIds: manifest.models.map((model) => model.id),
      contextWindows: new Map(
        manifest.models.map((model) => [model.id, model.contextWindow]),
      ),
      pid: child.pid ?? -1,
      stop: async () => stopProcess(managedProcess!),
    };
  } catch (error) {
    if (managedProcess) {
      await stopProcess(managedProcess);
    } else {
      await cleanupSessionFiles({
        sessionDirectory,
        apiKeyFile,
        presetFile,
      });
    }
    throw error;
  }
}
