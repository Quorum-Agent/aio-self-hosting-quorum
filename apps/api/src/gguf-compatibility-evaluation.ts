/**
 * Load-gates GGUF artifacts against Quorum's pinned llama.cpp build.
 *
 * ADR 0001 item 5 requires Quorum to "verify separately downloaded GGUF
 * artifacts and advertise only models that load successfully in the pinned
 * runtime." This is that gate.
 *
 * It exists because a model NAME and the GGUF magic header are both
 * insufficient compatibility checks. The managed-runtime spike found Qwen 3.5
 * artifacts failing with `key qwen35.rope.dimension_sections has wrong array
 * length; expected 4, got 3` — a valid GGUF that the pinned build cannot
 * parse. GGUF carries a container version and an architecture name but no
 * required-feature list and no forward-compatibility declaration, so no
 * amount of metadata inspection answers the question. Only loading it does.
 *
 * Deliberately loads through `startManagedLlamaRuntime` rather than spawning
 * llama-server directly, so the gate exercises the same preset rendering,
 * readiness polling and authentication the production path uses. An artifact
 * that loads under a hand-rolled command line but not under Quorum's is not
 * a passing artifact.
 *
 * Run:
 *   QUORUM_MANAGED_LLAMA_SERVER=... npx tsx src/gguf-compatibility-evaluation.ts <gguf...>
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { promisify } from "node:util";

import { startManagedLlamaRuntime } from "./managed-llama-runtime.js";

const run = promisify(execFile);

/**
 * Free VRAM in MiB, or undefined when it cannot be determined.
 *
 * The gate needs this because llama.cpp reports a failed CUDA allocation the
 * same way it reports an unparseable file: the process exits and startup times
 * out. Without checking, the gate blacklists good artifacts whenever something
 * else happens to be holding the card — which it did, rejecting six for six
 * while Ollama held 12.7 GB of a 16 GB card.
 */
async function freeVramMib(): Promise<number | undefined> {
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.free",
      "--format=csv,noheader,nounits",
    ]);
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a startup failure looks like the machine rather than the artifact.
 *
 * A verdict of "incompatible" is durable — it is meant to keep an artifact off
 * a recommendation list. A verdict caused by a busy GPU is not, and conflating
 * them poisons the list with models that are fine.
 */
function looksResourceBound(detail: string): boolean {
  return /cuda|cudaMalloc|cudaStream|out of memory|failed to allocate|-1073740791/iu.test(
    detail,
  );
}

interface GateResult {
  artifact: string;
  /** Distinguishes "this build cannot read it" from "not right now". */
  inconclusive?: boolean;
  loads: boolean;
  answers: boolean;
  /**
   * Whether reasoning can actually be turned off for this artifact.
   *
   * A separate verdict from `answers` because it is a property of the model's
   * chat template rather than of Quorum's configuration, and llama.cpp treats
   * templates that ignore the request as working-as-intended. Measured on
   * b10192: `qwen3:4b` emits ~300 characters of reasoning with BOTH
   * `reasoning_effort: "none"` and `chat_template_kwargs.enable_thinking:
   * false` set. Reasoning is drawn from the same budget as the answer, so an
   * artifact that cannot suppress it needs headroom the caller must know about
   * in advance.
   */
  suppressible: boolean;
  reasoningChars?: number;
  loadSeconds?: number;
  detail?: string;
}

const CONTEXT_WINDOW = 2_048;
// Matches what the provider actually asks for rather than a token or two. A
// tight budget makes any reasoning model look broken: the first version of
// this gate used 64 and rejected `qwen3:4b`, which answers perfectly well with
// room to think. The gate must not fail an artifact for a setting it chose.
const PROBE_MAX_TOKENS = 512;
const PROBE = "Reply with the single word: ready.";

