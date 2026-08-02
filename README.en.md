# coderig

**A terminal coding harness optimized for the DeepSeek API — a from-scratch implementation of the core mechanisms behind Claude Code.**

`coderig` is an autonomous coding assistant that lives in your terminal: it reads, searches, and modifies your code, runs shell commands, decomposes complex tasks into checklists, plans before acting, and can restore files the model breaks. It is not a wrapper around an existing agent framework — every layer of the agent system (agent loop, tool calling, permission gate, context management, observability) is implemented from scratch, and each layer is deliberately engineered around DeepSeek's protocol specifics (thinking mode, `reasoning_content` round-tripping, context caching) to squeeze the most out of the model.

Published on npm (`coderig`). Built with Bun, shipped as a single self-contained binary per platform (`bun build --compile`) — no runtime dependency on Node.

- TypeScript · Bun · zero runtime dependencies
- ~8.5k lines of TypeScript, **29 unit-test files** covering the core loop, permissions, compaction, doom-loop detection, and both render backends
- Chinese original: [README.md](README.md)

---

## Feature highlights

| Layer | What it does | Why it's interesting |
|---|---|---|
| **Agent Loop** | Stop semantics, fallbacks, summary round, doom-loop detection | Stop = "no tool_calls this round", `finish_reason` only as a fallback; on round-limit/deadlock, tools are disabled and the model must summarize progress in plain text instead of a hard kill |
| **DeepSeek adaptation** | Thinking protocol, cache-friendly prompt layout, network resilience | Assistant messages carrying `tool_calls` must round-trip `reasoning_content` verbatim (protocol hard requirement — missing it returns 400); runtime state is injected at the *tail* of the request to keep the static prefix cacheable |
| **Tool system** | 11 tools + registry + two-phase execution | `def` + `handler` convention per tool; parallel execution waves with file-lock conflict detection; read-before-write guard |
| **Permission gate** | Three-level decisions + dangerous-command recognition | auto / ask / deny; `rm -rf`, `sudo`, `git push --force`, `curl \| sh` can never be allowlisted for the session; read-only whitelist with escape-hatch detection |
| **Context management** | 1M window + LLM summarization | lossless transcript vs. lossy send-view separation; compaction triggered by *real* `prompt_tokens` from the API; CJK-aware token estimation |
| **Observability** | 16 event types, cross-run trace file | `sid`/`seq`/`round`/`ts` 4-dimension index; raw SSE payloads persisted for protocol-level debugging; every permission decision logged as an `approval` event |
| **Dual render backends** | Linear (Clack) + TUI (Ink + React) | One `chat.ts` loop drives both UIs; the TUI subscribes via `useSyncExternalStore` — scroll-back history + live streaming area + modal interactions |

---

## Install & usage

```bash
npm install -g coderig
cd your-project
coderig
```

First run walks you through entering your DeepSeek API key, stored in `~/.coderig/config.json` (mode 0600).

```
coderig                       Start a new conversation in the current directory
coderig --resume <cid>        Resume a conversation (transcript persists across sessions)
coderig --list                List conversation history
coderig --snapshots [cid]     List change snapshots (recover file contents after the model breaks them)
coderig --restore <cid> <path>   Restore a file's snapshot content (confirms before overwriting)
coderig config                Re-run the setup wizard
```

What it can do:

- Read / search / modify the code in the current directory; run shell commands (dangerous ones ask first)
- Decompose complex tasks into a `todo` checklist and work through it item by item
- Enter **plan mode** for read-only investigation, write the plan into a dedicated directory, and get it approved before implementing
- Snapshot every change automatically — `--restore` brings broken files back
- Resume sessions across restarts: the same conversation shares its snapshots and todo state

Config lives in `~/.coderig/config.json`; environment variables take precedence (`API_KEY` / `MODEL` / `BASE_URL` / `CONTEXT_WINDOW_TOKENS` / `MAX_OUTPUT_TOKENS` / `CODERIG_HOME` …). All runtime state stays under `~/.coderig/` — **nothing is written into your project directory**.

---

## Core mechanisms

### 1. Agent Loop — stop semantics and fallbacks

The core loop: the model produces output → if there are `tool_calls`, execute them, feed the results back, and ask again → no `tool_calls` means the final answer; stop. Every failure mode has an explicit fallback instead of dumping a half-finished mess on the user:

- **Stop semantics**: `[DONE]` is only a transport-level EOF ("this stream finished") and every round has one — it is never the stop signal. Stop = "no tool_calls this round"; `finish_reason` is checked as a fallback only
- **Summary round**: when the 50-round cap is hit or a doom loop is detected, **tools are disabled** and one final request asks the model to state in plain text what's done, what's not, and what to do next — vastly more useful than a hard stop
- **Nudge**: an empty response (no content, no tool calls) triggers an injected continuation prompt, up to 2 times; then it gives up explicitly instead of looping forever
- **Doom-loop detection**: call signatures are pattern-matched to catch oscillating repeated calls of the same tool with the same arguments
- **Request failure**: the error is pinned on screen and the loop exits without running half of the tool calls or saving half of the answer

