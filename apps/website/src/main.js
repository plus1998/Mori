const menuButton = document.querySelector(".menu-button");
const mobileNav = document.querySelector("#mobile-nav");
function closeMenu() {
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.setAttribute("aria-label", "打开导航");
  mobileNav.hidden = true;
}
menuButton.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  mobileNav.hidden = !open;
});
for (const link of mobileNav.querySelectorAll("a")) {
  link.addEventListener("click", closeMenu);
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !mobileNav.hidden) {
    closeMenu();
    menuButton.focus();
  }
});
window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
  if (event.matches) closeMenu();
});

const gallery = {
  cost: {
    src: "./images/principle-billing.svg",
    title: "每一笔花费，心里有数。",
    alt: "费用面板示意，按模型展示费用与缓存命中率，数据为示例",
    caption: "费用面板样式示意 · 金额、缓存命中率均为示例，非实际调用结果。",
    layout: "illustration",
  },
  roles: {
    src: "./images/principle-roles.svg",
    title: "把好模型，用在关键处。",
    alt: "GPT-6.1 规划与审查，PI 搭配本地 Qwen3.8 执行的分工示意",
    caption: "分工配置示意 · 模型与 Harness 可按任务自由搭配。",
    layout: "illustration",
  },
  resources: {
    src: "./images/principle-resources.svg",
    title: "已有的资源，继续用好。",
    alt: "ChatGPT 账号、API、中转站与本地模型的资源搭配示意",
    caption: "资源配置示意 · 连接状态为示例，实际能力与额度由所选服务决定。",
    layout: "illustration",
  },
  mobile: {
    src: "./images/mobile-session.png",
    title: "Mori 移动端",
    alt: "Mori 真实移动端组件渲染的网站深色主题任务会话，内容为模拟示例",
    caption: "真实移动端组件渲染 · 对话与任务结果为模拟示例。",
    portrait: true,
  },
  wechat: {
    src: "./images/wechat-chat.png",
    title: "通过微信呼叫 Mori",
    alt: "微信聊天样式复现：询问任务进度、请求审查并接收通知，内容为模拟示例",
    caption: "微信原生聊天样式复现 · 对话、时间与任务结果为模拟示例。",
    portrait: true,
  },
};
const dialog = document.querySelector("#product-dialog");
const dialogImage = document.querySelector("#dialog-image");
for (const button of document.querySelectorAll("[data-gallery]")) {
  button.addEventListener("click", () => {
    const item = gallery[button.dataset.gallery];
    dialogImage.src = item.src;
    dialogImage.alt = item.alt;
    dialog.dataset.layout = item.layout ?? (item.portrait ? "portrait" : "landscape");
    document.querySelector("#dialog-title").textContent = item.title;
    document.querySelector("#dialog-caption").textContent =
      item.caption ?? "产品界面示例，具体内容随配置与版本变化。";
    dialog.showModal();
  });
}
dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    dialog.close();
});

const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
const mobileDevice =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/mac/i.test(platform) && navigator.maxTouchPoints > 1);
const operatingSystem = mobileDevice
  ? null
  : /mac/i.test(platform)
    ? "macOS"
    : /win/i.test(platform)
      ? "Windows"
      : /linux/i.test(platform) && !/android/i.test(navigator.userAgent)
        ? "Linux"
        : null;
if (operatingSystem) document.querySelector("#download-label").textContent = `下载 Mori · ${operatingSystem}`;

const filmTrack = document.querySelector("#film-track");
const previousFilm = document.querySelector(".film-previous");
const nextFilm = document.querySelector(".film-next");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const workflow = document.querySelector(".workflow-panel");
const workflowSteps = [...workflow.querySelectorAll(".workflow-stage")];
const workflowPlayback = workflow.querySelector(".workflow-playback");
const savings = workflow.querySelector(".workflow-savings");
const savingNumber = workflow.querySelector("#workflow-saving");
const costNumber = workflow.querySelector("#workflow-cost");
const stepWindows = [
  [0, 1400],
  [1400, 3200],
  [3200, 4600],
];
// Example only: 20% at the baseline rate + 80% at one tenth = 28% cost.
const exampleSaving = Math.round((1 - (0.2 + 0.8 * 0.1)) * 100);
const resultStart = 4600;
const resultDuration = 1200;
const workflowCycle = 9000;
let workflowElapsed = reducedMotion.matches ? resultStart + resultDuration : 0;
let workflowWanted = !reducedMotion.matches;
let workflowInView = false;
let workflowFrame = 0;
let workflowLastTime = null;

