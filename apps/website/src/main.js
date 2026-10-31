const presets = {
  balanced: {
    model: "DeepSeek",
    description: "让经济的模型，承担具体工作。",
    badge: "经济高效",
    note: "订阅做规划，API 做执行。按任务自由搭配。",
  },
  local: {
    model: "你的本地模型",
    description: "大量具体工作，在自己的设备上完成。",
    badge: "本地执行",
    note: "云端负责规划与审查，本地执行；看图按需调用。",
  },
};

for (const button of document.querySelectorAll("[data-preset]")) {
  button.addEventListener("click", () => {
    const preset = presets[button.dataset.preset];
    for (const option of document.querySelectorAll("[data-preset]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
    document.querySelector("#execution-model").textContent = preset.model;
    document.querySelector("#execution-description").textContent = preset.description;
    document.querySelector("#execution-badge").textContent = preset.badge;
    document.querySelector("#workflow-footnote").textContent = preset.note;
  });
}

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
  workspace: {
    src: "/assets/workspace.jpg",
    title: "Mori 工作台",
    alt: "Mori 的项目列表、任务会话与 Agent 工作区",
  },
  team: {
    src: "/assets/team.jpg",
    title: "Agent 分工配置",
    alt: "为不同 Agent 分别配置模型、服务商与工具的 Mori 界面",
  },
  cost: {
    src: "/assets/cost.jpg",
    title: "费用与缓存",
    alt: "按会话、Agent 和模型查看用量、费用与缓存的 Mori 面板",
  },
};
const dialog = document.querySelector("#product-dialog");
const dialogImage = document.querySelector("#dialog-image");
for (const button of document.querySelectorAll("[data-gallery]")) {
  button.addEventListener("click", () => {
    const item = gallery[button.dataset.gallery];
    dialogImage.src = item.src;
    dialogImage.alt = item.alt;
    document.querySelector("#dialog-title").textContent = item.title;
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