### 2. DeepSeek adaptation (the differentiator)

The backend is the DeepSeek cloud API (thinking mode, 1M context window). Many things that look like "model quirks" are actually protocol hard requirements — the harness must cooperate at the protocol level:

- **`reasoning_content` round-tripping**: an assistant message with `tool_calls` must store the raw thinking text (`reasoning_content`) back into history and resend it — the DeepSeek protocol returns 400 if it's missing, this is not a model preference. The `llm_raw` event persists raw SSE payloads for post-hoc protocol debugging
- **Context-cache-friendly layout**: per-round runtime state (mode, todo list) is injected as a message at the **tail**, not glued into the system prefix — changing the first token of the prefix invalidates DeepSeek's whole context cache; tail injection keeps the static prefix cached
- **Streaming with real usage**: SSE streams reasoning/content incrementally; the final chunk's **real** `prompt_tokens` drive the compaction threshold — no local estimation
- **Network resilience**: exponential backoff with jitter, retrying only "provider hiccup" errors (429/5xx/network); 4xx errors (bad params, auth) are never retried and are thrown with the response body — DeepSeek's 400 body contains the concrete reason, discarding it is debugging blind

### 3. Tool system and permission gate

11 tools: `read_file` / `list_dir` / `glob` / `grep` / `write_file` / `edit_file` / `bash` / `search_history` / `todo` / `enter_plan_mode` / `exit_plan_mode`. Each tool follows a `def` (description for the model) + `handler` (implementation) convention, registered in a central registry; failures uniformly return a `"错误："`-prefixed string so the observability layer can judge `ok`.

The **permission gate** (`permissions.ts`) is the security core. With a cloud LLM behind it, the model genuinely *can* execute `rm -rf` — the implicit protection of "too weak to cause real harm" is gone. The harness grants the user's own permissions, with an explicit gate in between:

- **Three-level decisions**: `auto` (pure read-only, no interruption) / `ask` (side effects, confirm first) / `deny` (hard block, no question)
- **Dangerous-command recognition**: `rm -rf`, `sudo`, `git reset --hard`, `git push --force`, `curl | sh` pipelines, overwriting `.env`, etc. — pattern-matched, and **never session-allowlistable**: even if `bash` is allowlisted, these ask every single time
- **Read-only whitelist with escape-hatch detection**: `ls` / `cat` / `grep` / `git status` etc. pass `auto` only if every pipe segment matches; escape hatches are caught (`find -delete`, `awk system()`, `tsc` without `--noEmit` which writes artifacts)
- **Config-level deny**: tools denied in settings.json are **invisible to the model** (removed from the tools list, rather than sent and refused)
- Every permission decision is logged as an `approval` event — you can later audit how often the model attempts dangerous operations

### 4. System prompt engineering

The system prompt is not one blob of text — it is modularly assembled, versioned, and injected with runtime state:

- **A+B+C+D architecture**: identity (`baseIdentity`) / tool discipline (`toolRules`) / verification discipline (`verification`) / workflow (`workflow`); `PROMPT_VERSION` (currently v6) bumps on every change
- **Project-type detection**: probes for `package.json` / `go.mod` / `Cargo.toml`… at startup and injects "what kind of project this is" into the identity layer — as a global command, the model faces arbitrary user projects and must not guess
- **Per-type verification commands**: TS projects get `npx tsc --noEmit`, Go gets `go build ./...` — never hardcoded to one
- **Plan mode**: the workflow segment chooses between two variants; `enter_plan_mode` investigates read-only, writes the plan into a dedicated directory (writes to other paths are rejected in plan mode), and `exit_plan_mode` submits it for approval
- **A/B baseline**: `PROMPT_VERSION=none` runs without a system prompt; the effect of version changes is measured against trace data
- **Runtime state injected every round**: mode + todo list as a separate message segment, kept apart from the static body

### 5. Context management (1M window)

- **Lossless transcript vs. lossy send-view separation**: what's persisted to disk is complete (needed for resume); what's sent to the model is a compacted/cropped projection
- **LLM summarization**: past the threshold, a model call compresses old history into a structured snapshot (goals / constraints / key conclusions / files & commands / task state) that keeps only what future actions need; the summary is read by the model only, and uses Markdown sections rather than pseudo-XML — half-closed tags make model output drift structurally
- **CJK-aware token estimation**: Chinese ≈ 1 char/token, Latin ≈ 4 chars/token, weighted separately — a flat 3.5 would badly underestimate Chinese transcripts, and compaction would fail exactly when the window is already overflowing
- **Graceful compaction degradation**: if nothing can be compacted but an oversized single message exists, a per-message cap crops the send-view; if truly stuck, an explicit error suggests a larger window instead of silently hammering the API into a 400

### 6. Observability

Every event lands in `~/.coderig/trace.jsonl` (accumulates across runs; `CODERIG_HOME` can point it back into the project for experiments), 16 event types, each tagged with `sid`/`seq`/`round`/`ts` — one run = one `sid`, so any single session can be sliced out for before/after comparison. Writes are serialized so line order = event order; crashes still leave a partial trace.

