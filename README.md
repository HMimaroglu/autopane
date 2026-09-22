# Autopane

A desktop app that does browser tasks in **its own browser**, inside its own window,
without touching your mouse, keyboard or other windows. Claude writes the plan; a local
Jev-style decision model (SemIf on Qwen3.5-4B) makes every per-step decision in well
under a second.

| | Run |
|---|---|
| **macOS / Linux** | `./run.sh` |
| **Windows** | double-click `run.cmd` (or `.\run.cmd` in a terminal) |

That's it. The first run installs whatever is missing (uv, which brings its own Python;
Node and git through Homebrew or winget), downloads the model once, and opens the app.
Later runs just open it. Add `--setup-only` to install without opening.

The one thing it can't do for you: the [`claude` CLI](https://claude.com/claude-code) must be
installed and signed in, because Claude writes the plan for each task. No API key is used.

The model runs where it's fastest on each machine: **MLX** on Apple Silicon (8-bit, 4.2 GB),
**PyTorch/CUDA** on a PC with an NVIDIA GPU, and **llama.cpp on the CPU** everywhere else.

## How it works

1. **Plan (Claude, ~5 s, once per task).** `claude -p` with tools, MCP, skills and settings
   off returns a start URL, a list of small steps (`click` / `type` / `select` / `scroll`,
   each naming one target the way a person would), and a yes/no success question.
2. **Ground each step (local model, ~0.4–1.0 s).** The page is reduced to its interactive
   elements, lexically cut to the best 8, and SemIf picks which one the step means, or
   "none of these". One option call, no text generation. If only one element could match
   and its own label matches the step, no model call is made.
3. **Act** through Chrome DevTools Protocol input on the agent's own `WebContentsView`.
   Nothing goes through the OS, so it works while the window is hidden or you are typing
   elsewhere. The view has its own cookie jar (`persist:autopane-agent`).
4. **Recover.** "None", or low confidence, means scroll once, then ask Claude to replan
   from the live page (at most twice). The final page is checked with the success question;
   a failed check gets one replan too.

## Speed

Measured 2026-09-22.

| | Mac, Apple M4 (MLX, 8-bit) | CPU engine on the M4 (llama.cpp) | Windows CI, 4-core, no GPU (llama.cpp) |
|---|---|---|---|
| Per decision, median | **0.54-0.93 s** | 2.3-2.8 s | 7-11 s |
| Claude plan | 4.7-8.2 s | same | not used (fixed plans) |
| Whole task (2-11 steps) | 7.5-20 s | 9.6-53 s | 18-84 s |

The model's cost is almost all prompt reading: about 2.5 ms per token on the M4 GPU for a
4B model (compute bound; a same-size standard-attention Qwen3-4B measured the same). That is
why every decision is kept to ~250 tokens. On a Windows PC, an NVIDIA GPU is what makes it
fast; the CPU engine works but is an order of magnitude slower.

## Tests

```
cd app
node --test test/agent.test.js          # unit: candidate filtering, ranking, plan parsing
node ../test/e2e.mjs                    # end to end: real Claude, real model, app run hidden
node ../test/e2e.mjs --fixed-plans      # same, with canned plans (no Claude login needed)
```

The e2e suite runs four tasks with the window **hidden and unfocused**: newsletter signup,
a flight search and booking of the cheapest nonstop out of 24 results, sign in plus a settings
change, and a live Wikipedia search. It passes on what the test site's server actually
received (or the live URL reached), not on the agent's own success check.

GitHub Actions runs the full setup and the e2e suite on a GPU-less **Windows** machine
(llama.cpp engine) on every push, plus the unit tests on macOS.

## Platforms

- **macOS, Apple Silicon:** verified end to end (MLX engine and llama.cpp CPU engine).
- **Windows:** setup and e2e run in CI on the CPU engine. The NVIDIA/CUDA path is written
  but has no GPU machine testing it.
- **Desktop apps (outside the browser):** not built. On macOS there is no supported way to
  give an agent its own invisible desktop without a VM.

## Layout

```
engine/   prepare_model.py (one-time model fetch per platform), server.py (SemIf over HTTP on 127.0.0.1)
app/      Electron: main.js (window, engine lifecycle), page.js (CDP snapshot + input),
          agent.js (grounding loop), planner.js (claude -p), renderer/ (panel UI)
test/     fixtures/server.mjs (recording test site), e2e.mjs
```
