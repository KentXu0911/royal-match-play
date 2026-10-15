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
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("游戏启动文件下载失败，请检查网络后刷新重试。"));
    document.head.append(script);
  });
}
start.addEventListener("click", async () => {
  if (window.playtest.state === "failed") { location.reload(); return; }
  start.disabled = true;
  start.hidden = true;
  progress.hidden = false;
  window.playtest.state = "loading";
  statusText.textContent = "正在下载游戏资源…";
  let dataBlobUrl;
  try {
    if (!canvas.getContext("webgl2")) throw new Error("当前浏览器无法启用 WebGL 2，请使用支持硬件加速的浏览器。" );
    const response = await fetch("game-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取游戏配置，请刷新重试。" );
    const config = await response.json();
    if (Array.isArray(config.dataChunks) && config.dataChunks.length) {
      let received = 0;
      const total = config.dataChunks.reduce((sum, part) => sum + part.bytes, 0);
      const parts = await Promise.all(config.dataChunks.map(async part => {
        const download = await fetch(part.url);
        if (!download.ok) throw new Error("游戏资源下载失败，请刷新重试。");
        const bytes = await download.arrayBuffer();
        if (bytes.byteLength !== part.bytes) throw new Error("游戏资源下载不完整，请刷新重试。");
        received += bytes.byteLength;
        progress.value = received / total * 0.65;
        statusText.textContent = `正在加载游戏… ${Math.round(progress.value * 100)}%`;
        return bytes;
      }));
      dataBlobUrl = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
      config.unity.dataUrl = dataBlobUrl;
      // Versioned chunks use normal HTTP caching; a temporary Blob must not
      // become a new persistent Unity cache entry every time the page opens.
      config.unity.cacheControl = () => "no-store";
    }
    await loadScript(config.loader);
    config.unity.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    config.unity.showBanner = (message, type) => {
      if (type === "error") { window.playtest.errors.push(message); statusText.textContent = message; }
    };
    window.unityInstance = await createUnityInstance(canvas, config.unity, value => {
      progress.value = dataBlobUrl ? 0.65 + value * 0.35 : value;
      statusText.textContent = value < 0.9 ? `正在加载游戏… ${Math.round(progress.value * 100)}%` : "正在准备棋盘…";
    });
    window.playtest.state = "running";
    cover.hidden = true;
    fullscreen.disabled = false;
    canvas.focus();
  } catch (error) {
    window.playtest.state = "failed";
    window.playtest.errors.push(String(error));
    statusText.textContent = "加载失败：" + String(error.message || error);
    start.hidden = false;
    start.disabled = false;
    start.textContent = "刷新重试";
    progress.hidden = true;
  } finally {
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
