# intake/pull — 企业微信会话存档拉取模块

拉取式收聊天:定时调官方 SDK 拉密文 → 私钥解随机密钥 → SDK 解正文 → 下载图片 →
输出统一事件到 `data/messages.jsonl`,供 Node 端(抽取 + 装配引擎 + 看板)消费。

**这是"采集适配器"这一脏活层**,独立进程(pm2 `intake-pull`),隔离于 sign。

## 文件

| 文件 | 作用 | 现在可跑? |
|------|------|-----------|
| `crypto.py` | RSA(PKCS1v15) 解 encrypt_random_key | ✅ 已测(`test_crypto.py` 往返通过) |
| `wework_sdk.py` | ctypes 封装 `libWeWorkFinanceSdk_C.so`(Init/GetChatData/DecryptData/GetMediaData) | 需 .so |
| `config.py` | 读环境变量配置 | ✅ |
| `seq_store.py` | 断点续拉(记 seq) | ✅ |
| `message_map.py` | 企微消息 → 统一事件(原始消息层,不判护照/小票) | ✅ |
| `emit.py` | 统一事件 → `messages.jsonl` | ✅ |
| `pull_once.py` | 拉一批全流程编排 | 需 .so |
| `watcher.py` | 常驻循环(pm2 起这个) | 需 .so |

## 统一事件契约(pull 输出,Node 消费)

```jsonc
{ "msg_id","room_id","sender","ts"(毫秒),"msgtype"(text|image|file|...),
  "text","sdkfileid","media_local_path" }
```
> 这一层只输出**原始消息**;判护照/小票/航班是 Node 端多模态抽取器的事。
> 图片已下载到本地,`media_local_path` 给抽取器读图;`sender`+`ts` 给装配引擎做发送上下文归组。

## 部署前置(服务器 Ubuntu)

1. 放官方 SDK:`libWeWorkFinanceSdk_C.so` → `intake/sdk/`(**只用腾讯官方二进制**,核对校验值)
2. 私钥:`intake/secrets/wecom_private.pem`(从本地传上去,权限 600)
3. `.env`:`WECOM_CORPID / WECOM_ARCHIVE_SECRET / WECOM_PRIVATE_KEY_PATH / WECOM_PUBLIC_KEY_VERSION / WECOM_SDK_PATH`
4. 依赖:`pip install -r pull/requirements.txt`
5. 可信IP=服务器公网IP(企微后台已设);存档已 Enable;测试群有消息

## 运行

```bash
# 拉一次(调试)
cd intake && py pull/pull_once.py
# 常驻(pm2)
pm2 start --name intake-pull --interpreter python3 pull/watcher.py
```

## 已验证 / 待验证

- ✅ RSA 解密往返(真实公私钥,2048bit)
- ⏳ SDK 调用链(Init/GetChatData/DecryptData/GetMediaData)—— 需 .so + 测试群消息才能端到端跑
