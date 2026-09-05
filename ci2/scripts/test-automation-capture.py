#!/usr/bin/env python3
import os
import selectors
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path


STDOUT = 1
STDERR = 2
HEADER = struct.Struct(">BQ")


def write_event(handle, stream_id, payload):
    handle.write(HEADER.pack(stream_id, len(payload)))
    handle.write(payload)
    handle.flush()


def write_status(path, rc, completed_ns, elapsed_ms):
    status_path = Path(path)
    tmp_path = status_path.with_suffix(status_path.suffix + ".tmp")
    tmp_path.write_text(
        f"rc={rc}\ncompleted_ns={completed_ns}\nelapsed_ms={elapsed_ms}\n",
        encoding="utf-8",
    )
    tmp_path.replace(status_path)


def safe_write_status(path, rc, start_ns):
    completed_ns = time.monotonic_ns()
    elapsed_ms = max(0, (completed_ns - start_ns) // 1_000_000)
    try:
        write_status(path, rc, completed_ns, elapsed_ms)
    except OSError:
        pass


def terminate_process(proc):
    if proc is None or proc.poll() is not None:
        return

    try:
        pgid = os.getpgid(proc.pid)
    except ProcessLookupError:
        return

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()


def capture(repo_root, rel_path, events_path, status_path, pgid_path, run_id, target_b64):
    visor2 = os.environ.get("VISOR2_BIN", "visor2")
    start_ns = time.monotonic_ns()
    proc = None
    events = None

    def handle_signal(signum, _frame):
        terminate_process(proc)
        safe_write_status(status_path, 128 + signum, start_ns)
        raise SystemExit(128 + signum)

    previous_term = signal.signal(signal.SIGTERM, handle_signal)
    previous_int = signal.signal(signal.SIGINT, handle_signal)
    try:
        with open(events_path, "wb") as events_handle:
            events = events_handle
            write_event(
                events,
                STDOUT,
                f"==> visor2 build --no-interactive {rel_path}\n".encode(),
            )
            try:
                proc = subprocess.Popen(
                    [visor2, "build", "--no-interactive", rel_path,
                     "--build-env", "SML_BASELINE_RUN_ID=" + run_id,
                     "--build-env", "SML_BASELINE_TARGET_B64=" + target_b64],
                    cwd=repo_root,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
            except OSError as exc:
                message = f"Failed to start visor2 build {rel_path}: {exc}\n"
                write_event(events, STDERR, message.encode())
                safe_write_status(status_path, 127, start_ns)
                return 127

            Path(pgid_path).write_text(f"{os.getpgid(proc.pid)}\n", encoding="utf-8")

            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ, STDOUT)
            selector.register(proc.stderr, selectors.EVENT_READ, STDERR)

            while selector.get_map():
                for key, _ in selector.select():
                    chunk = key.fileobj.read1(65536)
                    if chunk:
                        write_event(events, key.data, chunk)
                    else:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()

            rc = proc.wait()
            safe_write_status(status_path, rc, start_ns)
            return rc
    except SystemExit:
        raise
    except BaseException as exc:
        terminate_process(proc)
        if events is not None:
            try:
                message = f"test automation capture failed for {rel_path}: {exc}\n"
                write_event(events, STDERR, message.encode())
            except OSError:
                pass
        safe_write_status(status_path, 125, start_ns)
        return 125
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        signal.signal(signal.SIGINT, previous_int)


def replay(events_path):
    with open(events_path, "rb") as events:
        while True:
            header = events.read(HEADER.size)
            if not header:
                return 0
            if len(header) != HEADER.size:
                raise RuntimeError(f"truncated event header in {events_path}")
            stream_id, length = HEADER.unpack(header)
            payload = events.read(length)
            if len(payload) != length:
                raise RuntimeError(f"truncated event payload in {events_path}")
            if stream_id == STDOUT:
                os.write(1, payload)
            elif stream_id == STDERR:
                os.write(2, payload)
            else:
                raise RuntimeError(f"unknown stream id {stream_id} in {events_path}")


def main(argv):
    if len(argv) < 2:
        print("usage: test-automation-capture.py capture|replay ...", file=sys.stderr)
        return 2
    mode = argv[1]
    if mode == "capture":
        if len(argv) != 9:
            print(
                "usage: test-automation-capture.py capture <repo-root> <rel-path> "
                "<events> <status> <pgid> <run-id> <target-b64>",
                file=sys.stderr,
            )
            return 2
        return capture(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8])
    if mode == "replay":
        if len(argv) != 3:
            print("usage: test-automation-capture.py replay <events>", file=sys.stderr)
            return 2
        return replay(argv[2])
    print(f"unknown mode: {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
