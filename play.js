"use strict";
const canvas = document.getElementById("game");
const cover = document.getElementById("cover");
const start = document.getElementById("start");
const statusText = document.getElementById("status");
const progress = document.getElementById("progress");
const fullscreen = document.getElementById("fullscreen");
window.playtest = { state: "idle", errors: [] };
window.addEventListener("error", (event) => window.playtest.errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => window.playtest.errors.push(String(event.reason)));
const originalError = console.error.bind(console);
console.error = (...args) => { window.playtest.errors.push(args.map(String).join(" ")); originalError(...args); };

// Retain completed chunks across a download retry, but never reuse another version.
const completedChunks = new Map();
let downloadVersion;
let reloadRequired = false;
const DOWNLOAD_IDLE_MS = 25000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_WORKERS = 3;

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error("下载已取消")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}

async function fetchBytes(url, { signal, expectedBytes, onProgress = () => {}, onRetry = () => {}, cache = "default" }) {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error("下载已取消");
    const request = new AbortController();
    const cancel = () => request.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let timer, reader;
    const heartbeat = () => { clearTimeout(timer); timer = setTimeout(() => request.abort(), DOWNLOAD_IDLE_MS); };
    let failure;
    try {
      heartbeat();
      const response = await fetch(url, { signal: request.signal, cache: attempt > 1 ? "reload" : cache });
      if (!response.ok) throw new Error(`下载返回 HTTP ${response.status}`);
      heartbeat();
      let received = 0;
      let bytes;
      if (response.body) {
        reader = response.body.getReader();
        // Known-size chunks avoid retaining both a segment list and its full copy.
        bytes = expectedBytes === undefined ? null : new Uint8Array(expectedBytes);
        const segments = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          heartbeat();
          if (expectedBytes !== undefined && received + value.byteLength > expectedBytes) throw new Error("资源大小不符");
          if (bytes) bytes.set(value, received); else segments.push(value);
          received += value.byteLength;
          onProgress(received);
        }
        if (!bytes) {
          bytes = new Uint8Array(received);
          let offset = 0;
          for (const segment of segments) { bytes.set(segment, offset); offset += segment.byteLength; }
        }
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
        received = bytes.byteLength;
        onProgress(received);
      }
      if (signal.aborted) throw new Error("下载已取消");
      if (expectedBytes !== undefined && received !== expectedBytes) throw new Error("资源下载不完整");
      return bytes;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      // Stop an incomplete response before retrying or releasing its reader.
      if (failure) { request.abort(); if (reader) await reader.cancel().catch(() => {}); }
      if (reader) reader.releaseLock();
    }
    if (signal.aborted) throw new Error("下载已取消");
    onProgress(0);
    if (attempt === DOWNLOAD_ATTEMPTS) throw new Error("网络下载中断，已下载的资源会保留，请点击继续下载。");
    onRetry(attempt);
    await waitForRetry(attempt * 800, signal);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timer;
    const finish = (error) => {
      clearTimeout(timer); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    script.src = src;
    script.onload = () => finish();
    script.onerror = () => finish(new Error("游戏启动文件下载失败，请刷新重试。"));
    timer = setTimeout(() => finish(new Error("游戏启动文件下载超时，请刷新重试。")), DOWNLOAD_IDLE_MS);
    document.head.append(script);
  });
}