async function gate(
  executablePath: string,
  file: string,
  dataDirectory: string,
): Promise<GateResult> {
  const artifact = basename(file);
  const manifestDirectory = await mkdtemp(join(tmpdir(), "quorum-gate-"));
  const manifestPath = join(manifestDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      models: [
        {
          id: "candidate",
          file,
          contextWindow: CONTEXT_WINDOW,
          gpuLayers: 999,
          loadOnStartup: true,
        },
      ],
    }),
    "utf8",
  );

  const started = Date.now();
  let runtime: Awaited<ReturnType<typeof startManagedLlamaRuntime>> | undefined;
  try {
    runtime = await startManagedLlamaRuntime(
      { executablePath, manifestPath, startupTimeoutMs: 180_000 },
      dataDirectory,
    );
  } catch (error) {
    await rm(manifestDirectory, { recursive: true, force: true });
    const message = (error as Error).message.replace(/\s+/gu, " ");
    const free = await freeVramMib();
    const needed = Math.round((await stat(file).catch(() => ({ size: 0 }))).size / 1024 ** 2);
    const resourceBound =
      looksResourceBound(message) || (free !== undefined && free < needed);
    return {
      artifact,
      ...(resourceBound
        ? {
            inconclusive: true,
            detail:
              `INCONCLUSIVE — looks resource-bound, not incompatible ` +
              `(${needed} MiB artifact, ${free ?? "?"} MiB free). Free the GPU and re-run.`,
          }
        : {}),
      loads: false,
      answers: false,
      suppressible: false,
      // Keep the tail rather than the head: llama.cpp prints its banner before
      // it prints why it refused the file, and the reason is the whole point.
      ...(resourceBound ? {} : { detail: message.slice(-220) }),
    };
  }
  const loadSeconds = Math.round((Date.now() - started) / 100) / 10;

  // Loading is necessary but not sufficient: a model can initialise and then
  // produce nothing usable, which from Quorum's side is the same outcome.
  let answers = false;
  let suppressible = false;
  let reasoningChars: number | undefined;
  let detail: string | undefined;
  try {
    const response = await fetch(`${runtime.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runtime.apiKey}`,
      },
      body: JSON.stringify({
        model: "candidate",
        messages: [{ role: "user", content: PROBE }],
        stream: false,
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
        // Both mechanisms at once. They cover different template generations,
        // and asking for both is what production should do — so the gate
        // measures whether the artifact honours the strongest request Quorum
        // can make, not a weaker one.
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
    };
    const message = payload.choices?.[0]?.message;
    const content = message?.content ?? "";
    reasoningChars = (message?.reasoning_content ?? "").length;
    answers = content.trim().length > 0;
    suppressible = reasoningChars === 0;
    if (!answers) detail = "loaded but returned empty content";
    else if (!suppressible) {
      detail = `answers, but ignores both suppression requests (${reasoningChars} chars of reasoning) — budget for it`;
    }
  } catch (error) {
    detail = `loaded but inference failed: ${(error as Error).message.slice(0, 100)}`;
  } finally {
    await runtime.stop();
    await rm(manifestDirectory, { recursive: true, force: true });
  }

  return {
    artifact,
    loads: true,
    answers,
    suppressible,
    ...(reasoningChars !== undefined ? { reasoningChars } : {}),
    loadSeconds,
    ...(detail ? { detail } : {}),
  };
}

async function main(): Promise<void> {
  const executablePath = process.env["QUORUM_MANAGED_LLAMA_SERVER"];
  if (!executablePath) {
    console.error("Set QUORUM_MANAGED_LLAMA_SERVER to the pinned llama-server binary.");
    process.exitCode = 1;
    return;
  }
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Pass one or more GGUF paths to gate.");
    process.exitCode = 1;
    return;
  }
  const freeAtStart = await freeVramMib();
  if (freeAtStart !== undefined) {
    console.log(`GPU free at start: ${freeAtStart} MiB
`);
  }
  const dataDirectory = await mkdtemp(join(tmpdir(), "quorum-gate-data-"));
  const results: GateResult[] = [];
  for (const file of files) {
    const result = await gate(executablePath, file, dataDirectory);
    results.push(result);
    const verdict = result.inconclusive
      ? "INCONCLUSIVE (machine, not artifact)"
      : !result.loads
        ? "REJECTED (does not load)"
      : !result.answers
        ? "REJECTED (no output)"
        : result.suppressible
          ? `ok (${result.loadSeconds}s)`
          : `ok, thinking not suppressible (${result.loadSeconds}s)`;
    console.log(`${result.artifact.slice(0, 24).padEnd(26)} ${verdict}`);
    if (result.detail) console.log(`${" ".repeat(26)} ${result.detail}`);
  }
  await rm(dataDirectory, { recursive: true, force: true });

  const passed = results.filter((r) => r.loads && r.answers).length;
  console.log(`\n${passed}/${results.length} artifacts are advertisable on this build.`);
}

await main();
