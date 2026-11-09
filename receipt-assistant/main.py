#!/usr/bin/env python3
"""
main.py – 收款凭证签名系统 v2  (Flask Web 架构)
依赖: flask pymupdf opencv-python pillow watchdog paddlepaddle paddleocr qrcode
启动后浏览器访问 http://localhost:8888
"""
import sys
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import difflib, io, json, os, queue, re, shutil, socket, subprocess, threading, time, traceback, uuid, webbrowser
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

_EARLY_BASE = Path(__file__).resolve().parent
_EARLY_LOGS_DIR = _EARLY_BASE / "logs"
SERVER_LOG_FILE = _EARLY_LOGS_DIR / "server.log"


def _server_log(message: str):
    line = f"{datetime.now().isoformat()} {message}"
    try:
        _EARLY_LOGS_DIR.mkdir(parents=True, exist_ok=True)
        with open(SERVER_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
    except Exception:
        try:
            print(line, file=sys.stderr, flush=True)
        except Exception:
            pass


_server_log("main.py started")

try:
    import cv2
    import numpy as np
    from PIL import Image
    import fitz
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    from flask import Flask, jsonify, request, send_file
except Exception:
    _server_log("import exception traceback:\n" + traceback.format_exc())
    raise

try:
    import tkinter as tk
    from tkinter import filedialog
    _TK_OK = True
except Exception:
    tk = None
    filedialog = None
    _TK_OK = False

_FLASK_OK = True

try:
    from paddleocr import PaddleOCR as _PaddleOCR
    _OCR_OK = True
except ImportError:
    _PaddleOCR = None
    _OCR_OK    = False

try:
    import qrcode as _qrcode
    _QR_OK = True
except ImportError:
    _qrcode = None
    _QR_OK  = False

_server_log("imports ok")

# ═══════════════════════════════════════════════════════════════════════════
# 常量
# ═══════════════════════════════════════════════════════════════════════════

APP_TITLE        = "收款凭证签名系统"
_BASE            = Path(__file__).resolve().parent
CONFIG_FILE      = _BASE / "config.json"
DEBUG_DIR        = _BASE / "debug"
LOGS_DIR         = _BASE / "logs"
REPORTS_DIR      = LOGS_DIR / "reports"
SCANS_DIR        = _BASE / "uploads"
UNMATCHED_DIR    = SCANS_DIR / "unmatched"
PENDING_DIR      = SCANS_DIR / "pending"
APPROVAL_DIR     = SCANS_DIR / "approval"
THUMBS_DIR       = DEBUG_DIR / "thumbs"
DONE_EXT         = ".done"
DEFAULT_CATEGORY = "uncategorized"
HTTP_PORT        = 8888
WORK_LOG_FILE    = LOGS_DIR / "工作记录.txt"
TASK_STORE_PATH  = LOGS_DIR / "task_store.json"
UPLOAD_LOG_FILE  = LOGS_DIR / "upload.log"
RECONCILIATION_LOG_FILE = LOGS_DIR / "reconciliation.log"
_work_log_lock   = threading.Lock()
_upload_log_lock = threading.Lock()
_reconciliation_log_lock = threading.Lock()
UPLOAD_SOURCES   = {"upload", "mobile_upload", "folder"}
MISSING_IMAGE_TYPE = "图片实体缺失"
MISSING_IMAGE_REASON = "原始图片实体缺失，疑似旧版本重命名覆盖导致，请重新上传该图片。"

PDF_W_PT, PDF_H_PT  = 595.25, 841.85
SIG_RECT_X0_PT      = 180.0
SIG_RECT_RIGHT_PT   = 30.0
SIG_RECT_Y0_PT      = 560.0
SIG_RECT_Y1_PT      = 650.0
SIG_PAGE = 0
SCAN_DPI = 300
PT_TO_PX = SCAN_DPI / 72.0

PASSPORT_RE = re.compile(r'\b([A-Z]{1,2}\d{6,8}|\d{6,9})\b')
NAME_RE     = re.compile(r'\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,4})\b')
WATCH_EXTS  = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}

DEFAULT_CFG = {
    "originals_path": "originals",
    "signed_path":    "completed",
    "scans_path":     "uploads",
}

_seen_paths: set = set()
_seen_lock = threading.Lock()
_warp_executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="warp")

# ═══════════════════════════════════════════════════════════════════════════
# 全局状态（在 main() 中初始化）
# ═══════════════════════════════════════════════════════════════════════════

cfg        = None   # Config
proc       = None   # Processor
rq         = None   # queue.Queue[Result]
task_store = None   # TaskStore
watching   = False
observer   = None   # Observer


def _mark_path_seen(path: Path) -> bool:
    key = str(path.resolve())
    with _seen_lock:
        if key in _seen_paths:
            return False
        _seen_paths.add(key)
        return True


def _add_seen_path(path: Path):
    with _seen_lock:
        _seen_paths.add(str(path.resolve()))


# ═══════════════════════════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════════════════════════

class Config:
    def __init__(self):
        self._d = dict(DEFAULT_CFG)

    def _normalize_value(self, k: str, v: str) -> str:
        raw = (v or "").strip()
        if not raw:
            return DEFAULT_CFG[k]
        p = Path(raw)
        if p.is_absolute():
            try:
                return str(p.resolve().relative_to(_BASE))
            except Exception:
                return DEFAULT_CFG[k]
        return raw

    def _resolve_value(self, v: str) -> str:
        raw = (v or "").strip()
        if not raw:
            return ""
        p = Path(raw)
        if p.is_absolute():
            return str(p)
        return str((_BASE / p).resolve())

    @property
    def file_exists(self) -> bool:
        return CONFIG_FILE.exists()

    def load(self) -> bool:
        if not CONFIG_FILE.exists():
            return False
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
            self._d.update({k: self._normalize_value(k, v) for k, v in saved.items() if k in DEFAULT_CFG})
            self.save()
            return True
        except Exception:
            return False

    def save(self):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(self._d, f, ensure_ascii=False, indent=2)

    def __getitem__(self, k: str) -> str:
        return self._resolve_value(self._d.get(k, ""))

    def __setitem__(self, k: str, v: str):
        self._d[k] = self._normalize_value(k, v)


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(1, 10000):
        candidate = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"cannot allocate unique filename for {path}")


def _business_image_dirs() -> list[Path]:
    dirs = [SCANS_DIR, APPROVAL_DIR, PENDING_DIR, UNMATCHED_DIR]
    for name in ("failed", "processing", "archive"):
        dirs.append(_BASE / name)
        dirs.append(SCANS_DIR / name)
    return dirs


