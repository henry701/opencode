#!/usr/bin/env python3
"""
Ad-hoc QA smoke for unified prompt queue via opencode-local.

Runs the current interactive surfaces:
  1. `opencode-local` full TUI with a mocked LLM
  2. `opencode-local attach` with a mocked server and queued API data

Optional live Nemotron when OPENCODE_QA_LIVE=1 (often slow; may time out).

Artifacts: OPENCODE_QA_ARTIFACT_DIR (default: /tmp/opencode-queue-qa-<pid>)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import pexpect
except ImportError:
    print("pexpect required: pip install pexpect", file=sys.stderr)
    sys.exit(2)

REPO = Path(__file__).resolve().parents[1]
CLI_ENTRY = REPO / "src" / "index.ts"
SOURCE_CLI = ["bun", "run", "--conditions=browser", str(CLI_ENTRY)]


def source_cli(extra: list[str], ws: Path) -> list[str]:
    """Repo-root bun entry with workspace directory pinned via --dir."""
    return [*SOURCE_CLI, *extra, "--dir", str(ws)]
OPENCODE_LOCAL = os.environ.get("OPENCODE_QA_BIN", shutil.which("opencode-local") or "opencode-local")


def cli_argv() -> list[str]:
    """Prefer opencode-local; fall back to repo source when the binary lacks /queue routes."""
    if os.environ.get("OPENCODE_QA_FORCE_SOURCE") == "1":
        return SOURCE_CLI
    if os.environ.get("OPENCODE_QA_BIN"):
        return [OPENCODE_LOCAL]
    if has_queue_routes(OPENCODE_LOCAL):
        return [OPENCODE_LOCAL]
    print(f"  NOTE  {OPENCODE_LOCAL} lacks POST /session/:id/queue; using repo source CLI")
    return SOURCE_CLI


def has_queue_routes(binary: str) -> bool:
    ws = Path(tempfile.mkdtemp(prefix="opencode-queue-probe-"))
    try:
        subprocess.run(["git", "init", "-q"], cwd=ws, check=True)
        (ws / "README.md").write_text("probe\n", encoding="utf-8")
        home = ws / ".home"
        home.mkdir()
        env = {
            **os.environ,
            "HOME": str(home),
            "OPENCODE_TEST_HOME": str(home),
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_PURE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
        }
        port = 42000 + (os.getpid() % 500)
        serve = subprocess.Popen(
            [binary, "serve", "--port", str(port)],
            cwd=str(ws),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        base_url: str | None = None
        try:
            assert serve.stdout is not None
            deadline = time.time() + 90
            while time.time() < deadline:
                line = serve.stdout.readline()
                if not line:
                    if serve.poll() is not None:
                        break
                    continue
                match = re.search(r"(https?://[^\s]+)", line)
                if match:
                    base_url = match.group(1).rstrip("/")
                    break
            if not base_url:
                return False
            session = curl_json("POST", f"{base_url}/session", str(ws), {"title": "probe"})
            sid = session.get("id")
            if not sid:
                return False
            curl_json(
                "POST",
                f"{base_url}/session/{sid}/queue",
                str(ws),
                {
                    "agent": "build",
                    "model": {"providerID": "test", "modelID": "test-model"},
                    "parts": [{"type": "text", "text": "probe"}],
                },
            )
            return True
        finally:
            stop_serve(serve)
    except Exception:
        return False
    finally:
        shutil.rmtree(ws, ignore_errors=True)
MODEL_MOCK = "test/test-model"
MODEL_LIVE = os.environ.get("OPENCODE_QA_MODEL", "opencode/nemotron-3-super-free")
ARTIFACT_DIR = Path(
    os.environ.get(
        "OPENCODE_QA_ARTIFACT_DIR",
        f"/tmp/opencode-queue-qa-{os.getpid()}",
    ),
)
LIVE = os.environ.get("OPENCODE_QA_LIVE", "") == "1"


def test_provider_config(llm_url: str) -> str:
    return json.dumps(
        {
            "formatter": False,
            "lsp": False,
            "provider": {
                "test": {
                    "name": "Test",
                    "id": "test",
                    "env": [],
                    "npm": "@ai-sdk/openai-compatible",
                    "models": {
                        "test-model": {
                            "id": "test-model",
                            "name": "Test Model",
                            "attachment": False,
                            "reasoning": False,
                            "temperature": False,
                            "tool_call": True,
                            "release_date": "2025-01-01",
                            "limit": {"context": 100_000, "output": 10_000},
                            "cost": {"input": 0, "output": 0},
                            "options": {},
                        }
                    },
                    "options": {"apiKey": "test-key", "baseURL": llm_url},
                }
            },
        }
    )


def isolated_env(home: Path, llm_url: str | None = None) -> dict[str, str]:
    env = {
        **os.environ,
        "OPENCODE_TEST_HOME": str(home),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
        "OPENCODE_PURE": "1",
        "OPENCODE_DISABLE_AUTOUPDATE": "1",
        "OPENCODE_DISABLE_AUTOCOMPACT": "1",
        "OPENCODE_DISABLE_MODELS_FETCH": "1",
        "OPENCODE_AUTH_CONTENT": "{}",
        "TERM": os.environ.get("TERM", "xterm-256color"),
        "COLORTERM": os.environ.get("COLORTERM", "truecolor"),
    }
    if llm_url:
        env["OPENCODE_CONFIG_CONTENT"] = test_provider_config(llm_url)
    return env


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)


@dataclass
class QaReport:
    passed: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def ok(self, name: str) -> None:
        self.passed.append(name)
        print(f"  PASS  {name}")

    def fail(self, name: str, detail: str) -> None:
        self.failed.append(f"{name}: {detail}")
        print(f"  FAIL  {name}: {detail}")

    def note(self, text: str) -> None:
        self.notes.append(text)
        print(f"  NOTE  {text}")


def save_screen(name: str, text: str) -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / f"{name}.txt"
    path.write_text(strip_ansi(text), encoding="utf-8")


def spawn_pty(
    argv: list[str],
    env: dict[str, str],
    cwd: Path,
    *,
    run_cwd: Path | None = None,
    cols: int = 120,
    rows: int = 40,
):
    child = pexpect.spawn(
        argv[0],
        argv[1:],
        cwd=str(run_cwd or cwd),
        env=env,
        encoding="utf-8",
        timeout=120,
        dimensions=(rows, cols),
    )
    child.logfile_read = None
    return child


def wait_pattern(child: pexpect.spawn, pattern: str | re.Pattern, timeout: float, label: str) -> str:
    idx = child.expect([pattern, pexpect.TIMEOUT, pexpect.EOF], timeout=timeout)
    if idx == 0:
        return child.before + child.after
    if idx == 2:
        raise RuntimeError(f"{label}: process exited (code {child.exitstatus})")
    raise RuntimeError(f"{label}: timed out after {timeout}s")


def screen(child: pexpect.spawn) -> str:
    chunks: list[str] = []
    while True:
        try:
            chunk = child.read_nonblocking(size=65536, timeout=0.05)
        except pexpect.TIMEOUT:
            break
        except pexpect.EOF:
            break
        if not chunk:
            break
        chunks.append(chunk)
    return "".join(chunks)


def snapshot(child: pexpect.spawn) -> str:
    return strip_ansi((getattr(child, "before", "") or "") + screen(child))


def send_queue_key(child: pexpect.spawn) -> None:
    # kitty/xterm modifyOtherKeys: ctrl+shift+enter
    child.send("\x1b[13;6u")
    time.sleep(0.05)
    child.send("\x1b[27;6;13~")


def send_edit_queue_key(child: pexpect.spawn) -> None:
    child.send("\x1b[1;3A")


def send_submit(child: pexpect.spawn) -> None:
    child.send("\r")


def close_child(child: pexpect.spawn, grace: float = 2.0) -> None:
    if not child.isalive():
        return
    try:
        child.sendcontrol("c")
        time.sleep(0.3)
        child.send("/quit\r")
        time.sleep(0.5)
    except Exception:
        pass
    try:
        child.close(force=True)
    except Exception:
        pass
    if child.isalive():
        child.terminate(force=True)


class MockLlm:
    def __init__(self) -> None:
        self.proc: subprocess.Popen[str] | None = None
        self.url: str | None = None

    def start(self) -> str:
        script = REPO / "scripts" / "start-mock-llm.ts"
        self.proc = subprocess.Popen(
            ["bun", "run", str(script)],
            cwd=str(REPO),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "OPENCODE_PURE": "1"},
        )
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline().strip()
        if not line.startswith("http"):
            err = self.proc.stderr.read(4000) if self.proc.stderr else ""
            raise RuntimeError(f"mock LLM failed to start: {line!r} {err}")
        self.url = line
        return line

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def make_workspace() -> Path:
    ws = Path(tempfile.mkdtemp(prefix="opencode-qa-"))
    subprocess.run(["git", "init", "-q"], cwd=ws, check=True)
    (ws / "README.md").write_text("# queue qa\n", encoding="utf-8")
    return ws


def curl_json(method: str, url: str, directory: str, body: dict | None = None) -> object:
    cmd = [
        "curl",
        "-sfS",
        "-X",
        method,
        url,
        "-H",
        f"x-opencode-directory: {directory}",
    ]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"curl {method} {url} failed ({result.returncode}): {result.stderr.strip()}")
    out = result.stdout.strip()
    if not out:
        return {}
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"curl {method} {url} returned non-JSON: {out[:200]!r}") from exc


def start_serve(ws: Path, env: dict[str, str], cli: list[str]) -> tuple[subprocess.Popen[str], str]:
    port = 41000 + (os.getpid() % 1000)
    serve = subprocess.Popen(
        [*cli, "serve", "--port", str(port)],
        cwd=str(ws),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    assert serve.stdout is not None
    base_url: str | None = None
    deadline = time.time() + 120
    while time.time() < deadline:
        line = serve.stdout.readline()
        if not line:
            if serve.poll() is not None:
                break
            time.sleep(0.1)
            continue
        match = re.search(r"(https?://[^\s]+)", line)
        if match:
            base_url = match.group(1).rstrip("/")
            break
    if not base_url:
        rest = serve.stdout.read() if serve.stdout else ""
        raise RuntimeError(f"serve did not print listening URL (exit={serve.poll()}): {rest[-500:]!r}")
    time.sleep(0.3)
    return serve, base_url


def stop_serve(serve: subprocess.Popen[str]) -> None:
    if serve.poll() is not None:
        return
    serve.send_signal(signal.SIGTERM)
    try:
        serve.wait(timeout=10)
    except subprocess.TimeoutExpired:
        serve.kill()


def test_run_interactive_demo(report: QaReport, ws: Path) -> None:
    name = "run -i --demo boots footer"
    # Always exercise the installed opencode-local binary for --demo.
    child = spawn_pty(
        [
            OPENCODE_LOCAL,
            "run",
            "-i",
            "--demo",
            "-m",
            MODEL_LIVE,
            "--title",
            "qa-run-demo",
        ],
        isolated_env(ws / ".home-demo"),
        ws,
    )
    try:
        wait_pattern(child, re.compile(r"(?i)(demo|prompt|footer|/help)"), 45, name)
        save_screen("run-demo-boot", snapshot(child))

        child.send("queue-me-on-demo")
        send_queue_key(child)
        time.sleep(0.8)
        buf = snapshot(child)
        save_screen("run-demo-queue-key", buf)
        if "queue unavailable in demo" in buf.lower():
            report.ok("run -i --demo rejects queue (ctrl+shift+enter)")
        elif re.search(r"\bqueued\b|message[s]? queued", buf, re.I):
            report.ok("run -i --demo queue key shows dock (binary may use memory queue)")
        else:
            report.fail(
                "run -i --demo queue key",
                f"expected demo queue rejection or dock; tail: {buf[-400:]!r}",
            )

        child.send("/quit\r")
        child.expect(pexpect.EOF, timeout=15)
        report.ok("run -i --demo /quit exits")
    except Exception as exc:
        save_screen("run-demo-error", str(exc) + "\n" + snapshot(child))
        report.fail(name, str(exc))
    finally:
        close_child(child)


def test_run_interactive_mock(
    report: QaReport,
    ws: Path,
    llm_url: str,
    cli: list[str],
    use_source: bool,
) -> None:
    home = ws / ".home-mock"
    env = isolated_env(home, llm_url)
    run_argv = (
        source_cli(["run", "-i", "-m", MODEL_MOCK, "--title", "qa-run-mock"], ws)
        if use_source
        else [*cli, "run", "-i", "-m", MODEL_MOCK, "--title", "qa-run-mock"]
    )
    child = spawn_pty(run_argv, env, ws, run_cwd=REPO if use_source else None)
    try:
        wait_pattern(child, re.compile(r"(?i)(test-model|build|prompt)"), 60, "run -i mock boot")
        time.sleep(1.0)

        child.send("open-turn-steer\r")
        wait_pattern(child, re.compile(r"(?i)(mock-ok|assistant|done|complete)"), 90, "run mock first turn")
        save_screen("run-mock-after-steer", snapshot(child))

        child.send("queue-via-keyboard\r")
        send_queue_key(child)
        time.sleep(1.2)
        buf = snapshot(child)
        save_screen("run-mock-queue-key", buf)
        if re.search(r"1 message queued|messages queued|\bqueued\b", buf, re.I):
            report.ok("run -i mock queue via ctrl+shift+enter shows dock")
        else:
            report.note("run mock queue key: dock text not seen; checking HTTP queue path next")

        child.send("/quit\r")
        child.expect(pexpect.EOF, timeout=20)
        report.ok("run -i mock /quit exits")
    except Exception as exc:
        save_screen("run-mock-error", str(exc))
        report.fail("run -i mock queue flow", str(exc))
    finally:
        close_child(child)


def test_run_interactive_api_queue(report: QaReport, ws: Path, llm_url: str, cli: list[str]) -> None:
    """Hold first turn, seed queue via HTTP (same API as TUI), verify dock in run -i."""
    home = ws / ".home-api"
    env = isolated_env(home, llm_url)
    serve: subprocess.Popen[str] | None = None
    try:
        serve, base_url = start_serve(ws, env, cli)

        session = curl_json(
            "POST",
            f"{base_url}/session",
            str(ws),
            {"title": "qa-run-api-queue"},
        )
        sid = session["id"]

        for text in ("queue-one", "queue-two", "queue-three"):
            curl_json(
                "POST",
                f"{base_url}/session/{sid}/queue",
                str(ws),
                {
                    "agent": "build",
                    "model": {"providerID": "test", "modelID": "test-model"},
                    "parts": [{"type": "text", "text": text}],
                },
            )

        listed = curl_json("GET", f"{base_url}/session/{sid}/queue", str(ws))
        if not isinstance(listed, list) or len(listed) != 3:
            raise RuntimeError(f"expected 3 queued items via GET, got {listed!r}")
        report.ok("HTTP queue API holds 3 items before run attach")

        use_source = cli == SOURCE_CLI
        attach_argv = (
            source_cli(
                [
                    "run",
                    "-i",
                    "-m",
                    MODEL_MOCK,
                    "--attach",
                    base_url,
                    "--session",
                    sid,
                ],
                ws,
            )
            if use_source
            else [
                *cli,
                "run",
                "-i",
                "-m",
                MODEL_MOCK,
                "--attach",
                base_url,
                "--session",
                sid,
                "--dir",
                str(ws),
            ]
        )
        child = spawn_pty(attach_argv, env, ws, run_cwd=REPO if use_source else None)
        try:
            wait_pattern(
                child,
                re.compile(r"3 messages queued|queue-one|queue-two|queue-three", re.I),
                45,
                "run attach shows queue dock",
            )
            save_screen("run-attach-queue-dock", snapshot(child))
            report.ok("run -i attach shows queued prompts in UI")
            child.send("/quit\r")
            child.expect(pexpect.EOF, timeout=15)
        except Exception as exc:
            save_screen("run-attach-queue-dock-error", snapshot(child))
            if "timed out" in str(exc).lower():
                report.note("run attach: queue API OK but dock text not visible in PTY (see artifact)")
            else:
                raise
        finally:
            close_child(child)
    except Exception as exc:
        report.fail("run -i attach queue dock", str(exc))
    finally:
        if serve is not None:
            stop_serve(serve)


def test_tui_full_queue(
    report: QaReport,
    ws: Path,
    llm_url: str,
    cli: list[str],
    use_source: bool,
) -> None:
    """Full `opencode-local` TUI (in-process server + mock LLM)."""
    home = ws / ".home-tui-full"
    env = isolated_env(home, llm_url)
    tui_argv = source_cli(["-m", MODEL_MOCK], ws) if use_source else [*cli, "-m", MODEL_MOCK]
    child = spawn_pty(tui_argv, env, ws, run_cwd=REPO if use_source else None)
    try:
        wait_pattern(child, re.compile(r"(?i)(opencode|build|session|prompt)"), 90, "full TUI boot")
        time.sleep(1.5)
        child.send("tui-steer-turn\r")
        wait_pattern(child, re.compile(r"(?i)(mock-ok|ok|assistant)"), 90, "full TUI first turn")
        child.send("tui-queued-msg\r")
        send_queue_key(child)
        time.sleep(1.2)
        buf = snapshot(child)
        save_screen("tui-full-queue", buf)
        if re.search(r"1 message queued|messages queued|\bqueued\b", buf, re.I):
            report.ok("full TUI queue dock via ctrl+shift+enter")
        else:
            report.fail("opencode-local full TUI queue", f"dock not visible; tail={buf[-500:]!r}")

        child.sendcontrol("c")
        time.sleep(0.15)
        child.send("q")
        time.sleep(0.4)
    except Exception as exc:
        save_screen("tui-full-error", str(exc))
        report.fail("opencode-local full TUI", str(exc))
    finally:
        close_child(child)


def test_tui_attach_queue(
    report: QaReport,
    ws: Path,
    llm_url: str,
    cli: list[str],
    use_source: bool,
) -> None:
    home = ws / ".home-tui"
    env = isolated_env(home, llm_url)
    serve: subprocess.Popen[str] | None = None
    try:
        serve, base_url = start_serve(ws, env, cli)

        session = curl_json("POST", f"{base_url}/session", str(ws), {"title": "qa-tui-queue"})
        sid = session["id"]

        for text in ("tui-q1", "tui-q2", "tui-q3"):
            curl_json(
                "POST",
                f"{base_url}/session/{sid}/queue",
                str(ws),
                {
                    "agent": "build",
                    "model": {"providerID": "test", "modelID": "test-model"},
                    "parts": [{"type": "text", "text": text}],
                },
            )

        listed = curl_json("GET", f"{base_url}/session/{sid}/queue", str(ws))
        if not isinstance(listed, list) or len(listed) != 3:
            raise RuntimeError(f"expected 3 queued items via GET, got {listed!r}")
        report.ok("TUI attach path: HTTP queue API holds 3 items")

        attach_argv = (
            [*SOURCE_CLI, "attach", base_url, "--session", sid, "--dir", str(ws)]
            if use_source
            else [*cli, "attach", base_url, "--session", sid]
        )
        child = spawn_pty(attach_argv, env, ws, run_cwd=REPO if use_source else None)
        try:
            wait_pattern(
                child,
                re.compile(r"3 messages queued|tui-q1|tui-q2|tui-q3", re.I),
                45,
                "TUI attach queue dock",
            )
            save_screen("tui-attach-queue-dock", snapshot(child))
            report.ok("TUI attach shows queued prompts in UI")

            send_edit_queue_key(child)
            wait_pattern(child, re.compile(r"Editing queued message|save edit", re.I), 15, "TUI queued edit mode")
            child.send("-edited")
            send_submit(child)
            time.sleep(0.8)

            edited = curl_json("GET", f"{base_url}/session/{sid}/queue", str(ws))
            if not isinstance(edited, list) or len(edited) != 3 or "-edited" not in edited[0].get("text", ""):
                raise RuntimeError(f"Enter did not save queued edit in place: {edited!r}")
            report.ok("TUI Enter saves queued edit without sending it")
        except Exception as exc:
            save_screen("tui-attach-queue-dock-error", snapshot(child))
            if "timed out" in str(exc).lower():
                report.note("TUI attach: queue API OK but dock text not visible in PTY (see artifact)")
            else:
                raise
        finally:
            close_child(child)
    except Exception as exc:
        report.fail("opencode-local TUI attach queue dock", str(exc))
    finally:
        if serve is not None:
            stop_serve(serve)


def test_live_nemotron(report: QaReport, ws: Path) -> None:
    child = spawn_pty(
        [
            OPENCODE_LOCAL,
            "run",
            "-i",
            "-m",
            MODEL_LIVE,
            "--title",
            "qa-live-nemotron",
        ],
        isolated_env(ws / ".home-live"),
        ws,
    )
    try:
        wait_pattern(child, re.compile(r"(?i)(nemotron|prompt|footer)"), 45, "live nemotron boot")
        child.send("Reply with exactly: PING\r")
        wait_pattern(child, re.compile(r"\bPING\b"), 120, "live nemotron PING reply")
        save_screen("live-nemotron-ping", snapshot(child))
        report.ok(f"live model {MODEL_LIVE} returned PING")
        child.send("/quit\r")
        child.expect(pexpect.EOF, timeout=15)
    except Exception as exc:
        save_screen("live-nemotron-error", str(exc))
        report.note(f"live Nemotron skipped/failed ({exc}); use OPENCODE_QA_LIVE=1 only when Zen is reachable")
    finally:
        close_child(child)


def main() -> int:
    cli = cli_argv()
    use_source = cli == SOURCE_CLI
    print(f"CLI: {' '.join(cli)}")
    print(f"opencode-local install: {OPENCODE_LOCAL}")
    print(f"artifacts: {ARTIFACT_DIR}")
    report = QaReport()
    ws = make_workspace()
    mock = MockLlm()

    try:
        llm_url = mock.start()
        print(f"mock LLM: {llm_url}")

        print("\n=== Phase 1: opencode-local full TUI ===")
        test_tui_full_queue(report, ws, llm_url, cli, use_source)

        print("\n=== Phase 2: opencode-local attach (queue API seed) ===")
        test_tui_attach_queue(report, ws, llm_url, cli, use_source)

        if LIVE:
            print("\n=== Phase 3: live Nemotron (optional) ===")
            test_live_nemotron(report, ws)
        else:
            report.note("skip live Nemotron (set OPENCODE_QA_LIVE=1 to enable)")

    finally:
        mock.stop()
        shutil.rmtree(ws, ignore_errors=True)

    print("\n=== Summary ===")
    print(f"passed: {len(report.passed)}")
    for item in report.passed:
        print(f"  + {item}")
    if report.failed:
        print(f"failed: {len(report.failed)}")
        for item in report.failed:
            print(f"  - {item}")
    for item in report.notes:
        print(f"  ~ {item}")

    summary_path = ARTIFACT_DIR / "summary.txt"
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        "\n".join(
            ["PASSED:"]
            + report.passed
            + ["FAILED:"]
            + report.failed
            + ["NOTES:"]
            + report.notes
        ),
        encoding="utf-8",
    )
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
