# HappySubs 本地实时识别服务
# 接收扩展发来的 16kHz/16bit/单声道 PCM,JSON 推回:
#   {"text": "当前这句的完整文本", "final": false}   识别中,整句刷新
#   {"text": "定稿文本",           "final": true}    检测到停顿,这句定稿
#
# 两个模型,各管一件事:
#   流式模型(sherpa-onnx 中英双语 zipformer)  边听边出字,并负责断句。快,但只懂
#       中文和英文,输出没有标点,词也常听错。
#   二次识别(SenseVoice-small,可选)          每句说完后,把这一句的音频整段重新
#       识别一遍,用它的结果做定稿:更准,带标点和大小写,还懂日语、韩语、粤语。
#       在 M1 上一句约 0.2 秒。
# model-sensevoice/ 不存在时(老安装),定稿退回流式模型的文本,和以前完全一样。
import asyncio
import errno
import json
import logging
import os
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
import websockets

HOST = "127.0.0.1"
PORT = 8765
SAMPLE_RATE = 16000
MODEL_DIR = Path(__file__).resolve().parent / "model"
REFINE_DIR = Path(__file__).resolve().parent / "model-sensevoice"
# 每句开头往前多带一点音频:流式模型的断句点常常落在下一个词刚开口之后,
# 不带这一点,二次识别会丢掉那个词的第一个音节。
LEAD_IN_SAMPLES = int(SAMPLE_RATE * 0.3)
# 流式模型只懂这两种;二次识别判定为别的语言时,流式模型出的是乱字,不往外推。
STREAMING_LANGS = {"zh", "en"}
# 调试用:HAPPYSUBS_DEBUG_AUDIO=1 时,把收到的音频原样存成 wav(每个连接最多 3 分钟),
# 用来和原视频的声音对比——识别得差,有时是送来的声音本身就缺了一块或太小。
DEBUG_AUDIO = os.environ.get("HAPPYSUBS_DEBUG_AUDIO") == "1"
DEBUG_AUDIO_MAX_SAMPLES = SAMPLE_RATE * 180

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", force=True)
log = logging.getLogger("blc")


def pick(name_int8: str, name_fp32: str) -> str:
    """优先用 int8 量化文件(小、快、精度损失可忽略)"""
    p = MODEL_DIR / name_int8
    return str(p if p.exists() else MODEL_DIR / name_fp32)


log.info("正在加载中英双语流式模型…")
recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=str(MODEL_DIR / "tokens.txt"),
    encoder=pick("encoder-epoch-99-avg-1.int8.onnx", "encoder-epoch-99-avg-1.onnx"),
    decoder=pick("decoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx"),
    joiner=pick("joiner-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.onnx"),
    num_threads=2,
    sample_rate=SAMPLE_RATE,
    feature_dim=80,
    # 束搜索比贪心解码准确率更高,代价是略多一点 CPU
    decoding_method="modified_beam_search",
    max_active_paths=4,
    enable_endpoint_detection=True,
    # 以下三个阈值单位都是「秒」(sherpa-onnx 默认 2.4 / 1.2 / 20)
    rule1_min_trailing_silence=2.4,   # 长静音断句
    # 断句越短,译文出得越早、一次越短。以前是停顿 1.2 秒、最长 12 秒,一个说话快的人
    # 三句话常被当成一句,中文要等十来秒才一起出来。在一段 4 分钟的脱口秀上比过:
    #   1.2s / 12s → 平均每段 7.7 秒、17 个词
    #   0.8s /  8s → 平均每段 4.8 秒、11 个词,没有一段混进两句话
    #   0.6s /  6s → 更短,但把一句话从中间切开的明显变多
    rule2_min_trailing_silence=0.8,   # 已出字后的短静音断句
    # 兜底:连续说这么久还没停顿就强制断句,免得一段越积越长、字幕铺满还被裁掉。
    rule3_min_utterance_length=8,
)
log.info("模型加载完成")

