/**
 * dsh-google-aistudio — 浏览器侧（独立设置页）。
 *
 * 在「设置」里注册一个**独立分区**「Google AI Studio」（插槽 `settings.section`），
 * 而不是塞在「插件」列表里。页面复用 harness 的设计令牌（`--dsw-alias-*`），
 * 分卡片展示内核/数据面/账户状态、模型勾选、账户导入与运维操作。
 *
 * 这是手写的客户端模块，使用与内置客户端 bundle 相同的加载格式
 * （window.__ModuleLoader__.load + CommonJS 工厂），不需要打包器：React 从应用
 * 的模块表里 require，样式注入一个带 data-plugin-css 标记的 <style>。
 */
window.__ModuleLoader__.load({
  id: "dsh-google-aistudio/client",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var react = require("react")
    var useSyncExternalStore = react.useSyncExternalStore
    var h = react.createElement

    /** 插件自有的 HTTP 路由前缀（由 host 侧注册）。 */
    var API = "/plugins/google-aistudio"

    /** 注入样式用的唯一标记。 */
    var STYLE_ID = "dsh-google-aistudio/settings-page.css"

    /** AI Studio 权益等级 → 展示名。 */
    var TIERS = { 0: "Free", 1: "Pro", 2: "Ultra", 3: "Plus" }

    /** 页面样式：全部基于 harness 设计令牌，跟随明暗主题。 */
    var CSS = [
      ".gws{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);padding:2px 2px 24px}",
      ".gws-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}",
      ".gws-brand{display:flex;align-items:center;gap:12px;min-width:0}",
      ".gws-mark{width:38px;height:38px;border-radius:12px;flex:none;display:grid;place-items:center;background:var(--dsw-alias-button-info-fill);color:#fff}",
      ".gws-title{margin:0;font-size:16px;font-weight:600;line-height:22px}",
      ".gws-sub{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-badge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:nowrap}",
      ".gws-badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".gws-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".gws-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
      ".gws-badge[data-tone=idle]{color:var(--dsw-alias-label-tertiary)}",
      ".gws-card{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".gws-card-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".gws-rows{display:flex;flex-direction:column;gap:7px;margin:0;padding:0;list-style:none}",
      ".gws-row{display:flex;align-items:center;gap:9px;font-size:13px;line-height:18px;min-width:0}",
      ".gws-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}",
      ".gws-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".gws-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".gws-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}",
      ".gws-row-key{flex:none;width:56px;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".gws-row-body{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gws-row-note{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px}",
      ".gws-models{display:grid;gap:4px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));max-height:288px;overflow:auto;padding:2px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3)}",
      ".gws-model{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}",
      ".gws-model:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".gws-model-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".gws-model-id{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}",
      ".gws-model-flag{flex:none;font-size:10px;color:var(--dsw-alias-state-warn-primary)}",
      ".gws-actions{display:flex;flex-direction:column;gap:12px}",
      ".gws-action-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
      ".gws-action-tag{flex:none;width:56px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-btn{height:32px;padding:0 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}",
      ".gws-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".gws-btn:disabled{opacity:.45;cursor:default}",
      ".gws-btn:active:not(:disabled){transform:translateY(1px)}",
      ".gws-btn[data-variant=primary]{background:var(--dsw-alias-button-info-fill);color:#fff;border-color:transparent}",
      ".gws-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}",
      ".gws-btn[data-variant=ghost]{background:transparent;border-color:transparent}",
      ".gws-check{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".gws-fields{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}",
      ".gws-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".gws-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
      ".gws-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}",
      ".gws-input:focus{outline:none;border-color:var(--dsw-alias-button-info-fill)}",
      ".gws-input:disabled{opacity:.55}",
      ".gws-select{box-sizing:border-box;width:100%;height:32px;padding:0 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}",
      ".gws-note{display:flex;align-items:flex-start;gap:8px;margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:17px;background:var(--dsw-alias-bg-layer-1)}",
      ".gws-note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".gws-note[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
      ".gws-note[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".gws-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-pre{margin:0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}"
    ].join("")

    function ensureStyles() {
      if (typeof document === "undefined") return
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") !== null) return
      var tag = document.createElement("style")
      tag.dataset.plugin = "dsh-google-aistudio"
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 发一个 JSON 请求；HTTP 状态非 2xx 时抛出带后端的错误信息。 */
    function call(path, method, body) {
      return fetch(API + path, {
        method: method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () {
          return {}
        }).then(function (json) {
          if (!res.ok) throw new Error(json && json.error ? json.error : "HTTP " + res.status)
          return json
        })
      })
    }

    /** 周期性拉取内核与账户状态。 */
    function useStatus(intervalMs) {
      var state = react.useState({ loading: true, data: null, error: null })
      var setState = state[1]
      var aliveRef = react.useRef(true)
      var load = react.useCallback(function () {
        return call("/status", "GET")
          .then(function (data) {
            if (aliveRef.current) setState({ loading: false, data: data, error: null })
          })
          .catch(function (error) {
            if (aliveRef.current) setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) })
          })
      }, [])
      react.useEffect(function () {
        aliveRef.current = true
        load()
        var timer = setInterval(load, intervalMs)
        return function () {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [intervalMs, load])
      return { value: state[0], reload: load }
    }

    /** 读 google-aistudio 设置命名空间的快照。 */
    function useConfig(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange) },
        function () { return scope.getSnapshot() }
      )
      var ready = snapshot.status === "ready" && snapshot.value !== undefined
      return {
        value: ready ? snapshot.value : {},
        writable: snapshot.writable === true && ready,
        ready: snapshot.status === "ready"
      }
    }

    /** 紧凑状态行：状态点 + 固定宽标题 + 单行内容（备注以小字跟在同一行）。 */
    function StatusRow(props) {
      var note = props.note || ""
      return h(
        "li",
        { className: "gws-row" },
        h("span", { className: "gws-dot", "data-tone": props.tone || "idle" }),
        h("span", { className: "gws-row-key" }, props.label),
        h(
          "span",
          { className: "gws-row-body", title: note ? props.text + " · " + note : props.text },
          props.text,
          note ? h("span", { className: "gws-row-note" }, note) : null
        )
      )
    }

    /** 卡片容器。 */
    function Card(props) {
      return h("section", { className: "gws-card" }, h("h3", { className: "gws-card-title" }, props.title), props.children)
    }

    /** 配置输入项。 */
    function Field(props) {
      return h(
        "label",
        { className: "gws-field" },
        h("span", { className: "gws-label" }, props.label),
        h("input", {
          className: "gws-input",
          type: props.type || "text",
          value: props.value,
          placeholder: props.placeholder,
          disabled: props.disabled,
          min: props.min,
          max: props.max,
          step: props.step,
          onChange: props.onChange
        })
      )
    }

    /** 下拉选择项。 */
    function Select(props) {
      return h(
        "label",
        { className: "gws-field" },
        h("span", { className: "gws-label" }, props.label),
        h(
          "select",
          { className: "gws-select", value: props.value, disabled: props.disabled, onChange: props.onChange },
          props.options.map(function (option) {
            return h("option", { key: option.value, value: option.value }, option.label)
          })
        )
      )
    }

    /** 按钮。 */
    function Button(props) {
      return h(
        "button",
        {
          type: "button",
          className: "gws-btn",
          "data-variant": props.variant || "default",
          disabled: props.disabled,
          onClick: props.onClick
        },
        props.children
      )
    }

    /** 内核行：分「已安装 / 进程在跑 / 数据面在跑」三态。 */
    function kernelRow(data) {
      var kernel = data && data.kernel
      if (!data) return { tone: "idle", text: "读取中…", note: "" }
      if (!kernel || kernel.installed === false) {
        return { tone: "error", text: "尚未下载反代内核", note: "点「下载 / 更新内核」，走下面的出口代理" }
      }
      if (!kernel.running) {
        return { tone: "warn", text: "内核未运行", note: "点「重启内核」拉起" }
      }
      return {
        tone: kernel.serviceRunning ? "ok" : "warn",
        text: kernel.serviceRunning ? "数据面运行中" : "内核已就绪，数据面未启动",
        note: "端口 " + kernel.port + " · " + kernel.version
      }
    }

    /** 账户行：把内核的账户池汇总成一行。 */
    function accountRow(data) {
      var kernel = data && data.kernel
      var accounts = (data && data.accounts) || []
      if (!kernel || kernel.accounts.total === 0) {
        return { tone: "warn", text: "尚未导入账户", note: "导入后才能生成内容" }
      }
      if (kernel.accounts.authRequired > 0) {
        return {
          tone: "error",
          text: kernel.accounts.authRequired + " / " + kernel.accounts.total + " 个账户登录态已失效",
          note: "重新导入该账户即可恢复"
        }
      }
      var primary = accounts[0]
      var tier = primary && primary.benefit_tier !== undefined && primary.benefit_tier !== null
        ? (TIERS[primary.benefit_tier] || "等级 " + primary.benefit_tier)
        : "权益未知"
      return {
        tone: "ok",
        text: kernel.accounts.total + " 个账户可用（" + tier + "）",
        note: primary ? primary.id : ""
      }
    }

    /** 设置页主体。 */
    function AIStudioPage(props) {
      var scope = props.scope
      var config = useConfig(scope)
      var status = useStatus(3000)
      var local = react.useState({ busy: "", message: "", error: "", output: "" })
      var busy = local[0].busy
      var message = local[0].message
      var error = local[0].error
      var output = local[0].output
      var setLocal = local[1]
      // 模型勾选的本地草稿：null = 跟随服务端已保存的选择。
      var modelDraftState = react.useState(null)
      var modelDraft = modelDraftState[0]
      var setModelDraft = modelDraftState[1]
      var importMode = react.useState("browser")
      var promptState = react.useState("只回复两个字：你好")

      /** 执行一个会改后端状态的动作，并把结果写进提示行。 */
      function run(key, fn, describe) {
        setLocal({ busy: key, message: "", error: "", output: "" })
        Promise.resolve()
          .then(fn)
          .then(function (result) {
            if (result && result.ok === false) {
              setLocal({ busy: "", message: "", error: result.message || (describe ? describe(result) : "操作未成功"), output: result.message || "" })
              return status.reload()
            }
            setLocal({ busy: "", message: describe ? describe(result) : "完成", error: "", output: (result && result.message) || "" })
            return status.reload()
          })
          .catch(function (err) {
            setLocal({ busy: "", message: "", error: String(err && err.message ? err.message : err), output: "" })
          })
      }

      /** 受控字段写入（checkbox 取 checked，number 转数字）。 */
      function setField(field) {
        return function (event) {
          var target = event.target
          var raw = target.type === "checkbox" ? target.checked : target.value
          var next = target.type === "number" ? Number(raw) : raw
          scope.set(field, next).catch(function (err) {
            setLocal({ busy: "", message: "", error: String(err && err.message ? err.message : err), output: "" })
          })
        }
      }

      /** 服务端已保存的模型选择。 */
      function serverSelected() {
        var options = (status.value.data && status.value.data.modelOptions) || []
        return options.filter(function (option) { return option.selected === true }).map(function (option) { return option.id })
      }

      /** 当前展示的模型选择（有草稿就用草稿）。 */
      function shownSelected() {
        return modelDraft === null ? serverSelected() : modelDraft
      }

      /** 勾选 / 取消一个模型。 */
      function toggleModel(id) {
        var current = shownSelected()
        var next = current.indexOf(id) >= 0
          ? current.filter(function (item) { return item !== id })
          : current.concat([id])
        setModelDraft(next)
      }

      /** 把模型选择写回配置（保存后会话窗口的选择器即可选这些模型）。 */
      function saveModels() {
        var list = shownSelected()
        if (list.length === 0) {
          setLocal({ busy: "", message: "", error: "至少要勾选一个模型", output: "" })
          return
        }
        run("models", function () { return scope.set("models", list) }, function () {
          setModelDraft(null)
          return "已保存模型选择（" + list.length + " 个）：到会话窗口的模型选择器里查看"
        })
      }

      if (!config.ready) {
        return h("div", { className: "gws" }, h("p", { className: "gws-hint" }, "Google AI Studio 设置加载中…"))
      }

      var value = config.value || {}
      var data = status.value.data
      var kernel = kernelRow(data)
      var account = accountRow(data)
      var modelOptionsList = (data && Array.isArray(data.modelOptions)) ? data.modelOptions : []
      var serverModelIds = serverSelected()
      var shownModelIds = shownSelected()
      var modelDirty = modelDraft !== null && modelDraft.join(",") !== serverModelIds.join(",")
      var disabled = busy !== ""
      var kernelRunning = !!(data && data.kernel && data.kernel.running)
      var serviceRunning = !!(data && data.kernel && data.kernel.serviceRunning)
      var browserRoots = (data && data.browserRoots) || []
      var rootOptions = browserRoots.map(function (entry) { return { value: entry.path, label: entry.name + " · " + entry.path } })
      var currentRoot = value.browserRoot && rootOptions.some(function (option) { return option.value === value.browserRoot })
        ? value.browserRoot
        : (rootOptions[0] ? rootOptions[0].value : "")

      return h(
        "div",
        { className: "gws" },

        h(
          "header",
          { className: "gws-head" },
          h(
            "div",
            { className: "gws-brand" },
            h(
              "span",
              { className: "gws-mark", "aria-hidden": "true" },
              h(
                "svg",
                { width: 20, height: 20, viewBox: "0 0 20 20", fill: "none" },
                h("path", { d: "M10 2.2l1.9 5.1 5.1 1.9-5.1 1.9L10 17.8 8.1 11.1 3 9.2l5.1-1.9L10 2.2z", fill: "currentColor" })
              )
            ),
            h(
              "div",
              null,
              h("h2", { className: "gws-title" }, "Google AI Studio"),
              h("p", { className: "gws-sub" }, "把 aistudio.google.com 接进 DSH：托管 AIStudio2API 内核、免 API 计费、支持 Nano Banana 出图")
            )
          ),
          h(
            "span",
            { className: "gws-badge", "data-tone": kernel.tone },
            h("span", { className: "gws-dot", "data-tone": kernel.tone, style: { marginTop: 0 } }),
            kernel.tone === "ok" ? "运行中" : kernel.text
          )
        ),

        h(
          Card,
          { title: "状态" },
          h(
            "ul",
            { className: "gws-rows" },
            h(StatusRow, { label: "内核", tone: kernel.tone, text: kernel.text, note: kernel.note }),
            h(StatusRow, { label: "账户", tone: account.tone, text: account.text, note: account.note }),
            h(StatusRow, {
              label: "出口",
              tone: (data && data.proxyUrl) ? "ok" : "warn",
              text: (data && data.proxyUrl) ? data.proxyUrl : "未配置代理（直连 Google 通常超时）",
              note: (data && data.timezone) ? "时区 " + data.timezone : ""
            }),
            h(StatusRow, {
              label: "上游",
              tone: "idle",
              text: (data && data.upstream ? data.upstream.repo + " " + data.upstream.version : "未知"),
              note: data && data.baseUrl ? "Base URL " + data.baseUrl : ""
            })
          ),
          data && data.authNotice
            ? h("p", { className: "gws-note", "data-tone": "error" }, "账户认证失败：" + data.authNotice)
            : null,
          data && data.lastError ? h("p", { className: "gws-note", "data-tone": "warn" }, data.lastError) : null
        ),

        h(
          Card,
          { title: "模型" },
          h("p", { className: "gws-hint" }, "勾选要暴露给 DSH 的模型；保存后会话窗口的模型选择器即时刷新。标记「内核无此模型」的项通常是账户权益不够。"),
          h(
            "div",
            { className: "gws-models" },
            modelOptionsList.map(function (option) {
              return h(
                "label",
                { key: option.id, className: "gws-model" },
                h("input", {
                  type: "checkbox",
                  checked: shownModelIds.indexOf(option.id) >= 0,
                  onChange: function () { toggleModel(option.id) }
                }),
                h("span", { className: "gws-model-name", title: option.id }, option.name),
                h("span", { className: "gws-model-id" }, option.id),
                option.available === false ? h("span", { className: "gws-model-flag" }, "内核无此模型") : null
              )
            })
          ),
          h(
            "div",
            { className: "gws-action-row" },
            h(Button, { variant: "primary", disabled: disabled || !modelDirty, onClick: saveModels }, modelDirty ? "保存模型选择" : "模型选择已保存"),
            h(Button, { disabled: disabled || modelDraft === null, onClick: function () { setModelDraft(null) } }, "撤销改动")
          )
        ),

        h(
          Card,
          { title: "账户" },
          h("p", { className: "gws-hint" }, "内核用账户目录里的登录态去换 WAA proof。导入方式二选一：从本机浏览器导入（能拿到续签材料，可自动续期），或从一个 Playwright storage-state 文件导入。"),
          h(
            "div",
            { className: "gws-fields" },
            h(Field, {
              label: "Google 邮箱（账户标识）",
              value: value.accountEmail || "",
              placeholder: "you@gmail.com",
              disabled: disabled || !config.writable,
              onChange: setField("accountEmail")
            }),
            importMode[0] === "browser"
              ? Select({
                  label: "浏览器 User Data 目录",
                  value: currentRoot,
                  disabled: disabled || rootOptions.length === 0,
                  options: rootOptions.length > 0 ? rootOptions : [{ value: "", label: "没有探测到可用的浏览器目录" }],
                  onChange: setField("browserRoot")
                })
              : Field({
                  label: "storage-state.json 路径",
                  value: value.storageStatePath || "",
                  placeholder: "D:\\\\path\\\\to\\\\<email>\\\\storage-state.json",
                  disabled: disabled || !config.writable,
                  onChange: setField("storageStatePath")
                })
          ),
          h(
            "div",
            { className: "gws-action-row" },
            h("span", { className: "gws-action-tag" }, "方式"),
            h(Button, {
              disabled: disabled,
              onClick: function () { importMode[1]("browser") }
            }, importMode[0] === "browser" ? "● 从浏览器导入" : "○ 从浏览器导入"),
            h(Button, {
              disabled: disabled,
              onClick: function () { importMode[1]("file") }
            }, importMode[0] === "file" ? "● 从文件导入" : "○ 从文件导入"),
            h(Button, {
              variant: "primary",
              disabled: disabled || !value.accountEmail,
              onClick: function () {
                run("import", function () {
                  return call("/account/import", "POST", importMode[0] === "browser"
                    ? { mode: "browser", email: value.accountEmail, browserRoot: currentRoot }
                    : { mode: "file", email: value.accountEmail, storageStatePath: value.storageStatePath })
                }, function (result) { return result.ok ? "账户导入完成，内核已重启" : "导入失败" })
              }
            }, busy === "import" ? "导入中…" : "导入账户")
          ),
          output ? h("pre", { className: "gws-pre" }, output) : null
        ),

        h(
          Card,
          { title: "操作" },
          h(
            "div",
            { className: "gws-actions" },
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "数据面"),
              h(Button, {
                variant: "primary",
                disabled: disabled || !kernelRunning || serviceRunning,
                onClick: function () {
                  run("start", function () { return call("/service/start", "POST", {}) }, function () { return "数据面已启动" })
                }
              }, busy === "start" ? "启动中…" : "启动服务"),
              h(Button, {
                disabled: disabled || !kernelRunning || !serviceRunning,
                onClick: function () {
                  run("stop", function () { return call("/service/stop", "POST", {}) }, function () { return "数据面已停止" })
                }
              }, busy === "stop" ? "停止中…" : "停止服务")
            ),
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "内核"),
              h(Button, {
                disabled: disabled,
                onClick: function () {
                  run("install", function () { return call("/kernel/install", "POST", {}) }, function (result) { return "内核已就绪（" + Math.round((result.bytes || 0) / 1048576) + " MB）" })
                }
              }, busy === "install" ? "下载中…" : "下载 / 更新内核"),
              h(Button, {
                disabled: disabled,
                onClick: function () {
                  run("restart", function () { return call("/kernel/restart", "POST", {}) }, function () { return "内核已重启" })
                }
              }, busy === "restart" ? "重启中…" : "重启内核"),
              h(Button, {
                disabled: !kernelRunning,
                onClick: function () {
                  if (data && data.kernel && data.kernel.port) window.open("http://127.0.0.1:" + data.kernel.port + "/", "_blank", "noopener")
                }
              }, "打开内核管理页")
            ),
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "连通性"),
              h("input", {
                className: "gws-input",
                style: { flex: "1 1 220px", minWidth: "180px" },
                value: promptState[0],
                placeholder: "测试用的提示词",
                onChange: function (event) { promptState[1](event.target.value) }
              }),
              h(Button, {
                disabled: disabled || !serviceRunning,
                onClick: function () {
                  run("test", function () {
                    return call("/test", "POST", { prompt: promptState[0] })
                  }, function (result) { return "生成成功（" + result.model + " · " + result.ms + " ms）" })
                }
              }, busy === "test" ? "调用中…" : "发送测试")
            ),
            output && busy === "" && message.indexOf("生成成功") === 0
              ? h("pre", { className: "gws-pre" }, output)
              : null
          )
        ),

        h(
          Card,
          { title: "配置" },
          h(
            "div",
            { className: "gws-fields" },
            h(Field, {
              label: "内核端口（0 = 自动分配）",
              type: "number",
              value: value.port === undefined ? 0 : value.port,
              disabled: disabled || !config.writable,
              onChange: setField("port")
            }),
            h(Field, {
              label: "出口代理",
              value: value.proxyUrl || "",
              placeholder: "http://127.0.0.1:7897",
              disabled: disabled || !config.writable,
              onChange: setField("proxyUrl")
            }),
            h(Field, {
              label: "常驻预热账户数",
              type: "number",
              min: 1,
              max: 10,
              value: value.warmWorkers === undefined ? 1 : value.warmWorkers,
              disabled: disabled || !config.writable,
              onChange: setField("warmWorkers")
            }),
            h(Field, {
              label: "单次请求超时（分钟）",
              type: "number",
              min: 1,
              max: 60,
              value: value.requestTimeoutMinutes === undefined ? 5 : value.requestTimeoutMinutes,
              disabled: disabled || !config.writable,
              onChange: setField("requestTimeoutMinutes")
            }),
            h(Field, {
              label: "内核可执行文件路径（留空 = 自动）",
              value: value.kernelPath || "",
              placeholder: "留空使用 ~/.dsh/aistudio/bin/",
              disabled: disabled || !config.writable,
              onChange: setField("kernelPath")
            })
          ),
          h(
            "div",
            { className: "gws-action-row" },
            h(
              "label",
              { className: "gws-check" },
              h("input", {
                type: "checkbox",
                checked: value.autoStartService !== false,
                disabled: disabled || !config.writable,
                onChange: setField("autoStartService")
              }),
              "内核启动后自动拉起数据面"
            ),
            h(
              "label",
              { className: "gws-check" },
              h("input", {
                type: "checkbox",
                checked: value.temporaryChat !== false,
                disabled: disabled || !config.writable,
                onChange: setField("temporaryChat")
              }),
              "使用临时对话（不写入 AI Studio 历史）"
            ),
            h(
              "label",
              { className: "gws-check" },
              h("input", {
                type: "checkbox",
                checked: value.enabled !== false,
                disabled: disabled || !config.writable,
                onChange: setField("enabled")
              }),
              "启用插件"
            )
          ),
          h("p", { className: "gws-hint" }, "端口、代理、密钥由插件写入内核的 .env；内核管理页里改动的其他配置项会保留。改动端口或代理后会自动重启内核。")
        ),

        message ? h("p", { className: "gws-note", "data-tone": "ok" }, message) : null,
        error ? h("p", { className: "gws-note", "data-tone": "error" }, error) : null
      )
    }

    /**
     * 浏览器插件入口：在「设置」里注册一个独立分区。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ensureStyles()
      var scope = ctx.settingsScope.bind({ namespace: "google-aistudio" })
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "google-aistudio",
            order: 25,
            label: function () { return "Google AI Studio" }
          },
          function AIStudioSection() {
            return h(AIStudioPage, { scope: scope })
          }
        )
      })
    }

    exports.name = "google-aistudio-ui"
    exports.apply = apply
    // 这里必须写 cordis 服务名（不是包名），否则插件会一直 pending 并卡住 web 启动。
    exports.inject = ["slots", "settingsScope"]
    return module.exports
  }
})
