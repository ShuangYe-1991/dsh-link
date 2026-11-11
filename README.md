# dsh-link · 一台电脑 + 一台手机

装**同一个包**在两边，用状态页里的开关选这台设备当什么：

| 角色 | 它干什么 |
|---|---|
| **电脑**（默认） | 在局域网/公网开一个带密码门的反向代理，把本机 `dsh web` 原样给手机用；能自己拉 cloudflared 起公网隧道 |
| **手机** | 在 `127.0.0.1` 开一个反向代理，把电脑那台 dsh 的整页喂给手机 DSH 的面板；会话登录、地址自愈都在这一侧 |

手机侧是 DSH 侧边栏里的一个面板（「电脑 DSH」）：全屏就是电脑的对话页，顶部有「切换」胶囊，可多台电脑切换、改地址、扫码添加。

## 两种角色怎么用

**电脑那台**：状态页 →「这台设备当什么用」选「作为电脑」。页面里给二维码、局域网地址、访问密码，以及公网访问（快速隧道 / 固定域名）。手机扫这个码或者手填地址 + 密码即可。

**手机那台**：状态页选「作为手机」。之后打开手机 DSH 侧边栏里的「电脑 DSH」→「切换 → 添加电脑」，贴地址、填密码。本机代理端口会自动挑（默认 `4319`，被占就顺延）。

状态页地址（只允许本机打开）：

| 角色 | 地址 |
|---|---|
| 电脑 | `http://127.0.0.1:3199/__link/ui`（固定端口）或 `http://127.0.0.1:<dsh端口>/__link/ui` |
| 手机 | `http://127.0.0.1:<dsh端口>/__link/ui`（切到手机角色后 3199 不再监听，另给一个连接管理页 `http://127.0.0.1:<手机代理端口>/__ctl/ui`） |

## 协议（dsh-link v1）

电脑端对手机端暴露的东西：

| 接口 | 说明 |
|---|---|
| `GET /__link/version` | 免鉴权，返回 `{ name:'dsh-link', version:1, host, features:['auth','ws'] }`；手机端据此识别协议 |
| `POST /__link/login` | 表单 `token=<密码>`：对 → `302` + `Set-Cookie: dsh_link=…`；错 → `200` + 登录页（含 `current-password`）；试错 5 次锁 60 秒（`429`） |
| `GET /__link/tunnel` | 要过密码门，返回**当前公网地址**：`{ ok, mode, state, url, updatedAt }`。手机端在同一局域网时问一次就能拿到新地址 |
| 其余所有请求 | 未带有效 cookie → 登录页（文档请求）或 `401`；带了 → 透传到 dsh web（HTTP + WebSocket） |

手机端同时兼容第三方 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)：先探 `/__link/version`，没有就走它的 `POST /pocket-login`。

## 公网访问

两种模式，都在状态页里开关：

| 模式 | 地址 | 需要什么 |
|---|---|---|
| 快速隧道 | `https://随机词.trycloudflare.com`，**重启电脑会变** | 什么都不需要，免费 |
| 固定域名 | `https://你的域名`，重启也不变 | Cloudflare 账号里一条隧道的 token + 一个指过去的域名 |

**地址稳定性**：隧道进程独立于 dsh 存活（detached + 输出写文件）。重启 dsh / 重开插件时按 pid + 进程名（`tasklist`）认领上一条隧道，所以**只重启 dsh 地址不变**，只有重启电脑才会换。

**手机自动拿到新地址**：连不上时手机侧会去局域网那个地址问 `/__link/tunnel`，拿到新公网地址就自己换掉、重新登录（连接管理页也有「自动找新地址」按钮）。前提是手机和电脑在同一个 WiFi——回过一次家就自动修好了。

**cloudflared 从哪来**：先找插件自己的 `$DSH_HOME/dsh-link/bin/`，再找 dsh-pocket 已经下好的、各 profile 的 `node_modules/cloudflared`、系统 PATH。都没有会自动下载，**按顺序试 4 个源**（GitHub 官方 → ghproxy.net → gh-proxy.com → ghfast.top），下完校验 `--version` 才改名落盘。全失败时状态页用红字列出：缺什么、找过哪些路径、每个源失败的原因，并给官方发布页——用户自己下下来放到 `$DSH_HOME/dsh-link/bin/cloudflared.exe` 再点「重新检测」就行。

## 竖屏适配

手机上竖屏时 dsh 自己的桌面布局会把主内容列算成 0 宽、推出屏幕外（一片空白、侧边栏反而拉得出来）。电脑端转发 HTML 时塞一小段脚本（约 1.5KB）：只在「视口 ≤ 900 且主内容列确实被挤出屏幕」时给外壳加 `grid-template-columns: 0 1fr 0`。平板 / 横屏 / 电脑宽度一律不碰；手机面板里的「布局 / 缩放 / 侧边栏」按钮通过 `postMessage` 控制它。

判断只在"没开适配"时量一次——开了之后主列本来就满宽，再拿量到的宽度反推会自己把自己关掉，来回抖（踩过）。

