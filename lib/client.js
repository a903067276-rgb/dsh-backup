window.__ModuleLoader__.load({
  id: "dsh-backup",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    /**
     * dsh-backup — Client 半（设置侧边栏页：备份管理）
     *
     * 设置 → 「备份」页：状态行（上次/下次备份）、立即备份、备份列表（删除）、
     * 配置表单（备份目录 / 定时开关+间隔 / 保留份数 / 自定义目录）。
     * UI 对齐 simple-memory 设置页规范（smem-card 同款皮肤，dsw token，无硬编码色）。
     * 与 host 半走 HTTP 路由 /api/dsh-backup/*（静态 bundle 无 harness.handle 配对）。
     */

    const inject = ["slots"];

    // ── 与 host 半通信 ──
    async function api(path, method, body) {
      const res = await fetch("/api/dsh-backup" + path, {
        cache: "no-store",
        method: method || "GET",
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
      return data;
    }

    // ── 样式（幂等注入，对齐 simple-memory 的 smem-card 皮肤）──
    if (typeof document !== "undefined" && !document.getElementById("dsh-backup-style")) {
      const tag = document.createElement("style");
      tag.id = "dsh-backup-style";
      tag.textContent = [
        // 设置内容皮肤（2026-08-21 对齐官方，同 simple-memory）：官方设置面板已提供背景，
        // 不自造卡片背景/边框/圆角——否则与其他插件分区深浅主题下灰底不一致
        ".bk-card{color:var(--dsw-alias-label-primary,#333);font-size:13px;line-height:1.6;}",
        ".bk-card h3{margin:0 0 8px;font-size:14px;font-weight:600;}",
        ".bk-card .row{margin:5px 0;color:var(--dsw-alias-label-secondary,#666);}",
        ".bk-card .btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);background:transparent;color:var(--dsw-alias-label-primary,#333);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;margin:6px 6px 0 0;}",
        ".bk-card .btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));}",
        ".bk-card .btn:disabled{opacity:.5;cursor:default;}",
        ".bk-card .btn-primary{color:var(--dsw-alias-state-business-primary,#4a7dff);font-weight:600;}",
        ".bk-card .btn-danger{color:var(--dsw-alias-state-error-primary,#d92d20);}",
        ".bk-card .field{margin:8px 0 0;}",
        ".bk-card .field label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:2px;}",
        ".bk-card .field input[type=text],.bk-card .field input[type=number]{width:100%;box-sizing:border-box;background:transparent;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);color:var(--dsw-alias-label-primary,#333);border-radius:6px;font-size:12px;padding:5px 8px;font-family:inherit;}",
        ".bk-card .field textarea{width:100%;box-sizing:border-box;background:transparent;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);color:var(--dsw-alias-label-primary,#333);border-radius:6px;font-size:12px;padding:5px 8px;font-family:inherit;min-height:64px;resize:vertical;}",
        ".bk-card .check{display:flex;align-items:center;gap:8px;margin:8px 0 0;font-size:13px;color:var(--dsw-alias-label-primary,#333);cursor:pointer;}",
        ".bk-card .check input{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary,#4a7dff);cursor:pointer;}",
        ".bk-card .msg{margin:8px 0 0;font-size:12px;}",
        ".bk-card .ok{color:var(--dsw-alias-state-success-primary,#2e9e44);}",
        ".bk-card .err{color:var(--dsw-alias-state-error-primary,#d03050);}",
        ".bk-card .btn.is-saved{color:var(--dsw-alias-state-success-primary,#2e9e44);border-color:var(--dsw-alias-state-success-primary,#2e9e44);}",
        ".bk-card .btn-danger.is-confirm{color:var(--dsw-alias-state-error-primary,#d92d20);border-color:var(--dsw-alias-state-error-primary,#d92d20);font-weight:600;}",
        ".bk-card .list-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5e5);}",
        ".bk-card .list-row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-family:monospace;font-size:11px;color:var(--dsw-alias-label-primary,#333);}",
        ".bk-card .list-row .meta{color:var(--dsw-alias-label-tertiary,#999);flex-shrink:0;font-size:11px;}",
        ".bk-card .sep{border-top:1px solid var(--dsw-alias-border-l1,#e5e5e5);margin:12px 0 8px;}",
        ".bk-card .hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin:4px 0 0;}",
      ].join("\n");
      document.head.appendChild(tag);
    }

    // ── 路径隐私（2026-08-20）：显示层把家目录缩写成 ~（截图分享不暴露用户名），
    //    保存时自动还原为真实绝对路径，功能不受影响 ──
    function displayPath(p, home) {
      if (typeof p !== "string" || p === "") return p;
      if (typeof home === "string" && home !== "") {
        if (p === home) return "~";
        if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
      }
      return p;
    }
    function resolvePath(p, home) {
      if (typeof p !== "string") return p;
      if (typeof home === "string" && home !== "") {
        if (p === "~") return home;
        if (p.startsWith("~/")) return home + p.slice(1);
      }
      return p;
    }

    function fmtSize(bytes) {
      if (typeof bytes !== "number" || bytes < 0) return "--";
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
      return bytes + " B";
    }

    function fmtWhen(ms) {
      if (typeof ms !== "number" || ms === null) return "--";
      const s = Math.floor((ms - Date.now()) / 1000);
      const abs = Math.abs(s);
      if (abs < 60) return s >= 0 ? s + " 秒后" : abs + " 秒前";
      if (abs < 3600) return s >= 0 ? Math.floor(abs / 60) + " 分钟后" : Math.floor(abs / 60) + " 分钟前";
      if (abs < 86400) return s >= 0 ? Math.floor(abs / 3600) + " 小时后" : Math.floor(abs / 3600) + " 小时前";
      return s >= 0 ? Math.floor(abs / 86400) + " 天后" : Math.floor(abs / 86400) + " 天前";
    }

    function fmtClock(ms) {
      if (typeof ms !== "number" || ms === null) return "--";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function BackupSettingsPage() {
      const [status, setStatus] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [msgOk, setMsgOk] = react.useState(true);
      // 保存成功按钮短暂变绿（统一反馈口径 2026-08-21）
      const [saved, setSaved] = react.useState(false);
      const savedTimer = react.useRef(null);
      // 行内二次确认删除（替代原生 confirm，2026-08-21）
      const [confirmName, setConfirmName] = react.useState(null);
      const confirmTimer = react.useRef(null);
      // 表单字段（首次加载时从 status 填充）
      const [backupDir, setBackupDir] = react.useState("");
      const [enabled, setEnabled] = react.useState(true);
      const [intervalHours, setIntervalHours] = react.useState("6");
      const [keepCount, setKeepCount] = react.useState("10");
      const [customDirs, setCustomDirs] = react.useState("");
      const [loaded, setLoaded] = react.useState(false);

      const load = react.useCallback(async () => {
        try {
          const data = await api("/status");
          setStatus(data);
          if (!loaded) {
            setBackupDir(displayPath(data.config.backupDir, data.homeDir));
            setEnabled(data.config.enabled);
            setIntervalHours(String(data.config.intervalHours));
            setKeepCount(String(data.config.keepCount));
            setCustomDirs((data.config.customDirs || []).map((d) => displayPath(d, data.homeDir)).join("\n"));
            setLoaded(true);
          }
        } catch (error) {
          setMsg("加载失败：" + (error instanceof Error ? error.message : String(error)));
          setMsgOk(false);
        }
      }, [loaded]);

      react.useEffect(() => { load(); }, [load]);

      const doBackup = async () => {
        if (busy) return;
        setBusy(true);
        setMsg(null);
        try {
          const data = await api("/backup", "POST", {});
          if (!data.ok) throw new Error(data.error || "备份失败");
          setMsg("备份完成：" + data.name + "（" + fmtSize(data.size) + "）");
          setMsgOk(true);
          setStatus((s) => ({ ...s, backups: data.backups || [], lastBackupAt: Date.now(), lastBackupName: data.name, lastError: null }));
        } catch (error) {
          setMsg("备份失败：" + (error instanceof Error ? error.message : String(error)));
          setMsgOk(false);
        } finally {
          setBusy(false);
        }
      };

      const doDelete = async (name) => {
        try {
          const data = await api("/delete", "POST", { name });
          setStatus((s) => ({ ...s, backups: data.backups || [] }));
        } catch (error) {
          setMsg("删除失败：" + (error instanceof Error ? error.message : String(error)));
          setMsgOk(false);
        }
      };

      // 行内二次确认：第一次点变"确认删除？"（红，3 秒自动复原），再点才执行
      const askDelete = (name) => {
        if (confirmName === name) {
          if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
          setConfirmName(null);
          doDelete(name);
          return;
        }
        setConfirmName(name);
        if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => { setConfirmName(null); confirmTimer.current = null; }, 3000);
      };

      react.useEffect(() => () => {
        if (savedTimer.current !== null) clearTimeout(savedTimer.current);
        if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      }, []);

      const doSave = async () => {
        if (saving) return;
        setSaving(true);
        setMsg(null);
        try {
          const dirs = customDirs.split("\n").map((s) => s.trim()).filter((s) => s !== "").map((d) => resolvePath(d, homeDir));
          const data = await api("/config", "POST", {
            backupDir: resolvePath(backupDir.trim(), homeDir),
            enabled,
            intervalHours: Number(intervalHours),
            keepCount: Number(keepCount),
            customDirs: dirs,
          });
          if (!data.ok) throw new Error(data.error || "保存失败");
          setMsg(data.message || "已保存");
          setMsgOk(true);
          setSaved(true);
          if (savedTimer.current !== null) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => { setSaved(false); savedTimer.current = null; }, 2000);
        } catch (error) {
          setMsg("保存失败：" + (error instanceof Error ? error.message : String(error)));
          setMsgOk(false);
        } finally {
          setSaving(false);
        }
      };

      const backups = status && Array.isArray(status.backups) ? status.backups : [];
      const cfg = status && status.config ? status.config : null;
      const homeDir = status && typeof status.homeDir === "string" ? status.homeDir : "";

      return react.createElement("div", { className: "bk-card" },
        react.createElement("h3", null, "备份"),
        react.createElement("div", { className: "row" },
          "上次备份：", status && status.lastBackupName
            ? status.lastBackupName + "（" + fmtWhen(status.lastBackupAt) + "）"
            : "从未"
        ),
        react.createElement("div", { className: "row" },
          "下次自动备份：", cfg ? (cfg.enabled ? fmtWhen(status.nextAt) + "（每 " + cfg.intervalHours + " 小时）" : "已关闭") : "--"
        ),
        status && status.lastError
          ? react.createElement("div", { className: "row err" }, "上次失败：" + status.lastError)
          : null,
        react.createElement("div", { className: "row" }, "备份目录：", cfg ? displayPath(cfg.backupDir, homeDir) : "--"),
        react.createElement("button", {
          type: "button",
          className: "btn btn-primary",
          disabled: busy,
          onClick: doBackup,
        }, busy ? "备份中…" : "立即备份"),

        react.createElement("div", null,
          react.createElement("div", { className: "sep" }),
          react.createElement("div", { className: "row", style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
            "备份列表（" + backups.length + "/" + (cfg ? cfg.keepCount : "--") + " 份，满额自动删最旧）"),
          backups.length === 0
            ? react.createElement("div", { className: "row" }, "还没有备份，点「立即备份」或等定时备份自动生成")
            : backups.map((b) => react.createElement("div", { key: b.name, className: "list-row" },
                react.createElement("span", { className: "name", title: b.name }, b.name),
                react.createElement("span", { className: "meta" }, fmtSize(b.size)),
                react.createElement("span", { className: "meta" }, fmtClock(b.mtime)),
                react.createElement("button", {
                  type: "button",
                  className: "btn btn-danger" + (confirmName === b.name ? " is-confirm" : ""),
                  onClick: () => askDelete(b.name),
                }, confirmName === b.name ? "确认删除？" : "删除")
              ))
        ),

        react.createElement("div", { className: "sep" }),
        react.createElement("div", { className: "row", style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "设置"),
        react.createElement("label", { className: "check" },
          react.createElement("input", {
            type: "checkbox",
            checked: enabled,
            onChange: (e) => setEnabled(e.target.checked),
          }),
          "启用定时备份"
        ),
        react.createElement("div", { className: "field" },
          react.createElement("label", null, "备份目录"),
          react.createElement("input", {
            type: "text",
            value: backupDir,
            placeholder: "如 /Users/me/Documents/DSH/backup",
            onChange: (e) => setBackupDir(e.target.value),
          })
        ),
        react.createElement("div", { className: "field" },
          react.createElement("label", null, "定时间隔（小时）"),
          react.createElement("input", {
            type: "number",
            min: "0.1",
            step: "0.1",
            value: intervalHours,
            onChange: (e) => setIntervalHours(e.target.value),
          })
        ),
        react.createElement("div", { className: "field" },
          react.createElement("label", null, "保留份数（1~100）"),
          react.createElement("input", {
            type: "number",
            min: "1",
            max: "100",
            value: keepCount,
            onChange: (e) => setKeepCount(e.target.value),
          }),
          react.createElement("div", { className: "hint" }, "备份达到上限后，新备份会自动覆盖最旧的一份。")
        ),
        react.createElement("div", { className: "field" },
          react.createElement("label", null, "自定义备份目录（每行一个绝对路径，如记忆库）"),
          react.createElement("textarea", {
            value: customDirs,
            placeholder: "/Users/me/Documents/DSH/memory",
            onChange: (e) => setCustomDirs(e.target.value),
          })
        ),
        react.createElement("div", { className: "hint" },
          "默认备份：会话记录、配置（排除安装包）、全局 AGENTS.md。记忆库等其它目录请加入上方列表。"
        ),
        react.createElement("button", {
          type: "button",
          className: "btn" + (saved ? " is-saved" : ""),
          disabled: saving,
          onClick: doSave,
        }, saving ? "保存中…" : (saved ? "✓ 已保存" : "保存设置")),
        msg !== null
          ? react.createElement("div", { className: "msg " + (msgOk ? "ok" : "err") }, msg)
          : null
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      // 设置侧边栏页（order 45，排在 todo-guard 之后）
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "dsh-backup-settings", order: 45, label: "备份" },
        () => react.createElement(BackupSettingsPage)
      ));
      // 插件卡片（设置双入口统一口径 2026-08-21：有配置项的插件 = 侧边栏页 + 插件卡片）
      slots.inject("settings.plugin.item", () => slots.register(
        { name: "settings.plugin.item", key: "backup" },
        () => react.createElement(BackupSettingsPage)
      ));
      console.log("[dsh-backup] client loaded");
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
