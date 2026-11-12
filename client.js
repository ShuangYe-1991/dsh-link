window.__ModuleLoader__.load({
  id: 'dsh-link',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 设置页那样的大面板往往有自己的层，直接用 position:fixed 会被它盖住（甚至被祖先的
    // transform 收成一个小盒子）。能拿到 react-dom 就 portal 到 body，摞在最上面。
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (error) {
      ReactDOM = null
    }

    const PORT_ROUTE = '/__pocket-remote/port'
    const SIDEBAR_KEY = '__dshLinkSidebar'
    const POS_KEY = '__dshLinkPillPos'
    const TOP_Z = 2147483647

    const readBool = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : raw === '1'
      } catch (error) {
        return fallback
      }
    }
    const writeBool = (key, value) => {
      try {
        localStorage.setItem(key, value ? '1' : '0')
      } catch (error) {}
    }
    const readPos = () => {
      try {
        const raw = localStorage.getItem(POS_KEY)
        return raw ? JSON.parse(raw) : null
      } catch (error) {
        return null
      }
    }
    const writePos = (pos) => {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch (error) {}
    }

    const store = {
      state: {
        enabled: readBool(SIDEBAR_KEY, false),
        port: 0,
        connections: [],
        activeId: null,
        error: '',
        lastError: null,
        open: false, // 电脑画面（iframe）
        drawer: false, // 切换抽屉
        adding: false,
        scan: false,
        form: { label: '', url: '', pin: '' },
        pos: readPos(),
      },
      listeners: new Set(),
      set(patch) {
        Object.assign(this.state, patch)
        if ('enabled' in patch) {
          try {
            this.onSidebarChange?.()
          } catch (error) {}
        }
        for (const fn of [...this.listeners]) fn()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    const useStore = () => {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store.state
    }
    try {
      window.__dshLinkStore = store
    } catch (error) {}

    const base = () => `http://127.0.0.1:${store.state.port || 4319}`

    async function loadPort() {
      try {
        const res = await fetch(PORT_ROUTE, { cache: 'no-store' })
        const json = await res.json()
        store.set({ port: Number(json.port) || 0 })
      } catch (error) {
        store.set({ error: '拿不到本机代理端口' })
      }
      await loadState()
    }

    async function loadState() {
      try {
        const res = await fetch('/__phone/__ctl/state', { cache: 'no-store' })
        const json = await res.json().catch(() => null)
        if (!res.ok) {
          store.set({ error: (json && json.error) || `本机代理不可用（HTTP ${res.status}）` })
          return
        }
        store.set({
          connections: json?.connections ?? [],
          activeId: json?.activeId ?? null,
          error: '',
          lastError: json?.lastError ?? null,
        })
      } catch (error) {
        store.set({ error: '本机代理没在跑' })
      }
    }

    async function post(path, body) {
      const res = await fetch(`/__phone${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`)
      return json
    }

    /** 打开某台电脑：选中 → 关抽屉 → 开画面。 */
    async function openComputer(id) {
      try {
        if (id && id !== store.state.activeId) await post('/__ctl/select', { id })
      } catch (error) {
        store.set({ error: error.message })
        return
      }
      await loadState()
      store.set({ open: true, drawer: false, adding: false })
    }

    const MonitorIcon = ({ size }) =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size ?? 18,
          height: size ?? 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 2.5, y: 4, width: 19, height: 12.5, rx: 2 }),
        h('path', { d: 'M8.5 20.5h7M12 16.5v4' }),
      )

    const css = {
      dim: { position: 'fixed', inset: 0, zIndex: TOP_Z - 3, background: 'rgba(0,0,0,.35)' },
      frameWrap: { position: 'fixed', inset: 0, zIndex: TOP_Z - 5, display: 'flex', flexDirection: 'column', background: '#fff', color: '#111' },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderBottom: '1px solid rgba(0,0,0,.12)',
        background: '#fff',
        color: '#111',
        flex: '0 0 auto',
        fontSize: 13,
      },
      grow: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      frame: { flex: '1 1 auto', width: '100%', border: 0, background: '#fff' },
      // 悬浮按钮/抽屉固定用白底深字：电脑页面可能是纯黑，跟着主题走就变成黑底黑字看不清。
      pill: (pos) => ({
        position: 'fixed',
        left: pos ? pos.x : 10,
        top: pos ? pos.y : 120,
        zIndex: TOP_Z,
        padding: '9px 14px',
        borderRadius: 99,
        border: '1px solid rgba(0,0,0,.18)',
        background: 'rgba(255,255,255,.92)',
        color: '#111',
        fontSize: 13,
        fontWeight: 600,
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'grab',
        opacity: 0.94,
        boxShadow: '0 4px 16px rgba(0,0,0,.28)',
      }),
      drawer: {
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: 0,
        width: 'min(86vw, 340px)',
        zIndex: TOP_Z - 1,
        background: '#ffffff',
        color: '#111111',
        borderRight: '1px solid rgba(0,0,0,.12)',
        boxShadow: '0 0 30px rgba(0,0,0,.35)',
        display: 'flex',
        flexDirection: 'column',
        padding: '70px 12px 16px',
        boxSizing: 'border-box',
        fontSize: 13,
        overflowY: 'auto',
      },
      bigBtn: {
        width: '100%',
        padding: '12px',
        borderRadius: 12,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
      },
      // 子元素统一"跟随容器"：容器（抽屉/顶栏）负责白底深字，
      // 设置页里这些控件仍然是跟随主题的，不会突然冒出一块白。
      micro: { fontSize: 11.5, opacity: 0.62, margin: '6px 2px 14px', lineHeight: 1.5, color: 'inherit' },
      row: { display: 'flex', gap: 6, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid rgba(127,127,127,.22)' },
      rowMain: { flex: '1 1 auto', minWidth: 0, cursor: 'pointer' },
      label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit' },
      url: { fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit' },
      small: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 8px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      input: {
        font: 'inherit',
        fontSize: 13,
        padding: '8px 9px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 6,
      },
      muted: { fontSize: 12, opacity: 0.66, margin: '4px 0 0', color: 'inherit' },
      err: { fontSize: 12.5, color: '#c0392b', margin: '6px 0 0' },
    }

    /* ---------------- 可拖动「切换」悬浮按钮 ---------------- */
    function Pill() {
      const state = useStore()
      const drag = React.useRef(null)
      if (!state.open || state.scan) return null
      const onDown = (event) => {
        const point = event.touches ? event.touches[0] : event
        drag.current = { dx: point.clientX - (state.pos?.x ?? 10), dy: point.clientY - (state.pos?.y ?? 120) }
        event.preventDefault()
      }
      const onMove = (event) => {
        if (!drag.current) return
        const point = event.touches ? event.touches[0] : event
        const next = { x: Math.max(0, point.clientX - drag.current.dx), y: Math.max(0, point.clientY - drag.current.dy) }
        store.set({ pos: next })
        event.preventDefault()
      }
      const onUp = () => {
        if (!drag.current) return
        drag.current = null
        writePos(store.state.pos)
      }
      return h(
        'button',
        {
          type: 'button',
          style: css.pill(state.pos),
          onMouseDown: onDown,
          onMouseMove: onMove,
          onMouseUp: onUp,
          onTouchStart: onDown,
          onTouchMove: onMove,
          onTouchEnd: onUp,
          onClick: () => {
            if (drag.current) return
            if (store.state.drawer) store.set({ drawer: false, hideFrame: false })
            else openDrawer()
          },
          title: '切换',
        },
        '切换',
      )
    }

    /* ---------------- 切换抽屉 ---------------- */
    function Drawer() {
      const state = useStore()
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      if (!state.drawer) return null

      const run = async (name, fn) => {
        setBusy(name)
        setNote('')
        try {
          await fn()
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy('')
        }
      }

      const save = () =>
        run('save', async () => {
          await post('/__ctl/save', state.form)
          store.set({ form: { label: '', url: '', pin: '' }, adding: false })
          await loadState()
          if (store.state.activeId) store.set({ open: true, drawer: false })
        })

      const known = (id) => state.connections.find((row) => row.id === id)

      return h(
        React.Fragment,
        null,
        h('div', { style: css.dim, onClick: () => store.set({ drawer: false, hideFrame: false }) }),
        h(
          'div',
          { style: css.drawer, role: 'dialog', 'aria-label': '切换' },
          // 顶部留白 + 标题行：手机前置摄像头在屏顶，按钮放太高会被遮住/点不到。
          h(
            'div',
            {
              style: {
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                padding: '16px 16px 12px',
                borderBottom: '1px solid rgba(127,127,127,.22)',
                pointerEvents: 'none',
              },
            },
            h('div', { style: { fontSize: 14, fontWeight: 700, letterSpacing: 0.2 } }, 'dsh-link'),
            h('div', { style: { fontSize: 11.5, opacity: 0.55, marginTop: 2 } }, 'github.com/ShuangYe-1991'),
          ),
          h(
            'button',
            { style: css.bigBtn, onClick: () => store.set({ open: false, drawer: false, adding: false }) },
            '切换手机 DSH',
          ),
          h('div', { style: css.micro }, '切换回手机 DSH。只要电脑和电脑上的 DSH 不关，随时可以回来（人在外面时要用公网地址连）。'),

          h('div', { style: { fontWeight: 600, margin: '0 0 6px' } }, '电脑'),
          state.connections.length === 0
            ? h('p', { style: css.muted }, '还没连过电脑，下面新增一台。')
            : state.connections.map((row) =>
                h(
                  'div',
                  { key: row.id, style: css.row },
                  h(
                    'div',
                    {
                      style: css.rowMain,
                      onClick: () => {
                        if (row.id === state.activeId && state.open) {
                          store.set({ drawer: false, hideFrame: false })
                          return
                        }
                        run('open-' + row.id, () => openComputer(row.id))
                      },
                    },
                    h('div', { style: css.label }, row.label || '未命名电脑', row.id === state.activeId ? h('span', { style: { color: '#2e9e5b', marginLeft: 6 } }, '●') : null),
                    h('div', { style: css.url }, row.url),
                  ),
                  h(
                    'button',
                    {
                      style: css.small,
                      onClick: () =>
                        run('rename', async () => {
                          const next = window.prompt('新的名字', known(row.id)?.label ?? '')
                          if (next === null) return
                          await post('/__ctl/rename', { id: row.id, label: next.trim() })
                          await loadState()
                        }),
                    },
                    '改名',
                  ),
                  h(
                    'button',
                    {
                      style: css.small,
                      onClick: () =>
                        run('pin', async () => {
                          const next = window.prompt('这台电脑的新访问密码', '')
                          if (next === null) return
                          const pin = next.trim()
                          if (!pin) return
                          await post('/__ctl/pin', { id: row.id, pin })
                          await loadState()
                        }),
                    },
                    '改密码',
                  ),
                ),
              ),

          state.adding
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('input', {
                  style: css.input,
                  placeholder: '名字，例如 家里电脑',
                  value: state.form.label,
                  onChange: (e) => store.set({ form: { ...state.form, label: e.target.value } }),
                }),
                h('input', {
                  style: css.input,
                  placeholder: '地址 http://192.168.1.5:3199 或 https://xxx.trycloudflare.com',
                  value: state.form.url,
                  onChange: (e) => store.set({ form: { ...state.form, url: e.target.value } }),
                }),
                h('input', {
                  style: css.input,
                  type: 'password',
                  placeholder: '输入密码',
                  value: state.form.pin,
                  onChange: (e) => store.set({ form: { ...state.form, pin: e.target.value } }),
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 10 } },
                  h('button', { style: css.small, onClick: save, disabled: busy !== '' }, busy === 'save' ? '正在连…' : '保存并进入'),
                  h('button', { style: css.small, onClick: () => store.set({ adding: false }) }, '取消'),
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 12 } },
                h(
                  'button',
                  { style: { ...css.small, flex: '1 1 0', padding: '10px' }, onClick: () => store.set({ adding: true }) },
                  '＋ 新增电脑',
                ),
                h(
                  'button',
                  { style: { ...css.small, flex: '1 1 0', padding: '10px' }, onClick: () => store.set({ scan: true, drawer: false }) },
                  '扫码',
                ),
              ),

          note ? h('p', { style: css.err }, note) : null,
          state.error ? h('p', { style: css.err }, state.error) : null,
        ),
      )
    }

    /* ---------------- 扫码添加（借用插件自己的扫码页） ---------------- */
    function ScanOverlay() {
      const state = useStore()
      React.useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.source !== 'dsh-link' || data.type !== 'scan-saved') return
          store.set({ scan: false })
          loadState()
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])
      if (!state.scan) return null
      const src = 'http://127.0.0.1:' + (state.port || 4319) + '/__ctl/scan?embed=1'
      return h(
        'div',
        { style: { position: 'fixed', inset: 0, zIndex: TOP_Z + 2, background: '#fff', color: '#111', display: 'flex', flexDirection: 'column', pointerEvents: 'auto' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid rgba(0,0,0,.12)' } },
          h('span', { style: { flex: '1 1 auto', fontWeight: 600, fontSize: 13 } }, '扫码添加电脑'),
          h('button', { style: css.small, onClick: () => store.set({ scan: false }) }, '关闭'),
        ),
        h('iframe', { style: { flex: '1 1 auto', width: '100%', border: 0, pointerEvents: 'auto', touchAction: 'auto' }, title: '扫码添加', src }),
      )
    }

    /* ---------------- 电脑画面 ---------------- */
    function Frame() {
      const state = useStore()
      if (!state.open) return null
      const active = state.connections.find((row) => row.id === state.activeId)
      return h(
        'div',
        { style: css.frameWrap },
        h(
          'div',
          { style: css.bar },
          h(MonitorIcon, { size: 16 }),
          h('span', { style: css.grow }, active ? active.label : '电脑 DSH'),
          h('span', { style: { fontSize: 10.5, opacity: 0.6, lineHeight: 1.25, textAlign: 'right' } }, '点切换可换电脑'),
          h('span', { style: { fontSize: 10.5, opacity: 0.6, lineHeight: 1.25, textAlign: 'right', marginLeft: 6 } }, '或返回手机 DSH'),
        ),
        h('iframe', {
          style: state.drawer ? { ...css.frame, visibility: 'hidden' } : css.frame,
          title: '电脑 DSH',
          src: `${base()}/`,
          allow: 'clipboard-read; clipboard-write',
        }),
      )
    }

    /**
     * 打开抽屉前先把焦点弄走：
     * 电脑页面里的输入框有光标时，软键盘会一直顶着，抽屉弹出来被挤到屏幕外，
     * 用户会以为"点了切换什么都没有"。iframe 是跨源的摸不到里面，所以
     * ①先 blur 掉 activeElement；②抽屉打开期间把 iframe 设成 visibility:hidden（不销毁、不重载，
     * 但会失去焦点 → 键盘收起）。
     */
    const openDrawer = () => {
      try {
        const el = document.activeElement
        if (el && typeof el.blur === 'function') el.blur()
      } catch (error) {}
      store.set({ drawer: true, hideFrame: true })
    }

    function Root() {
      const state = useStore()
      if (!state.open && !state.drawer && !state.scan) return null
      const tree = h(React.Fragment, null, h(Frame, null), h(Pill, null), h(Drawer, null), h(ScanOverlay, null))
      // 能 portal 就挂到 body：设置页/侧边栏无论在哪个层，都会被盖住
      if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
        try {
          window.__dshLinkPortal = true
          return ReactDOM.createPortal(tree, document.body)
        } catch (error) {
          window.__dshLinkPortal = false
        }
      }
      return tree
    }

    /**
     * 侧边栏那一行点不动的原因（手机端诊断报告的结论）：
     * `sidebar.panellist` 的目录说明写着 —— 「每个 id 对应一个 main 面板，侧边栏负责画按钮、
     * 从 list metadata 取文字」。也就是说那一行按钮是宿主的，点它 = 把主区切到同 id 的 main 面板；
     * 我们当时只注册了 panellist（按钮），没有注册 main（面板），所以点了没有任何目标可切。
     *
     * 所以这里补上 main 面板：id 与 panellist 一致，宿主自己把点击路由过来。
     */
    function MainPanel() {
      const state = useStore()
      const returned = React.useRef(false)

      React.useEffect(() => {
        // 从侧边栏点进来（宿主切到本面板）时，把画面打开
        if (!store.state.open) {
          if (!store.state.port) loadPort()
          else loadState()
          store.set({ open: true })
        }
      }, [])

      // 用户点了「切换手机 DSH」→ 覆盖层收掉，但宿主的主区还停在这个面板上。
      // 目标：回到最近打开的那个会话（侧边栏会话列表按最近排序，取第一条）；
      // 列表为空才新建。不要留空白页。
      React.useEffect(() => {
        if (state.open || returned.current) return
        returned.current = true

        const clickRecentSession = () => {
          // 会话行里那个「⋯」按钮的 aria-label 形如 会话“标题”的操作，用它定位，再点整行
          const marker = document.querySelector('[aria-label^="会话"]')
          if (marker) {
            let node = marker
            for (let i = 0; i < 5 && node && node !== document.body; i += 1) {
              const role = node.getAttribute('role')
              const tag = node.tagName
              if (tag === 'BUTTON' || role === 'button' || role === 'listitem' || role === 'option' || tag === 'A') break
              node = node.parentElement
            }
            if (node && node !== document.body) {
              try {
                node.click()
                return true
              } catch (error) {}
            }
          }
          const newBtn = [...document.querySelectorAll('button,[role="button"]')].find((node) => {
            const label = (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')
            return /新建会话/.test(label) && node.getBoundingClientRect().width > 0
          })
          if (newBtn) {
            try {
              newBtn.click()
              return true
            } catch (error) {}
          }
          return false
        }

        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          if (clickRecentSession() || tries >= 8) clearInterval(timer)
        }, 180)
        return () => clearInterval(timer)
      }, [state.open])

      if (state.open) return h(Root, null)
      return null
    }

    /* ---------------- 侧边栏入口 ---------------- */
    /**
     * 宿主把每一项渲染成一整行按钮，只把图标那一小块留给我们。
     *
     * 做法不再靠"猜多少像素"，而是**量它**：
     *   找到包住我们的那一行（closest 到 button/[role=button]），给它补一个 position:relative，
     *   然后把自己的热区绝对定位铺满整行（inset:0），再用 ResizeObserver 跟着行宽变化。
     * 这样不管哪台手机、什么字号、侧边栏多宽，热区永远等于整行。
     */
    function PanelIcon({ size }) {
      const lastFire = React.useRef(0)

      // 只处理点击，不再改动宿主 DOM（上一次往上爬祖先、给它加 position:relative、
      // 再绝对定位盖整行，会把同一容器里别的图标一起顶乱——这正是 0.4.5 的副作用）。
      const open = async (event) => {
        event?.stopPropagation?.()
        const now = Date.now()
        if (now - lastFire.current < 700) return
        lastFire.current = now
        if (!store.state.port) await loadPort()
        await loadState()
        if (store.state.connections.length === 1) await openComputer(store.state.connections[0].id)
        else openDrawer()
      }

      return h(
        'span',
        {
          role: 'button',
          tabIndex: 0,
          title: '电脑 DSH',
          'aria-label': '电脑 DSH',
          onClick: open,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') open(event)
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 8,
            padding: '4px 6px',
            margin: '-4px -6px',
            cursor: 'pointer',
          },
        },
        h(MonitorIcon, { size: size ?? 18 }),
      )
    }

    /* ---------------- 设置页 ---------------- */
    function SettingsPage() {
      const state = useStore()
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const [role, setRole] = React.useState('')

      React.useEffect(() => {
        loadPort()
        fetch('/__link/api', { cache: 'no-store' })
          .then((res) => res.json())
          .then((json) => setRole(json?.state?.role ?? ''))
          .catch(() => setRole(''))
      }, [])

      const run = async (name, fn) => {
        setBusy(name)
        setNote('')
        try {
          await fn()
        } catch (error) {
          setNote(error.message)
        } finally {
          setBusy('')
        }
      }

      const switchRole = (next) => {
        if (next === role) {
          setNote('当前已经是这个角色了，不用切')
          return
        }
        return run('role', async () => {
          const res = await fetch('/__link/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'role', role: next }),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`)
          setRole(json?.state?.role ?? next)
          await loadPort()
        })
      }

      const toggleSidebar = () => {
        const next = !store.state.enabled
        writeBool(SIDEBAR_KEY, next)
        store.set({ enabled: next })
      }

      const roleRow = h(
        'div',
        { style: css.row },
        h(
          'div',
          { style: { ...css.rowMain, cursor: 'default' } },
          '这台设备当什么用',
          h('p', { style: css.muted }, role === 'phone' ? '现在：手机（连别人的电脑）' : role === 'computer' ? '现在：电脑（开入口给手机连）' : '正在读…'),
        ),
        h('button', { style: css.small, onClick: () => switchRole('computer'), disabled: busy !== '' }, '作为电脑'),
        h('button', { style: css.small, onClick: () => switchRole('phone'), disabled: busy !== '' }, '作为手机'),
      )

      const header = (subtitle) =>
        h(
          'div',
          null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h(MonitorIcon, { size: 18 }), h('strong', null, '电脑 DSH')),
          h('p', { style: css.muted }, subtitle),
        )

      // 鸣谢 + 联系方式（设置页里两个角色都显示）
      const thanksBlock = h(
        'div',
        { style: { marginTop: 18, paddingTop: 12, borderTop: '1px solid rgba(127,127,127,.25)', fontSize: 12, lineHeight: 1.7, opacity: 0.85 } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '鸣谢'),
        h(
          'div',
          null,
          '灵感与协议参考 dsh-pocket（@shaobeichen，本项目不复用其代码）；公网隧道 cloudflared；二维码 qrcode-generator (MIT)；解码 jsQR (Apache-2.0)。',
        ),
        h('div', { style: { marginTop: 4 } }, '作者 GitHub：@ShuangYe-1991　·　问题与建议：到仓库开 Issue 最快被看到'),
      )

      if (role === 'computer') {
        return h(
          'div',
          { style: { padding: '4px 2px', fontSize: 13 } },
          header('这台在给手机开入口。下面这块就是完整控制页：开关手机访问、改端口、看/换访问密码、开公网、竖屏适配。'),
          roleRow,
          h('iframe', {
            src: '/__link/ui',
            title: '手机访问控制页',
            style: { width: '100%', height: 620, border: 0, borderRadius: 10, marginTop: 6, background: 'transparent' },
          }),
            note ? h('p', { style: css.err }, note) : null,
        )
      }

      const save = () =>
        run('save', async () => {
          const body = state.form
          if (state.editingId) await post('/__ctl/update', { ...body, id: state.editingId })
          else await post('/__ctl/save', body)
          store.set({ form: { label: '', url: '', pin: '' }, editingId: null })
          await loadState()
        })

      return h(
        'div',
        { style: { padding: '4px 2px', fontSize: 13 } },
        header('连上别的电脑上的 DSH：手机这边通过本机代理去连，登录态和地址都在代理里管。'),
        roleRow,
        thanksBlock,

        h(
          'div',
          { style: css.row },
          h('div', { style: { ...css.rowMain, cursor: 'default' } }, '在侧边栏显示入口', h('p', { style: css.muted }, '打开后侧边栏多一个显示器图标，点它直接进电脑；有多台电脑时先让你选。')),
          h('button', { style: css.small, onClick: toggleSidebar }, state.enabled ? '关掉' : '开启'),
        ),

        h(
          'div',
          { style: css.row },
          h('div', { style: { ...css.rowMain, cursor: 'default' } }, '本机代理', h('p', { style: css.muted }, state.port ? `127.0.0.1:${state.port}` : '还没起来')),
          h('button', { style: css.small, onClick: () => run('reload', loadPort) }, '刷新'),
        ),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px' } }, '已连的电脑'),
        state.connections.length === 0
          ? h('p', { style: css.muted }, '还没连过。下面填电脑上 dsh-link 状态页给的地址和密码。')
          : state.connections.map((row) =>
              h(
                'div',
                { key: row.id, style: { padding: '10px 2px', borderBottom: '1px solid rgba(127,127,127,.2)' } },
                // 第一行：名字 + 连接状态 + 地址
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                  h(
                    'div',
                    { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto' } },
                    row.label || '未命名电脑',
                  ),
                  row.id === state.activeId
                    ? h('span', { style: { color: '#2e9e5b', fontSize: 11.5, flex: '0 0 auto' } }, '正在用')
                    : h('span', { style: { fontSize: 11.5, opacity: 0.5, flex: '0 0 auto' } }, '未连接'),
                  h(
                    'span',
                    { style: { fontSize: 11, opacity: 0.5, marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' } },
                    row.url,
                  ),
                ),
                // 第二行：按钮统一大小、等宽一排
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, marginTop: 8 } },
                  [
                    { label: '进入', fn: () => run('open', () => openComputer(row.id)) },
                    { label: '改名', fn: () => run('rename', async () => {
                        const next = window.prompt('新的名字', row.label ?? '')
                        if (next === null) return
                        await post('/__ctl/rename', { id: row.id, label: next.trim() })
                        await loadState()
                      }) },
                    { label: '改网址', fn: () => {
                        store.set({ form: { label: row.label || '', url: row.url, pin: '' }, editingId: row.id })
                        setNote('改网址：密码留空就沿用旧的')
                      } },
                    { label: '改密码', fn: () => run('pin', async () => {
                        const next = window.prompt('这台电脑的新访问密码（电脑上 dsh-link 页面显示的那个）', '')
                        if (next === null) return
                        const pin = next.trim()
                        if (!pin) return
                        await post('/__ctl/pin', { id: row.id, pin })
                        await loadState()
                      }) },
                    { label: '删除', fn: () => run('delete', async () => {
                        await post('/__ctl/delete', { id: row.id })
                        await loadState()
                      }) },
                  ].map((item) =>
                    h(
                      'button',
                      {
                        key: item.label,
                        style: { ...css.small, flex: '1 1 0', textAlign: 'center', padding: '7px 0' },
                        onClick: item.fn,
                      },
                      item.label,
                    ),
                  ),
                ),
              ),
            ),

        h('div', { style: { fontWeight: 600, margin: '14px 0 2px' } }, state.editingId ? '修改这台电脑' : '添加一台电脑'),
        h('input', {
          style: css.input,
          placeholder: '名字，例如 家里电脑',
          value: state.form.label,
          onChange: (e) => store.set({ form: { ...state.form, label: e.target.value } }),
        }),
        h('input', {
          style: css.input,
          placeholder: '地址 http://192.168.1.5:3199 或 https://xxx.trycloudflare.com',
          value: state.form.url,
          onChange: (e) => store.set({ form: { ...state.form, url: e.target.value } }),
        }),
        h('input', {
          style: css.input,
          type: 'password',
          placeholder: '输入密码',
          value: state.form.pin,
          onChange: (e) => store.set({ form: { ...state.form, pin: e.target.value } }),
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { style: css.small, onClick: save, disabled: busy !== '' }, busy === 'save' ? '正在连…' : state.editingId ? '保存修改' : '保存并连接'),
          h(
            'button',
            {
              style: css.small,
              onClick: () =>
                run('refresh', async () => {
                  const result = await post('/__ctl/refresh', {})
                  await loadState()
                  setNote(result.changed ? '拿到新地址了，已经换上' : '地址没变，或者现在问不到（可能不在同一个 WiFi）')
                }),
              disabled: busy !== '',
            },
            busy === 'refresh' ? '正在问…' : '自动找新地址',
          ),
          h('button', { style: css.small, onClick: () => store.set({ scan: true }) }, '扫码添加'),
        ),
        h(
          'p',
          { style: { ...css.muted, color: '#c0392b', opacity: 0.9 } },
          '扫码添加：部分手机版 DSH 可能拿不到相机权限，用「从相册选」识别二维码图片也行，或者直接手填电脑上的地址。',
        ),
        h('p', { style: css.muted }, '电脑重启后公网地址会变。手机和电脑在同一个 WiFi 时点「自动找新地址」，它会去局域网问一次，问到就自己换上。'),
        state.lastError
          ? h(
              'p',
              { style: css.muted },
              state.lastError.kind === 'dns'
                ? '上次没连上：网址可能变了。点那台电脑的「进入」，失败页里能直接扫码/填新地址。'
                : '上次没连上：点那台电脑的「进入」，失败页里能改地址和密码。',
            )
          : null,
        state.error ? h('p', { style: css.err }, state.error) : null,
        note ? h('p', { style: css.err }, note) : null,
        thanksBlock,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧边栏入口是可选的：默认不注册，打开开关才注册（关掉就注销那一行）
        let sidebarDisposer = null
        let slotReady = false
        const syncSidebar = () => {
          if (!slotReady) return
          const want = store.state.enabled
          if (want && !sidebarDisposer) {
            sidebarDisposer = ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-link', order: 20, label: '电脑 DSH' }, PanelIcon)
          } else if (!want && sidebarDisposer) {
            try {
              sidebarDisposer()
            } catch (error) {}
            sidebarDisposer = null
          }
        }
        store.onSidebarChange = syncSidebar

        ctx.slots.inject('sidebar.panellist', () => {
          slotReady = true
          syncSidebar()
          return () => {
            slotReady = false
            if (sidebarDisposer) {
              try {
                sidebarDisposer()
              } catch (error) {}
              sidebarDisposer = null
            }
          }
        })
        // 侧边栏那一行是宿主画的按钮，点它只会把主区切到"同 id 的 main 面板"。
        // 所以必须同时注册 main（id 与 panellist 一致），否则点击没有目标、看起来像没反应。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-link' }, MainPanel),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-link-panel', order: 60 }, Root),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-link', order: 40, label: '电脑 DSH' }, SettingsPage),
        )
        // 不再注册 settings.section.icon：手机端截图证明，多注册一个图标会让
        // 设置页里其它栏目的图标整体错位（有的多一个、有的少一个）——宿主是按顺序配对的。
      },
    }
  },
})
