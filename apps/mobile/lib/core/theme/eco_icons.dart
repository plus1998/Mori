import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../utils/activity_display.dart';

/// Eco Mobile 语义化图标，统一映射到 Lucide Icons。
///
/// Lucide 在 AI / 开发场景下图标更丰富（bot、sparkles、git、terminal 等），
/// 比 Material Icons 语义更准确。
abstract final class EcoIcons {
  // ── 导航 ──────────────────────────────────────────────
  static const IconData sessions = LucideIcons.messageSquare;
  static const IconData sessionsSelected = LucideIcons.messagesSquare;
  static const IconData settings = LucideIcons.settings;

  // ── 通用操作 ──────────────────────────────────────────
  static const IconData back = LucideIcons.arrowLeft;
  static const IconData close = LucideIcons.x;
  static const IconData check = LucideIcons.check;
  static const IconData checkCircle = LucideIcons.circleCheck;
  static const IconData refresh = LucideIcons.refreshCw;
  static const IconData more = LucideIcons.ellipsis;
  static const IconData notifications = LucideIcons.bell;
  static const IconData schedule = LucideIcons.clock;
  static const IconData add = LucideIcons.plus;
  static const IconData send = LucideIcons.arrowUp;
  static const IconData expandDown = LucideIcons.chevronDown;
  static const IconData expandUp = LucideIcons.chevronUp;
  static const IconData expandFullscreen = LucideIcons.maximize2;
  static const IconData collapseFullscreen = LucideIcons.minimize2;
  static const IconData galleryHorizontal = LucideIcons.galleryHorizontal;
  static const IconData galleryVertical = LucideIcons.galleryVertical;
  static const IconData chevronLeft = LucideIcons.chevronLeft;
  static const IconData chevronRight = LucideIcons.chevronRight;
  static const IconData goForward = LucideIcons.arrowRightCircle;

  // ── 设备 / 连接 ───────────────────────────────────────
  static const IconData desktop = LucideIcons.monitor;
  static const IconData qrScan = LucideIcons.scanLine;
  static const IconData flashlight = LucideIcons.flashlight;
  static const IconData flashlightOn = LucideIcons.flashlightOff;
  static const IconData user = LucideIcons.user;
  static const IconData logout = LucideIcons.logOut;

  // ── 外观 / 主题 ───────────────────────────────────────
  static const IconData themeSystem = LucideIcons.monitor;
  static const IconData themeDark = LucideIcons.moon;
  static const IconData themeLight = LucideIcons.sun;

  // ── 文件 / 项目 ───────────────────────────────────────
  static const IconData home = LucideIcons.home;
  static const IconData folder = LucideIcons.folder;
  static const IconData folderOpen = LucideIcons.folderOpen;
  static const IconData pin = LucideIcons.pin;
  static const IconData delete = LucideIcons.trash;
  static const IconData file = LucideIcons.fileText;
  static const IconData read = LucideIcons.bookOpen;
  static const IconData branch = LucideIcons.gitFork;
  static const IconData newThread = LucideIcons.messageSquarePlus;

  // ── AI / Agent ────────────────────────────────────────
  static const IconData agent = LucideIcons.bot;
  static const IconData pi = LucideIcons.pi;
  static const IconData sparkles = LucideIcons.sparkles;
  static const IconData terminal = LucideIcons.terminal;
  static const IconData terminalSquare = LucideIcons.squareTerminal;
  static const IconData search = LucideIcons.search;
  static const IconData network = LucideIcons.globe2;
  static const IconData contextCompaction = LucideIcons.minimize2;
  static const IconData edit = LucideIcons.pencil;
  static const IconData copy = LucideIcons.copy;
  static const IconData mic = LucideIcons.mic;
  static const IconData stop = LucideIcons.stopCircle;
  static const IconData volume2 = LucideIcons.volume2;
  static const IconData speaking = LucideIcons.audioLines;

  // ── 会话工具栏 ────────────────────────────────────────
  static const IconData todos = LucideIcons.listChecks;
  static const IconData planApproval = LucideIcons.clipboardList;
  static const IconData codeReview = LucideIcons.fileDiff;
  static const IconData commitPush = LucideIcons.gitCommit;
  static const IconData pull = LucideIcons.download;
  static const IconData npmScripts = LucideIcons.squareTerminal;

  // ── Composer 配置 ───────────────────────────────────────
  static const IconData orchestration = LucideIcons.layoutDashboard;
  static const IconData subagents = LucideIcons.users;
  static const IconData planMode = LucideIcons.listTodo;
  static const IconData askMode = LucideIcons.messageCircle;
  static const IconData agentMode = LucideIcons.infinity;
  static const IconData shieldAuto = LucideIcons.shield;
  static const IconData shieldAllowAll = LucideIcons.shieldOff;
  static const IconData shieldManual = LucideIcons.hand;
  static const IconData mcp = LucideIcons.plug;
  static const IconData image = LucideIcons.image;
  static const IconData images = LucideIcons.images;
  static const IconData browser = LucideIcons.appWindow;
  static const IconData tool = LucideIcons.wrench;
  static const IconData computer = LucideIcons.monitor;
  static const IconData skills = LucideIcons.bookOpen;

  // ── Markdown / Mermaid ────────────────────────────────
  static const IconData previewOn = LucideIcons.eye;
  static const IconData previewOff = LucideIcons.eyeOff;

  static const IconData followUp = LucideIcons.notebook;
  static const IconData pause = LucideIcons.pause;
  static const IconData play = LucideIcons.play;
  static const IconData subthread = LucideIcons.messagesSquare;
  static const IconData indent = LucideIcons.cornerDownRight;
  static const IconData rename = LucideIcons.type;

  // ── Git / 云端 ────────────────────────────────────────
  static const IconData cloudUpload = LucideIcons.cloudUpload;

  // ── 用量 / 状态 ───────────────────────────────────────
  static const IconData contextMemory = LucideIcons.cpu;
  static const IconData error = LucideIcons.alertCircle;
  static const IconData blocked = LucideIcons.ban;
  static const IconData pending = LucideIcons.circle;
  static const IconData active = LucideIcons.circleDot;
  static const IconData waiting = LucideIcons.hourglass;

  static IconData activityAction(ActivityActionIcon icon) {
    return switch (icon) {
      ActivityActionIcon.search => search,
      ActivityActionIcon.edit => edit,
      ActivityActionIcon.terminal => terminal,
      ActivityActionIcon.agent => agent,
      ActivityActionIcon.file => file,
      ActivityActionIcon.read => read,
      ActivityActionIcon.context => contextCompaction,
      ActivityActionIcon.network => network,
      ActivityActionIcon.image => image,
      ActivityActionIcon.images => images,
      ActivityActionIcon.browser => browser,
      ActivityActionIcon.computer => computer,
      ActivityActionIcon.tool => tool,
    };
  }
}
