"""把统一事件交给 Node 端处理。这里用最简的 JSONL 追加(一行一条),
Node 侧 tail 这个文件做抽取+装配。以后可换成 HTTP 推送或消息队列,契约不变。"""

import json


def append_event(messages_file, event):
    with open(messages_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")
