import json
import subprocess
import sys


def write_message(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_script(message):
    script_path = message.get("scriptPath")
    args = message.get("args") or []
    timeout_ms = message.get("timeoutMs")
    cwd = message.get("cwd") or None

    if not script_path:
        raise ValueError("scriptPath is required")

    timeout = None
    if timeout_ms:
        timeout = max(float(timeout_ms) / 1000.0, 0.001)

    completed = subprocess.run(
        [sys.executable, script_path, *[str(arg) for arg in args]],
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=timeout,
    )

    return {
        "ok": completed.returncode == 0,
        "code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
            message_id = message.get("id")
            message_type = message.get("type")

            if message_type == "ping":
                write_message({"id": message_id, "type": "pong", "ok": True})
                continue

            if message_type == "shutdown":
                write_message({"id": message_id, "type": "shutdown", "ok": True})
                break

            if message_type == "execute":
                result = run_script(message)
                result["id"] = message_id
                result["type"] = "result"
                write_message(result)
                continue

            write_message({
                "id": message_id,
                "type": "error",
                "ok": False,
                "error": f"Unknown message type: {message_type}",
            })
        except subprocess.TimeoutExpired as error:
            write_message({
                "id": message.get("id") if "message" in locals() else None,
                "type": "error",
                "ok": False,
                "code": "ETIMEDOUT",
                "stdout": error.stdout or "",
                "stderr": error.stderr or "",
                "error": str(error),
            })
        except Exception as error:
            write_message({
                "id": message.get("id") if "message" in locals() else None,
                "type": "error",
                "ok": False,
                "error": str(error),
            })


if __name__ == "__main__":
    main()
