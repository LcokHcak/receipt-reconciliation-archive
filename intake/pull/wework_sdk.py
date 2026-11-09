"""ctypes 封装官方会话存档 C SDK(libWeWorkFinanceSdk_C.so)。

按官方 C 接口写。需要把官方 .so 放到 WECOM_SDK_PATH 才能加载运行。
(本文件在没有 .so 的机器上 import 时不会崩;真正加载发生在 WeWorkSdk() 构造时。)

官方接口:
  NewSdk() -> sdk*
  Init(sdk, corpid, secret) -> int(0 成功)
  GetChatData(sdk, seq, limit, proxy, passwd, timeout, Slice*) -> int
  DecryptData(encrypt_key, encrypt_msg, Slice*) -> int
  GetMediaData(sdk, indexbuf, sdkfileid, proxy, passwd, timeout, MediaData*) -> int
  NewSlice()/FreeSlice()/GetContentFromSlice()/GetSliceLen()
  NewMediaData()/FreeMediaData()/GetData()/GetDataLen()/GetOutIndexBuf()/IsMediaDataFinish()
  DestroySdk(sdk)
"""

import ctypes
import json


class WeWorkSdkError(Exception):
    pass


class WeWorkSdk:
    def __init__(self, sdk_path, corpid, secret):
        self._lib = ctypes.CDLL(sdk_path)
        self._bind()
        self._sdk = self._lib.NewSdk()
        ret = self._lib.Init(self._sdk, corpid.encode(), secret.encode())
        if ret != 0:
            raise WeWorkSdkError(f"Init 失败 ret={ret}")

    def _bind(self):
        lib = self._lib
        lib.NewSdk.restype = ctypes.c_void_p
        lib.Init.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
        lib.Init.restype = ctypes.c_int
        lib.GetChatData.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulonglong,
            ctypes.c_uint,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_void_p,
        ]
        lib.GetChatData.restype = ctypes.c_int
        lib.DecryptData.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p]
        lib.DecryptData.restype = ctypes.c_int
        lib.GetMediaData.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_void_p,
        ]
        lib.GetMediaData.restype = ctypes.c_int
        lib.NewSlice.restype = ctypes.c_void_p
        lib.FreeSlice.argtypes = [ctypes.c_void_p]
        lib.GetContentFromSlice.argtypes = [ctypes.c_void_p]
        lib.GetContentFromSlice.restype = ctypes.c_void_p
        lib.GetSliceLen.argtypes = [ctypes.c_void_p]
        lib.GetSliceLen.restype = ctypes.c_int
        lib.NewMediaData.restype = ctypes.c_void_p
        lib.FreeMediaData.argtypes = [ctypes.c_void_p]
        lib.GetData.argtypes = [ctypes.c_void_p]
        lib.GetData.restype = ctypes.c_void_p
        lib.GetDataLen.argtypes = [ctypes.c_void_p]
        lib.GetDataLen.restype = ctypes.c_int
        lib.GetOutIndexBuf.argtypes = [ctypes.c_void_p]
        lib.GetOutIndexBuf.restype = ctypes.c_char_p
        lib.IsMediaDataFinish.argtypes = [ctypes.c_void_p]
        lib.IsMediaDataFinish.restype = ctypes.c_int
        lib.DestroySdk.argtypes = [ctypes.c_void_p]

    def _slice_to_bytes(self, slice_ptr):
        length = self._lib.GetSliceLen(slice_ptr)
        content = self._lib.GetContentFromSlice(slice_ptr)
        return ctypes.string_at(content, length)

    def get_chat_data(self, seq, limit, proxy="", passwd="", timeout=30):
        """拉一批会话密文。返回 chatdata 列表(每项含 encrypt_random_key/encrypt_chat_msg/seq...)。"""
        sl = self._lib.NewSlice()
        try:
            ret = self._lib.GetChatData(
                self._sdk,
                ctypes.c_ulonglong(seq),
                ctypes.c_uint(limit),
                proxy.encode(),
                passwd.encode(),
                ctypes.c_int(timeout),
                sl,
            )
            if ret != 0:
                raise WeWorkSdkError(f"GetChatData 失败 ret={ret}")
            data = json.loads(self._slice_to_bytes(sl).decode("utf-8"))
            return data.get("chatdata", [])
        finally:
            self._lib.FreeSlice(sl)

    def decrypt_data(self, encrypt_key, encrypt_chat_msg):
        """encrypt_key = RSA 解出的随机密钥(bytes)。返回明文消息 dict。"""
        sl = self._lib.NewSlice()
        try:
            key = (
                encrypt_key if isinstance(encrypt_key, bytes) else encrypt_key.encode()
            )
            ret = self._lib.DecryptData(key, encrypt_chat_msg.encode(), sl)
            if ret != 0:
                raise WeWorkSdkError(f"DecryptData 失败 ret={ret}")
            return json.loads(self._slice_to_bytes(sl).decode("utf-8"))
        finally:
            self._lib.FreeSlice(sl)

    def get_media_data(self, sdkfileid, out_path, proxy="", passwd="", timeout=120):
        """按 sdkfileid 下载媒体(可能分片,循环拉到 finish),写入 out_path。"""
        index_buf = ""
        with open(out_path, "wb") as f:
            while True:
                media = self._lib.NewMediaData()
                try:
                    ret = self._lib.GetMediaData(
                        self._sdk,
                        index_buf.encode(),
                        sdkfileid.encode(),
                        proxy.encode(),
                        passwd.encode(),
                        ctypes.c_int(timeout),
                        media,
                    )
                    if ret != 0:
                        raise WeWorkSdkError(f"GetMediaData 失败 ret={ret}")
                    length = self._lib.GetDataLen(media)
                    data_ptr = self._lib.GetData(media)
                    f.write(ctypes.string_at(data_ptr, length))
                    if self._lib.IsMediaDataFinish(media) == 1:
                        break
                    index_buf = self._lib.GetOutIndexBuf(media).decode()
                finally:
                    self._lib.FreeMediaData(media)
        return out_path

    def close(self):
        if getattr(self, "_sdk", None):
            self._lib.DestroySdk(self._sdk)
            self._sdk = None
