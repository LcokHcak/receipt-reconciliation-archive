"""把企微解密后的消息 JSON 映射成 intake 统一事件(原始消息层)。

注意:这一层只输出"原始消息"(文本/图片/文件),不判断护照/小票/航班——
那是后面 Node 端多模态抽取器的活。图片会带上本地路径,供抽取器读图。

统一事件字段:
  msg_id     消息唯一ID
  room_id    群ID(单聊为空);后续按 roomid 换群名/映射代理
  sender     发送者(内部 userid 或外部 external_userid)
  ts         毫秒时间戳(发送上下文归组要用)
  msgtype    text | image | file | voice | video | ...
  text       文本内容(msgtype=text 时)
  sdkfileid  媒体文件ID(图片/文件,供 GetMediaData 下载)
  media_local_path  下载后的本地路径(图片抽取用)
"""


def to_event(msg):
    """msg: 企微 DecryptData 解出的单条消息 dict。返回统一事件 dict。"""
    msgtype = msg.get("msgtype", "")
    event = {
        "msg_id": msg.get("msgid", ""),
        "room_id": msg.get("roomid", ""),
        "sender": msg.get("from", ""),
        "ts": msg.get("msgtime"),  # 毫秒
        "msgtype": msgtype,
        "text": "",
        "sdkfileid": "",
        "media_local_path": "",
    }
    if msgtype == "text":
        event["text"] = msg.get("text", {}).get("content", "")
    elif msgtype in ("image", "file", "video", "voice", "emotion"):
        sub = msg.get(msgtype, {})
        event["sdkfileid"] = sub.get("sdkfileid", "")
    return event


def is_image(event):
    return event.get("msgtype") == "image" and event.get("sdkfileid")
