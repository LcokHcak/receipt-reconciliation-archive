"""断点续拉:记录/读取最新 seq。会话存档只存 5 天,必须持续拉,断了从这里接着来。"""

import os


def load_seq(seq_file):
    if not os.path.exists(seq_file):
        return 0
    with open(seq_file, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    return int(raw) if raw else 0


def save_seq(seq_file, seq):
    tmp = seq_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(str(int(seq)))
    os.replace(tmp, seq_file)  # 原子写,防写一半崩了坏掉