def _count_images_in_dir(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(1 for f in d.iterdir()
               if f.is_file() and f.suffix.lower() in WATCH_EXTS)


def _count_images_recursive(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(1 for f in d.rglob("*")
               if f.is_file() and f.suffix.lower() in WATCH_EXTS)


def _business_image_counts() -> dict:
    uploads_root = _count_images_in_dir(SCANS_DIR)
    uploads_tree = _count_images_recursive(SCANS_DIR)
    approval = _count_images_in_dir(APPROVAL_DIR)
    pending = _count_images_in_dir(PENDING_DIR)
    unmatched = _count_images_in_dir(UNMATCHED_DIR)
    failed = _count_images_in_dir(_BASE / "failed") + _count_images_in_dir(SCANS_DIR / "failed")
    processing = _count_images_in_dir(_BASE / "processing") + _count_images_in_dir(SCANS_DIR / "processing")
    archive = _count_images_in_dir(_BASE / "archive") + _count_images_in_dir(SCANS_DIR / "archive")
    unique_images = set()
    for directory in _business_image_dirs():
        if not directory.exists():
            continue
        unique_images.update(
            f.name for f in directory.iterdir()
            if f.is_file() and f.suffix.lower() in WATCH_EXTS
        )
    total = len(unique_images)
    return {
        "uploads_root": uploads_root,
        "uploads_tree": uploads_tree,
        "approval_dir": approval,
        "pending_dir": pending,
        "unmatched_dir": unmatched,
        "failed_dir": failed,
        "processing_dir": processing,
        "archive_dir": archive,
        "filesystem_total": total,
    }


def _scan_relative_image_names() -> set[str]:
    if not SCANS_DIR.exists():
        return set()
    return {
        path.name
        for path in SCANS_DIR.rglob("*")
        if path.is_file() and path.suffix.lower() in WATCH_EXTS
    }


def _append_upload_audit(batch: dict):
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        lines = [
            "",
            f"[{datetime.now().isoformat()}] upload batch",
            f"batch_id={batch.get('batch_id', '')}",
            f"upload_batch_id={batch.get('batch_id', '')}",
            f"upload_time={batch.get('created_at', '')}",
            f"selected_count={batch.get('selected_count', 0)}",
            f"sent_count={batch.get('sent_count', 0)}",
            f"received_count={batch.get('received_count', 0)}",
            f"saved_count={batch.get('saved_count', 0)}",
            f"skipped_count={batch.get('skipped_count', 0)}",
            f"failed_count={batch.get('failed_count', 0)}",
            f"queued_count={batch.get('queued_count', 0)}",
            f"before_disk_count={batch.get('before_disk_count', 0)}",
            f"after_disk_count={batch.get('after_disk_count', 0)}",
            f"disk_added_count={batch.get('disk_added_count', 0)}",
            f"reconciliation_ok={batch.get('reconciliation_ok', False)}",
        ]
        for item in batch.get("files", []):
            lines.append(
                "file "
                f"original_name={item.get('original_name', '')!r} "
                f"saved_name={item.get('saved_name', '')!r} "
                f"status={item.get('status', '')!r} "
                f"queued={bool(item.get('queued', False))} "
                f"reason={item.get('reason', '')!r}"
            )
        with _upload_log_lock:
            with open(UPLOAD_LOG_FILE, "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════
# 处理结果
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Result:
    filename:    str
    status:      str   # matched | success | unmatched | failed | warning | system | approval | ocr_debug
    message:     str
    passport_no: str = ""
    name:        str = ""
    category:    str = ""
    candidates:  list = field(default_factory=list)
    match_basis: str = ""
    matched_pdf: str = ""


# ═══════════════════════════════════════════════════════════════════════════
# 任务追踪
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class TaskRecord:
    id:          str
    filename:    str
    status:      str = "queued"        # queued|processing|success|completed|missing_output|failed|unmatched|approval
    stage:       str = "received"     # received|ocr|warp|replace|archive|failed
    name:        str = ""
    passport_no: str = ""
    category:    str = ""
    message:     str = ""
    match_basis: str = ""
    matched_pdf: str = ""
    selected_pdf: str = ""
    original_pdf: str = ""
    manual_pdf_confirmed: bool = False
    filename_verify_status: str = ""  # pending|passed|failed
    result_review_status: str = ""    # pending|passed
    output_pdf: str = ""
    expected_output_pdf: str = ""
    missing_output: bool = False
    last_error: str = ""
    candidates:  list = field(default_factory=list)
    timeline:    list = field(default_factory=list)
    source:      str = "folder"       # folder|upload
    exception_state: str = "pending"  # pending|resolved|ignored|expired
    exception_reason: str = ""
    exception_type: str = ""
    preview_rotation: int = 0
    current_image_path: str = ""
    created_at:  str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at:  str = field(default_factory=lambda: datetime.now().isoformat())


class TaskStore:
    def __init__(self):
        self._tasks: dict[str, TaskRecord] = {}
        self._by_filename: dict[str, str]  = {}
        self._lock = threading.Lock()
        self._today_count = 0
        self._success_count = 0
        self._failed_count  = 0
        self._upload_counts = {
            "selected_count": 0,
            "sent_count": 0,
            "received_count": 0,
            "saved_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
            "queued_count": 0,
        }
        self._upload_batches: dict[str, dict] = {}
        self._session_date  = datetime.now().date()
        self._load()
        threading.Thread(target=self._persist_loop, daemon=True).start()

    def _persist_loop(self):
        while True:
            time.sleep(2)
            self._save()

    def _save(self):
        try:
            LOGS_DIR.mkdir(parents=True, exist_ok=True)
            with self._lock:
                data = {
                    "session_date":  self._session_date.isoformat(),
                    "today_count":   self._today_count,
                    "success_count": self._success_count,
                    "failed_count":  self._failed_count,
                    "upload_counts": dict(self._upload_counts),
                    "upload_batches": dict(self._upload_batches),
                    "tasks": {tid: asdict(t) for tid, t in self._tasks.items()},
                }
            tmp = TASK_STORE_PATH.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            tmp.replace(TASK_STORE_PATH)
        except Exception:
            pass

    def _load(self):
        recovered_batches = []
        try:
            if not TASK_STORE_PATH.exists():
                return
            with open(TASK_STORE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            sd = data.get("session_date", "")
            if sd:
                self._session_date = datetime.fromisoformat(sd).date()
            self._today_count   = data.get("today_count", 0)
            self._success_count = data.get("success_count", 0)
            self._failed_count  = data.get("failed_count", 0)
            saved_counts = data.get("upload_counts", {})
            for key in self._upload_counts:
                self._upload_counts[key] = max(0, int(saved_counts.get(key, 0) or 0))
            saved_batches = data.get("upload_batches", {})
            if isinstance(saved_batches, dict):
                self._upload_batches = saved_batches
                current_files = _scan_relative_image_names()
                for batch in self._upload_batches.values():
                    saved_count = int(batch.get("saved_count", 0))
                    legacy_total = int(batch.get("disk_added_count", 0))
                    suspicious_empty_baseline = (
                        batch.get("finished_at")
                        and int(batch.get("before_disk_count", 0)) == 0
                        and int(batch.get("after_disk_count", 0)) == 0
                        and legacy_total > saved_count
                    )
                    if suspicious_empty_baseline:
                        batch["before_disk_files"] = []
                        batch["before_disk_count"] = max(0, legacy_total - saved_count)
                        batch["after_disk_count"] = legacy_total
                        batch["disk_added_count"] = saved_count
                        batch["reconciliation_ok"] = True
                        batch["reconciliation_message"] = ""
                        batch["legacy_total_recovered_v2"] = True
                        recovered_batches.append(batch)
                        continue
                    if "before_disk_files" in batch:
                        continue
                    if "baseline_files" in batch:
                        batch["before_disk_files"] = list(batch.get("baseline_files", []))
                        batch["before_disk_count"] = len(batch["before_disk_files"])
                        continue
                    if batch.get("finished_at"):
                        saved_names = {
                            str(item.get("saved_name", ""))
                            for item in batch.get("files", [])
                            if item.get("status") == "saved" and item.get("saved_name")
                        }
                        before_files = current_files - saved_names
                        batch["before_disk_files"] = sorted(before_files)
                        batch["before_disk_count"] = len(before_files)
                        batch["after_disk_count"] = len(current_files)
                        batch["disk_added_count"] = len(current_files - before_files)
                        batch["reconciliation_ok"] = (
                            int(batch.get("saved_count", 0)) == batch["disk_added_count"]
                        )
                        batch["reconciliation_message"] = (
                            "" if batch["reconciliation_ok"]
                            else "上传统计异常，请查看 upload.log"
                        )
                        batch["legacy_baseline_recovered"] = True
                        recovered_batches.append(batch)
            for tid, td in data.get("tasks", {}).items():
                try:
                    td.setdefault("current_image_path", "")
                    td.setdefault("expected_output_pdf", "")
                    td.setdefault("missing_output", False)
                    td.setdefault("last_error", "")
                    if td.get("expected_output_pdf") is None:
                        td["expected_output_pdf"] = ""
                    if td.get("missing_output") is None:
                        td["missing_output"] = False
                    if td.get("last_error") is None:
                        td["last_error"] = ""
                    t = TaskRecord(**td)
                    if t.status == "failed" and t.exception_type == "missing_output":
                        t.status = "missing_output"
                        t.stage = "archive"
                        t.missing_output = True
                        t.last_error = t.last_error or "输出PDF缺失"
                        t.exception_state = "resolved"
                    self._tasks[tid] = t
                    self._by_filename[t.filename] = tid
                except Exception:
                    pass
            if recovered_batches:
                self._save()
                for batch in recovered_batches:
                    _append_upload_audit(self._public_upload_batch_locked(batch))
        except Exception:
            pass

    def _reset_if_new_day(self):
        today = datetime.now().date()
        if today != self._session_date:
            self._session_date  = today
            self._today_count   = 0
            self._success_count = 0
            self._failed_count  = 0
            for key in self._upload_counts:
                self._upload_counts[key] = 0
            self._upload_batches.clear()

    def start_upload_batch(self, batch_id: str, selected_count: int,
                           skipped_files: list | None = None) -> dict:
        if not batch_id:
            return {}
        self._reset_if_new_day()
        selected_count = max(0, int(selected_count or 0))
        normalized_skipped = []
        for item in skipped_files or []:
            if not isinstance(item, dict):
                continue
            normalized_skipped.append({
                "original_name": str(item.get("original_name") or ""),
                "saved_name": "",
                "status": "skipped",
                "reason": str(item.get("reason") or "前端过滤"),
                "queued": False,
            })
        normalized_skipped = normalized_skipped[:selected_count]
        before_disk_files = sorted(_scan_relative_image_names())
        with self._lock:
            if batch_id in self._upload_batches:
                return dict(self._upload_batches[batch_id])
            self._upload_batches[batch_id] = {
                "batch_id": batch_id,
                "selected_count": selected_count,
                "sent_count": 0,
                "received_count": 0,
                "saved_count": 0,
                "skipped_count": len(normalized_skipped),
                "failed_count": 0,
                "queued_count": 0,
                "transport_failed_count": 0,
                "files": normalized_skipped,
                "before_disk_files": before_disk_files,
                "before_disk_count": len(before_disk_files),
                "after_disk_count": len(before_disk_files),
                "disk_added_count": 0,
                "reconciliation_ok": True,
                "reconciliation_message": "",
                "created_at": datetime.now().isoformat(),
            }
            self._upload_counts["selected_count"] += selected_count
            self._upload_counts["skipped_count"] += len(normalized_skipped)
            return dict(self._upload_batches[batch_id])

    def record_upload_received(self, batch_id: str):
        with self._lock:
            self._upload_counts["received_count"] += 1
            batch = self._upload_batches.get(batch_id)
            if batch is not None:
                batch["received_count"] = int(batch.get("received_count", 0)) + 1

    def record_upload_file(self, batch_id: str, original_name: str,
                           saved_name: str, status: str, reason: str = "",
                           queued: bool = False) -> dict:
        status = status if status in {"saved", "skipped", "failed"} else "failed"
        item = {
            "original_name": original_name,
            "saved_name": saved_name,
            "status": status,
            "reason": reason,
            "queued": bool(queued),
        }
        with self._lock:
            batch = self._upload_batches.get(batch_id)
            if batch is None:
                return {}
            batch.setdefault("files", []).append(item)
            count_key = f"{status}_count"
            self._upload_counts[count_key] += 1
            batch[count_key] = int(batch.get(count_key, 0)) + 1
            if queued:
                self._upload_counts["queued_count"] += 1
                batch["queued_count"] = int(batch.get("queued_count", 0)) + 1
            return self._public_upload_batch_locked(batch)

    def finish_upload_batch(self, batch_id: str, sent_count: int,
                            transport_failed_files: list | None = None) -> dict:
        sent_count = max(0, int(sent_count or 0))
        transport_failed_files = transport_failed_files or []
        with self._lock:
            batch = self._upload_batches.get(batch_id)
            if batch is None:
                batch = {
                    "batch_id": batch_id,
                    "selected_count": sent_count,
                    "sent_count": 0,
                    "received_count": 0,
                    "saved_count": 0,
                    "skipped_count": 0,
                    "failed_count": 0,
                    "queued_count": 0,
                    "transport_failed_count": 0,
                    "files": [],
                    "before_disk_files": sorted(_scan_relative_image_names()),
                    "created_at": datetime.now().isoformat(),
                }
                batch["before_disk_count"] = len(batch["before_disk_files"])
                batch["after_disk_count"] = batch["before_disk_count"]
                self._upload_batches[batch_id] = batch
                self._upload_counts["selected_count"] += sent_count
            old_sent = int(batch.get("sent_count", 0))
            if sent_count > old_sent:
                self._upload_counts["sent_count"] += sent_count - old_sent
                batch["sent_count"] = sent_count
            known_transport = {
                item.get("original_name", "")
                for item in batch.get("files", [])
                if item.get("reason") == "前端发送失败"
            }
            for raw in transport_failed_files:
                original_name = str(
                    raw.get("original_name", "") if isinstance(raw, dict) else raw
                )
                if original_name in known_transport:
                    continue
                known_transport.add(original_name)
                batch.setdefault("files", []).append({
                    "original_name": original_name,
                    "saved_name": "",
                    "status": "failed",
                    "reason": "前端发送失败",
                    "queued": False,
                })
                self._upload_counts["failed_count"] += 1
                batch["failed_count"] = int(batch.get("failed_count", 0)) + 1
                batch["transport_failed_count"] = int(batch.get("transport_failed_count", 0)) + 1
            after_disk_files = _scan_relative_image_names()
            before_disk_files = batch.get("before_disk_files")
            if before_disk_files is None:
                legacy_baseline = batch.get("baseline_files")
                if legacy_baseline is not None:
                    before_disk_files = legacy_baseline
                else:
                    saved_names = {
                        str(item.get("saved_name", "")).replace("\\", "/")
                        for item in batch.get("files", [])
                        if item.get("status") == "saved" and item.get("saved_name")
                    }
                    before_disk_files = sorted(after_disk_files - saved_names)
            before_disk_files = set(before_disk_files)
            disk_added_count = len(after_disk_files - before_disk_files)
            batch["before_disk_files"] = sorted(before_disk_files)
            batch["before_disk_count"] = len(before_disk_files)
            batch["after_disk_count"] = len(after_disk_files)
            batch["disk_added_count"] = disk_added_count
            batch["reconciliation_ok"] = disk_added_count == int(batch.get("saved_count", 0))
            batch["reconciliation_message"] = (
                "" if batch["reconciliation_ok"]
                else "上传统计异常，请查看 upload.log"
            )
            batch["finished_at"] = datetime.now().isoformat()
            public_batch = self._public_upload_batch_locked(batch)
        _append_upload_audit(public_batch)
        return public_batch

    def _public_upload_batch_locked(self, batch: dict) -> dict:
        return {
            "batch_id": batch.get("batch_id", ""),
            "selected_count": int(batch.get("selected_count", 0)),
            "sent_count": int(batch.get("sent_count", 0)),
            "received_count": int(batch.get("received_count", 0)),
            "saved_count": int(batch.get("saved_count", 0)),
            "skipped_count": int(batch.get("skipped_count", 0)),
            "failed_count": int(batch.get("failed_count", 0)),
            "queued_count": int(batch.get("queued_count", 0)),
            "before_disk_count": int(batch.get("before_disk_count", 0)),
            "after_disk_count": int(batch.get("after_disk_count", 0)),
            "disk_added_count": int(batch.get("disk_added_count", 0)),
            "reconciliation_ok": bool(batch.get("reconciliation_ok", True)),
            "reconciliation_message": str(batch.get("reconciliation_message", "")),
            "files": [dict(item) for item in batch.get("files", [])],
            "created_at": batch.get("created_at", ""),
            "finished_at": batch.get("finished_at", ""),
        }

    def get_upload_batch(self, batch_id: str) -> dict:
        with self._lock:
            batch = self._upload_batches.get(batch_id)
            return self._public_upload_batch_locked(batch) if batch else {}

    def get_upload_counts(self) -> dict:
        with self._lock:
            counts = dict(self._upload_counts)
            latest = {}
            if self._upload_batches:
                latest = self._public_upload_batch_locked(
                    next(reversed(self._upload_batches.values()))
                )
        rows = self.get_all()
        active = [t for t in rows
                  if self._is_upload_record(t)
                  and t.exception_state != "ignored"
                  and t.status not in {"ignored", "canceled", "cancelled"}]
        counts["processing_count"] = sum(
            1 for t in active if t.status in {"queued", "processing", "warning", "paused", "manual"}
        )
        counts["completed_count"] = sum(
            1 for t in active
            if (t.status in {"success", "completed"} or t.result_review_status == "passed")
            and self._completed_pdf_exists_locked(t)
        )
        counts["task_counts"] = {
            "total": len(active),
            "processing": counts["processing_count"],
            "verify": sum(1 for t in active if t.status == "matched"),
            "manual": sum(1 for t in active if t.status == "manual"),
            "browse": sum(
                1 for t in active
                if t.status == "success" and t.result_review_status != "passed"
            ),
            "error": sum(1 for t in active if self._is_pending_exception_locked(t)),
            "completed": counts["completed_count"],
        }
        counts["latest_batch"] = latest
        return counts

    def _ts(self) -> str:
        return datetime.now().strftime("%H:%M:%S")

    def _file_exists_for(self, filename: str) -> bool:
        return any((d / filename).exists() for d in _business_image_dirs())

    def _is_upload_record(self, t: TaskRecord) -> bool:
        return t.source in UPLOAD_SOURCES

    def _needs_image_entity(self, t: TaskRecord) -> bool:
        return t.status not in {"ignored", "canceled"} and t.exception_state != "ignored"

    def _completed_pdf_exists_locked(self, t: TaskRecord) -> bool:
        pdf_name = (
            t.expected_output_pdf
            or t.output_pdf
            or t.matched_pdf
            or t.selected_pdf
            or t.original_pdf
        )
        if not pdf_name:
            return False
        bases = []
        try:
            if cfg:
                bases.append(Path(cfg["signed_path"]))
        except Exception:
            pass
        bases.append(_BASE / "completed")
        seen = set()
        for base in bases:
            key = str(base)
            if key in seen:
                continue
            seen.add(key)
            candidates = []
            if t.category:
                candidates.append(base / t.category / pdf_name)
            candidates.append(base / pdf_name)
            if any(p.exists() for p in candidates):
                return True
            if base.exists():
                try:
                    if next(base.rglob(pdf_name), None):
                        return True
                except Exception:
                    pass
        return False

    def _is_completed_record_locked(self, t: TaskRecord) -> bool:
        return (
            (
                t.status in {"completed", "success"}
                or t.stage == "archive"
                or t.result_review_status == "passed"
                or bool(t.output_pdf)
            )
            and self._completed_pdf_exists_locked(t)
        )

    def mark_missing_output(self, task_id: str, pdf_name: str, reason: str) -> bool:
        with self._lock:
            t = self._tasks.get(task_id)
            if not t or t.status in {"ignored", "canceled", "cancelled"}:
                return False
            if (
                t.status == "missing_output"
                and t.exception_type == "missing_output"
                and t.expected_output_pdf == pdf_name
            ):
                return True
            t.status = "missing_output"
            t.stage = "archive"
            t.expected_output_pdf = pdf_name
            t.missing_output = True
            t.last_error = "输出PDF缺失"
            t.exception_state = "resolved"
            t.exception_type = "missing_output"
            t.exception_reason = reason
            t.message = reason
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({
                "time": self._ts(),
                "text": f"缺失输出：{pdf_name}；{reason}",
                "level": "red",
            })
            return True

    def upsert_reconciliation_exception(self, pdf_name: str, image_name: str, reason: str) -> str:
        task_id = "recon-" + uuid.uuid5(uuid.NAMESPACE_URL, pdf_name.lower()).hex[:12]
        now = datetime.now().isoformat()
        with self._lock:
            t = self._tasks.get(task_id)
            if t is None:
                t = TaskRecord(
                    id=task_id,
                    filename=image_name or pdf_name,
                    status="failed",
                    stage="failed",
                    original_pdf=pdf_name,
                    expected_output_pdf=pdf_name,
                    source="reconciliation",
                    exception_state="pending",
                    exception_type="missing_output",
                    exception_reason=reason,
                    message=reason,
                    created_at=now,
                    updated_at=now,
                    timeline=[{
                        "time": self._ts(),
                        "text": f"文件级对账发现缺失输出：{pdf_name}",
                        "level": "red",
                    }],
                )
                self._tasks[task_id] = t
            else:
                t.filename = image_name or t.filename
                t.status = "failed"
                t.stage = "failed"
                t.original_pdf = pdf_name
                t.expected_output_pdf = pdf_name
                t.exception_state = "pending"
                t.exception_type = "missing_output"
                t.exception_reason = reason
                t.message = reason
                t.updated_at = now
            return task_id

    def resolve_reconciliation_exceptions(self, missing_pdf_names: set[str]) -> None:
        with self._lock:
            for t in self._tasks.values():
                if t.exception_type != "missing_output":
                    continue
                pdf_name = t.expected_output_pdf or t.original_pdf
                if pdf_name in missing_pdf_names:
                    continue
                if not self._completed_pdf_exists_locked(t):
                    continue
                t.status = "completed" if t.source == "reconciliation" else "success"
                t.stage = "archive"
                t.exception_state = "resolved"
                t.exception_reason = ""
                t.exception_type = ""
                t.missing_output = False
                t.last_error = ""
                t.message = f"缺失输出已补齐：{pdf_name}"
                t.output_pdf = pdf_name
                t.expected_output_pdf = ""
                if t.source != "reconciliation":
                    t.result_review_status = "pending"
                t.updated_at = datetime.now().isoformat()

    def _is_pending_exception_locked(self, t: TaskRecord) -> bool:
        return (
            t.status == "failed"
            and t.exception_type != "missing_output"
            and t.exception_state == "pending"
            and t.status not in {"ignored", "canceled", "cancelled"}
            and t.result_review_status != "passed"
        )

    def _warn_completed_image_missing_locked(self, t: TaskRecord):
        warning_text = f"警告：{MISSING_IMAGE_REASON}，任务已完成，不改变完成状态"
        if not any(item.get("text") == warning_text for item in t.timeline if isinstance(item, dict)):
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": warning_text, "level": "amber"})

    def _mark_image_missing_locked(self, t: TaskRecord):
        if (
            self._is_completed_record_locked(t)
            or t.status in {"success", "completed", "missing_output"}
            or bool(t.output_pdf)
        ):
            self._warn_completed_image_missing_locked(t)
            return
        if t.status == "failed" and t.exception_type == MISSING_IMAGE_TYPE:
            if t.exception_state == "pending":
                t.exception_state = "expired"
                t.exception_reason = MISSING_IMAGE_REASON
                t.updated_at = datetime.now().isoformat()
                t.timeline.append({"time": self._ts(), "text": f"异常已失效：{MISSING_IMAGE_REASON}", "level": "amber"})
            return
        t.status = "failed"
        t.stage = "failed"
        t.message = MISSING_IMAGE_REASON
        t.exception_state = "expired"
        t.exception_type = MISSING_IMAGE_TYPE
        t.exception_reason = MISSING_IMAGE_REASON
        t.updated_at = datetime.now().isoformat()
        t.timeline.append({"time": self._ts(), "text": f"异常已失效：{MISSING_IMAGE_REASON}", "level": "amber"})

    def _refresh_missing_images_locked(self):
        for t in self._tasks.values():
            if self._is_upload_record(t) and self._needs_image_entity(t) and not self._file_exists_for(t.filename):
                self._mark_image_missing_locked(t)

    def _exception_type(self, t: TaskRecord) -> str:
        msg = (t.message or "").lower()
        if not self._file_exists_for(t.filename):
            return MISSING_IMAGE_TYPE
        if any(x in msg for x in ["empty", "为空", "0 bytes", "zero"]):
            return "file_empty"
        if any(x in msg for x in ["cannot identify image", "pillow", "decode", "解码"]):
            return "image_decode"
        if any(x in msg for x in ["timeout", "超时"]):
            return "ocr_timeout" if "ocr" in msg or t.stage == "ocr" else "timeout"
        if "ocr" in msg or t.stage == "ocr":
            return "ocr_failed"
        if "passport" in msg or "护照" in msg:
            return "passport_missing"
        if "pdf" in msg:
            return "pdf_missing" if any(x in msg for x in ["not found", "未找到", "missing"]) else "pdf_error"
        return "file_read"

    def _exception_reason(self, t: TaskRecord) -> str:
        return {
            MISSING_IMAGE_TYPE: MISSING_IMAGE_REASON,
            "file_empty": "文件为空",
            "image_decode": "图片编码不支持",
            "ocr_timeout": "OCR处理超时",
            "ocr_failed": "OCR识别失败",
            "passport_missing": "未识别护照号",
            "pdf_missing": "未找到对应PDF",
            "multiple_candidates": "PDF匹配冲突",
            "pdf_error": "PDF无法打开",
            "workflow_anomaly": "流程异常",
            "timeout": "处理超时",
            "file_read": "系统无法打开该文件",
        }.get(self._exception_type(t), "处理失败")

    def _pending_exception_type_locked(self, t: TaskRecord, status_hint: str = "") -> str:
        if t.exception_type:
            return t.exception_type
        status = (status_hint or t.status or "").lower()
        msg = (t.message or t.exception_reason or "").lower()
        if status in {"approval", "pending_confirm"} or "冲突" in msg or "多个" in msg or "multiple" in msg:
            return "multiple_candidates"
        if "passport" in msg or "护照" in msg:
            return "passport_missing"
        if "ocr" in msg or "识别" in msg or (status == "unmatched" and not (t.name or "").strip()):
            return "ocr_failed"
        if "pdf" in msg:
            return "pdf_missing" if any(x in msg for x in ["not found", "未找到", "missing", "缺少"]) else "pdf_error"
        if "匹配" in msg or "未找到" in msg or status == "unmatched":
            return "pdf_missing"
        return self._exception_type(t) or "workflow_anomaly"

    def _pending_exception_reason_locked(self, t: TaskRecord, exception_type: str) -> str:
        if t.exception_reason:
            return t.exception_reason
        if t.message:
            return t.message
        return {
            "ocr_failed": "OCR识别失败",
            "passport_missing": "未识别护照号",
            "pdf_missing": "未找到对应PDF",
            "multiple_candidates": "PDF匹配冲突，等待人工选择PDF",
            "workflow_anomaly": "流程异常",
        }.get(exception_type, "处理失败")

    def _set_pending_exception_locked(self, t: TaskRecord, exception_type: str = "",
                                      reason: str = "", timeline_text: str = ""):
        if t.result_review_status == "passed" or t.status in {"ignored", "canceled", "cancelled"}:
            return
        status_hint = t.status
        resolved_type = exception_type or self._pending_exception_type_locked(t, status_hint)
        t.status = "failed"
        t.stage = "failed"
        t.exception_state = "pending"
        t.exception_type = resolved_type
        t.exception_reason = reason or self._pending_exception_reason_locked(t, resolved_type)
        if not t.message:
            t.message = t.exception_reason
        t.updated_at = datetime.now().isoformat()
        if timeline_text:
            t.timeline.append({"time": self._ts(), "text": timeline_text, "level": "red"})

    def _normalize_exception_states_locked(self):
        for t in self._tasks.values():
            if (
                t.status in {"queued", "processing", "warning", "matched", "manual"}
                and t.stage in {"replace", "archive"}
                and (t.matched_pdf or t.selected_pdf or t.original_pdf)
                and self._completed_pdf_exists_locked(t)
            ):
                out_path = _task_output_pdf_path(t)
                t.status = "success"
                t.stage = "archive"
                t.output_pdf = out_path.name if out_path else (t.matched_pdf or t.selected_pdf or t.original_pdf)
                t.expected_output_pdf = ""
                t.exception_state = "resolved"
                t.exception_reason = ""
                t.exception_type = ""
                if not t.result_review_status:
                    t.result_review_status = "pending"
                t.message = f"已检测到输出PDF，自动恢复完成状态：{t.output_pdf}"
                t.updated_at = datetime.now().isoformat()
                t.timeline.append({"time": self._ts(), "text": t.message, "level": "green"})
            if t.status in {"ignored", "canceled", "cancelled", "success", "completed", "missing_output"}:
                continue
            if t.result_review_status == "passed" or t.exception_state in {"resolved", "ignored", "expired"}:
                continue
            if t.status in {"unmatched", "approval", "pending_confirm"}:
                original_status = t.status
                etype = self._pending_exception_type_locked(t, original_status)
                self._set_pending_exception_locked(
                    t,
                    etype,
                    self._pending_exception_reason_locked(t, etype),
                )
            elif t.status == "failed":
                if t.exception_state != "pending" or not t.exception_type:
                    etype = self._pending_exception_type_locked(t, "failed")
                    self._set_pending_exception_locked(
                        t,
                        etype,
                        self._pending_exception_reason_locked(t, etype),
                    )

    def cleanup_exceptions(self):
        now = datetime.now()
        with self._lock:
            self._refresh_missing_images_locked()
            self._normalize_exception_states_locked()
            for t in self._tasks.values():
                if self._is_completed_record_locked(t):
                    if not self._file_exists_for(t.filename):
                        self._warn_completed_image_missing_locked(t)
                    continue
                if t.status == "failed" and t.exception_state == "pending":
                    expired_by_age = False
                    try:
                        expired_by_age = (now - datetime.fromisoformat(t.updated_at)).total_seconds() > 86400
                    except Exception:
                        pass
                    if t.exception_type == MISSING_IMAGE_TYPE or expired_by_age or not self._file_exists_for(t.filename):
                        t.exception_state = "expired"
                        t.exception_type = self._exception_type(t)
                        t.exception_reason = MISSING_IMAGE_REASON if t.exception_type == MISSING_IMAGE_TYPE else ("文件已不存在" if not self._file_exists_for(t.filename) else "超过24小时未处理")
                        t.updated_at = now.isoformat()
                        t.timeline.append({"time": self._ts(), "text": f"异常已失效：{t.exception_reason}", "level": "amber"})

    def new_task(self, filename: str, source: str = "folder") -> str:
        tid = str(uuid.uuid4())[:8]
        record = TaskRecord(
            id=tid, filename=filename, source=source,
            timeline=[{"time": self._ts(), "text": "文件已接收，加入处理队列", "level": "green"}]
        )
        with self._lock:
            old_tid = self._by_filename.get(filename)
            old = self._tasks.get(old_tid) if old_tid else None
            if old and old.status == "failed" and old.exception_state == "pending":
                old.exception_state = "resolved"
                old.exception_reason = "已重新上传或重新处理"
                old.updated_at = datetime.now().isoformat()
                old.timeline.append({"time": self._ts(), "text": "异常已解决，已重新进入处理流程", "level": "green"})
            self._tasks[tid] = record
            self._by_filename[filename] = tid
        return tid

    def start_task(self, filename: str):
        with self._lock:
            tid = self._by_filename.get(filename)
            if not (tid and tid in self._tasks):
                return
            t = self._tasks[tid]
            if t.status in {"paused", "manual", "canceled", "ignored"}:
                return
            t.status = "processing"
            t.stage  = "replace" if (t.manual_pdf_confirmed or t.filename_verify_status == "passed") else "ocr"
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": "开始处理", "level": "blue"})

    def update_ocr_stage(self, filename: str, ocr_text: str):
        with self._lock:
            tid = self._by_filename.get(filename)
            if not (tid and tid in self._tasks):
                return
            t = self._tasks[tid]
            if t.status in {"paused", "manual", "canceled", "ignored"}:
                return
            t.stage = "warp"
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(),
                                "text": f"OCR 完成 → {ocr_text[:80]}", "level": "blue"})

    def complete_task(self, result: Result):
        with self._lock:
            self._reset_if_new_day()
            tid = self._by_filename.get(result.filename)
            if not tid:
                tid = str(uuid.uuid4())[:8]
                self._tasks[tid] = TaskRecord(id=tid, filename=result.filename,
                                              timeline=[{"time": self._ts(),
                                                         "text": "文件已接收", "level": "green"}])
                self._by_filename[result.filename] = tid

            t = self._tasks[tid]
            if t.status in {"paused", "manual", "canceled", "ignored"}:
                t.timeline.append({"time": self._ts(), "text": "自动处理结果已忽略，任务已由人工接管/停止", "level": "amber"})
                t.updated_at = datetime.now().isoformat()
                return
            t.status      = result.status
            t.name        = result.name
            t.passport_no = result.passport_no
            t.category    = result.category
            t.message     = result.message
            t.match_basis = result.match_basis
            if result.matched_pdf:
                t.matched_pdf = result.matched_pdf
            t.candidates  = result.candidates
            t.updated_at  = datetime.now().isoformat()

            if result.status == "matched":
                t.status = "matched"
                t.stage = "warp"
                t.exception_state = "resolved"
                t.exception_reason = ""
                t.exception_type = ""
                t.filename_verify_status = "pending"
                t.timeline.append({"time": self._ts(),
                                    "text": f"PDF匹配完成，等待文件名核验：{result.matched_pdf}", "level": "blue"})
                self._today_count += 1

            elif result.status == "success":
                t.exception_state = "resolved"
                t.exception_reason = ""
                t.exception_type = ""
                t.missing_output = False
                t.last_error = ""
                t.stage = "archive"
                t.output_pdf = result.matched_pdf or t.matched_pdf or t.output_pdf
                t.expected_output_pdf = ""
                t.result_review_status = "pending"
                if not t.filename_verify_status:
                    t.filename_verify_status = "passed"
                pp = f" · 护照号 {result.passport_no}" if result.passport_no else ""
                cat = f" · [{result.category}]" if result.category else ""
                t.timeline.extend([
                    {"time": self._ts(), "text": f"OCR 识别成功{pp}", "level": "green"},
                    {"time": self._ts(), "text": "透视矫正 · 整页替换完成", "level": "green"},
                    {"time": self._ts(), "text": f"已归档{cat}", "level": "green"},
                ])
                self._today_count   += 1
                self._success_count += 1

            elif result.status == "failed":
                etype = self._pending_exception_type_locked(t, "failed")
                self._set_pending_exception_locked(
                    t,
                    etype,
                    self._pending_exception_reason_locked(t, etype),
                    f"处理失败: {result.message}"
                )
                self._today_count  += 1
                self._failed_count += 1

            elif result.status == "approval":
                self._set_pending_exception_locked(
                    t,
                    "multiple_candidates",
                    result.message or "PDF匹配冲突，等待人工选择PDF",
                    "发现多个同名文件，已进入异常处理"
                )
                self._today_count += 1
                self._failed_count += 1

            elif result.status == "unmatched":
                etype = self._pending_exception_type_locked(t, "unmatched")
                self._set_pending_exception_locked(
                    t,
                    etype,
                    result.message or self._pending_exception_reason_locked(t, etype),
                    result.message or "未找到匹配，已进入异常处理"
                )
                self._today_count += 1
                self._failed_count += 1

    def get_all(self) -> list:
        self.cleanup_exceptions()
        with self._lock:
            self._normalize_exception_states_locked()
            tasks = list(self._tasks.values())
        tasks.sort(key=lambda t: t.updated_at, reverse=True)
        return tasks

    def get_open_exceptions(self) -> list:
        self.cleanup_exceptions()
        with self._lock:
            self._normalize_exception_states_locked()
            items = [t for t in self._tasks.values()
                     if self._is_pending_exception_locked(t)]
        items.sort(key=lambda t: t.updated_at, reverse=True)
        return items

    def get_exception_history(self) -> list:
        self.cleanup_exceptions()
        with self._lock:
            items = [t for t in self._tasks.values()
                     if t.exception_state in {"resolved", "ignored", "expired"}]
        items.sort(key=lambda t: t.updated_at, reverse=True)
        return items

    def _workspace_state_locked(self) -> dict:
        self._normalize_exception_states_locked()
        rows = list(self._tasks.values())
        active = [t for t in rows
                  if t.status not in {"ignored", "canceled", "cancelled"}
                  and t.exception_state != "ignored"]
        processing = [t for t in active
                      if t.status in {"queued", "processing", "warning", "paused"}]
        filename_verify = [t for t in active
                           if t.status == "matched"
                           and t.filename_verify_status == "pending"
                           and t.exception_state != "pending"
                           and bool((t.name or "").strip())
                           and bool((t.matched_pdf or t.original_pdf or "").strip())]
        manual = [t for t in active if t.status == "manual"]
        result_review = [t for t in active
                         if t.status == "success"
                         and t.result_review_status != "passed"]
        pending_exceptions = [t for t in active
                              if self._is_pending_exception_locked(t)]
        incomplete = [t for t in active
                      if not (self._is_completed_record_locked(t)
                              or (t.status == "failed"
                                  and t.exception_state in {"resolved", "expired"}))]
        clearable = bool(rows) and not (
            processing or filename_verify or manual or result_review
            or pending_exceptions or incomplete
        )
        return {
            "has_tasks": bool(rows),
            "task_count": len(rows),
            "active_count": len(active),
            "processing": len(processing),
            "filename_verify": len(filename_verify),
            "manual": len(manual),
            "result_review": len(result_review),
            "pending_exceptions": len(pending_exceptions),
            "incomplete": len(incomplete),
            "complete": clearable,
            "clearable": clearable,
        }

    def get_workspace_state(self) -> dict:
        with self._lock:
            return self._workspace_state_locked()

    def clear_completed_workspace(self) -> tuple[bool, str, int]:
        with self._lock:
            if not self._workspace_state_locked()["clearable"]:
                return False, "仍有未完成任务，请处理完成后再清空工作台。", 0
            cleared = len(self._tasks)
            self._tasks.clear()
            self._by_filename.clear()
            self._today_count = 0
            self._success_count = 0
            self._failed_count = 0
            self._session_date = datetime.now().date()
        self._save()
        return True, "工作台已清空，已生成PDF保留在 completed 文件夹", cleared

    def get(self, tid: str) -> Optional[TaskRecord]:
        with self._lock:
            return self._tasks.get(tid)

    def get_by_filename(self, filename: str) -> Optional[TaskRecord]:
        with self._lock:
            tid = self._by_filename.get(filename)
            t = self._tasks.get(tid) if tid else None
            if t:
                return t
            return next((x for x in self._tasks.values() if x.filename == filename), None)

    def ensure_exception_task(self, filename: str, status: str, reason: str = "",
                              name: str = "", passport_no: str = "",
                              candidates: list | None = None,
                              exception_type: str = "") -> str:
        with self._lock:
            tid = self._by_filename.get(filename)
            t = self._tasks.get(tid) if tid else None
            if not t:
                t = next((x for x in self._tasks.values() if x.filename == filename), None)
                tid = t.id if t else ""
            if t:
                if tid:
                    self._by_filename[filename] = tid
                if t.exception_state not in {"resolved", "ignored", "expired"}:
                    etype = exception_type or self._pending_exception_type_locked(t, status)
                    self._set_pending_exception_locked(
                        t,
                        etype,
                        reason or self._pending_exception_reason_locked(t, etype),
                    )
                return t.id
            tid = str(uuid.uuid4())[:8]
            now = datetime.now().isoformat()
            etype = exception_type or (
                "multiple_candidates" if status in {"approval", "pending_confirm"} else "pdf_missing"
            )
            record = TaskRecord(
                id=tid,
                filename=filename,
                status="failed",
                stage="failed",
                name=name or "",
                passport_no=passport_no or "",
                message=reason or "等待人工选择PDF",
                candidates=candidates or [],
                source="upload",
                exception_state="pending",
                exception_reason=reason or "等待人工选择PDF",
                exception_type=etype,
                created_at=now,
                updated_at=now,
                timeline=[{"time": self._ts(), "text": "异常任务已恢复，等待人工选择PDF", "level": "amber"}]
            )
            self._tasks[tid] = record
            self._by_filename[filename] = tid
            return tid

    def status_for_file(self, filename: str) -> str:
        with self._lock:
            tid = self._by_filename.get(filename)
            t = self._tasks.get(tid) if tid else None
            if not t:
                t = next((x for x in self._tasks.values() if x.filename == filename), None)
            return t.status if t else ""

    def rename_task_file(self, old_filename: str, new_filename: str):
        with self._lock:
            tid = self._by_filename.get(old_filename)
            t = self._tasks.get(tid) if tid else None
            if not t:
                return
            t.filename = new_filename
            t.updated_at = datetime.now().isoformat()
            self._by_filename.pop(old_filename, None)
            self._by_filename[new_filename] = tid

    def update_image_path(self, task_id: str, old_filename: str, new_path: "Path"):
        with self._lock:
            t = self._tasks.get(task_id)
            if not t:
                return
            t.filename = new_path.name
            t.current_image_path = str(new_path)
            t.updated_at = datetime.now().isoformat()
            self._by_filename.pop(old_filename, None)
            self._by_filename[new_path.name] = task_id

    def is_stopped(self, filename: str) -> bool:
        return self.status_for_file(filename) in {"paused", "manual", "canceled", "ignored"}

    def control_task(self, tid: str, action: str) -> tuple[bool, str]:
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return False, "任务不存在"
            now = datetime.now().isoformat()
            mapping = {
                "pause": ("paused", "已暂停"),
                "manual": ("manual", "人工处理中"),
                "cancel": ("canceled", "已取消"),
                "ignore": ("ignored", "已忽略"),
                "resume": ("processing", "处理中"),
                "manual_complete": ("success", "已完成"),
            }
            if action not in mapping:
                return False, "未知操作"
            if action == "manual_complete" and not self._completed_pdf_exists_locked(t):
                return False, "输出PDF不存在，不能标记完成"
            terminal = {"success", "canceled", "ignored"}
            if t.status in {"success", "completed"} and action in {"pause", "cancel", "ignore"}:
                return False, "任务已完成，不能执行该操作"
            if t.status == "canceled" and action == "cancel":
                return False, "任务已取消，不能重复取消"
            if t.status == "ignored" and action == "ignore":
                return False, "任务已忽略，不能重复忽略"
            allowed = {
                "pause": {"processing", "queued"},
                "manual": {"processing", "queued", "paused", "failed", "success", "completed"},
                "cancel": {"processing", "queued", "paused", "failed", "manual"},
                "ignore": {"failed"},
                "resume": {"paused", "manual"},
                "manual_complete": {"manual", "success", "completed"},
            }
            if t.status not in allowed[action]:
                status_label = {
                    "queued": "排队中", "processing": "处理中", "success": "已完成", "completed": "已完成",
                    "failed": "失败/异常", "paused": "已暂停", "manual": "人工处理中",
                    "canceled": "已取消", "ignored": "已忽略"
                }.get(t.status, t.status)
                return False, f"当前状态为“{status_label}”，不允许该操作"
            new_status, label = mapping[action]
            t.status = new_status
            if action in {"cancel", "ignore"}:
                t.exception_state = "ignored" if action == "ignore" else "resolved"
            if action == "manual":
                t.exception_state = "resolved"
            if action == "manual_complete":
                t.exception_state = "resolved"
                t.stage = "archive"
                t.result_review_status = "passed"
                t.status = "completed"
                self._success_count += 1
            t.updated_at = now
            t.timeline.append({"time": self._ts(), "text": f"状态改为：{label}", "level": "amber" if action != "resume" else "blue"})
            return True, ""

    def mark_exception(self, tid: str, state: str, reason: str = "") -> bool:
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return False
            t.exception_state = state
            if reason:
                t.exception_reason = reason
            t.updated_at = datetime.now().isoformat()
            level = "green" if state == "resolved" else "amber"
            label = {"resolved": "已解决", "ignored": "已忽略", "expired": "已失效"}.get(state, state)
            t.timeline.append({"time": self._ts(), "text": f"异常{label}", "level": level})
            return True

    def add_exception_history(self, filename: str, state: str, reason: str, exception_type: str,
                              name: str = "", passport_no: str = ""):
        tid = str(uuid.uuid4())[:8]
        now = datetime.now().isoformat()
        record = TaskRecord(
            id=tid,
            filename=filename,
            status="failed",
            stage="failed",
            name=name,
            passport_no=passport_no,
            message=reason,
            exception_state=state,
            exception_reason=reason,
            exception_type=exception_type,
            created_at=now,
            updated_at=now,
            timeline=[{"time": self._ts(), "text": f"异常已{ {'ignored':'忽略','expired':'失效','resolved':'解决'}.get(state, state) }：{reason}", "level": "amber"}]
        )
        with self._lock:
            self._tasks[tid] = record
        return tid

    def clear_expired(self) -> int:
        with self._lock:
            expired = [tid for tid, t in self._tasks.items() if t.exception_state == "expired"]
            for tid in expired:
                t = self._tasks.pop(tid, None)
                if t and self._by_filename.get(t.filename) == tid:
                    self._by_filename.pop(t.filename, None)
            return len(expired)

    def save_preview_rotation(self, filename: str, rotation: int) -> int:
        normalized = rotation % 360
        changed = 0
        with self._lock:
            for t in self._tasks.values():
                if t.filename == filename:
                    t.preview_rotation = normalized
                    t.updated_at = datetime.now().isoformat()
                    t.timeline.append({"time": self._ts(), "text": f"预览旋转方向已保存：{normalized}°", "level": "blue"})
                    changed += 1
        return changed

    def mark_retrying(self, tid: str):
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return
            t.status = "processing"
            t.stage = "ocr"
            t.message = "重新处理中..."
            t.exception_state = "resolved"
            t.exception_reason = "已重新加入处理队列"
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": "已重新加入处理队列", "level": "blue"})
            self._by_filename[t.filename] = tid

    def bind_manual_pdf(self, tid: str, pdf_name: str):
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return
            t.selected_pdf = pdf_name
            t.matched_pdf = pdf_name
            t.original_pdf = pdf_name
            t.expected_output_pdf = ""
            t.manual_pdf_confirmed = True
            t.match_basis = "人工选择PDF"
            t.filename_verify_status = "manual_confirmed"
            t.exception_state = "resolved"
            t.exception_reason = ""
            t.exception_type = ""
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": f"人工确认PDF已通过：{pdf_name}", "level": "blue"})

    def mark_manual_pdf_generating(self, tid: str):
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return
            t.status = "processing"
            t.stage = "replace"
            t.message = "人工选择PDF后生成中..."
            t.result_review_status = ""
            t.exception_state = "resolved"
            t.exception_reason = ""
            t.exception_type = ""
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": "人工选择PDF后，直接进入首页替换与生成PDF", "level": "blue"})

    def mark_filename_verified_generating(self, tid: str):
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return
            t.status = "processing"
            t.stage = "replace"
            t.message = "文件名核验通过，生成PDF中..."
            t.result_review_status = ""
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": "文件名核验通过，开始首页替换与生成PDF", "level": "blue"})

    def mark_filename_verify_passed(self, tid: str) -> bool:
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return False
            t.filename_verify_status = "passed"
            t.updated_at = datetime.now().isoformat()
            t.timeline.append({"time": self._ts(), "text": "文件名核验通过，进入首页替换与PDF生成", "level": "green"})
            return True

    def is_filename_verified(self, filename: str) -> bool:
        with self._lock:
            tid = self._by_filename.get(filename)
            t = self._tasks.get(tid) if tid else None
            return bool(t and (t.filename_verify_status == "passed" or t.manual_pdf_confirmed))

    def mark_workflow_anomaly(self, tid: str) -> bool:
        with self._lock:
            t = self._tasks.get(tid)
            if not t:
                return False
            self._set_pending_exception_locked(
                t,
                "workflow_anomaly",
                "该任务在文件名核验通过前已生成PDF，请重新核验。",
                "该任务在文件名核验通过前已生成PDF，请重新核验。"
            )
            return True

    def get_stats(self) -> dict:
        self._reset_if_new_day()
        success_statuses = {"success", "completed"}
        processing_statuses = {"queued", "processing", "warning", "paused", "manual"}
        with self._lock:
            self._refresh_missing_images_locked()
            self._normalize_exception_states_locked()
            rows = [t for t in self._tasks.values()
                    if self._is_upload_record(t) and t.exception_state != "ignored"]
            task_upload_total = len(rows)
            success = sum(
                1 for t in rows
                if t.status in success_statuses and self._completed_pdf_exists_locked(t)
            )
            confirm = sum(1 for t in rows
                          if t.status == "matched"
                          and t.filename_verify_status == "pending"
                          and t.exception_state != "pending")
            processing = sum(1 for t in rows if t.status in processing_statuses)
            pending_exceptions = sum(1 for t in rows if self._is_pending_exception_locked(t))
            failed = pending_exceptions
            missing = sum(1 for t in rows
                          if t.status == "failed" and t.exception_type == MISSING_IMAGE_TYPE)
            task_total = len([t for t in self._tasks.values() if t.exception_state != "ignored"])
            unique_filenames = len(set(t.filename for t in rows))
        file_counts = _business_image_counts()
        tracked_files = file_counts["filesystem_total"]
        directory_image_total = file_counts["uploads_tree"]
        consistency_ok = task_upload_total == tracked_files
        file_delta = task_upload_total - tracked_files
        if consistency_ok:
            consistency_message = ""
        elif file_delta > 0:
            consistency_message = f"任务记录 {task_upload_total} 张，当前可追踪图片 {tracked_files} 张，缺失 {file_delta} 张。"
        else:
            consistency_message = f"任务记录 {task_upload_total} 张，当前可追踪图片 {tracked_files} 张，多出 {abs(file_delta)} 张。"
        upload_counts = self.get_upload_counts()
        return {
            "today": upload_counts["saved_count"],
            "upload_total": upload_counts["saved_count"],
            "today_saved_count": upload_counts["saved_count"],
            "directory_image_total": directory_image_total,
            "actual_saved_files": upload_counts["saved_count"],
            "upload_counts": upload_counts,
            "task_counts": upload_counts["task_counts"],
            "selected_count": upload_counts["selected_count"],
            "sent_count": upload_counts["sent_count"],
            "received_count": upload_counts["received_count"],
            "saved_count": upload_counts["saved_count"],
            "skipped_count": upload_counts["skipped_count"],
            "upload_failed_count": upload_counts["failed_count"],
            "queued_count": upload_counts["queued_count"],
            "processing_count": upload_counts["processing_count"],
            "completed_count": upload_counts["completed_count"],
            "task_total": task_total,
            "upload_task_total": task_upload_total,
            "unique_upload_filenames": unique_filenames,
            "success":  success,
            "failed":   failed,
            "pending_exceptions": pending_exceptions,
            "processing": processing,
            "confirm":  confirm,
            "pending":  file_counts["pending_dir"],
            "approval": file_counts["approval_dir"],
            "tracked_files_total": tracked_files,
            "missing_files": max(0, file_delta),
            "file_delta": file_delta,
            "missing_entity_tasks": missing,
            "file_task_consistency_ok": consistency_ok,
            "consistency_message": consistency_message,
            "invariant_total": success + failed + processing + confirm,
            "invariant_ok": task_upload_total == success + failed + processing + confirm,
        }


# ═══════════════════════════════════════════════════════════════════════════
# 核心处理器（逻辑不变）
# ═══════════════════════════════════════════════════════════════════════════

class Processor:
    _ocr              = None
    _ocr_lock         = threading.Lock()
    _output_claim_lock = threading.Lock()
    _output_claims: dict[str, str] = {}
    _ocr_loading      = False
    ocr_ready         = threading.Event()
    _ocr_startup_done = threading.Event()  # set after warmup succeeds OR fails
    _ocr_ch           = None
    _ocr_ch_lock      = threading.Lock()
    _ocr_ch_loading   = False
    ocr_ch_ready      = threading.Event()

    def __init__(self, cfg_obj: Config, result_queue: "queue.Queue[Result]"):
        self.cfg   = cfg_obj
        self.rq    = result_queue
        self._pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="sig")

    @classmethod
    def init_ocr_async(cls):
        if not _OCR_OK:
            print("  [OCR] PaddleOCR not installed; OCR disabled", flush=True)
            cls._ocr_startup_done.set()
            return
        if cls._ocr is not None:
            cls.ocr_ready.set()
            cls._ocr_startup_done.set()
            return
        if not cls._ocr_loading:
            print("  [OCR] PaddleOCR loading in background", flush=True)
            threading.Thread(target=cls._load_ocr, daemon=True, name="ocr-warmup").start()

    @classmethod
    def _load_ocr(cls):
        with cls._ocr_lock:
            if cls._ocr is not None or cls._ocr_loading:
                return
            cls._ocr_loading = True
        t0 = time.time()
        try:
            print("  [OCR] PaddleOCR warmup started", flush=True)
            ocr_variants = [
                {"use_angle_cls": True, "lang": "en", "use_gpu": False, "show_log": False},
                {"use_angle_cls": True, "lang": "en", "use_gpu": False},
                {"use_angle_cls": True, "lang": "en"},
                {"use_textline_orientation": True, "lang": "en"},
                {"lang": "en"},
            ]
            last_error = None
            for kwargs in ocr_variants:
                try:
                    r = _PaddleOCR(**kwargs)
                    break
                except (TypeError, ValueError) as e:
                    if "Unknown argument" not in str(e) and "unexpected keyword" not in str(e):
                        raise
                    last_error = e
            else:
                raise last_error
            # Warm up with a blank image. PaddleOCR 2.x accepts cls=...;
            # PaddleOCR 3.x removed that keyword and uses the constructor flag.
            blank = np.ones((100, 100, 3), dtype=np.uint8) * 255
            try:
                r.ocr(blank, cls=True)
            except TypeError as e:
                if "cls" not in str(e) and "unexpected keyword" not in str(e):
                    raise
                r.ocr(blank)
            with cls._ocr_lock:
                cls._ocr = r
            cls.ocr_ready.set()
            print(f"  [OCR] PaddleOCR ready in {time.time()-t0:.1f}s", flush=True)
        except Exception as e:
            print(f"  [OCR] PaddleOCR startup failed: {e}", flush=True)
        finally:
            cls._ocr_loading = False
            cls._ocr_startup_done.set()  # always unblock waiting workers

    @classmethod
    def is_ocr_ready(cls) -> bool:
        return cls._ocr is not None

    @classmethod
    def is_ocr_ch_ready(cls) -> bool:
        return cls._ocr_ch is not None

    @classmethod
    def _load_ocr_ch(cls) -> bool:
        """Load PaddleOCR lang=ch synchronously; returns True if ready."""
        with cls._ocr_ch_lock:
            if cls._ocr_ch is not None:
                return True
            if cls._ocr_ch_loading:
                return False
            cls._ocr_ch_loading = True
        t0 = time.time()
        try:
            ocr_variants = [
                {"use_angle_cls": True, "lang": "ch", "use_gpu": False, "show_log": False},
                {"use_angle_cls": True, "lang": "ch", "use_gpu": False},
                {"use_angle_cls": True, "lang": "ch"},
                {"use_textline_orientation": True, "lang": "ch"},
                {"lang": "ch"},
            ]
            last_error = None
            for kwargs in ocr_variants:
                try:
                    r = _PaddleOCR(**kwargs)
                    break
                except (TypeError, ValueError) as e:
                    if "Unknown argument" not in str(e) and "unexpected keyword" not in str(e):
                        raise
                    last_error = e
            else:
                raise last_error
            blank = np.ones((100, 100, 3), dtype=np.uint8) * 255
            try:
                r.ocr(blank, cls=True)
            except TypeError as e:
                if "cls" not in str(e) and "unexpected keyword" not in str(e):
                    raise
                r.ocr(blank)
            with cls._ocr_ch_lock:
                cls._ocr_ch = r
            cls.ocr_ch_ready.set()
            print(f"  [OCR-CH] PaddleOCR (lang=ch) ready in {time.time()-t0:.1f}s", flush=True)
            return True
        except Exception as e:
            print(f"  [OCR-CH] PaddleOCR (lang=ch) failed: {e}", flush=True)
            return False
        finally:
            cls._ocr_ch_loading = False

    @staticmethod
    def _signature_rect(page_rect: fitz.Rect) -> fitz.Rect:
        return fitz.Rect(SIG_RECT_X0_PT, SIG_RECT_Y0_PT,
                         page_rect.width - SIG_RECT_RIGHT_PT, SIG_RECT_Y1_PT)

    @staticmethod
    def _detected_signature_rect(pdf_path: Path, page_rect: fitz.Rect) -> tuple:
        doc = fitz.open(str(pdf_path))
        try:
            page = doc[SIG_PAGE]
            for block in page.get_text("dict")["blocks"]:
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    text = "".join(span.get("text","") for span in line.get("spans",[]))
                    if ("수령자" in text or "签" in text) and ("인" in text or "（" in text or "(" in text):
                        r = fitz.Rect(line["bbox"])
                        rect = fitz.Rect(
                            max(0, r.x0 - 8), max(0, r.y0 - 20),
                            min(page_rect.width, page_rect.width - SIG_RECT_RIGHT_PT),
                            min(page_rect.height, r.y1 + 30),
                        )
                        return rect, "动态定位"
        finally:
            doc.close()
        return Processor._signature_rect(page_rect), "静态坐标"

    @staticmethod
    def _rect_to_px(rect: fitz.Rect) -> tuple:
        return (round(rect.x0*PT_TO_PX), round(rect.y0*PT_TO_PX),
                round(rect.x1*PT_TO_PX), round(rect.y1*PT_TO_PX))

    @staticmethod
    def _render_pdf_page(pdf_path: Path) -> tuple:
        doc = fitz.open(str(pdf_path))
        try:
            page     = doc[SIG_PAGE]
            page_rect = fitz.Rect(page.rect)
            pix      = page.get_pixmap(matrix=fitz.Matrix(PT_TO_PX, PT_TO_PX), alpha=False)
            arr      = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 1:   rendered = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
            elif pix.n == 3: rendered = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
            else:             rendered = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
            return rendered, page_rect
        finally:
            doc.close()

    @staticmethod
    def _gen_pdf_thumb(pdf_path: Path, size=(150, 200)) -> Optional[Image.Image]:
        THUMBS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            mtime = int(pdf_path.stat().st_mtime)
        except Exception:
            return None
        cache = THUMBS_DIR / f"{pdf_path.stem}_{mtime}.png"
        if cache.exists():
            try:
                return Image.open(cache).copy()
            except Exception:
                pass
        try:
            doc  = fitz.open(str(pdf_path))
            page = doc[0]
            scale = min(size[0]/page.rect.width, size[1]/page.rect.height) * 2
            pix  = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            img  = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            img.thumbnail(size, Image.LANCZOS)
            doc.close()
            img.save(str(cache), "PNG")
            return img
        except Exception:
            return None

    @staticmethod
    def _write_approval_meta(scan_path: Path, name: str, passport: str,
                             candidates: list, auto_candidate: Optional[str]=None):
        meta = {"name": name, "passport": passport, "candidates": candidates,
                "auto_candidate": auto_candidate, "created_at": datetime.now().isoformat()}
        mp = scan_path.parent / (scan_path.stem + ".json")
        try:
            mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    @staticmethod
    def _order_points(pts: np.ndarray) -> np.ndarray:
        pts  = pts.astype(np.float32)
        s    = pts.sum(axis=1)
        diff = np.diff(pts, axis=1).ravel()
        return np.array([pts[np.argmin(s)], pts[np.argmin(diff)],
                         pts[np.argmax(s)], pts[np.argmax(diff)]], dtype=np.float32)

    @staticmethod
    def _detect_paper(img: np.ndarray) -> Optional[np.ndarray]:
        gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5,5), 0)
        edges   = cv2.Canny(blurred, 50, 150)
        kernel  = cv2.getStructuringElement(cv2.MORPH_RECT, (3,3))
        edges   = cv2.dilate(edges, kernel, iterations=1)
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnts    = sorted(cnts, key=cv2.contourArea, reverse=True)
        img_area = img.shape[0] * img.shape[1]
        for cnt in cnts[:5]:
            if cv2.contourArea(cnt) < img_area * 0.1:
                break
            peri   = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.02*peri, True)
            if len(approx) == 4:
                pts     = approx.reshape(4,2).astype(np.float32)
                ordered = Processor._order_points(pts)
                top_w   = np.linalg.norm(ordered[1] - ordered[0])
                bot_w   = np.linalg.norm(ordered[2] - ordered[3])
                left_h  = np.linalg.norm(ordered[3] - ordered[0])
                right_h = np.linalg.norm(ordered[2] - ordered[1])
                w = max(top_w, bot_w); h = max(left_h, right_h)
                if h <= 0: continue
                if cv2.contourArea(cnt)/img_area >= 0.25 and 0.5 <= min(w,h)/max(w,h) <= 0.9:
                    return pts
        return None

    def _extract_sig(self, img: np.ndarray, pdf_path: Path):
        pdf_render, page_rect = self._render_pdf_page(pdf_path)
        page_h, page_w = pdf_render.shape[:2]

        corners = self._detect_paper(img)
        if corners is not None:
            ordered = self._order_points(corners)
            dst_pts = np.array([[0,0],[page_w-1,0],[page_w-1,page_h-1],[0,page_h-1]], dtype=np.float32)
            M = cv2.getPerspectiveTransform(ordered, dst_pts)
            warped = cv2.warpPerspective(img, M, (page_w, page_h))
        else:
            warped = cv2.resize(img, (page_w, page_h))

        sig_rect, _ = self._detected_signature_rect(pdf_path, page_rect)
        x1,y1,x2,y2 = self._rect_to_px(sig_rect)
        x1,y1 = max(0,x1), max(0,y1)
        x2,y2 = min(page_w,x2), min(page_h,y2)
        crop = warped[y1:y2, x1:x2]
        if crop.size == 0:
            raise ValueError(f"签字区域为空 (rendered={page_w}x{page_h}px)")

        rgba  = np.zeros((page_h, page_w, 4), dtype=np.uint8)
        debug = {"corners": corners, "warped": warped, "crop": crop}
        return rgba, debug, (x1, y1, x2, y2)

    def _run_extract_sig(self, img: np.ndarray, pdf_path: Path):
        fut = _warp_executor.submit(self._extract_sig, img, pdf_path)
        try:
            return fut.result(timeout=30)
        except FutureTimeoutError:
            raise ValueError("透视矫正超时（超过30秒），已自动跳过")

    def _ocr_fields(self, img: np.ndarray):
        with self._ocr_lock:
            reader = self._ocr
            if reader is None:
                return None, None, None
            try:
                result = reader.ocr(img, cls=True)
            except TypeError as e:
                if "cls" not in str(e) and "unexpected keyword" not in str(e):
                    raise
                result = reader.ocr(img)
        try:
            if not result:
                return None, None, None

            texts = []
            for page in result:
                if page is None:
                    continue
                if isinstance(page, dict):
                    rec_texts = page.get("rec_texts") or page.get("texts") or []
                    rec_scores = page.get("rec_scores") or page.get("scores") or [1.0] * len(rec_texts)
                    texts.extend(t for t, s in zip(rec_texts, rec_scores) if float(s or 0) > 0.5)
                    continue
                if hasattr(page, "get"):
                    rec_texts = page.get("rec_texts") or []
                    rec_scores = page.get("rec_scores") or [1.0] * len(rec_texts)
                    texts.extend(t for t, s in zip(rec_texts, rec_scores) if float(s or 0) > 0.5)
                    continue
                for line in page:
                    try:
                        if line[1][1] > 0.5:
                            texts.append(line[1][0])
                    except Exception:
                        continue

            text     = " ".join(str(t).upper() for t in texts)
            pm       = PASSPORT_RE.search(text)
            passport = pm.group(1) if pm else None
            clean    = PASSPORT_RE.sub(" ", text)
            nm       = NAME_RE.search(clean)
            name     = nm.group(1).strip() if nm else None
            return name, passport, text
        except Exception:
            return None, None, None

    @classmethod
    def _claim_output(cls, task: Optional[TaskRecord], pdf_name: str) -> tuple[bool, str]:
        task_id = task.id if task else ""
        with cls._output_claim_lock:
            owner_id = cls._output_claims.get(pdf_name)
            if owner_id and owner_id != task_id:
                return False, owner_id
            if task_store:
                for other in task_store.get_all():
                    if task and other.id == task.id:
                        continue
                    other_pdf = (
                        other.expected_output_pdf
                        or other.output_pdf
                        or other.matched_pdf
                        or other.selected_pdf
                        or other.original_pdf
                    )
                    if (
                        other_pdf == pdf_name
                        and other.status in {"success", "completed"}
                        and _task_output_pdf_exists(other)
                    ):
                        return False, other.id
            cls._output_claims[pdf_name] = task_id or "system"
            return True, ""

    @classmethod
    def _release_output_claim(cls, task: Optional[TaskRecord], pdf_name: str) -> None:
        task_id = task.id if task else "system"
        with cls._output_claim_lock:
            if cls._output_claims.get(pdf_name) == task_id:
                cls._output_claims.pop(pdf_name, None)

    @staticmethod
    def _name_from_stem(stem: str) -> str:
        parts = []
        for tok in re.split(r'[-_\s]', stem):
            tok = tok.strip()
            if not tok or len(tok) < 2: continue
            if any(c.isdigit() for c in tok): continue
            parts.append(tok.upper())
        return " ".join(parts)

    @staticmethod
    def _name_matches_stem(name_norm: str, stem_norm: str) -> bool:
        clean = re.sub(r'\b[a-z]{0,2}\d{4,}\b', '', stem_norm).strip()
        clean = re.sub(r'\s+', ' ', clean)
        if name_norm in clean:
            return True
        name_words = name_norm.split()
        stem_words = clean.split()
        if not stem_words:
            return False
        for nw in name_words:
            if len(nw) < 3:
                if nw not in stem_words: return False
            else:
                best = max((difflib.SequenceMatcher(None, nw, sw).ratio()
                            for sw in stem_words), default=0.0)
                if best < 0.80: return False
        return True

    def _find_pdfs_by_name(self, name: str) -> list:
        orig = Path(self.cfg["originals_path"])
        if not orig.exists(): return []
        name_norm = name.lower().replace("_"," ").strip()
        return [pdf for pdf in sorted(orig.rglob("*.pdf"))
                if self._name_matches_stem(name_norm, pdf.stem.lower().replace("_"," "))]

    @staticmethod
    def _write_pending_meta(scan_path: Path, reason: str,
                            name: str="", passport: str="", candidates: list=None,
                            raw_ocr: str="", category: str="", confidence: str=""):
        meta = {"reason": reason, "name": name, "passport": passport,
                "candidates": candidates or [], "raw_ocr": raw_ocr,
                "category": category, "confidence": confidence}
        mp = scan_path.parent / (scan_path.stem + ".json")
        try:
            mp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def _find_pdf(self, passport: str) -> Optional[Path]:
        orig = Path(self.cfg["originals_path"])
        if not orig.exists(): return None
        pdfs = sorted(orig.rglob("*.pdf"))
        if not pdfs: return None
        def _norm(s): return re.sub(r'[-_\s]','',s).upper()
        needle = _norm(passport)
        for p in pdfs:
            if needle in _norm(p.stem): return p
        prefix = needle[:4]
        if len(prefix)==4:
            hits = [p for p in pdfs if prefix in _norm(p.stem)]
            if hits: return hits[0]
        return None

    @staticmethod
    def _replace_page(pdf_path: Path, warped: np.ndarray, out_path: Path):
        gray   = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
        binary = cv2.adaptiveThreshold(gray, 255,
                                       cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, 35, 11)
        buf  = io.BytesIO()
        Image.fromarray(binary).save(buf, format="PNG")
        doc  = fitz.open(str(pdf_path))
        rect = doc[SIG_PAGE].rect
        doc.delete_page(SIG_PAGE)
        new_page = doc.new_page(SIG_PAGE, width=rect.width, height=rect.height)
        new_page.insert_image(new_page.rect, stream=buf.getvalue())
        doc.save(str(out_path))
        doc.close()

    @staticmethod
    def _imwrite(path_str: str, img: np.ndarray, ext: str=".jpg"):
        ok, buf = cv2.imencode(ext, img)
        if ok: Path(path_str).write_bytes(buf.tobytes())

    @staticmethod
    def _save_debug(src: Path, original: np.ndarray, rgba: np.ndarray,
                    debug: dict, crop_box: tuple):
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        pfx = DEBUG_DIR / f"{src.stem}_{ts}"
        Processor._imwrite(str(pfx)+"_1_original.jpg", original)
        ann = original.copy()
        if debug["corners"] is not None:
            cv2.drawContours(ann, [debug["corners"].astype(np.int32)], -1, (0,0,255), 3)
        Processor._imwrite(str(pfx)+"_2_detected.jpg", ann)
        x1,y1,x2,y2 = crop_box
        warped_ann = debug["warped"].copy()
        cv2.rectangle(warped_ann, (x1,y1), (x2,y2), (0,0,255), 2)
        Processor._imwrite(str(pfx)+"_3_warped.jpg", warped_ann)
        Image.fromarray(cv2.cvtColor(debug["crop"], cv2.COLOR_BGR2RGB)).save(str(pfx)+"_4_signature.jpg")
        Image.fromarray(rgba,"RGBA").save(str(pfx)+"_5_enhanced.png")

    @staticmethod
    def _read_image(path: Path, retries: int=3) -> Optional[np.ndarray]:
        for attempt in range(retries):
            time.sleep(0.1 if attempt==0 else 0.5)
            try:
                data = path.read_bytes()
                arr  = np.frombuffer(data, dtype=np.uint8)
                img  = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if img is not None: return img
            except Exception:
                continue
        return None

    @staticmethod
    def _mark_done(pdf_path: Path):
        marker = pdf_path.parent / (pdf_path.stem + DONE_EXT)
        try:
            marker.write_text(datetime.now().isoformat(), encoding="utf-8")
        except Exception:
            pass

    @staticmethod
    def _pdf_category(pdf: Path, orig_base: Path) -> str:
        try:
            rel = pdf.parent.relative_to(orig_base)
            return str(rel) if str(rel) != "." else ""
        except ValueError:
            return ""

    def submit(self, path: Path):
        self._pool.submit(self._run, path)

    def submit_generate_pdf(self, scan_path: Path, pdf_path: Path):
        self._pool.submit(self._run_generate_pdf, scan_path, pdf_path)

    def submit_with_passport(self, scan_path: Path, passport_no: str):
        self._pool.submit(self._run_with_passport, scan_path, passport_no)

    def _run(self, path: Path):
        if _OCR_OK and not Processor.is_ocr_ready():
            state = "loading" if Processor._ocr_loading else "failed"
            print(f"  [task] {path.name}: OCR {state}; retry later", flush=True)
            if task_store:
                task_store.start_task(path.name)
            self.rq.put(Result(path.name, "warning", "OCR加载中，请稍后重试"))
            return
        if task_store:
            task_store.start_task(path.name)
        try:
            res = self._process(path)
        except Exception as e:
            res = Result(path.name, "failed", f"意外错误: {e}")
        self.rq.put(res)

    def _run_generate_pdf(self, scan_path: Path, pdf_path: Path):
        if task_store:
            task_store.start_task(scan_path.name)
        try:
            res = self._process_generate_pdf(scan_path, pdf_path)
        except Exception as e:
            res = Result(scan_path.name, "failed", f"意外错误: {e}")
        self.rq.put(res)

    def _run_with_passport(self, scan_path: Path, passport_no: str):
        if task_store:
            task_store.start_task(scan_path.name)
        try:
            pdf = self._find_pdf(passport_no)
            if pdf is None:
                res = Result(scan_path.name, "unmatched", "手动输入护照号后仍未找到PDF", passport_no)
            else:
                if task_store:
                    t = task_store.get_by_filename(scan_path.name)
                    if t:
                        t.passport_no = passport_no
                        task_store.bind_manual_pdf(t.id, pdf.name)
                        task_store.mark_manual_pdf_generating(t.id)
                res = self._process_generate_pdf(scan_path, pdf)
        except Exception as e:
            res = Result(scan_path.name, "failed", f"意外错误: {e}")
        self.rq.put(res)

    def _process(self, path: Path) -> Result:
        if task_store and task_store.is_stopped(path.name):
            return Result(path.name, "warning", "任务已暂停或人工接管")
        img = self._read_image(path)
        if img is None:
            return Result(path.name, "failed", f"无法读取图片: {path.name}")

        name, passport, raw_ocr = self._ocr_fields(img)
        if task_store and task_store.is_stopped(path.name):
            return Result(path.name, "warning", "任务已暂停或人工接管")
        if raw_ocr is not None:
            self.rq.put(Result(path.name, "ocr_debug",
                               f"OCR原文 → {raw_ocr[:400] or '(空)'}"))

        is_system_upload_name = path.stem.lower().startswith("upload_")
        if not name and not is_system_upload_name:
            name = self._name_from_stem(path.stem) or None
        if not passport and not is_system_upload_name:
            pm = re.search(r'([A-Z]{1,2}\d{6,8}|\d{6,9})', path.stem.upper())
            if pm: passport = pm.group(1)
        if task_store and task_store.is_stopped(path.name):
            return Result(path.name, "warning", "任务已暂停或人工接管")

        def _to_pending(reason: str, candidates: list=None):
            nonlocal path
            PENDING_DIR.mkdir(parents=True, exist_ok=True)
            work_copy = _copy_task_image_for_exception(path, PENDING_DIR)
            meta_path = work_copy or path
            self._write_pending_meta(meta_path, reason, name=name or "",
                                     passport=passport or "",
                                     candidates=candidates or [],
                                     raw_ocr=raw_ocr or "")

        if not name:
            _to_pending("未识别姓名")
            return Result(path.name, "unmatched", "未识别姓名", passport or "", "")

        pdfs = self._find_pdfs_by_name(name)

        if len(pdfs) == 0:
            _to_pending("未找到匹配PDF")
            return Result(path.name, "unmatched", "未找到匹配PDF", passport or "", name)

        if len(pdfs) > 1:
            def _passport_in_stem(p: Path) -> str:
                for tok in re.split(r'[-_\s]', p.stem):
                    tok = tok.strip()
                    if tok and any(c.isdigit() for c in tok): return tok.upper()
                return ""

            auto_pdf: Optional[Path] = None
            if passport:
                pp_norm = re.sub(r'[-_\s]','',passport.upper())
                secondary = [p for p in pdfs
                             if pp_norm in re.sub(r'[-_\s]','',_passport_in_stem(p))
                             or re.sub(r'[-_\s]','',_passport_in_stem(p)) in pp_norm]
                if len(secondary) == 1: auto_pdf = secondary[0]

            cand_list = []
            for p in pdfs:
                basis = "姓名+护照号匹配" if (auto_pdf and p == auto_pdf) else "姓名匹配"
                cand_list.append({"filename": p.name, "path": str(p), "match_basis": basis})

            APPROVAL_DIR.mkdir(parents=True, exist_ok=True)
            work_copy = _copy_task_image_for_exception(path, APPROVAL_DIR)
            meta_path = work_copy or path
            self._write_approval_meta(meta_path, name or "", passport or "", cand_list,
                                      auto_pdf.name if auto_pdf else None)
            return Result(path.name, "approval",
                          f"发现{len(pdfs)}个同名文件，等待审批",
                          passport or "", name or "",
                          candidates=[c["filename"] for c in cand_list],
                          match_basis="姓名+护照号匹配" if auto_pdf else "姓名匹配")

        pdf = pdfs[0]
        orig_base = Path(self.cfg["originals_path"])
        category  = self._pdf_category(pdf, orig_base)
        if task_store and task_store.is_stopped(path.name):
            return Result(path.name, "warning", "任务已暂停或人工接管")

        return Result(path.name, "matched", "PDF匹配完成，等待文件名核验",
                      passport or "", name, category, matched_pdf=pdf.name,
                      match_basis="姓名匹配")

    def _process_generate_pdf(self, path: Path, pdf: Path) -> Result:
        if task_store and not task_store.is_filename_verified(path.name):
            return Result(path.name, "failed", "流程异常: 文件名核验未通过，禁止生成PDF")
        if task_store and task_store.is_stopped(path.name):
            return Result(path.name, "warning", "任务已暂停或人工接管")
        img = self._read_image(path)
        if img is None:
            return Result(path.name, "failed", f"无法读取图片: {path.name}")

        orig_base = Path(self.cfg["originals_path"])
        category  = self._pdf_category(pdf, orig_base)
        t = task_store.get_by_filename(path.name) if task_store else None
        name = t.name if t else ""
        passport = t.passport_no if t else ""
        claimed, owner_id = self._claim_output(t, pdf.name)
        if not claimed:
            return Result(
                path.name,
                "failed",
                f"输出冲突: {pdf.name} 已由任务 {owner_id} 生成，禁止覆盖",
                passport,
                name,
                category,
                matched_pdf=pdf.name,
            )

        try:
            rgba, debug, crop = self._run_extract_sig(img, pdf)
        except ValueError as e:
            self._release_output_claim(t, pdf.name)
            return Result(path.name, "failed", str(e), passport, name, category)
        if task_store and task_store.is_stopped(path.name):
            self._release_output_claim(t, pdf.name)
            return Result(path.name, "warning", "任务已暂停或人工接管")

        self._save_debug(path, img, rgba, debug, crop)

        signed_base = Path(self.cfg["signed_path"])
        out_dir = signed_base / category if category else signed_base
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / pdf.name

        try:
            self._replace_page(pdf, debug["warped"], out)
            if not out.exists() or out.stat().st_size <= 0:
                raise IOError("输出文件未写入磁盘")
            with fitz.open(str(out)) as generated:
                if generated.page_count <= 0:
                    raise IOError("输出PDF没有有效页面")
        except Exception as e:
            self._release_output_claim(t, pdf.name)
            return Result(path.name, "failed", f"PDF替换失败: {e}", passport, name, category)

        self._mark_done(pdf)
        meta = path.parent / (path.stem + ".json")
        try:
            meta.unlink(missing_ok=True)
        except Exception:
            pass

        return Result(path.name, "success", f"补录完成 → {out.name}",
                      passport, name, category, matched_pdf=pdf.name)