### 7. Dual render backends

One `chat.ts` main loop drives two terminal UIs through a `Term` interface:

- **Linear mode**: Clack prompt + streaming output (pipes, simple contexts)
- **TUI mode**: Ink + React — `Static` scroll-back for settled content, a live streaming area pinned above the input, and modal interactions (input / confirm / select); Ctrl+C semantics are handled centrally (unmount and restore the terminal first, then run the normal shutdown)

---

## Architecture

```
index.ts                    CLI entry (command parsing, config bootstrap, snapshot restore)
bin/coderig                 Distribution entry (platform probe, self-contained compiled binary)
src/
├── cli/
│   ├── chat.ts             agent loop: stop logic, tool execution, permission gate, compaction, summary round
│   ├── doom_loop.ts        doom-loop detection (pure function, unit-tested)
│   ├── render.ts           linear render backend (Clack)
│   ├── tui/                TUI render backend (Ink + React: scroll-back / live area / modals)
│   ├── snapshot_cmd.ts     snapshot list/restore commands
│   └── setup.ts            config wizard
├── llm/
│   ├── client.ts           DeepSeek client: SSE streaming, retry, thinking protocol, cache-friendly layout
│   ├── stream.ts           SSE byte stream → StreamEvent parsing
│   └── types.ts            message / tool / event types
├── tools/                  11 tools + registry + permission gate + snapshots
│   ├── permissions.ts      permission gate: three levels, dangerous-command recognition, read-only whitelist
│   ├── partition.ts        two-phase tool execution, parallel waves, file-lock conflict detection
│   ├── snapshot.ts         change snapshots (pre-change backup, restorable)
│   └── context.ts          session context (mode / todo state)
├── history/
│   ├── store.ts            lossless transcript persistence (resume support)
│   ├── context.ts          lossy send-view, compaction trigger
│   └── compact.ts          LLM summarization (structured snapshot template)
├── prompts/system.ts       modular system prompt (versioned, A/B baseline)
├── config/                 config layer (env > file > wizard) and path convergence
└── observability/tracer.ts observability (16 event types, cross-run accumulation)
```

Data flow (one task = multiple HTTP streams, one per round):

```
user input ──► agent loop (chat.ts)
               │  sendMessages ──► DeepSeek SSE stream
               │    ├─ reasoning/content → streamed to the renderer (TUI / linear)
               │    ├─ tool_calls → permission gate (auto/ask/deny) → execute → feed back into history
               │    └─ usage (real tokens) → compaction threshold check
               │  ◄─ no tool_calls = final answer, stop
               │  ◄─ round cap / doom loop → summary round (tools disabled, model summarizes)
               └─ every event persisted to trace.jsonl (sid/seq/round/ts)
```

---

## Design decisions (interview talking points)

Choices worth expanding on — and defensible under questioning:

- **Why stop on "no tool_calls" instead of parsing `finish_reason`**: `[DONE]` is only transport EOF — "this stream finished" ≠ "the answer is done", and every round has its own `[DONE]`. The real stop signal is "no tool_calls this round"; `finish_reason` is a fallback check only
- **Why runtime state goes to the tail instead of into `system`**: DeepSeek's context cache is prefix-sensitive — changing the first token invalidates the whole cache, paying full input cost every round. Tail injection keeps the static prefix cacheable
- **Why compaction uses real `prompt_tokens` instead of local estimation**: estimation is a lossy approximation (especially for Chinese); the API's usage is ground truth. Compaction decisions should be made on facts
- **Summary round instead of hard stop**: hitting the round cap or a deadlock doesn't kill the process — it disables tools and asks the model to state progress. An order of magnitude more useful to the user (the approach opencode takes)
- **Why three permission levels instead of two**: `deny` covers operations that shouldn't even be asked about (overwriting `.env`), `ask` + `rememberable` covers grantable-but-auditable operations, `auto` covers pure reads — a balance between noise and safety
- **Why build from scratch instead of using a framework**: every agent-system decision (stop logic, compaction, permissions) depends on concrete protocol understanding. Only by implementing it yourself do you learn where the boundaries actually are

---

## Quality

- **29 unit-test files** covering: stop logic and round control, permission grading and dangerous-command recognition, compaction triggers and CJK estimation, doom-loop detection, SSE parsing, and both render backends (including TUI component tests)
- `bunx tsc --noEmit` passes strict type checking
- Core logic (stop logic, permissions, compaction, doom loop) is factored into pure functions testable without I/O
- `bun run build` produces per-platform binaries (`darwin/linux/windows × arm64/x64 + linux-musl`) via `bun build --compile` — runtime bundled, no Node needed

## Development

```bash
bun install
bun run index.ts          # run from source
bun test                  # unit tests
bunx tsc --noEmit         # type check
bun run build             # compile all-platform binaries to dist/
```

Run sysprompt A/B experiments:

```bash
TRACE_PATH=logs/trace.jsonl CODERIG_HOME=./logs bun run index.ts
PROMPT_VERSION=none bun run index.ts   # no-system-prompt baseline
```
