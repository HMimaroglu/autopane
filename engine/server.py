"""Local decision server: SemIf behind one HTTP endpoint on 127.0.0.1.

POST /decide  {"state": str, "questions": [{"id", "question", "options": [{"id", "description"}]}]}
           -> {"answers": {id: {"choice", "confidence", "probabilities"}}, "ms", "input_tokens"}
GET  /health  -> {"ok": true, "backend": ...}

Every question in one request shares the same state, so the state is read once
and each question only costs its own short suffix. Prints "READY <port>" once
the model is loaded and warm.
"""

from __future__ import annotations

import argparse
import faulthandler
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_TOKENS = 6144


def log(message: str) -> None:
    print(f"[engine] {message}", file=sys.stderr, flush=True)


def load(config: dict):
    backend = config["backend"]
    log(f"loading {backend} model")
    if backend == "mlx":
        from semif_phase1 import mlx_backend as impl

        model, tokenizer, meta = impl.load_model(config["model"], config["revision"])
        return impl, model, tokenizer, meta

    if backend == "llamacpp":
        from semif_phase1 import llamacpp_backend as impl

        model, tokenizer, meta = impl.load_model(config["model"], config["revision"], config["gguf"],
                                                 context_tokens=MAX_TOKENS)
        return impl, model, tokenizer, meta
    from types import SimpleNamespace

    from semif_phase1.core import load_causal_model
    from semif_phase1.direct import score
    from semif_phase1.shared import score_shared

    model, tokenizer, meta = load_causal_model(config["model"], config["revision"], "auto", "bfloat16")
    return SimpleNamespace(score=score, score_shared=score_shared), model, tokenizer, meta


class LastPositionOnly:
    """SemIf's MLX direct scorer reads model(ids)[0, -1]. Projecting only that last
    hidden state onto the 248k-token vocabulary, instead of every position, gives
    the same logits (bf16 rounding aside) and cuts ~200 ms off a short prompt."""

    def __init__(self, model):
        self.lm = getattr(model, "language_model", model)

    def __call__(self, ids):
        hidden = self.lm.model(ids)[:, -1:, :]
        if hasattr(self.lm, "lm_head"):
            return self.lm.lm_head(hidden)
        return self.lm.model.embed_tokens.as_linear(hidden)


class Engine:
    def __init__(self, config: dict):
        self.backend = config["backend"]
        self.impl, self.model, self.tokenizer, self.meta = load(config)
        self.single = LastPositionOnly(self.model) if self.backend == "mlx" else self.model
        self.lock = threading.Lock()  # one forward pass at a time on the one model

    def decide(self, state: str, questions: list[dict]) -> dict:
        if not questions:
            raise ValueError("questions must be a nonempty list")
        rows = [{"id": q["id"], "state": state, "question": q["question"], "options": q["options"]}
                for q in questions]
        started = time.perf_counter()
        with self.lock:
            if len(rows) == 1:
                results = [self.impl.score(self.single, self.tokenizer, rows[0], self.meta, MAX_TOKENS)]
            else:
                results, _ = self.impl.score_shared(self.model, self.tokenizer, rows, self.meta, MAX_TOKENS)
        answers = {}
        for result in results:
            probs = dict(zip(result["option_ids"], result["probabilities"]))
            choice = max(probs, key=probs.get)
            answers[result["id"]] = {"choice": choice, "confidence": probs[choice], "probabilities": probs}
        return {"answers": answers, "ms": round((time.perf_counter() - started) * 1000),
                "input_tokens": max(r["input_tokens"] for r in results)}


def serve(engine: Engine, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "backend": engine.backend})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/decide":
                return self._send(404, {"error": "not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                self._send(200, engine.decide(body["state"], body["questions"]))
            except (KeyError, ValueError, TypeError) as error:
                self._send(400, {"error": str(error)})

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="JSON printed by prepare_model.py")
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
    parser.add_argument("--exit-with-stdin", action="store_true",
                        help="Exit when stdin closes, so the model never outlives the app that started it")
    args = parser.parse_args()
    if os.environ.get("AUTOPANE_TRACE_HANG"):
        # Diagnostics: print every thread's stack periodically if startup stalls.
        faulthandler.dump_traceback_later(int(os.environ["AUTOPANE_TRACE_HANG"]), repeat=True)
    if args.exit_with_stdin:
        # The parent holds our stdin open; EOF means it quit or crashed.
        threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()
    engine = Engine(json.loads(args.config))
    log("model loaded, warming up")
    # First forward compiles kernels; do it before announcing readiness.
    engine.decide("warmup", [{"id": "w", "question": "Ready?",
                             "options": [{"id": "yes", "description": "Yes."},
                                         {"id": "no", "description": "No."}]}])
    faulthandler.cancel_dump_traceback_later()
    server = serve(engine, args.port)
    print(f"READY {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
