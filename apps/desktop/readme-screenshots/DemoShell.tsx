import { Bot, FolderOpen, MessageCirclePlus, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";

interface DemoShellProps {
  children: ReactNode;
  activeThreadTitle?: string;
  projectName?: string;
}

export function DemoShell({
  children,
  activeThreadTitle = "Supabase Center 配对 UI",
  projectName = "mori-demo",
}: DemoShellProps) {
  return (
    <main className="shell readme-demo-root">
      <aside className="codex-sidebar" id="primary-sidebar" aria-hidden={false}>
        <div className="codex-sidebar-chrome" aria-hidden>
          <div className="codex-sidebar-chrome-drag" />
        </div>
        <div className="codex-sidebar-body-drag">
          <div className="sidebar-core-selector">
            <div className="sidebar-core-selector-label">Codex</div>
          </div>
          <button type="button" className="sidebar-action">
            <MessageCirclePlus size={18} strokeWidth={2} />
            新会话
          </button>
          <button type="button" className="sidebar-action muted">
            <FolderOpen size={18} strokeWidth={2} />
            打开项目
          </button>
          <div className="sidebar-section sidebar-section-grow">
            <div className="readme-demo-sidebar-project">{projectName}</div>
            <button type="button" className="readme-demo-sidebar-thread is-active">
              {activeThreadTitle}
              <span className="readme-demo-sidebar-thread-meta">Agent · 5 分钟前</span>
            </button>
            <button type="button" className="readme-demo-sidebar-thread">
              表格预览交互优化
              <span className="readme-demo-sidebar-thread-meta">PI · 昨天</span>
            </button>
          </div>
          <button type="button" className="sidebar-action muted">
            <Search size={18} strokeWidth={2} />
            搜索
          </button>
          <button type="button" className="sidebar-action muted">
            <Settings size={18} strokeWidth={2} />
            设置
          </button>
        </div>
      </aside>

      <section className="codex-main">
        <header className="codex-main-topbar">
          <div className="activity-header">
            <h2>{activeThreadTitle}</h2>
          </div>
          <div className="codex-main-topbar-actions">
            <div className="codex-main-topbar-action-group" data-group="workspace">
              <button type="button" className="codex-main-toolbar-button" aria-label="会话信息">
                <Bot size={15} aria-hidden />
              </button>
            </div>
          </div>
        </header>
        <div className="codex-main-left-column">
          <div className="codex-main-scroll-body">
            <div className="codex-feed-stack">{children}</div>
          </div>
        </div>
      </section>
    </main>
  );
}

interface DemoSettingsFrameProps {
  title: string;
  children: ReactNode;
}

export function DemoSettingsFrame({ title, children }: DemoSettingsFrameProps) {
  return (
    <div className="readme-demo-settings-frame">
      <aside className="settings-nav">
        <div className="settings-nav-group">
          <span className="settings-nav-group-label">模型与编排</span>
          <button type="button" className="settings-nav-item active">
            运行配置
          </button>
          <button type="button" className="settings-nav-item">
            模型服务商
          </button>
        </div>
      </aside>
      <div className="settings-main">
        <div className="settings-content">
          <header className="settings-page-header">
            <h1>{title}</h1>
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}