refiner = None
if (REFINE_DIR / "model.int8.onnx").exists() and (REFINE_DIR / "tokens.txt").exists():
    try:
        refiner = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(REFINE_DIR / "model.int8.onnx"),
            tokens=str(REFINE_DIR / "tokens.txt"),
            num_threads=2,
            use_itn=True,       # 带标点、数字写成阿拉伯数字
            language="auto",    # 每句自己判断语言
        )
        log.info("二次识别模型(SenseVoice)加载完成:定稿更准、带标点,支持中/英/日/韩/粤")
    except Exception as e:  # 模型文件坏了、sherpa-onnx 太旧等:不影响流式识别
        log.warning("二次识别模型加载失败,定稿将使用流式结果: %s", e)
else:
    log.info("未安装二次识别模型(model-sensevoice/),定稿使用流式结果。重新运行一次安装命令即可装上")


def prettify(text: str) -> str:
    """模型输出的英文是全大写,转成正常句式:全小写 → 句首大写,I/I'm 保持大写"""
    t = text.lower()
    t = re.sub(r"\bi\b", "I", t)
    m = re.search(r"[a-z]", t)
    if m and m.start() == re.search(r"[a-zA-Z一-鿿]", t).start():
        t = t[: m.start()] + t[m.start()].upper() + t[m.start() + 1 :]
    return t


def refine(samples: np.ndarray) -> tuple:
    """整句重新识别,返回 (文本, 语言代码)。语言形如 zh / en / ja / ko / yue,取不到时为空"""
    s = refiner.create_stream()
    s.accept_waveform(SAMPLE_RATE, samples)
    refiner.decode_stream(s)
    text = (s.result.text or "").strip()
    # 英文逗号后面偶尔不带空格("And I said,That dog");补上
    text = re.sub(r",(?=[A-Za-z])", ", ", text)
    # 句首两个词偶尔粘在一起("AndWe were walking"):往前多带的那一点音频里有半个词,
    # 模型把它和这句的第一个词连着写了
    # (只拆常见的句首小词,免得把 McDonald 这类名字也拆开)
    text = re.sub(r"^(And|But|So|Or|Then|Well|Yeah|Oh|Now|Because|Like|Okay)([A-Z][a-z]+)\b", r"\1 \2", text)
    # 往前多带的那一点音频里有时只有上一句最后一个词的尾巴("mentsWith me"),去掉
    text = re.sub(r"^[a-z]{2,8}(?=[A-Z][a-z])", "", text)
    lang = re.sub(r"[<|>]", "", getattr(s.result, "lang", "") or "")
    return text, lang