# ═══════════════════════════════════════════════════════════════════════════
# Watchdog
# ═══════════════════════════════════════════════════════════════════════════

class ScanHandler(FileSystemEventHandler):
    def __init__(self, proc_obj: Processor):
        self.proc = proc_obj

    def _go(self, raw: str):
        p = Path(raw)
        if p.suffix.lower() not in WATCH_EXTS:
            return
        if not _mark_path_seen(p):
            return
        time.sleep(0.8)
        if task_store:
            task_store.new_task(p.name, source="folder")
        self.proc.submit(p)

    def on_created(self, e):
        if not e.is_directory: self._go(e.src_path)

    def on_moved(self, e):
        if not e.is_directory: self._go(e.dest_path)


# ═══════════════════════════════════════════════════════════════════════════
# Flask 应用
# ═══════════════════════════════════════════════════════════════════════════

flask_app = Flask(__name__)
_server_log("app created ok")


@flask_app.after_request
def _add_cors(response):
    response.headers['Access-Control-Allow-Origin']  = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Requested-With'
    return response


@flask_app.route('/api/upload', methods=['OPTIONS'])
@flask_app.route('/api/upload/batch/start', methods=['OPTIONS'])
@flask_app.route('/api/upload/batch/finish', methods=['OPTIONS'])
@flask_app.route('/api/approve', methods=['OPTIONS'])
@flask_app.route('/api/pending-submit', methods=['OPTIONS'])
@flask_app.route('/api/pending-retry', methods=['OPTIONS'])
@flask_app.route('/api/toggle-listen', methods=['OPTIONS'])
@flask_app.route('/api/settings', methods=['OPTIONS'])
@flask_app.route('/api/select-folder', methods=['OPTIONS'])
@flask_app.route('/api/ensure-folder', methods=['OPTIONS'])
@flask_app.route('/api/browse-folder', methods=['OPTIONS'])
@flask_app.route('/api/open-folder', methods=['OPTIONS'])
@flask_app.route('/api/exceptions/<task_id>/ignore', methods=['OPTIONS'])
@flask_app.route('/api/exceptions/<task_id>/resolve', methods=['OPTIONS'])
@flask_app.route('/api/exceptions/file-ignore', methods=['OPTIONS'])
@flask_app.route('/api/exceptions/clear-expired', methods=['OPTIONS'])
@flask_app.route('/api/preview/rotation', methods=['OPTIONS'])
@flask_app.route('/api/tasks/<task_id>/control', methods=['OPTIONS'])
@flask_app.route('/api/tasks/<task_id>/manual-pdf', methods=['OPTIONS'])
@flask_app.route('/api/tasks/<task_id>/filename-verify-pass', methods=['OPTIONS'])
@flask_app.route('/api/tasks/<task_id>/workflow-anomaly', methods=['OPTIONS'])
@flask_app.route('/api/approval-retry', methods=['OPTIONS'])
@flask_app.route('/api/workspace/clear-completed', methods=['OPTIONS'])
@flask_app.route('/api/work-log/append', methods=['OPTIONS'])
@flask_app.route('/api/open-work-log', methods=['OPTIONS'])
def _cors_preflight():
    return '', 204