function renderWorkflow(elapsed) {
  const time = elapsed % workflowCycle;
  const showingResult = time >= resultStart;
  const phase = showingResult ? "result" : String(stepWindows.findIndex(([, end]) => time < end));
  if (workflow.dataset.workflow !== phase) workflow.dataset.workflow = phase;
  for (const [index, step] of workflowSteps.entries()) {
    const [start, end] = stepWindows[index];
    const active = time >= start && time < end;
    const complete = time >= end;
    step.classList.toggle("is-active", active);
    step.classList.toggle("is-complete", complete);
    const progress = Math.min(1, Math.max(0, (time - start) / (end - start)));
    step.style.setProperty("--step-progress", `${progress * 100}%`);
  }
  const progress = Math.min(1, Math.max(0, (time - resultStart) / resultDuration));
  const eased = 1 - (1 - progress) ** 3;
  const percent = Math.round(exampleSaving * eased);
  if (savingNumber.textContent !== String(percent)) savingNumber.textContent = String(percent);
  if (costNumber.textContent !== String(100 - percent)) costNumber.textContent = String(100 - percent);
  savings.style.setProperty("--cost-width", `${100 - percent}%`);
}

function animateWorkflow(time) {
  if (workflowLastTime !== null) workflowElapsed += time - workflowLastTime;
  workflowLastTime = time;
  renderWorkflow(workflowElapsed);
  workflowFrame = requestAnimationFrame(animateWorkflow);
}

function syncWorkflowPlayback() {
  cancelAnimationFrame(workflowFrame);
  workflowLastTime = null;
  const running = workflowWanted && workflowInView && !document.hidden;
  workflow.dataset.playback = running ? "playing" : "paused";
  workflowPlayback.setAttribute("aria-pressed", String(workflowWanted));
  workflowPlayback.setAttribute("aria-label", workflowWanted ? "暂停分工动画" : "播放分工动画");
  workflowPlayback.querySelector("use").setAttribute("href", workflowWanted ? "#pause" : "#play");
  if (running) workflowFrame = requestAnimationFrame(animateWorkflow);
}

workflow.dataset.animated = "true";
workflowPlayback.hidden = false;
renderWorkflow(workflowElapsed);
syncWorkflowPlayback();
new IntersectionObserver(
  ([entry]) => {
    workflowInView = entry.isIntersecting && entry.intersectionRatio >= 0.15;
    syncWorkflowPlayback();
  },
  { threshold: 0.15 },
).observe(workflow);
workflowPlayback.addEventListener("click", () => {
  workflowWanted = !workflowWanted;
  syncWorkflowPlayback();
});
document.addEventListener("visibilitychange", syncWorkflowPlayback);
reducedMotion.addEventListener("change", (event) => {
  workflowWanted = !event.matches;
  workflowElapsed = event.matches ? resultStart + resultDuration : 0;
  renderWorkflow(workflowElapsed);
  syncWorkflowPlayback();
});

function updateFilmNavigation() {
  previousFilm.disabled = filmTrack.scrollLeft < 2;
  nextFilm.disabled = filmTrack.scrollLeft + filmTrack.clientWidth >= filmTrack.scrollWidth - 2;
}
function browseFilms(direction) {
  filmTrack.scrollBy({
    left: direction * filmTrack.querySelector(".film-card").getBoundingClientRect().width,
    behavior: reducedMotion.matches ? "instant" : "smooth",
  });
}
previousFilm.addEventListener("click", () => browseFilms(-1));
nextFilm.addEventListener("click", () => browseFilms(1));
filmTrack.addEventListener("scroll", updateFilmNavigation, { passive: true });
new ResizeObserver(updateFilmNavigation).observe(filmTrack);
filmTrack.addEventListener("keydown", (event) => {
  if (event.target !== filmTrack || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  browseFilms(event.key === "ArrowRight" ? 1 : -1);
});

// Start autoplay on the first view; after leaving, the visitor can choose when to resume.
const films = document.querySelectorAll(".film-screen video");
const filmObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const film = entry.target;
      const inView = entry.isIntersecting && entry.intersectionRatio >= 0.5;
      if (inView && !film.dataset.started && !reducedMotion.matches && !document.hidden) {
        film.dataset.started = "true";
        film.play().catch(() => {
          // Native controls remain available if the browser blocks autoplay.
        });
      } else if (!inView) {
        film.pause();
      }
    }
  },
  { threshold: 0.5 },
);
for (const film of films) filmObserver.observe(film);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const film of films) film.pause();
});
reducedMotion.addEventListener("change", (event) => {
  if (event.matches) for (const film of films) film.pause();
});