## 配置与文件

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/dsh-link/state.json` | 角色、开关、端口、访问密码、隧道配置（0600） |
| `$DSH_HOME/dsh-link/tunnel.json` | 隧道运行时（pid/地址/模式），用来跨 dsh 重启认领 |
| `$DSH_HOME/dsh-link/tunnel.log` | cloudflared 自己的输出 |
| `$DSH_HOME/dsh-link/proxy.log` | 门口发生的事：换 dsh 会话 cookie、上游 401/403、重试 |
| `$DSH_HOME/dsh-link/phone/state.json` | 手机侧：连过哪些电脑、当前用哪台 |

## 三个实现要点（踩过的坑）

1. **dsh web 自己也有鉴权**：根路径要带一次 `?token=<启动令牌>` 换 cookie。令牌由插件向 dsh 要（`ctx.connection.authenticatedUrl()`），换 cookie 用的 authority 必须和转发时的 `Host` 一致，否则一直 401。
2. **别注入 transport shim**：dsh ≥ 0.2.2 上那类改写会让「壳渲染出来、内容全空」。本插件一个字节都不注入，只加竖屏适配那段。
3. **WebSocket 必须通**：dsh 的实时通道走 WS（`/api/remote.mux`），升级请求要和普通请求一样过密码门与头改写。

## 已知限制

- 快速隧道没有可用性保证（Cloudflare 免费给的就是"试试"级别），要稳定就得固定域名；
- 手机不在家、电脑又刚重启过，那一次需要手贴新地址；
- 窄屏横竖屏切换偶发要刷新一次才正常（已知，未修）。

## 目录

```
dsh-link/
├─ index.js              入口：按角色起电脑端或手机端
├─ client.js             手机侧面板（侧边栏入口 + iframe + 切换抽屉）
├─ lib/
│  ├─ link.mjs           电脑端：密码门反向代理 + 状态页接口
│  ├─ tunnel.mjs         公网隧道（cloudflared 生命周期、认领、可达性）
│  ├─ cloudflared.mjs    找/下载 cloudflared（多源、校验）
│  ├─ pages.mjs          电脑端状态页 / 登录页
│  ├─ state.mjs          电脑端状态与密码
│  ├─ fit.mjs            竖屏适配脚本（注入到转发的 HTML）
│  └─ phone/
│     ├─ runtime.mjs     手机端：本机反向代理 + 登录 + 地址自愈
│     └─ pages.mjs       手机端连接管理 / 扫码页
├─ vendor/               二维码生成（MIT）、jsQR（Apache-2.0）
└─ cordis.patch.yml
```

## 安装（别人怎么用）

**方式一：直接从 GitHub 装**

```sh
dsh plugin --profile web add github:ShuangYe-1991/dsh-link
```

**方式二：下载 Release 里的 tgz**

```sh
dsh plugin --profile web add /sdcard/Download/dsh-link-0.6.2.tgz
```

装完重开 DSH。电脑和手机装的是**同一个包**，只是角色选得不一样：

| 设备 | 装完后要做 |
|---|---|
| 电脑 | 设置 → 电脑 DSH → 选「作为电脑」；到 `http://127.0.0.1:3199/__link/ui` 看地址、密码、二维码 |
| 手机 | 设置 → 电脑 DSH → 选「作为手机」；填电脑的地址 + 密码（或扫码）；打开「在侧边栏显示入口」 |

## 作者

[ShuangYe-1991](https://github.com/ShuangYe-1991)

## 已知问题（0.5.9）


1. **从电脑画面切回手机 DSH 会停在空白主区**，回不到会话列表/对话。当前实现是「占用宿主 main 面板 + 全屏覆盖层」，退出时宿主没有可用的"切回会话"入口。计划改用官方面板切换 API，或换一种不占 main 的承载方式。
2. **扫码页在"设置 → 电脑 DSH → 扫码添加"入口下偶发卡顿/黑屏**（"电脑画面 → 切换 → 扫码"入口正常）。表现为首次点击要等几秒。
3. **相机与剪贴板在手机 App 内可能不可用**：`getUserMedia` / `clipboard.readText` 需要宿主在 WebView 的权限回调里放行，插件层无权授予。已提供替代路径：系统「拍照扫码」、从相册选图识别、以及在电脑上复制地址手填。
4. **多台电脑切换只做了逻辑，没有第二台真机验证过**。
5. 快速隧道地址在重启电脑后会变；只重启 dsh 会沿用（靠认领上次的进程）。要固定地址需要命名隧道 + 域名。
6. **关闭「局域网访问」后，电脑本机的管理页也会被 403 挡住**（把自己锁在外面），需要用 state.json 手动改回。**这个开关暂时不要用。**
7. **连接失败后在设置页出现的红框，更新网址成功后仍然挂着**，容易误导；下一版要挪到"进入面板失败"那一页里，并和扫码/相册识别放在一起。
8. 已连电脑那行按钮有 5~6 个、挤在一行；下一版改成两行（上行名字+状态，下行等宽按钮）。
## 鸣谢

这个项目的**灵感与协议设计**来自 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（作者 [@shaobeichen](https://github.com/shaobeichen)）。

它最早做出了"手机扫码就能用电脑上的 DSH"这件事，也是本插件的起点：先有了 dsh-pocket 的能力边界、它的登录门与反向代理思路，才有后面的协议约定（`/__link/version`、`/__link/login`、WebSocket 透传）。本项目的手机端面板交互（悬浮胶囊 + 切换抽屉 + 多台电脑）同样是沿着它那套探索走过来的。

需要说明：**本项目不复用 dsh-pocket 的代码**（它是 GPL-2.0，本项目是 MIT），只按它的对外行为实现客户端；两者协议不兼容时，各以各自文档为准。

另外用到的开源组件与外部服务：

- [Cloudflare cloudflared](https://github.com/cloudflare/cloudflared) —— 公网隧道（免费快速隧道 / 命名隧道）
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）—— 生成二维码
- [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0）—— 解码二维码图片

以及所有愿意试用、反馈问题的人。

## 联系

- GitHub：[@ShuangYe-1991](https://github.com/ShuangYe-1991)
- 问题与建议：直接在这个仓库开 [Issue](https://github.com/ShuangYe-1991/dsh-link/issues)，比私信更容易被看见

## 许可

MIT。二维码生成用 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）；扫码解码用 [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0）。