def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


# ── 主页 ──────────────────────────────────────────────────────────────────

@flask_app.route('/')
def index():
    return send_file(str(_BASE / 'index.html'))


# ── 状态 ──────────────────────────────────────────────────────────────────

@flask_app.route('/api/status')
def api_status():
    reconciliation = _reconcile_pdf_outputs()
    stats = task_store.get_stats() if task_store else {}
    stats["missing_output_count"] = reconciliation["missing_output_count"]
    stats["output_pdf_count"] = reconciliation["output_pdf_count"]
    stats["original_pdf_count"] = reconciliation["original_pdf_count"]
    workspace = task_store.get_workspace_state() if task_store else {
        "has_tasks": False, "complete": False, "clearable": False
    }
    return jsonify({
        "ok":          True,
        "status":      "running",
        "app_id":      "receipt_assistant",
        "listening":   watching,
        "ocr_ready":   Processor.is_ocr_ready(),
        "ocr_engine":  "PaddleOCR",
        "ocr_warming": _OCR_OK and Processor._ocr_loading,
        "ocr_enabled": _OCR_OK,
        "local_ip":    _get_local_ip(),
        "port":        HTTP_PORT,
        "stats":       stats,
        "workspace":   workspace,
        "reconciliation": reconciliation,
    })


# ── 任务列表 ──────────────────────────────────────────────────────────────