async function downloadChunks(config, controller) {
  if (downloadVersion !== config.version) { completedChunks.clear(); downloadVersion = config.version; }
  const chunks = config.dataChunks;
  const total = chunks.reduce((sum, part) => sum + part.bytes, 0);
  const received = chunks.map(part => completedChunks.get(part.url)?.byteLength === part.bytes ? part.bytes : 0);
  let next = 0, active = true;
  const showProgress = () => {
    if (!active || controller.signal.aborted) return;
    const count = received.reduce((sum, size) => sum + size, 0);
    progress.value = count / total * 0.65;
    statusText.textContent = `正在下载游戏资源… ${(count / 1000000).toFixed(1)} / ${(total / 1000000).toFixed(1)} MB`;
  };
  showProgress();
  let failure;
  const worker = async () => {
    try {
      while (!controller.signal.aborted) {
        const index = next++;
        if (index >= chunks.length) return;
        const part = chunks[index];
        if (received[index] === part.bytes) continue;
        const bytes = await fetchBytes(part.url, {
          signal: controller.signal,
          expectedBytes: part.bytes,
          onProgress: count => { received[index] = count; showProgress(); },
          onRetry: attempt => { if (active && !controller.signal.aborted) statusText.textContent = `网络较慢，正在自动重试（${attempt}/${DOWNLOAD_ATTEMPTS - 1}）…`; }
        });
        completedChunks.set(part.url, bytes);
      }
    } catch (error) {
      if (!failure) failure = error;
      active = false;
      controller.abort();
    }
  };
  // Settle cancelled workers before showing failure or enabling another attempt.
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_WORKERS, chunks.length) }, worker));
  active = false;
  if (failure) throw failure;
  return chunks.map(part => completedChunks.get(part.url));
}

start.addEventListener("click", async () => {
  if (window.playtest.state === "loading" || window.playtest.state === "running") return;
  if (reloadRequired) { location.reload(); return; }
  start.disabled = true;
  start.hidden = true;
  progress.hidden = false;
  window.playtest.state = "loading";
  statusText.textContent = "正在连接游戏资源…";
  const controller = new AbortController();
  let dataBlobUrl, initTimer;
  try {
    if (!canvas.getContext("webgl2")) throw new Error("当前浏览器无法启用 WebGL 2，请使用支持硬件加速的浏览器。");
    const configBytes = await fetchBytes("game-config.json", {
      signal: controller.signal, cache: "no-store",
      onRetry: () => { statusText.textContent = "连接较慢，正在重新连接…"; }
    });
    const config = JSON.parse(new TextDecoder().decode(configBytes));
    if (Array.isArray(config.dataChunks) && config.dataChunks.length) {
      const parts = await downloadChunks(config, controller);
      dataBlobUrl = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
      config.unity.dataUrl = dataBlobUrl;
      config.unity.cacheControl = () => "no-store";
    }
    statusText.textContent = "资源下载完成，正在启动游戏…";
    // A Unity instance that times out may still be initializing. Retry it only
    // after a reload so two runtimes cannot share the same canvas.
    reloadRequired = true;
    await loadScript(config.loader);
    config.unity.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    config.unity.showBanner = (message, type) => {
      if (type === "error") { window.playtest.errors.push(message); if (window.playtest.state === "loading") statusText.textContent = message; }
    };
    let expired = false;
    const instance = createUnityInstance(canvas, config.unity, value => {
      if (expired || window.playtest.state !== "loading") return;
      progress.value = dataBlobUrl ? 0.65 + value * 0.35 : value;
      statusText.textContent = value < 0.9 ? `正在启动游戏… ${Math.round(progress.value * 100)}%` : "正在准备棋盘…";
    });
    const timeout = new Promise((_, reject) => {
      initTimer = setTimeout(() => { expired = true; reject(new Error("游戏启动超时，请刷新重试。")); }, 180000);
    });
    instance.then(late => { if (expired) late.Quit().catch(() => {}); }, () => {});
    window.unityInstance = await Promise.race([instance, timeout]);
    clearTimeout(initTimer);
    completedChunks.clear();
    window.playtest.state = "running";
    cover.hidden = true;
    fullscreen.disabled = false;
    canvas.focus();
  } catch (error) {
    controller.abort();
    window.playtest.state = "failed";
    window.playtest.errors.push(String(error));
    statusText.textContent = "加载失败：" + String(error.message || error);
    start.hidden = false;
    start.disabled = false;
    start.textContent = reloadRequired ? "刷新重试" : "继续下载";
    progress.hidden = true;
  } finally {
    clearTimeout(initTimer);
    if (dataBlobUrl) URL.revokeObjectURL(dataBlobUrl);
  }
});
fullscreen.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.getElementById("stage").requestFullscreen();
    canvas.focus();
  } catch (error) { console.warn("全屏不可用", error); }
});
document.getElementById("exit-fullscreen").addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  canvas.focus();
});
canvas.addEventListener("pointerdown", () => canvas.focus());
canvas.addEventListener("contextmenu", event => event.preventDefault());
