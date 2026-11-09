/**
 * dsh-lan-connect — 客户端插件（web GUI 半侧）
 *
 * 干两件事：
 *   1. 在侧边栏注入「局域网连接」入口。点一下**直接在页面里弹出浮层**，
 *      显示配对二维码和倒计时——不用另开标签页。
 *   2. 定时向 host 半侧发心跳，这样管理页才知道"现在有哪些设备连着"。
 *
 * 格式说明：手写 __ModuleLoader__.load 闭包工厂，与 dsh-artifact-library /
 * 皮肤插件同一套约定，不需要构建步骤。
 *
 * 关于选择器：本仓库前端用 CSS Modules，类名形如 `<hash>_<local>`。
 * 直接写死 hash（如 .cXnCAq_sidebarCol）会随 dsh 重新构建而失效，
 * 所以这里一律用 `[class*="local 名"]` 做宽松匹配——hash 变了也不受影响。
 * 浮层则完全挂在自己的节点上，不去猜宿主的 DOM 结构。
 */

window.__ModuleLoader__.load({
  id: "dsh-lan-connect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var BASE = "/ext/lan-connect";
    var STYLE_ID = "dsh-lan-connect/sidebar-entry.css";
    var BUTTON_CLASS = "dsh-lan-connect-entry";
    var PANEL_CLASS = "dsh-lan-connect-panel";
    var BACKDROP_CLASS = "dsh-lan-connect-backdrop";
    var HEARTBEAT_MS = 20000;

    var css = [
      "." + BUTTON_CLASS + "{",
      "  display:flex;align-items:center;gap:8px;margin:6px 10px;padding:8px 12px;",
      "  border-radius:8px;cursor:pointer;user-select:none;",
      "  font-size:13px;font-weight:600;line-height:1.4;",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  background:var(--dsw-alias-interactive-bg-hover, rgba(127,160,255,.08));",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  transition:background .15s, border-color .15s;",
      "}",
      "." + BUTTON_CLASS + ":hover{",
      "  background:var(--dsw-alias-interactive-bg-hover-solid, rgba(127,160,255,.16));",
      "  border-color:var(--dsw-alias-brand-primary, #4da3ff);",
      "}",
      "." + BUTTON_CLASS + " .dlc-icon{font-size:16px;line-height:1}",
      "." + BUTTON_CLASS + " .dlc-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "body[data-ds-collapsed] ." + BUTTON_CLASS + "{display:none}",

      "." + BACKDROP_CLASS + "{",
      "  position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;",
      "  background:rgba(0,0,0,.55);padding:20px;",
      "}",
      "." + PANEL_CLASS + "{",
      "  width:min(420px,100%);max-height:90vh;overflow:auto;",
      "  background:var(--dsw-alias-bg-base, #151b23);",
      "  color:var(--dsw-alias-label-primary, #e6edf3);",
      "  border:1px solid var(--dsw-alias-border-l2, #2a3242);",
      "  border-radius:14px;padding:20px;",
      "  box-shadow:0 18px 60px rgba(0,0,0,.5);",
      "  font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;",
      "}",
      "." + PANEL_CLASS + " h3{margin:0 0 2px;font-size:16px}",
      "." + PANEL_CLASS + " .dlc-sub{color:var(--dsw-alias-label-secondary,#8b98a9);font-size:12px;margin-bottom:16px}",
      "." + PANEL_CLASS + " .dlc-qr{",
      "  width:220px;height:220px;margin:0 auto 12px;background:#fff;border-radius:10px;padding:8px;",
      "}",
      "." + PANEL_CLASS + " .dlc-qr img{width:100%;height:100%;display:block}",
      "." + PANEL_CLASS + " .dlc-qr.dlc-empty{",
      "  background:rgba(127,160,255,.06);border:1px dashed var(--dsw-alias-border-l2,#2a3242);",
      "  display:flex;align-items:center;justify-content:center;text-align:center;",
      "  color:var(--dsw-alias-label-secondary,#8b98a9);font-size:12px;padding:16px;",
      "}",
      "." + PANEL_CLASS + " .dlc-line{",
      "  display:flex;justify-content:space-between;align-items:center;",
      "  font-size:12.5px;margin-bottom:10px;color:var(--dsw-alias-label-secondary,#8b98a9);",
      "}",
      "." + PANEL_CLASS + " .dlc-cd{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary,#4da3ff)}",
      "." + PANEL_CLASS + " .dlc-cd.dlc-expired{color:#d29922}",
      "." + PANEL_CLASS + " .dlc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}",
      "." + PANEL_CLASS + " button{",
      "  font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;",
      "  color:var(--dsw-alias-label-primary,#e6edf3);",
      "  background:rgba(127,160,255,.10);",
      "  border:1px solid var(--dsw-alias-border-l2,#2a3242);",
      "  border-radius:8px;padding:7px 14px;",
      "}",
      "." + PANEL_CLASS + " button:hover{background:rgba(127,160,255,.2)}",
      "." + PANEL_CLASS + " button:disabled{opacity:.5;cursor:default}",
      "." + PANEL_CLASS + " .dlc-close{margin-left:auto;background:transparent}",
      "." + PANEL_CLASS + " .dlc-foot{color:var(--dsw-alias-label-secondary,#8b98a9);font-size:11.5px;margin-top:14px;line-height:1.7}",
    ].join("\n");

    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]")) return;
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", STYLE_ID);
      tag.textContent = css;
      (document.head || document.documentElement).appendChild(tag);
    }

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function copyText(text) {
      // 局域网是 http 非安全上下文，clipboard API 常常不可用，留个退路
      function fallback(value) {
        var ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* 交给用户手动复制 */ }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(function () { fallback(text); });
        return;
      }
      fallback(text);
    }

    var openPanel = null; // 当前打开的浮层（同一时刻只开一个）

    /** 打开浮层：拉一次 state（允许签发配对码），渲染二维码与倒计时。 */
    function showPanel() {
      if (openPanel) return;
      injectCss();

      var backdrop = el("div", BACKDROP_CLASS);
      var panel = el("div", PANEL_CLASS);
      backdrop.appendChild(panel);

      panel.appendChild(el("h3", "", "局域网连接"));
      panel.appendChild(el("div", "dlc-sub", "手机连同一个 Wi-Fi，扫码即可进入"));

      var qrBox = el("div", "dlc-qr dlc-empty", "正在获取配对码…");
      panel.appendChild(qrBox);

      var line = el("div", "dlc-line");
      var addrText = el("span", "", "");
      var cd = el("span", "dlc-cd", "");
      line.appendChild(addrText);
      line.appendChild(cd);
      panel.appendChild(line);

      var actions = el("div", "dlc-actions");
      var copyBtn = el("button", "", "复制配对链接");
      var regenBtn = el("button", "", "重新生成");
      var fullBtn = el("button", "", "打开管理页");
      var closeBtn = el("button", "dlc-close", "关闭");
      actions.appendChild(copyBtn);
      actions.appendChild(regenBtn);
      actions.appendChild(fullBtn);
      actions.appendChild(closeBtn);
      panel.appendChild(actions);

      panel.appendChild(el("div", "dlc-foot",
        "配对码默认 2 分钟有效，刷新会换一张并让上一张立即失效。链接等同这台电脑的钥匙，只发给信得过的设备。"));

      document.body.appendChild(backdrop);
      openPanel = {};

      var tickTimer = null;
      var currentUrl = "";

      function stopTick() {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      }
      function close() {
        stopTick();
        document.removeEventListener("keydown", onKey);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        openPanel = null;
      }
      function onKey(e) { if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
      closeBtn.addEventListener("click", close);

      function startCountdown(expiresAt) {
        stopTick();
        function tick() {
          if (!cd.parentNode) { stopTick(); return; }
          var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
          if (left <= 0) {
            stopTick();
            cd.textContent = "已过期";
            cd.className = "dlc-cd dlc-expired";
            qrBox.className = "dlc-qr dlc-empty";
            qrBox.textContent = "配对码已过期，点「重新生成」换一张";
            copyBtn.disabled = true;
            currentUrl = "";
            return;
          }
          cd.textContent = left + " 秒";
        }
        tick();
        tickTimer = setInterval(tick, 1000);
      }

      function render(s) {
        var g = s.gate || {};
        var all = s.addresses || [];
        // 新版 host：地址带 gateUrl（给电脑输的网址）与 pairUrl（手机扫码免密）。
        // 旧 host（插件文件已更新但 dsh 还没重启）：只有 url（直携进程令牌）。
        // 三种都兜住，避免"界面是新的、后端是旧的"时给出误导信息。
        var modern = all.filter(function (a) { return a.gateUrl; });
        var legacy = modern.length === 0 && all.length > 0;
        var picked = modern[0] || all[0];

        if (!picked) {
          qrBox.className = "dlc-qr dlc-empty";
          qrBox.textContent = g.running
            ? "没有可用的局域网地址；确认 Wi-Fi 已连接。"
            : (g.enabled === false
              ? "访问门禁未启用，局域网设备接不进来。"
              : "访问门禁未启动（端口可能被占用），详见管理页。");
          addrText.textContent = "";
          cd.textContent = "";
          copyBtn.disabled = true;
          return;
        }

        // 复制按钮给的是**给电脑用的网址**；二维码是给手机扫的免密入口。
        currentUrl = picked.gateUrl || picked.pairUrl || picked.url || "";
        copyBtn.disabled = currentUrl === "";
        addrText.textContent = legacy
          ? picked.address
          : (picked.address + " · 手机扫码 / 电脑输网址");
        qrBox.className = "dlc-qr";
        qrBox.textContent = "";
        var img = document.createElement("img");
        img.alt = "配对二维码";
        // 二维码内容由服务端决定（新版是门禁口的免密配对链接）
        img.src = BASE + "/qr.svg?i=0&t=" + String(Date.now());
        img.onerror = function () {
          qrBox.className = "dlc-qr dlc-empty";
          qrBox.textContent = "二维码生成失败";
        };
        qrBox.appendChild(img);

        copyBtn.textContent = legacy ? "复制链接（长期有效）" : "复制网址（给电脑）";

        if (legacy) {
          cd.className = "dlc-cd dlc-expired";
          cd.textContent = "host 端待重启";
          return;
        }
        if (g.running === false) {
          cd.className = "dlc-cd dlc-expired";
          cd.textContent = "门禁未启动";
          return;
        }
        if (s.pair && s.pair.active) {
          cd.className = "dlc-cd";
          startCountdown(s.pair.expiresAt);
        } else {
          cd.className = "dlc-cd dlc-expired";
          cd.textContent = "配对码已过期";
        }
      }

      function fetchState() {
        return fetch(BASE + "/api/state?issue=1", { headers: { accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(render)
          .catch(function () {
            qrBox.className = "dlc-qr dlc-empty";
            qrBox.textContent = "读取失败，请改用完整管理页";
          });
      }

      copyBtn.addEventListener("click", function () {
        if (currentUrl) copyText(currentUrl);
      });
      regenBtn.addEventListener("click", function () {
        regenBtn.disabled = true;
        fetch(BASE + "/api/pair/issue", { method: "POST" })
          .then(fetchState)
          .catch(function () {})
          .then(function () { regenBtn.disabled = false; });
      });
      fullBtn.addEventListener("click", function () {
        window.open(BASE + "/", "_blank", "noopener");
      });

      fetchState();
    }

    function makeButton() {
      var btn = document.createElement("div");
      btn.className = BUTTON_CLASS;
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.title = "局域网连接：显示配对二维码、查看在线设备";
      btn.innerHTML = '<span class="dlc-icon">🌐</span><span class="dlc-label">局域网连接</span>';
      btn.addEventListener("click", showPanel);
      btn.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          showPanel();
        }
      });
      return btn;
    }

    /** 找到侧边栏列——hash 无关的宽松匹配。 */
    function findSidebar() {
      return document.querySelector('[class*="sidebarCol"]')
        || document.querySelector('[class*="sidebar"] [class*="footArea"]');
    }

    /** 把入口按钮插到侧边栏脚部之上；找不到脚部就追加到列尾。 */
    function mountEntry() {
      var col = findSidebar();
      if (!col) return false;
      if (col.querySelector("." + BUTTON_CLASS)) return true;
      var btn = makeButton();
      var foot = col.querySelector('[class*="footArea"]') || col.querySelector('[class*="settingsArea"]');
      if (foot && foot.parentElement) foot.parentElement.insertBefore(btn, foot);
      else col.appendChild(btn);
      return true;
    }

    function unmountEntry() {
      if (typeof document === "undefined") return;
      var nodes = document.querySelectorAll("." + BUTTON_CLASS);
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    }

    function beat() {
      try {
        fetch(BASE + "/api/heartbeat", { method: "POST", keepalive: true }).catch(function () {});
      } catch (e) { /* 网络抖动无所谓，下一次心跳会补上 */ }
    }

    /**
     * 插件入口。React 会重渲染侧边栏把节点冲掉，所以用轻量定时器兜住；
     * 返回的 disposer 把所有东西撤干净。
     */
    function apply(ctx) {
      injectCss();
      mountEntry();
      var mountTimer = setInterval(mountEntry, 1500);
      beat();
      var beatTimer = setInterval(beat, HEARTBEAT_MS);
      return function () {
        clearInterval(mountTimer);
        clearInterval(beatTimer);
        var backdrop = document.querySelector("." + BACKDROP_CLASS);
        if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        openPanel = null;
        unmountEntry();
      };
    }

    exports.apply = apply;
    return module.exports;
  },
});