@flask_app.route('/api/tasks')
def api_tasks():
    if not task_store:
        return jsonify([])
    _reconcile_pdf_outputs()
    tasks = task_store.get_all()
    return jsonify([{
        "id":         t.id,
        "filename":   t.filename,
        "status":     t.status,
        "stage":      t.stage,
        "name":       t.name,
        "passport_no":t.passport_no,
        "category":   t.category,
        "message":    t.message,
        "match_basis":t.match_basis,
        "matched_pdf":t.matched_pdf,
        "selected_pdf": t.selected_pdf,
        "original_pdf": t.original_pdf,
        "manual_pdf_confirmed": t.manual_pdf_confirmed,
        "filename_verify_status": t.filename_verify_status,
        "result_review_status": t.result_review_status,
        "output_pdf": t.output_pdf or t.matched_pdf,
        "expected_output_pdf": t.expected_output_pdf,
        "missing_output": t.missing_output,
        "last_error": t.last_error,
        "output_pdf_exists": _task_output_pdf_exists(t),
        "candidates": t.candidates,
        "source":     t.source,
        "exception_state": t.exception_state,
        "exception_reason": t.exception_reason,
        "exception_type": t.exception_type,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    } for t in tasks])


@flask_app.route('/api/debug/reconciliation')
def api_debug_reconciliation():
    return jsonify(_reconcile_pdf_outputs())


@flask_app.route('/api/tasks/<task_id>')
def api_task_detail(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    t = task_store.get(task_id)
    if not t:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "id":         t.id,
        "filename":   t.filename,
        "status":     t.status,
        "stage":      t.stage,
        "name":       t.name,
        "passport_no":t.passport_no,
        "category":   t.category,
        "message":    t.message,
        "match_basis":t.match_basis,
        "matched_pdf":t.matched_pdf,
        "selected_pdf": t.selected_pdf,
        "original_pdf": t.original_pdf,
        "manual_pdf_confirmed": t.manual_pdf_confirmed,
        "filename_verify_status": t.filename_verify_status,
        "result_review_status": t.result_review_status,
        "output_pdf": t.output_pdf or t.matched_pdf,
        "expected_output_pdf": t.expected_output_pdf,
        "missing_output": t.missing_output,
        "last_error": t.last_error,
        "output_pdf_exists": _task_output_pdf_exists(t),
        "candidates": t.candidates,
        "source":     t.source,
        "timeline":   t.timeline,
        "exception_state": t.exception_state,
        "exception_reason": t.exception_reason,
        "exception_type": t.exception_type,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    })