HAS_WORDS = re.compile(r"[0-9A-Za-z\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
HAS_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def save_debug_wav(chunks: list) -> None:
    if not chunks:
        return
    path = Path(__file__).resolve().parent / f"debug-audio-{time.strftime('%H%M%S')}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"".join(chunks))
    log.info("调试音频已保存: %s", path)


def decode(stream) -> tuple:
    """跑到没有可解码的帧为止,返回 (当前文本, 是否句尾)"""
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    text = prettify(recognizer.get_result(stream))
    is_endpoint = recognizer.is_endpoint(stream)
    if is_endpoint:
        recognizer.reset(stream)
    return text, is_endpoint


# 连上就先报一下自己是哪一版、有没有二次识别。扩展收不到这条,就知道连的是
# 2.2.0 之前的旧识别服务,会在「实时听译」标签里提示重新运行安装命令。
SERVER_VERSION = "2.2.0"


async def handle(ws):
    log.info("客户端已连接: %s", ws.remote_address)
    await ws.send(json.dumps({"type": "hello", "version": SERVER_VERSION, "refine": refiner is not None}))
    stream = recognizer.create_stream()
    loop = asyncio.get_running_loop()
    last_sent = ""
    # 当前这一句的音频(float32 片段),定稿时交给二次识别;tail 是上一句的结尾一小段
    seg = []
    tail = np.zeros(0, dtype=np.float32)
    # 最近几句的语言。连续两句都不是中/英时,流式模型出的是乱字,暂停推送"识别中"
    recent_langs = []
    debug_chunks, debug_samples = [], 0
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                if DEBUG_AUDIO and debug_samples < DEBUG_AUDIO_MAX_SAMPLES:
                    debug_chunks.append(msg)
                    debug_samples += len(msg) // 2
                pcm = np.frombuffer(msg, dtype=np.int16).astype(np.float32) / 32768.0
                seg.append(pcm)
                stream.accept_waveform(SAMPLE_RATE, pcm)
                # 推理放线程池,避免阻塞 WebSocket 心跳
                text, final = await loop.run_in_executor(None, decode, stream)
                if final:
                    audio = np.concatenate([tail] + seg) if seg else tail
                    seg = []
                    tail = audio[-LEAD_IN_SAMPLES:]
                    if text and refiner is not None:
                        try:
                            better, lang = await loop.run_in_executor(None, refine, audio)
                        except Exception as e:
                            log.warning("二次识别失败,使用流式结果: %s", e)
                            better, lang = "", ""
                        # 二次识别没听出话来(掌声、欢呼、音乐):这一段就不是话。流式模型
                        # 会把这类声音硬听成字("加油加油"),以前在这里保留了它的结果,
                        # 观众一鼓掌字幕里就冒出一串不相干的字。只剩标点的结果同样不算话。
                        # 一直在说英语,这一句里却冒出几个汉字("Under. Good主生了凡。"):
                        # 是一小段杂音被当成中文听了。去掉这几个字,语言仍算英语
                        if recent_langs == ["en", "en"] and HAS_CJK.search(better):
                            better = re.sub(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+[。，、！？]?", "", better)
                            better = re.sub(r"\s{2,}", " ", better).strip()
                            lang = "en"
                        if not HAS_WORDS.search(better):
                            better = ""
                        elif lang:
                            recent_langs = (recent_langs + [lang])[-2:]
                        text = better
                        # 空定稿也要发:扩展靠它把屏幕上"识别中"的那串字清掉
                        if last_sent or text:
                            await ws.send(json.dumps({"text": text, "final": True}, ensure_ascii=False))
                    elif text:
                        await ws.send(json.dumps({"text": text, "final": True}, ensure_ascii=False))
                    last_sent = ""
                elif text and text != last_sent:
                    foreign = len(recent_langs) == 2 and not (set(recent_langs) & STREAMING_LANGS)
                    # 一直在说英语,流式模型突然冒出汉字:多半是噪声被听成了字,不推
                    off_script = recent_langs == ["en", "en"] and bool(HAS_CJK.search(text))
                    if not foreign and not off_script:
                        await ws.send(json.dumps({"text": text, "final": False}, ensure_ascii=False))
                    last_sent = text
            else:
                data = json.loads(msg)
                if data.get("type") == "reset":  # 切换视频,丢弃识别上下文
                    stream = recognizer.create_stream()
                    last_sent = ""
                    seg = []
                    tail = np.zeros(0, dtype=np.float32)
                    recent_langs = []
                    log.info("已重置识别状态")
    except websockets.ConnectionClosed:
        pass
    finally:
        if DEBUG_AUDIO:
            save_debug_wav(debug_chunks)
        log.info("客户端断开: %s", ws.remote_address)


async def main():
    try:
        # max_size=None: 音频二进制帧不限大小; 一次只服务一个页面
        async with websockets.serve(handle, HOST, PORT, max_size=None):
            log.info("监听 ws://%s:%d", HOST, PORT)
            await asyncio.Future()
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            log.error(
                "端口 %d 被占用(通常是上一个 server.py 还在跑)。先执行:\n"
                "    lsof -ti:%d | xargs kill\n再重新启动。", PORT, PORT,
            )
            sys.exit(1)
        raise


if __name__ == "__main__":
    asyncio.run(main())