def _task_payload(t: TaskRecord) -> dict:
    return {
        "id": t.id,
        "filename": t.filename,
        "status": t.status,
        "stage": t.stage,
        "name": t.name,
        "passport_no": t.passport_no,
        "category": t.category,
        "message": t.message,
        "matched_pdf": t.matched_pdf,
        "selected_pdf": t.selected_pdf,
        "original_pdf": t.original_pdf,
        "manual_pdf_confirmed": t.manual_pdf_confirmed,
        "filename_verify_status": t.filename_verify_status,
        "result_review_status": t.result_review_status,
        "output_pdf": t.output_pdf or t.matched_pdf,
        "expected_output_pdf": t.expected_output_pdf,
        "missing_output": t.missing_output,
        "last_error": t.last_error,
        "output_pdf_exists": _task_output_pdf_exists(t),
        "source": t.source,
        "exception_state": t.exception_state,
        "exception_reason": t.exception_reason,
        "exception_type": t.exception_type,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


@flask_app.route('/api/exceptions')
def api_exceptions():
    if not task_store:
        return jsonify([])
    return jsonify([_task_payload(t) for t in task_store.get_open_exceptions()])


@flask_app.route('/api/exceptions/history')
def api_exception_history():
    if not task_store:
        return jsonify([])
    return jsonify([_task_payload(t) for t in task_store.get_exception_history()])


@flask_app.route('/api/exceptions/<task_id>/ignore', methods=['POST'])
def api_exception_ignore(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    if not task_store.mark_exception(task_id, "ignored", "用户忽略"):
        return jsonify({"error": "task not found"}), 404
    return jsonify({"status": "ok"})


@flask_app.route('/api/exceptions/<task_id>/resolve', methods=['POST'])
def api_exception_resolve(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    if not task_store.mark_exception(task_id, "resolved", "已重新上传或修复"):
        return jsonify({"error": "task not found"}), 404
    return jsonify({"status": "ok"})


def _archive_exception_file(path: Path):
    try:
        dst_dir = DEBUG_DIR / "exception_history_files"
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = _unique_path(dst_dir / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{path.name}")
        shutil.copy2(str(path), str(dst))
        meta = path.parent / (path.stem + ".json")
        if meta.exists():
            shutil.move(str(meta), str(_unique_path(dst.with_suffix(".json"))))
    except Exception:
        pass


@flask_app.route('/api/exceptions/file-ignore', methods=['POST'])
def api_exception_file_ignore():
    data = request.get_json(silent=True) or {}
    scan_name = data.get("scan_name", "").strip()
    kind = data.get("kind", "pending").strip()
    if not scan_name:
        return jsonify({"error": "missing scan_name"}), 400
    base = APPROVAL_DIR if kind == "approval" else PENDING_DIR
    path = base / scan_name
    if not path.exists():
        return jsonify({"error": "scan not found"}), 404
    meta = {}
    mp = path.parent / (path.stem + ".json")
    if mp.exists():
        try:
            meta = json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            pass
    if task_store:
        task_store.add_exception_history(
            scan_name, "ignored",
            "用户忽略",
            "multiple_candidates" if kind == "approval" else "pdf_missing",
            meta.get("name", ""),
            meta.get("passport", "")
        )
    _archive_exception_file(path)
    return jsonify({"status": "ok"})


@flask_app.route('/api/exceptions/clear-expired', methods=['POST'])
def api_exception_clear_expired():
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    return jsonify({"status": "ok", "cleared": task_store.clear_expired()})


# ── 分类 ──────────────────────────────────────────────────────────────────

@flask_app.route('/api/categories', methods=['GET'])
def api_categories():
    orig = Path(cfg["originals_path"])
    if not orig.exists():
        return jsonify([])
    result = []
    for d in sorted(orig.iterdir()):
        if not d.is_dir(): continue
        count      = len(list(d.glob("*.pdf")))
        done_count = len(list(d.glob(f"*{DONE_EXT}")))
        result.append({"name": d.name, "count": count, "done_count": done_count})
    return jsonify(result)


@flask_app.route('/api/categories', methods=['POST'])
def api_create_category():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "empty name"}), 400
    orig    = Path(cfg["originals_path"])
    new_dir = orig / name
    try:
        new_dir.mkdir(parents=True, exist_ok=True)
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── pending ────────────────────────────────────────────────────────────────

def _best_pdf_match(name: str, passport: str, pdf_names: list) -> str:
    if not pdf_names:
        return ""
    name_parts = [p.upper() for p in re.split(r'[-_\s]', name) if len(p) >= 2] if name else []
    pp_clean   = re.sub(r'[-_\s]', '', passport.upper()) if passport else ""
    def _score(n: str) -> int:
        stem = re.sub(r'[-_\s]', '', n.rsplit('.', 1)[0].upper())
        s = 0
        if pp_clean and pp_clean in stem: s += 100
        for part in name_parts:
            if part in stem: s += 10
        return s
    return max(pdf_names, key=_score)


def _match_basis(name: str, passport: str, pdf_name: str) -> dict:
    stem = Path(pdf_name or "").stem.upper()
    clean_name = re.sub(r'[-_\s]+', ' ', name or '').strip().upper()
    clean_stem = re.sub(r'[-_\s]+', ' ', stem).strip()
    name_score = int(round(difflib.SequenceMatcher(None, clean_name, clean_stem).ratio() * 100)) if clean_name and clean_stem else 0
    pp = re.sub(r'[-_\s]', '', (passport or '').upper())
    stem_flat = re.sub(r'[-_\s]', '', stem)
    passport_match = bool(pp and pp in stem_flat)
    return {
        "name_similarity": name_score,
        "passport_match": passport_match,
        "passport_text": "已匹配" if passport_match else "未匹配",
    }


def _task_id_for_scan(scan_name: str) -> str:
    if not task_store:
        return ""
    t = task_store.get_by_filename(scan_name)
    return t.id if t else ""


def _filename_verify_ok(name: str, pdf_filename: str) -> bool:
    if not name or not pdf_filename:
        return False
    ocr = re.sub(r'\s+', ' ', name.strip().lower())
    pdf = re.sub(r'[_\-.]+', ' ', Path(pdf_filename).stem).strip().lower()
    if not ocr or not pdf:
        return False
    if pdf in ocr or ocr in pdf:
        return True
    ocr_tokens = [x for x in re.split(r'\s+', ocr) if x]
    pdf_tokens = [x for x in re.split(r'\s+', pdf) if x]
    matched = [tok for tok in ocr_tokens if any(tok in p or p in tok for p in pdf_tokens)]
    return len(matched) >= min(len(ocr_tokens), 1)


def _task_output_pdf_path(t: TaskRecord) -> Optional[Path]:
    pdf_name = (
        t.expected_output_pdf
        or t.output_pdf
        or t.matched_pdf
        or t.selected_pdf
        or t.original_pdf
    )
    if not pdf_name or not cfg:
        return None
    signed = Path(cfg["signed_path"])
    candidates = []
    if t.category:
        candidates.append(signed / t.category / pdf_name)
    candidates.append(signed / pdf_name)
    for p in candidates:
        if p.exists():
            return p
    if signed.exists():
        try:
            return next(signed.rglob(pdf_name), None)
        except Exception:
            return None
    return None


def _task_output_pdf_exists(t: TaskRecord) -> bool:
    return _task_output_pdf_path(t) is not None


def _task_pdf_name(t: TaskRecord) -> str:
    return (
        t.expected_output_pdf
        or t.output_pdf
        or t.matched_pdf
        or t.selected_pdf
        or t.original_pdf
        or ""
    )


def _task_generation_distance(t: TaskRecord, output_mtime: float) -> float:
    try:
        base_date = datetime.fromisoformat(t.created_at).date()
    except Exception:
        base_date = datetime.now().date()
    distances = []
    for item in t.timeline:
        if not isinstance(item, dict):
            continue
        try:
            clock = datetime.strptime(str(item.get("time", "")), "%H:%M:%S").time()
            event_time = datetime.combine(base_date, clock).timestamp()
            distances.append(abs(output_mtime - event_time))
        except Exception:
            continue
    return min(distances) if distances else float("inf")


def _current_reconciliation_tasks() -> list[TaskRecord]:
    if not task_store:
        return []
    with task_store._lock:
        current_ids = set(task_store._by_filename.values())
        return [
            t for tid, t in task_store._tasks.items()
            if tid in current_ids or t.source == "reconciliation"
        ]


def _scan_pdf_map(base: Path) -> dict[str, Path]:
    if not base.exists():
        return {}
    return {
        p.relative_to(base).as_posix().lower(): p
        for p in base.rglob("*.pdf")
        if p.is_file()
    }


def _task_can_have_missing_output(t: TaskRecord) -> bool:
    return (
        t.status in {"success", "completed", "missing_output"}
        and t.exception_state != "ignored"
        and bool(_task_pdf_name(t))
    )


def _find_original_pdf_for_task(
    t: TaskRecord,
    original_pdfs: dict[str, Path],
    pdf_name: str,
) -> tuple[str, Optional[Path]]:
    if not pdf_name:
        return "", None
    candidates = []
    if t.category:
        candidates.append((Path(t.category) / pdf_name).as_posix().lower())
    candidates.append(pdf_name.lower())
    for key in candidates:
        if key in original_pdfs:
            return key, original_pdfs[key]
    basename = pdf_name.lower()
    for key, path in original_pdfs.items():
        if Path(key).name.lower() == basename or path.name.lower() == basename:
            return key, path
    return "", None


def _output_pdf_exists_for_task_key(
    t: TaskRecord,
    output_pdfs: dict[str, Path],
    original_key: str,
    pdf_name: str,
) -> bool:
    candidates = []
    if original_key:
        candidates.append(original_key.lower())
    if t.category:
        candidates.append((Path(t.category) / pdf_name).as_posix().lower())
    candidates.append(pdf_name.lower())
    for key in candidates:
        if key in output_pdfs:
            return True
    basename = pdf_name.lower()
    return any(Path(key).name.lower() == basename for key in output_pdfs)


def _build_pdf_reconciliation() -> dict:
    if not cfg:
        return {
            "original_pdf_count": 0,
            "upload_image_count": 0,
            "output_pdf_count": 0,
            "missing_output_count": 0,
            "missing_outputs": [],
            "duplicate_output_claims": [],
            "ok": True,
        }

    originals_root = Path(cfg["originals_path"])
    outputs_root = Path(cfg["signed_path"])
    scans_root = Path(cfg["scans_path"])
    original_pdfs = _scan_pdf_map(originals_root)
    output_pdfs = _scan_pdf_map(outputs_root)
    upload_images = [
        p for p in scans_root.iterdir()
        if p.is_file() and p.suffix.lower() in WATCH_EXTS
    ] if scans_root.exists() else []

    tasks = _current_reconciliation_tasks()
    live_tasks = [
        t for t in tasks
        if t.source != "reconciliation"
        and t.status not in {"ignored", "canceled", "cancelled"}
    ]
    task_claims: dict[str, list[TaskRecord]] = {}
    for t in live_tasks:
        pdf_name = _task_pdf_name(t)
        if not pdf_name:
            continue
        key = (Path(t.category) / pdf_name).as_posix().lower() if t.category else pdf_name.lower()
        task_claims.setdefault(key, []).append(t)

    duplicate_claims = []
    duplicate_suspects: list[TaskRecord] = []
    for key, claimants in sorted(task_claims.items()):
        completed_claimants = [
            t for t in claimants
            if t.status in {"success", "completed"} or t.result_review_status == "passed"
        ]
        if len(completed_claimants) < 2:
            continue
        output_path = output_pdfs.get(key)
        owner = min(
            completed_claimants,
            key=lambda t: _task_generation_distance(
                t,
                output_path.stat().st_mtime if output_path else 0,
            ),
        )
        suspects = [t for t in completed_claimants if t.id != owner.id]
        duplicate_suspects.extend(suspects)
        duplicate_claims.append({
            "pdf_name": original_pdfs.get(key, output_path).name if (original_pdfs.get(key) or output_path) else key,
            "owner_task_id": owner.id,
            "owner_image_name": owner.filename,
            "conflicting_tasks": [
                {
                    "task_id": t.id,
                    "image_name": t.filename,
                    "task_status": t.status,
                    "manually_matched": bool(t.manual_pdf_confirmed),
                }
                for t in suspects
            ],
        })

    missing_outputs = []
    for task in live_tasks:
        if not _task_can_have_missing_output(task):
            continue
        if _resolve_task_image(task) is None:
            continue
        pdf_name = _task_pdf_name(task)
        original_key, original = _find_original_pdf_for_task(task, original_pdfs, pdf_name)
        if not original_key or not original:
            continue
        if _output_pdf_exists_for_task_key(task, output_pdfs, original_key, pdf_name):
            continue
        reason = (
            f"输出PDF缺失：{original.name}。"
            + (
                f"任务同时错误占用了 {_task_pdf_name(task)}，疑似重复匹配或同名覆盖。"
                if task in duplicate_suspects
                else "原始PDF存在，但输出目录没有对应文件。"
            )
        )
        if task.exception_type == "missing_output" and task.exception_reason:
            reason = task.exception_reason
        missing_outputs.append({
            "pdf_name": original.name,
            "image_name": task.filename,
            "task_id": task.id,
            "task_status": task.status,
            "passport_no": task.passport_no,
            "last_processed_at": task.updated_at,
            "last_error": task.exception_reason or task.message or reason,
            "manually_matched": bool(task.manual_pdf_confirmed),
            "match_basis": "duplicate_output_claim" if task in duplicate_suspects else "task_record",
            "reason": reason,
        })

    return {
        "original_pdf_count": len(original_pdfs),
        "upload_image_count": len(upload_images),
        "output_pdf_count": len(output_pdfs),
        "missing_output_count": len(missing_outputs),
        "missing_outputs": missing_outputs,
        "duplicate_output_claims": duplicate_claims,
        "ok": not missing_outputs,
        "checked_at": datetime.now().isoformat(),
    }


def _sync_pdf_reconciliation(report: dict) -> None:
    if not task_store:
        return
    missing_names = {item["pdf_name"] for item in report.get("missing_outputs", [])}
    for item in report.get("missing_outputs", []):
        reason = item.get("reason") or f"输出PDF缺失：{item['pdf_name']}"
        task_id = item.get("task_id", "")
        task = task_store.get(task_id) if task_id else None
        if task and _should_mark_missing_output(task, item):
            task_store.mark_missing_output(task_id, item["pdf_name"], reason)
    _clear_stale_missing_output_exceptions(missing_names)
    task_store.resolve_reconciliation_exceptions(missing_names)


def _clear_stale_missing_output_exceptions(current_missing_names: set[str]) -> None:
    if not task_store:
        return
    now = datetime.now().isoformat()
    with task_store._lock:
        remove_ids = []
        for tid, t in task_store._tasks.items():
            pdf_name = t.expected_output_pdf or t.output_pdf or t.matched_pdf or t.original_pdf
            if t.source == "reconciliation":
                if pdf_name not in current_missing_names:
                    remove_ids.append(tid)
                continue
            if t.exception_type != "missing_output":
                continue
            if pdf_name in current_missing_names:
                continue
            if task_store._completed_pdf_exists_locked(t):
                continue
            if t.status == "missing_output" and t.missing_output:
                continue
            t.status = "queued"
            t.stage = "ocr"
            t.expected_output_pdf = ""
            t.exception_state = "resolved"
            t.exception_type = ""
            t.exception_reason = ""
            t.message = "缺失输出判定已撤销，等待重新处理"
            t.updated_at = now
            t.timeline.append({
                "time": task_store._ts(),
                "text": "缺失输出判定已撤销：任务尚未成功完成，不能计入缺失输出",
                "level": "blue",
            })
        for tid in remove_ids:
            t = task_store._tasks.pop(tid, None)
            if t:
                task_store._by_filename.pop(t.filename, None)


def _should_mark_missing_output(task: TaskRecord, item: dict) -> bool:
    if not task or task.source == "reconciliation":
        return False
    if task.status in {
        "queued", "processing", "warning", "paused", "manual",
        "matched", "unmatched", "approval", "pending_confirm",
    }:
        return False
    if task.exception_type and task.exception_type != "missing_output":
        return False
    if item.get("match_basis") == "duplicate_output_claim":
        return True
    return (
        task.status in {"success", "completed"}
        or task.stage == "archive"
        or task.result_review_status == "passed"
        or bool(task.output_pdf)
    )


_last_reconciliation_signature = ""


def _append_reconciliation_log(report: dict) -> None:
    global _last_reconciliation_signature
    signature = json.dumps({
        "original_pdf_count": report.get("original_pdf_count", 0),
        "upload_image_count": report.get("upload_image_count", 0),
        "output_pdf_count": report.get("output_pdf_count", 0),
        "missing_outputs": report.get("missing_outputs", []),
    }, ensure_ascii=False, sort_keys=True)
    with _reconciliation_log_lock:
        if signature == _last_reconciliation_signature:
            return
        _last_reconciliation_signature = signature
        try:
            LOGS_DIR.mkdir(parents=True, exist_ok=True)
            with open(RECONCILIATION_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(report, ensure_ascii=False) + "\n")
        except Exception:
            pass


def _reconcile_pdf_outputs() -> dict:
    report = _build_pdf_reconciliation()
    _sync_pdf_reconciliation(report)
    report = _build_pdf_reconciliation()
    _append_reconciliation_log(report)
    return report


def _log_stat_mismatch_if_needed(batch_id: str, batch_saved: int, cumulative_saved: int) -> None:
    """Log STAT_MISMATCH when the uploads directory file count differs from saved_count.
    Both UI panels use cumulative_saved as their single source of truth, so they are
    always in sync with each other. This log catches directory drift regressions
    (e.g. files manually copied into uploads/) that would previously have caused
    the workspace bar to show a different number than the upload inlet."""
    try:
        scans_path = cfg["scans_path"]
        d = Path(scans_path)
        upload_dir_count = (
            sum(1 for f in d.rglob("*")
                if f.is_file() and f.suffix.lower() in WATCH_EXTS)
            if d.exists() else 0
        )
        if upload_dir_count == cumulative_saved:
            return
        entry = {
            "event": "STAT_MISMATCH",
            "timestamp": datetime.now().isoformat(),
            "batch_id": batch_id,
            "saved_count": cumulative_saved,
            "ui_upload_count": cumulative_saved,
            "upload_directory_count": upload_dir_count,
            "note": (
                f"uploads目录有{upload_dir_count}张图片，但saved_count为{cumulative_saved}。"
                "UI已正确使用saved_count，目录额外文件不影响统计。"
            ),
        }
        with _reconciliation_log_lock:
            LOGS_DIR.mkdir(parents=True, exist_ok=True)
            with open(RECONCILIATION_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _task_already_handled(t: Optional[TaskRecord]) -> bool:
    if not t:
        return False
    return (
        t.manual_pdf_confirmed
        or t.exception_state in {"resolved", "ignored", "expired"}
        or t.status in {"success", "completed"}
    )


def _pdf_done_marker_exists(pdf_name: str) -> bool:
    if not pdf_name:
        return False
    orig = Path(cfg["originals_path"])
    if not orig.exists():
        return False
    for pdf in orig.rglob(pdf_name):
        marker = pdf.parent / (pdf.stem + DONE_EXT)
        if marker.exists():
            return True
    return False


def _exception_file_already_finished(filename: str, candidates: list | None = None) -> bool:
    t = task_store.get_by_filename(filename) if task_store else None
    if _task_already_handled(t):
        return True
    for c in candidates or []:
        pdf_name = c.get("filename", "") if isinstance(c, dict) else str(c or "")
        if _pdf_done_marker_exists(pdf_name):
            return True
    return False


def _archive_residual_exception_scan(filename: str):
    for d in (APPROVAL_DIR, PENDING_DIR, UNMATCHED_DIR):
        p = d / filename
        if p.exists():
            _archive_exception_file(p)


@flask_app.route('/api/pending')
def api_pending():
    if not PENDING_DIR.exists():
        return jsonify([])
    orig      = Path(cfg["originals_path"])
    pdf_names = sorted(p.name for p in orig.rglob("*.pdf")) if orig.exists() else []
    items = []
    for f in sorted(PENDING_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if f.suffix.lower() not in WATCH_EXTS:
            continue
        age_hours = (datetime.now().timestamp() - f.stat().st_mtime) / 3600
        if age_hours > 24:
            if task_store:
                task_store.add_exception_history(f.name, "expired", "超过24小时未处理", "pdf_missing")
            _archive_exception_file(f)
            continue
        meta: dict = {}
        mp = f.parent / (f.stem + ".json")
        if mp.exists():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:
                pass
        candidates   = meta.get("candidates", [])
        if _exception_file_already_finished(f.name, candidates):
            _archive_exception_file(f)
            continue
        is_ambiguous = bool(candidates)
        name         = meta.get("name", f.stem)
        passport     = meta.get("passport", "")
        cand_list    = [c.get("filename", "") if isinstance(c, dict) else c for c in candidates] if is_ambiguous else pdf_names
        best         = _best_pdf_match(name, passport, cand_list)
        # 将推荐项排在最前，弹窗列表中优先展示。
        if best and best in cand_list:
            cand_list = [best] + [c for c in cand_list if c != best]
        task_id = ""
        if task_store:
            task_id = task_store.ensure_exception_task(
                f.name, "unmatched", meta.get("reason", "等待人工选择PDF"),
                name, passport, cand_list, "pdf_missing"
            )
        items.append({
            "scan_name":    f.name,
            "task_id":      task_id,
            "name":         name,
            "passport":     passport,
            "category":     meta.get("category", ""),
            "ocr_text":     meta.get("raw_ocr", ""),
            "confidence":   meta.get("confidence", ""),
            "reason":       meta.get("reason", "未知原因"),
            "candidates":   cand_list,
            "best_match":   best,
            "match_basis":  _match_basis(name, passport, best) if best else {},
            "current_problem": "OCR未识别护照号" if not passport else ("PDF存在多个候选" if is_ambiguous else "未找到完全匹配PDF"),
            "is_ambiguous": is_ambiguous,
            "mtime":        f.stat().st_mtime,
            "age_hours":    age_hours,
        })
    return jsonify(items)


# ── 待审批 ────────────────────────────────────────────────────────────────

@flask_app.route('/api/approval')
def api_approval():
    if not APPROVAL_DIR.exists():
        return jsonify([])
    items = []
    for f in sorted(APPROVAL_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if f.suffix.lower() not in WATCH_EXTS:
            continue
        age_hours = (datetime.now().timestamp() - f.stat().st_mtime) / 3600
        if age_hours > 24:
            if task_store:
                task_store.add_exception_history(f.name, "expired", "超过24小时未处理", "multiple_candidates")
            _archive_exception_file(f)
            continue
        meta: dict = {}
        mp = f.parent / (f.stem + ".json")
        if mp.exists():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:
                pass
        candidates = meta.get("candidates", [])
        finished_candidates = [meta.get("auto_candidate")] if meta.get("auto_candidate") else candidates
        if _exception_file_already_finished(f.name, finished_candidates):
            _archive_exception_file(f)
            continue
        task_id = ""
        if task_store:
            task_id = task_store.ensure_exception_task(
                f.name, "approval", "匹配冲突，等待人工选择PDF",
                meta.get("name", f.stem), meta.get("passport", ""),
                [c.get("filename", "") if isinstance(c, dict) else c for c in candidates],
                "multiple_candidates"
            )
        items.append({
            "scan_name":      f.name,
            "task_id":        task_id,
            "name":           meta.get("name", f.stem),
            "passport":       meta.get("passport", ""),
            "candidates":     candidates,
            "auto_candidate": meta.get("auto_candidate"),
            "mtime":          f.stat().st_mtime,
            "age_hours":      age_hours,
        })
    return jsonify(items)


# ── 图片移动辅助 ──────────────────────────────────────────────────────────

def _copy_task_image_for_exception(src: Path, dst_dir: Path) -> Optional[Path]:
    """保留 uploads 根目录原图，仅在异常目录创建同名工作副本。"""
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    try:
        shutil.copy2(str(src), str(dst))
    except Exception:
        return None
    _add_seen_path(dst)
    return dst


def _move_task_image(task_id: Optional[str], src: Path, dst_dir: Path) -> Optional[Path]:
    """移动图片到 dst_dir，更新 TaskStore。返回落地路径，失败返回 None。"""
    try:
        if src.parent.resolve() == dst_dir.resolve():
            return src
    except Exception:
        pass
    dst = _unique_path(dst_dir / src.name)
    try:
        shutil.move(str(src), str(dst))
    except Exception:
        return None
    _add_seen_path(dst)
    if task_store and task_id:
        task_store.update_image_path(task_id, src.name, dst)
    elif task_store:
        task_store.rename_task_file(src.name, dst.name)
    return dst


def _remove_exception_work_copies(filename: str):
    """根目录原图存在时，清理 pending/approval 中的临时工作副本。"""
    if not (SCANS_DIR / filename).exists():
        return
    for directory in (PENDING_DIR, APPROVAL_DIR, UNMATCHED_DIR):
        try:
            (directory / filename).unlink(missing_ok=True)
            (directory / (Path(filename).stem + ".json")).unlink(missing_ok=True)
        except Exception:
            pass


def _resolve_task_image(t: "TaskRecord") -> Optional[Path]:
    """优先用 current_image_path，再 fallback 到目录遍历。"""
    if t.current_image_path:
        p = Path(t.current_image_path)
        if p.exists():
            return p
    for d in [SCANS_DIR, PENDING_DIR, APPROVAL_DIR, UNMATCHED_DIR]:
        p = d / t.filename
        if p.exists():
            return p
    return None


# ── 审批操作 ──────────────────────────────────────────────────────────────

@flask_app.route('/api/approve', methods=['POST'])
def api_approve():
    data      = request.get_json(silent=True) or {}
    scan_name = data.get("scan_name", "").strip()
    pdf_name  = data.get("pdf_name", "").strip()
    if not scan_name or not pdf_name:
        return jsonify({"error": "missing params"}), 400

    t_by_name = task_store.get_by_filename(scan_name) if task_store else None
    scan_path = _resolve_task_image(t_by_name) if t_by_name else None
    if scan_path is None:
        scan_path = APPROVAL_DIR / scan_name
        if not scan_path.exists():
            scan_path = PENDING_DIR / scan_name
        if not scan_path.exists():
            return jsonify({"error": "scan not found"}), 404
    source_dir = scan_path.parent

    orig    = Path(cfg["originals_path"])
    matches = list(orig.rglob(pdf_name))
    if not matches:
        return jsonify({"error": f"pdf not found: {pdf_name}"}), 404

    tid_approve = t_by_name.id if t_by_name else None
    moved = _move_task_image(tid_approve, scan_path, SCANS_DIR)
    if moved is None:
        return jsonify({"error": "move scan failed"}), 500
    scan_path = moved
    _remove_exception_work_copies(scan_path.name)
    try:
        (source_dir / (Path(scan_name).stem + ".json")).unlink(missing_ok=True)
    except Exception:
        pass

    if task_store:
        t2 = task_store.get_by_filename(scan_path.name)
        tid = t2.id if t2 else task_store.ensure_exception_task(
            scan_path.name, "approval", "匹配冲突，等待人工选择PDF",
            "", "", [pdf_name], "multiple_candidates"
        )
        task_store.bind_manual_pdf(tid, pdf_name)
        task_store.mark_manual_pdf_generating(tid)
    proc.submit_generate_pdf(scan_path, matches[0])
    return jsonify({"status": "ok", "generating": True})


@flask_app.route('/api/pending-submit', methods=['POST'])
def api_pending_submit():
    data      = request.get_json(silent=True) or {}
    scan_name = data.get("scan_name", "").strip()
    pdf_name  = data.get("pdf_name", "").strip()
    passport  = data.get("passport", "").strip().upper()

    t_pending = task_store.get_by_filename(scan_name) if task_store else None
    scan_path = _resolve_task_image(t_pending) if t_pending else None
    if scan_path is None:
        scan_path = PENDING_DIR / scan_name
    if not scan_path.exists():
        return jsonify({"error": "scan not found"}), 404
    tid_pending = t_pending.id if t_pending else None

    if pdf_name:
        orig    = Path(cfg["originals_path"])
        matches = list(orig.rglob(pdf_name))
        if not matches:
            return jsonify({"error": f"pdf not found: {pdf_name}"}), 404
        active_path = _move_task_image(tid_pending, scan_path, SCANS_DIR)
        if active_path is None:
            return jsonify({"error": "move scan failed"}), 500
        _remove_exception_work_copies(active_path.name)
        try:
            (PENDING_DIR / (Path(scan_name).stem + ".json")).unlink(missing_ok=True)
        except Exception:
            pass
        if task_store:
            t2 = task_store.get_by_filename(active_path.name)
            tid = t2.id if t2 else task_store.ensure_exception_task(
                active_path.name, "unmatched", "等待人工选择PDF",
                "", "", [pdf_name], "pdf_missing"
            )
            task_store.bind_manual_pdf(tid, pdf_name)
            task_store.mark_manual_pdf_generating(tid)
        proc.submit_generate_pdf(active_path, matches[0])
    elif passport:
        active_path = _move_task_image(tid_pending, scan_path, SCANS_DIR)
        if active_path is None:
            return jsonify({"error": "move scan failed"}), 500
        _remove_exception_work_copies(active_path.name)
        try:
            (PENDING_DIR / (Path(scan_name).stem + ".json")).unlink(missing_ok=True)
        except Exception:
            pass
        proc.submit_with_passport(active_path, passport)
    else:
        return jsonify({"error": "provide pdf_name or passport"}), 400

    return jsonify({"status": "ok"})


@flask_app.route('/api/pending-retry', methods=['POST'])
def api_pending_retry():
    data = request.get_json(silent=True) or {}
    scan_name = data.get("scan_name", "").strip()
    if not scan_name:
        return jsonify({"error": "missing scan_name"}), 400
    t_pr = task_store.get_by_filename(scan_name) if task_store else None
    scan_path = _resolve_task_image(t_pr) if t_pr else None
    if scan_path is None:
        scan_path = PENDING_DIR / scan_name
    if not scan_path.exists():
        return jsonify({"error": "scan not found"}), 404
    tid_pr = t_pr.id if t_pr else None
    moved = _move_task_image(tid_pr, scan_path, SCANS_DIR)
    if moved is None:
        return jsonify({"error": "move scan failed"}), 500
    _remove_exception_work_copies(moved.name)
    try:
        meta = PENDING_DIR / (Path(scan_name).stem + ".json")
        if meta.exists():
            meta.unlink(missing_ok=True)
    except Exception:
        pass
    proc.submit(moved)
    return jsonify({"status": "ok"})


@flask_app.route('/api/approval-retry', methods=['POST'])
def api_approval_retry():
    data = request.get_json(silent=True) or {}
    scan_name = data.get("scan_name", "").strip()
    if not scan_name:
        return jsonify({"error": "missing scan_name"}), 400
    t_ar = task_store.get_by_filename(scan_name) if task_store else None
    scan_path = _resolve_task_image(t_ar) if t_ar else None
    if scan_path is None:
        scan_path = APPROVAL_DIR / scan_name
    if not scan_path.exists():
        return jsonify({"error": "scan not found"}), 404
    tid_ar = t_ar.id if t_ar else None
    moved = _move_task_image(tid_ar, scan_path, SCANS_DIR)
    if moved is None:
        return jsonify({"error": "move scan failed"}), 500
    _remove_exception_work_copies(moved.name)
    try:
        meta = APPROVAL_DIR / (Path(scan_name).stem + ".json")
        if meta.exists():
            meta.unlink(missing_ok=True)
    except Exception:
        pass
    proc.submit(moved)
    return jsonify({"status": "ok"})


# ── 上传 ──────────────────────────────────────────────────────────────────

@flask_app.route('/upload', methods=['GET'])
def upload_page():
    return send_file(str(_BASE / 'upload.html'))


def _upload_json_error(message: str, status_code: int = 400):
    return jsonify({"ok": False, "status": "error", "error": message, "message": message}), status_code


def _upload_log(message: str):
    try:
        print(message, flush=True)
    except Exception:
        pass


def _upload_response(batch_id: str, ok: bool, status_code: int = 200,
                     message: str = ""):
    batch = task_store.get_upload_batch(batch_id) if task_store else {}
    payload = {
        "ok": ok,
        "status": "ok" if ok else "error",
        "batch_id": batch_id,
        "selected_count": batch.get("selected_count", 0),
        "received_count": batch.get("received_count", 0),
        "saved_count": batch.get("saved_count", 0),
        "skipped_count": batch.get("skipped_count", 0),
        "failed_count": batch.get("failed_count", 0),
        "queued_count": batch.get("queued_count", 0),
        "before_disk_count": batch.get("before_disk_count", 0),
        "after_disk_count": batch.get("after_disk_count", 0),
        "disk_added_count": batch.get("disk_added_count", 0),
        "files": batch.get("files", []),
        "reconciliation_ok": batch.get("reconciliation_ok", True),
        "reconciliation_message": batch.get("reconciliation_message", ""),
    }
    if message:
        payload["message"] = message
        if not ok:
            payload["error"] = message
    return jsonify(payload), status_code


@flask_app.route('/api/upload/batch/start', methods=['POST'])
def api_upload_batch_start():
    if not task_store:
        return _upload_json_error("处理服务未就绪，请重启程序", 503)
    data = request.get_json(silent=True) or {}
    batch_id = str(data.get("batch_id") or "").strip()
    if not batch_id:
        return _upload_json_error("缺少 batch_id", 400)
    batch = task_store.start_upload_batch(
        batch_id,
        data.get("selected_count", 0),
        data.get("skipped_files", []),
    )
    return jsonify({"ok": True, "status": "ok", **batch})


@flask_app.route('/api/upload/batch/finish', methods=['POST'])
def api_upload_batch_finish():
    if not task_store:
        return _upload_json_error("处理服务未就绪，请重启程序", 503)
    data = request.get_json(silent=True) or {}
    batch_id = str(data.get("batch_id") or "").strip()
    if not batch_id:
        return _upload_json_error("缺少 batch_id", 400)
    batch = task_store.finish_upload_batch(
        batch_id,
        data.get("sent_count", 0),
        data.get("transport_failed_files", []),
    )
    cumulative_saved = task_store.get_upload_counts().get("saved_count", 0)
    _log_stat_mismatch_if_needed(batch_id, batch.get("saved_count", 0), cumulative_saved)
    return jsonify({"ok": True, "status": "ok", **batch})


@flask_app.route('/api/upload', methods=['POST'])
def api_upload():
    batch_id = (request.form.get("batch_id") or "").strip()
    implicit_batch = not batch_id
    if implicit_batch:
        batch_id = f"direct_{uuid.uuid4().hex}"
    if task_store:
        if implicit_batch:
            task_store.start_upload_batch(batch_id, 1, [])
        task_store.record_upload_received(batch_id)
    original_name = ""
    saved_name = ""
    file_status = "failed"
    reason = ""
    queued = False
    status_code = 500
    try:
        # ── 调试日志：打印请求头和字段，方便排查 iPhone 快捷指令格式 ──
        ct = request.content_type or ''
        ua = request.headers.get('User-Agent', '')[:80]
        _upload_log(f"[upload] Content-Type: {ct}")
        _upload_log(f"[upload] files keys:   {list(request.files.keys())}")
        _upload_log(f"[upload] form keys:    {list(request.form.keys())}")
        _upload_log(f"[upload] User-Agent:   {ua}")

        # 找上传的文件：优先 'file'，再取第一个字段
        f = None
        if 'file' in request.files:
            f = request.files['file']
        elif request.files:
            first_key = next(iter(request.files))
            f = request.files[first_key]
            _upload_log(f"[upload] field is not file; using {first_key}")

        if f is None:
            reason = f"未找到文件字段（收到字段: {list(request.files.keys())}）"
            file_status = "skipped"
            status_code = 400
            raise ValueError(reason)

        reported_name = str(request.form.get("original_name") or f.filename or "").replace("\\", "/").strip()
        original_name = reported_name
        original_basename = reported_name.split("/")[-1].strip()
        if not original_basename:
            reason = "文件名为空"
            file_status = "skipped"
            status_code = 400
            raise ValueError(reason)

        suffix = Path(original_basename).suffix.lower()
        if suffix not in WATCH_EXTS:
            reason = f"不支持 {suffix or '该'} 文件，仅支持 JPG/JPEG/PNG/WEBP/BMP/TIF/TIFF"
            file_status = "skipped"
            status_code = 400
            raise ValueError(reason)

        safe_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(original_basename).stem).strip(" .")
        if not safe_stem:
            safe_stem = "upload"
        saved_name = f"{safe_stem}{suffix}"
        SCANS_DIR.mkdir(parents=True, exist_ok=True)
        save_path = _unique_path(SCANS_DIR / saved_name)
        saved_name = save_path.name
        _add_seen_path(save_path)
        f.save(str(save_path))
        _add_seen_path(save_path)
        size = save_path.stat().st_size if save_path.exists() else 0
        _upload_log(f"[upload] saved: {saved_name} size: {size} bytes")
        if size <= 0:
            save_path.unlink(missing_ok=True)
            reason = "文件为空"
            file_status = "skipped"
            status_code = 400
            raise ValueError(reason)
        try:
            with Image.open(save_path) as img:
                img.verify()
        except Exception as e:
            save_path.unlink(missing_ok=True)
            _upload_log(f"[upload] error: broken image ({e})")
            reason = "图片损坏或编码不受支持"
            file_status = "skipped"
            status_code = 400
            raise ValueError(reason)
        file_status = "saved"
        status_code = 200
        if not proc:
            reason = "文件已保存，但处理服务未就绪，未进入OCR队列"
        else:
            try:
                if task_store:
                    source_hint = (request.form.get("source") or "").lower()
                    is_mobile = any(x in ua.lower() for x in ["iphone", "android", "mobile"])
                    source = "mobile_upload" if source_hint == "mobile" or (is_mobile and source_hint != "computer") else "upload"
                    task_store.new_task(saved_name, source=source)
                proc.submit(save_path)
                queued = True
            except Exception as e:
                reason = f"文件已保存，但进入OCR队列失败: {e}"
    except Exception as e:
        if not reason:
            reason = f"上传接口异常: {e}"
            file_status = "failed"
            status_code = 500
        _upload_log(f"[upload] exception: {reason}")

    if task_store:
        task_store.record_upload_file(
            batch_id,
            original_name,
            saved_name,
            file_status,
            reason,
            queued,
        )
        if implicit_batch:
            task_store.finish_upload_batch(batch_id, 1, [])
    ok = file_status == "saved"
    response, _ = _upload_response(batch_id, ok, status_code, reason)
    payload = response.get_json()
    payload["original_name"] = original_name
    payload["saved_name"] = saved_name
    payload["filename"] = saved_name
    payload["queued"] = queued
    return jsonify(payload), status_code


# ── 监听开关 ──────────────────────────────────────────────────────────────

@flask_app.route('/api/toggle-listen', methods=['POST'])
def api_toggle_listen():
    if watching:
        _stop_watch()
    else:
        _start_watch()
    return jsonify({"listening": watching})


# ── 重试 ──────────────────────────────────────────────────────────────────

@flask_app.route('/api/retry/<task_id>', methods=['POST'])
def api_retry(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    t = task_store.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    scan_path = _resolve_task_image(t)
    if scan_path is None:
        return jsonify({"error": "scan file not found"}), 404
    task_store.mark_retrying(task_id)
    proc.submit(scan_path)
    return jsonify({"status": "ok"})


@flask_app.route('/api/tasks/<task_id>/control', methods=['POST'])
def api_task_control(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    data = request.get_json(silent=True) or {}
    action = data.get("action", "").strip()
    t = task_store.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    if action not in {"pause", "manual", "cancel", "ignore", "resume", "manual_complete"}:
        return jsonify({"error": "unknown action"}), 400
    resume_path = None
    if action == "resume":
        resume_path = _resolve_task_image(t)
        if resume_path is None:
            return jsonify({"error": "scan file not found"}), 404
    ok, reason = task_store.control_task(task_id, action)
    if not ok:
        return jsonify({"error": reason or "操作失败"}), 409
    if action == "resume":
        proc.submit(resume_path)
    return jsonify({"status": "ok"})


@flask_app.route('/api/tasks/<task_id>/manual-pdf', methods=['POST'])
def api_task_manual_pdf(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    data = request.get_json(silent=True) or {}
    pdf_name = data.get("pdf_name", "").strip()
    if not pdf_name:
        return jsonify({"error": "missing pdf_name"}), 400
    t = task_store.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    if t.status in {"success", "completed"} and t.manual_pdf_confirmed:
        _archive_residual_exception_scan(t.filename)
        return jsonify({
            "status": "ok",
            "task_id": task_id,
            "pdf_name": t.selected_pdf or t.matched_pdf or pdf_name,
            "already_generated": True,
        })
    if t.status not in {"manual", "failed", "unmatched", "approval", "pending_confirm", "matched", "workflow_anomaly"}:
        return jsonify({"error": "当前任务状态不允许手动选择PDF"}), 409
    orig = Path(cfg["originals_path"])
    matches = list(orig.rglob(pdf_name))
    if not matches:
        return jsonify({"error": f"pdf not found: {pdf_name}"}), 404
    scan_path = _resolve_task_image(t)
    if scan_path is None:
        return jsonify({"error": "scan file not found"}), 404
    if scan_path.parent != SCANS_DIR:
        source_dir = scan_path.parent
        moved = _move_task_image(task_id, scan_path, SCANS_DIR)
        if moved is None:
            return jsonify({"error": "move scan failed"}), 500
        try:
            meta = source_dir / (scan_path.stem + ".json")
            if meta.exists():
                meta.unlink(missing_ok=True)
        except Exception:
            pass
        scan_path = moved
        t = task_store.get(task_id) or t
    task_store.bind_manual_pdf(task_id, pdf_name)
    task_store.mark_manual_pdf_generating(task_id)
    _remove_exception_work_copies(scan_path.name)
    proc.submit_generate_pdf(scan_path, matches[0])
    return jsonify({"status": "ok", "task_id": task_id, "pdf_name": pdf_name, "generating": True})


@flask_app.route('/api/tasks/<task_id>/filename-verify-pass', methods=['POST'])
def api_task_filename_verify_pass(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    t = task_store.get(task_id)
    if not t:
        return jsonify({"error": "task not found"}), 404
    if not _filename_verify_ok(t.name, t.matched_pdf):
        return jsonify({"error": "文件名核验未通过，禁止生成PDF"}), 409
    task_store.mark_filename_verify_passed(task_id)
    if t.status in {"success", "completed"}:
        return jsonify({"status": "ok", "already_generated": True})
    scan_path = _resolve_task_image(t)
    if scan_path is None:
        return jsonify({"error": "scan file not found"}), 404
    orig = Path(cfg["originals_path"])
    matches = list(orig.rglob(t.matched_pdf))
    if not matches:
        return jsonify({"error": f"pdf not found: {t.matched_pdf}"}), 404
    task_store.mark_filename_verified_generating(task_id)
    proc.submit_generate_pdf(scan_path, matches[0])
    return jsonify({"status": "ok", "generating": True})


@flask_app.route('/api/tasks/<task_id>/workflow-anomaly', methods=['POST'])
def api_task_workflow_anomaly(task_id):
    if not task_store:
        return jsonify({"error": "not ready"}), 503
    if not task_store.mark_workflow_anomaly(task_id):
        return jsonify({"error": "task not found"}), 404
    return jsonify({"status": "ok"})


@flask_app.route('/api/workspace/clear-completed', methods=['POST'])
def api_workspace_clear_completed():
    if not task_store:
        return jsonify({"ok": False, "message": "系统尚未就绪"}), 503
    ok, message, cleared = task_store.clear_completed_workspace()
    if not ok:
        return jsonify({"ok": False, "message": message}), 409
    return jsonify({"ok": True, "message": message, "cleared": cleared})


@flask_app.route('/api/pdfs')
def api_pdfs():
    orig = Path(cfg["originals_path"])
    if not orig.exists():
        return jsonify([])
    return jsonify(sorted(p.name for p in orig.rglob("*.pdf")))


# ── 设置 ──────────────────────────────────────────────────────────────────

def _path_config_key(kind: str) -> Optional[str]:
    return {
        "originals": "originals_path",
        "completed": "signed_path",
        "signed": "signed_path",
        "scans": "scans_path",
    }.get((kind or "").strip().lower())


def _resolve_config_path(raw: str) -> Path:
    p = Path((raw or "").strip())
    if not p.is_absolute():
        p = _BASE / p
    return p.resolve()


def _run_folder_dialog(initial_dir: str) -> Optional[str]:
    """Open Windows native folder-picker via PowerShell.

    Uses STARTUPINFO+SW_HIDE instead of CREATE_NO_WINDOW so the process
    has full desktop access (CREATE_NO_WINDOW can prevent GUI windows from
    appearing on the user's desktop).
    """
    if sys.platform != 'win32':
        return None
    safe = initial_dir.replace('"', '')
    ps = (
        'Add-Type -AssemblyName System.Windows.Forms;'
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog;'
        '$f.ShowNewFolderButton = $true;'
        f'$f.SelectedPath = "{safe}";'
        '$null = $f.ShowDialog();'
        'Write-Output $f.SelectedPath'
    )
    si = subprocess.STARTUPINFO()
    si.dwFlags  = subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0   # SW_HIDE — hides the console, GUI windows still appear
    try:
        res = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps],
            capture_output=True, text=True, timeout=120,
            encoding='utf-8', errors='replace',
            startupinfo=si
        )
        out = (res.stdout or '').strip()
        return out if out else None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def _bring_explorer_front(path: Path):
    """Raise the Explorer window opened for path (runs in background thread).

    Uses HWND_TOPMOST trick to bypass Windows focus-theft prevention:
    briefly set the window as topmost (forces it to front), then remove
    the topmost flag so it stays visible without being always-on-top.
    """
    if sys.platform != 'win32':
        return
    import ctypes
    from ctypes import wintypes

    folder_name = path.name.lower() if path.name else str(path).lower()

    try:
        user32 = ctypes.windll.user32

        # Callback for EnumWindows — finds a visible window whose title contains
        # the folder name (Explorer shows "FolderName - File Explorer" or "FolderName").
        found: list = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
        def _cb(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if folder_name in buf.value.lower():
                found.append(hwnd)
                return False  # stop enumeration
            return True

        # Wait for Explorer to open and retry up to ~3 s
        for _ in range(8):
            time.sleep(0.4)
            found.clear()
            user32.EnumWindows(_cb, 0)
            if found:
                break

        if not found:
            return

        hwnd = found[0]
        SW_RESTORE     = 9
        HWND_TOPMOST   = ctypes.c_void_p(-1)
        HWND_NOTOPMOST = ctypes.c_void_p(-2)
        SWP_FLAGS      = 0x0002 | 0x0001 | 0x0040  # NOMOVE | NOSIZE | SHOWWINDOW

        user32.ShowWindow(hwnd, SW_RESTORE)
        # Set topmost → window jumps to front even with focus-theft protection active
        user32.SetWindowPos(hwnd, HWND_TOPMOST,   0, 0, 0, 0, SWP_FLAGS)
        # Remove topmost so it doesn't stay always-on-top
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS)
        user32.SetForegroundWindow(hwnd)
    except Exception:
        pass

@flask_app.route('/api/settings', methods=['GET'])
def api_settings_get():
    return jsonify({
        "originals_path": cfg["originals_path"],
        "signed_path":    cfg["signed_path"],
        "scans_path":     cfg["scans_path"],
        "port":           HTTP_PORT,
        "ocr_enabled":    _OCR_OK,
        "qr_enabled":     _QR_OK,
    })


@flask_app.route('/api/settings', methods=['POST'])
def api_settings_post():
    data = request.get_json(silent=True) or {}
    if "originals_path" in data:
        cfg["originals_path"] = data["originals_path"].strip()
    if "signed_path" in data:
        cfg["signed_path"] = data["signed_path"].strip()
    if "scans_path" in data:
        cfg["scans_path"] = data["scans_path"].strip()
    try:
        created = []
        for key in ["originals_path", "signed_path", "scans_path"]:
            raw = (cfg[key] or "").strip()
            if not raw:
                continue
            p = Path(raw)
            if not p.exists():
                p.mkdir(parents=True, exist_ok=True)
                created.append(str(p))
        cfg.save()
        return jsonify({"status": "ok", "created": created})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 浏览文件夹（Windows 置顶对话框） ─────────────────────────────────────

@flask_app.route('/api/select-folder', methods=['POST'])
def api_select_folder():
    data = request.get_json(silent=True) or {}
    kind = data.get("type", "")
    key = _path_config_key(kind)
    if not key:
        return jsonify({"error": "unknown path type"}), 400
    if sys.platform != 'win32':
        return jsonify({"error": "仅支持 Windows 系统"}), 500
    initial = cfg[key]
    if not initial or not Path(initial).exists():
        initial = str(_BASE)
    try:
        selected = _run_folder_dialog(initial)
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    if not selected:
        return jsonify({"status": "cancelled", "cancelled": True, "message": "已取消选择"})
    return jsonify({"status": "ok", "type": kind, "path": selected})

@flask_app.route('/api/browse-folder', methods=['GET'])
def api_browse_folder():
    with flask_app.test_request_context(json={"type": request.args.get("type", "originals")}):
        return api_select_folder()


@flask_app.route('/api/ensure-folder', methods=['POST'])
def api_ensure_folder():
    data = request.get_json(silent=True) or {}
    raw = (data.get("path") or "").strip()
    if not raw:
        kind = data.get("type", "")
        key = _path_config_key(kind)
        raw = cfg[key] if key else ""
    if not raw:
        return jsonify({"error": "missing path"}), 400
    try:
        p = Path(raw)
        created = not p.exists()
        p.mkdir(parents=True, exist_ok=True)
        return jsonify({"status": "ok", "path": str(p), "created": created})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 打开文件夹（os.startfile） ────────────────────────────────────────────

@flask_app.route('/api/open-folder', methods=['POST'])
def api_open_folder():
    data = request.get_json(silent=True) or {}
    raw = (data.get("path") or "").strip()
    if not raw:
        key = _path_config_key(data.get("folder", "") or data.get("type", ""))
        raw = cfg[key] if key else ""
        # Fall back to DEFAULT_CFG when config has been saved as empty
        if not raw and key:
            raw = DEFAULT_CFG.get(key, "")
    if not raw:
        return jsonify({"error": "unknown folder"}), 400
    p = _resolve_config_path(raw)
    if not p.exists():
        if data.get("create"):
            try:
                p.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                return jsonify({"error": str(e)}), 500
        else:
            return jsonify({"status": "missing", "missing": True, "path": str(p), "error": "文件夹不存在"})
    try:
        if sys.platform == 'win32':
            subprocess.Popen(["explorer.exe", str(p)])
            threading.Thread(target=_bring_explorer_front, args=(p,), daemon=True).start()
        else:
            webbrowser.open(str(p))
        return jsonify({"status": "ok", "path": str(p)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 文件数量统计 ──────────────────────────────────────────────────────────

@flask_app.route('/api/file-counts')
def api_file_counts():
    def cnt_pdf(path_str):
        d = Path(path_str)
        return len(list(d.rglob("*.pdf"))) if d.exists() else 0

    def cnt_img(path_str):
        d = Path(path_str)
        if not d.exists():
            return 0
        return sum(1 for f in d.rglob("*")
                   if f.is_file() and f.suffix.lower() in WATCH_EXTS)

    return jsonify({
        "originals": cnt_pdf(cfg["originals_path"]),
        "signed":    cnt_pdf(cfg["signed_path"]),
        "scans":     cnt_img(cfg["scans_path"]),
    })


@flask_app.route('/api/debug/stats')
def api_debug_stats():
    """Diagnostic endpoint: returns all upload-count sources for cross-checking.
    'saved_count' and 'ui_upload_count' are the authoritative source for the UI.
    'upload_directory_count' is the raw filesystem scan (must NOT be used by UI)."""
    def cnt_pdf(path_str):
        d = Path(path_str)
        return len(list(d.rglob("*.pdf"))) if d.exists() else 0

    def cnt_img(path_str):
        d = Path(path_str)
        if not d.exists():
            return 0
        return sum(1 for f in d.rglob("*")
                   if f.is_file() and f.suffix.lower() in WATCH_EXTS)

    upload_counts = task_store.get_upload_counts() if task_store else {}
    saved_count = upload_counts.get("saved_count", 0)
    upload_dir_count = cnt_img(cfg["scans_path"])
    return jsonify({
        "saved_count": saved_count,
        "ui_upload_count": saved_count,
        "upload_directory_count": upload_dir_count,
        "original_pdf_count": cnt_pdf(cfg["originals_path"]),
        "completed_count": upload_counts.get("completed_count", 0),
        "_note": {
            "saved_count": "upload_counts.saved_count — single source of truth for UI",
            "ui_upload_count": "same as saved_count; shown explicitly for verification",
            "upload_directory_count": "raw filesystem scan — NOT used by UI, for drift detection only",
        },
    })


# ── 工作记录 ──────────────────────────────────────────────────────────────
def _append_work_log(operator: str, pdf_name: str, ocr_image_name: str, result: str) -> None:
    """追加一条极简工作记录。"""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    line = (
        f"{now.year}-{now.month}-{now.day} {now.strftime('%H:%M:%S')}"
        f"｜{operator}｜{pdf_name or '—'}｜{ocr_image_name or '—'}｜{result or '—'}\n"
    )
    with _work_log_lock:
        with open(WORK_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)


def _append_work_summary(summary: str) -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    with _work_log_lock:
        with open(WORK_LOG_FILE, "a", encoding="utf-8") as f:
            f.write((summary or "").strip() + "\n")


def _parse_report_time(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        s = str(value).strip()
        if s.endswith("Z"):
            return datetime.fromtimestamp(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
        dt = datetime.fromisoformat(s)
        if dt.tzinfo:
            return datetime.fromtimestamp(dt.timestamp())
        return dt
    except Exception:
        return None


def _fmt_seconds(seconds: float) -> str:
    seconds = max(0, float(seconds or 0))
    if seconds < 60:
        return f"{seconds:.1f}秒"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.1f}分钟"
    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}小时"
    days = hours / 24
    return f"{days:.1f}天"


def _fmt_rate(value: float) -> str:
    return f"{float(value or 0):.1f}%"


def _pdf_count(path_str: str) -> int:
    d = Path(path_str)
    return len(list(d.rglob("*.pdf"))) if d.exists() else 0


def _build_operations_report(operator: str, batch_start_iso: str = "") -> tuple[str, dict]:
    now = datetime.now()
    supplied_start = _parse_report_time(batch_start_iso)
    all_rows = []
    if task_store:
        try:
            with task_store._lock:
                all_rows = [t for t in task_store._tasks.values()
                            if t.source in UPLOAD_SOURCES and t.exception_state != "ignored"]
        except Exception:
            all_rows = []

    rows = all_rows
    if supplied_start:
        rows = [t for t in all_rows if (_parse_report_time(t.created_at) or now) >= supplied_start]
        if not rows:
            rows = all_rows

    created_times = [_parse_report_time(t.created_at) for t in rows if _parse_report_time(t.created_at)]
    updated_times = [_parse_report_time(t.updated_at) for t in rows if _parse_report_time(t.updated_at)]
    batch_start = supplied_start or (min(created_times) if created_times else now)
    batch_end = max(updated_times) if updated_times else now
    if batch_end < batch_start:
        batch_end = now
    total_seconds = max(0.1, (batch_end - batch_start).total_seconds())

    uploaded_count = len(rows)
    original_pdf_count = _pdf_count(cfg["originals_path"]) if cfg else 0
    generated_pdf_count = _pdf_count(cfg["signed_path"]) if cfg else 0

    completed_rows = [t for t in rows if t.status in {"success", "completed"} or t.result_review_status == "passed"]
    completed_count = len(completed_rows)
    exception_rows = [t for t in rows if t.status in {"failed", "manual"}]
    exception_count = len(exception_rows)

    manual_pdf_ids = {t.id for t in rows if t.manual_pdf_confirmed or t.filename_verify_status == "manual_confirmed"}
    manual_confirm_ids = {t.id for t in rows
                          if t.status in {"approval", "pending_confirm", "unmatched", "manual"}
                          or t.manual_pdf_confirmed}
    exception_handled_ids = {t.id for t in rows
                             if t.exception_type
                             or t.status in {"failed", "manual"}
                             or t.exception_state in {"expired", "ignored"}}
    manual_intervention_ids = manual_confirm_ids | manual_pdf_ids | exception_handled_ids

    auto_completed_count = max(0, completed_count - len(manual_intervention_ids & {t.id for t in completed_rows}))
    manual_confirm_count = len(manual_confirm_ids)
    manual_pdf_count = len(manual_pdf_ids)
    exception_handled_count = len(exception_handled_ids)

    complete_rate = (completed_count / uploaded_count * 100) if uploaded_count else 0
    avg_seconds = total_seconds / uploaded_count if uploaded_count else 0
    per_minute = uploaded_count / (total_seconds / 60) if uploaded_count else 0
    per_hour = uploaded_count / (total_seconds / 3600) if uploaded_count else 0
    daily_capacity = per_hour * 8
    automation_rate = (auto_completed_count / uploaded_count * 100) if uploaded_count else 0
    manual_rate = (len(manual_intervention_ids) / uploaded_count * 100) if uploaded_count else 0
    exception_rate = (exception_count / uploaded_count * 100) if uploaded_count else 0

    def estimate(count: int) -> dict:
        sec = avg_seconds * count
        return {"count": count, "seconds": round(sec, 2), "text": _fmt_seconds(sec)}

    estimates = [estimate(n) for n in [100, 500, 1000, 5000, 10000, 20000]]
    risk_lines = []
    if exception_count > 0:
        risk_lines.append(f"发现异常任务{exception_count}个。")
        risk_lines.append("建议优先分析异常原因。")
    if exception_rate > 5:
        risk_lines.append("异常率偏高，建议优化OCR识别或匹配规则。")
    if manual_rate > 10:
        risk_lines.append("人工介入率偏高，建议优化自动匹配流程。")
    if exception_count == 0 and manual_rate <= 10:
        risk_lines.append("本批次流程稳定，可进入量产测试阶段。")
    if not risk_lines:
        risk_lines.append("本批次未发现明显风险。")

    conclusion = (
        f"本批次共处理{uploaded_count}张图片。\n"
        f"成功生成{generated_pdf_count}份PDF。\n"
        f"异常{exception_count}个。\n"
        f"自动化率{_fmt_rate(automation_rate)}。\n"
        f"系统总耗时{_fmt_seconds(total_seconds)}。\n"
        f"平均每张图片处理{avg_seconds:.1f}秒。\n"
        f"按照当前处理速度，预计处理10000张图片需要约{estimates[4]['text']}。"
    )

    report = {
        "test_date": now.strftime("%Y-%m-%d"),
        "operator": operator or "—",
        "batch_start_time": batch_start.strftime("%Y-%m-%d %H:%M:%S"),
        "batch_end_time": batch_end.strftime("%Y-%m-%d %H:%M:%S"),
        "total_seconds": round(total_seconds, 2),
        "total_duration": _fmt_seconds(total_seconds),
        "uploaded_images": uploaded_count,
        "original_pdfs": original_pdf_count,
        "generated_pdfs": generated_pdf_count,
        "exceptions": exception_count,
        "completion_rate": round(complete_rate, 2),
        "avg_seconds_per_image": round(avg_seconds, 2),
        "images_per_minute": round(per_minute, 2),
        "images_per_hour": round(per_hour, 2),
        "estimated_8h_images": round(daily_capacity, 1),
        "auto_completed": auto_completed_count,
        "manual_confirmed": manual_confirm_count,
        "manual_pdf_selected": manual_pdf_count,
        "exception_handled": exception_handled_count,
        "automation_rate": round(automation_rate, 2),
        "manual_intervention_rate": round(manual_rate, 2),
        "exception_rate": round(exception_rate, 2),
        "volume_estimates": estimates,
        "conclusion": conclusion,
        "risks": risk_lines,
    }

    lines = [
        "批次运营分析报告",
        "=" * 24,
        "",
        "【一、批次概览】",
        f"测试日期：{report['test_date']}",
        f"责任人：{report['operator']}",
        f"批次开始时间：{report['batch_start_time']}",
        f"批次完成时间：{report['batch_end_time']}",
        f"系统处理总耗时：{report['total_duration']}",
        f"本批次上传图片数：{uploaded_count}",
        f"原始PDF数量：{original_pdf_count}",
        f"已生成PDF数量：{generated_pdf_count}",
        f"异常数量：{exception_count}",
        f"完成率：{_fmt_rate(complete_rate)}",
        "",
        "【二、效率分析】",
        f"平均每张图片处理耗时：{avg_seconds:.1f}秒",
        f"平均每分钟处理图片数：{per_minute:.2f}张",
        f"平均每小时处理图片数：{per_hour:.2f}张",
        f"按照当前速度：预计每天（8小时）可处理图片数：{daily_capacity:.1f}张",
        "",
        "【三、自动化分析】",
        f"自动完成数量：{auto_completed_count}",
        f"人工确认数量：{manual_confirm_count}",
        f"人工选择PDF数量：{manual_pdf_count}",
        f"异常处理数量：{exception_handled_count}",
        f"自动化率：{_fmt_rate(automation_rate)}",
        f"人工介入率：{_fmt_rate(manual_rate)}",
        f"异常率：{_fmt_rate(exception_rate)}",
        "",
        "【四、量产测算】",
        "基于本批次真实处理速度自动测算：",
    ]
    for item in estimates:
        lines.append(f"预计处理{item['count']}张需要：{item['text']}")
    lines.extend([
        "",
        "【五、批次结论】",
        conclusion,
        "",
        "【六、风险提示】",
        *risk_lines,
        "",
        "说明：本报告仅包含汇总、分析、测算和结论，不包含任务明细。",
    ])
    return "\n".join(lines), report


@flask_app.route('/api/reports/operations', methods=['POST'])
def api_operations_report():
    data = request.get_json(silent=True) or {}
    operator = str(data.get("operator", "—")).strip() or "—"
    batch_start_iso = str(data.get("batch_start_iso", "")).strip()
    text, payload = _build_operations_report(operator, batch_start_iso)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}_运营分析报告"
    txt_path = REPORTS_DIR / f"{stem}.txt"
    json_path = REPORTS_DIR / f"{stem}.json"
    txt_path.write_text(text, encoding="utf-8")
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({
        "status": "ok",
        "txt_path": str(txt_path),
        "json_path": str(json_path),
        "report": payload,
    })


@flask_app.route('/api/work-log/append', methods=['POST'])
def api_work_log_append():
    data     = request.get_json(silent=True) or {}
    operator = str(data.get("operator", "—")).strip() or "—"
    summary  = str(data.get("summary", "")).strip()
    if summary:
        _append_work_summary(summary)
        return jsonify({"status": "ok"})
    pdf_name = str(data.get("pdf_name", data.get("filename", ""))).strip()
    ocr_name = str(data.get("ocr_name", data.get("action", ""))).strip()
    result   = str(data.get("result", "")).strip()
    if not (pdf_name or ocr_name or result):
        return jsonify({"error": "missing log fields"}), 400
    _append_work_log(operator, pdf_name, ocr_name, result)
    return jsonify({"status": "ok"})


@flask_app.route('/api/open-work-log', methods=['POST'])
def api_open_work_log():
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    if not WORK_LOG_FILE.exists():
        WORK_LOG_FILE.write_text(
            "# 工作记录\n# 格式：日期时间｜操作员｜PDF原文件名｜OCR识别后的上传图片名｜替换结果\n",
            encoding="utf-8"
        )
    try:
        import subprocess
        subprocess.Popen(["notepad.exe", str(WORK_LOG_FILE)])
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── 工作完成检查 ──────────────────────────────────────────────────────────

@flask_app.route('/api/work-check')
def api_work_check():
    orig   = Path(cfg["originals_path"])
    done_pdfs, undone_pdfs = [], []
    if orig.exists():
        for pdf in sorted(orig.rglob("*.pdf")):
            marker = pdf.parent / (pdf.stem + DONE_EXT)
            (done_pdfs if marker.exists() else undone_pdfs).append(pdf.name)
    pending_files = []
    if PENDING_DIR.exists():
        pending_files = [f.name for f in sorted(PENDING_DIR.iterdir())
                         if f.suffix.lower() in WATCH_EXTS]
    total = len(done_pdfs) + len(undone_pdfs)
    if pending_files or undone_pdfs:
        summary = f"还有 {len(undone_pdfs)} 份未处理、{len(pending_files)} 份 pending"
    else:
        summary = "全部完成！" if total > 0 else "暂无 originals PDF 文件"
    return jsonify({"done": done_pdfs, "undone": undone_pdfs,
                    "pending": pending_files, "summary": summary})


# ── 缩略图 ────────────────────────────────────────────────────────────────

def _find_scan_file(filename: str) -> Optional[Path]:
    for d in [APPROVAL_DIR, PENDING_DIR, SCANS_DIR, UNMATCHED_DIR]:
        p = d / filename
        try:
            rp = p.resolve()
            if not rp.is_relative_to(d.resolve()):
                continue  # block ../ path traversal
        except Exception:
            continue
        if rp.exists() and rp.is_file():
            return rp
    return None


def _find_pdf_file(filename: str) -> Optional[Path]:
    for base in [Path(cfg["originals_path"]), Path(cfg["signed_path"])]:
        if not base.exists():
            continue
        matches = list(base.rglob(filename))
        if matches:
            return matches[0]
    return None


@flask_app.route('/api/preview/scan/<path:filename>')
def api_preview_scan(filename):
    p = _find_scan_file(filename)
    if not p:
        return jsonify({"error": "not found"}), 404
    return send_file(str(p))


@flask_app.route('/api/preview/pdf/<path:filename>')
def api_preview_pdf(filename):
    p = _find_pdf_file(filename)
    if not p:
        return jsonify({"error": "not found"}), 404
    try:
        scale = float(request.args.get("scale", "3"))
    except Exception:
        scale = 3.0
    scale = max(1.0, min(scale, 5.0))
    try:
        doc = fitz.open(str(p))
        page = doc[0]
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        doc.close()
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype='image/png')
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@flask_app.route('/api/preview/rotation', methods=['POST'])
def api_preview_rotation():
    data = request.get_json(silent=True) or {}
    filename = data.get("filename", "").strip()
    try:
        rotation = int(data.get("rotation", 0))
    except Exception:
        rotation = 0
    if not filename:
        return jsonify({"error": "missing filename"}), 400
    changed = task_store.save_preview_rotation(filename, rotation) if task_store else 0
    return jsonify({"status": "ok", "updated": changed, "rotation": rotation % 360})

@flask_app.route('/api/thumb/pdf/<path:filename>')
def api_thumb_pdf(filename):
    pdf = _find_pdf_file(filename)
    if pdf:
        img = Processor._gen_pdf_thumb(pdf)
        if img:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            return send_file(buf, mimetype='image/png')
    return jsonify({"error": "not found"}), 404


@flask_app.route('/api/thumb/scan/<path:filename>')
def api_thumb_scan(filename):
    p = _find_scan_file(filename)
    if p:
        try:
            img = Image.open(p)
            img.thumbnail((300, 400), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            buf.seek(0)
            return send_file(buf, mimetype='image/jpeg')
        except Exception:
            pass
    return jsonify({"error": "not found"}), 404


# ── 二维码 ────────────────────────────────────────────────────────────────

@flask_app.route('/api/qr')
def api_qr():
    if not _QR_OK:
        return jsonify({"error": "qrcode not installed"}), 503
    ip  = _get_local_ip()
    url = f"http://{ip}:{HTTP_PORT}/upload"
    try:
        qr = _qrcode.QRCode(error_correction=_qrcode.constants.ERROR_CORRECT_M,
                             box_size=8, border=3)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return send_file(buf, mimetype='image/png')
    except Exception as e:
        return jsonify({"error": str(e)}), 500


_server_log("routes registered ok")


# ═══════════════════════════════════════════════════════════════════════════
# 监听控制
# ═══════════════════════════════════════════════════════════════════════════

def _start_watch():
    global watching, observer
    SCANS_DIR.mkdir(parents=True, exist_ok=True)
    handler  = ScanHandler(proc)
    observer = Observer()
    observer.schedule(handler, str(SCANS_DIR), recursive=False)
    observer.start()
    watching = True
    print("  [watch] uploads directory watcher started", flush=True)


def _stop_watch():
    global watching, observer
    if observer:
        observer.stop()
        observer.join(timeout=3.0)
        observer = None
    watching = False
    print("  [watch] stopped", flush=True)


# ═══════════════════════════════════════════════════════════════════════════
# 结果队列消费（后台线程，替代 tkinter._poll）
# ═══════════════════════════════════════════════════════════════════════════

def _result_consumer():
    while True:
        try:
            r: Result = rq.get(timeout=1.0)
            if r.status == "ocr_debug":
                if task_store:
                    task_store.update_ocr_stage(r.filename, r.message)
                continue
            if task_store:
                task_store.complete_task(r)
        except queue.Empty:
            continue
        except Exception:
            continue


# ═══════════════════════════════════════════════════════════════════════════
# 入口
# ═══════════════════════════════════════════════════════════════════════════

def _startup_integrity_check() -> None:
    """Warn on startup if disk is nearly full or index.html is damaged."""
    import shutil as _shutil
    # Disk space check
    try:
        usage = _shutil.disk_usage(_BASE)
        free_gb = usage.free / (1024 ** 3)
        if usage.free < 1 * (1024 ** 3):
            print(f"⚠ 警告：磁盘空间严重不足（剩余 {free_gb:.2f} GB）——禁止修改文件，否则可能被清空！")
        elif usage.free < 5 * (1024 ** 3):
            print(f"⚠ 注意：磁盘空间偏低（剩余 {free_gb:.1f} GB），建议尽快清理。")
    except Exception:
        pass
    # index.html integrity check
    index_html = _BASE / "index.html"
    try:
        if not index_html.exists():
            print("⚠ 警告：index.html 不存在！前端页面无法加载，请立即恢复备份。")
        elif index_html.stat().st_size < 10 * 1024:
            size_kb = index_html.stat().st_size // 1024
            print(f"⚠ 警告：前端文件异常（index.html 仅 {size_kb} KB），可能已损坏，请恢复备份。")
    except Exception:
        pass


def main():
    global cfg, proc, rq, task_store, SCANS_DIR, PENDING_DIR, APPROVAL_DIR, UNMATCHED_DIR

    _startup_integrity_check()

    if not _FLASK_OK:
        print("Please install Flask: pip install flask")
        return

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    _server_log(f"starting, base={_BASE}, port={HTTP_PORT}")

    cfg = Config()
    cfg.load()

    # 从 config 同步目录常量（允许用户通过设置页更改路径）
    SCANS_DIR     = Path(cfg["scans_path"])
    PENDING_DIR   = SCANS_DIR / "pending"
    APPROVAL_DIR  = SCANS_DIR / "approval"
    UNMATCHED_DIR = SCANS_DIR / "unmatched"

    for d in (Path(cfg["originals_path"]),
              Path(cfg["signed_path"]),
              SCANS_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    rq         = queue.Queue()
    task_store = TaskStore()
    proc       = Processor(cfg, rq)

    Processor.init_ocr_async()

    _start_watch()

    threading.Thread(target=_result_consumer, daemon=True).start()

    ip = _get_local_ip()
    print(f"\n{'='*52}")
    print("  Signature System v2.0 started")
    print(f"  Local URL:  http://127.0.0.1:{HTTP_PORT}")
    print(f"  Mobile URL: http://{ip}:{HTTP_PORT}")
    print("  Press Ctrl+C to stop")
    print(f"{'='*52}\n")

    _server_log("before app.run")
    _server_log(f"app.run host=0.0.0.0 port={HTTP_PORT}")
    flask_app.run(host='0.0.0.0', port=HTTP_PORT, debug=False,
                  use_reloader=False, threaded=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _server_log("exception traceback:\n" + traceback.format_exc())
        raise
