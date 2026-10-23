# workbench/vendor/xterm — 钉死版本的 xterm.js

ROUND8 的 pane 弹窗用 xterm.js 做真终端仿真。**不走 CDN**（内网可能不通，而且 CDN 版本会漂）：
下面三个文件是从 npm registry 拉下来的官方 tarball 里原样 `cp` 出来的，一个字节没改。

| 文件 | 来源包 | 版本 | tarball sha256 | 文件 sha256 |
|---|---|---|---|---|
| `xterm.js` | `@xterm/xterm` (`lib/xterm.js`, UMD) | 5.5.0 | `bd954fa721872170188cc5d7e83e88db3c83c9a18a4e8d24c2783d26491f59d2` | `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495` |
| `xterm.css` | `@xterm/xterm` (`css/xterm.css`) | 5.5.0 | 同上 | `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit` (`lib/addon-fit.js`, UMD) | 0.10.0 | `917ac44972453d5eed52edc1e50260c76398ce48cf2290c2e60671102bba0b33` | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |
| `addon-webgl.js` | `@xterm/addon-webgl` (`lib/addon-webgl.js`, UMD) | 0.18.0 | `6229e5c0b66a9de0e155602e90586605c53b91d6af657a6cbe2b8377d6019370` | `9ffa9ac3ff6d47d4e6216ed1972ca8e0b5336cef744f50ebdc3f67b0ed727cdb` |

许可证原样带着：`LICENSE-xterm.txt`、`LICENSE-addon-fit.txt`、`LICENSE-addon-webgl.txt`（都是 MIT）。

复现方法（任何人都可以自己核一遍 sha256）：

```
npm pack @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 @xterm/addon-webgl@0.18.0
tar xzf xterm-xterm-5.5.0.tgz          # → package/lib/xterm.js, package/css/xterm.css
tar xzf xterm-addon-fit-0.10.0.tgz     # → package/lib/addon-fit.js
tar xzf xterm-addon-webgl-0.18.0.tgz   # → package/lib/addon-webgl.js, package/LICENSE
```

`addon-webgl` 是 2026-10-12 加的，为什么：xterm 5.5.0 默认用 DOM 渲染器，每个脏行都要重建
一棵 span 树。pane 弹窗铺满视口的时候是 177×47 = 8319 个格子，刷屏的时候这一下就是整个
操控 Tab 最大的一笔开销 —— 「按键到 xterm 解析完」实测 12.9ms 中位数，但那个数**不含**
把屏幕真画出来的那一段。WebGL 渲染器把画字的活交给 GPU。
它的 peerDependencies 是 `@xterm/xterm: ^5.0.0`，和盘上这份 5.5.0 对得上（0.19+ 要的是
xterm 6.x）。页面在 `onContextLoss` 时 `dispose()` 它 —— 丢了 WebGL 上下文（或者所在的
webview 压根没有 WebGL）就退回 DOM 渲染器，只是慢，不会变成一块黑屏。

为什么是 5.5.0 而不是 registry 上的 latest（6.0.0）：5.5.0 是 UMD 全局 `Terminal` 这条
路径上最后一个被广泛使用的稳定版（`vscode` / 一大票服务端终端都钉在 5.x），而本页是
`<script src>` 直接挂全局、没有打包器。6.x 的目标形态是 ESM + 子包，拿来当单文件挂全局
不是它的主用法。盘上另有两份离线 `@xterm/xterm` 6.1.0-beta.91（`~/.comate*` 里），**没有用**：
它是 beta，而且那两棵树里没有 `@xterm/addon-fit`。

挂载方式（见 `workbench/index.html` 的 shell 区 + `workbench/server.py` 的 `/vendor/` 路由）：
* `GET /vendor/xterm/<file>` 只认这三个文件 + 两个 LICENSE 的精确文件名白名单，**不拼路径**，
  所以不存在 `..` 穿越面；
* 这条路由**和别的 GET 一样要 token**。`<script src>`/`<link href>` 发不出 Authorization
  头 —— 静态资源因此被开成免鉴权是常见做法，这里没有：页面在开 pane 的时候自己带上
  `?token=` 把标签注进去（见 index.html 的 shell 区），板子于是只有一条规矩「除了
  `/api/health`，每一条 GET 都要 token」，不长出第二个例外。实测：不带 token 的
  `GET /vendor/xterm/xterm.js` 是 401，带上是 200（`ref/round8/stage4-gate3.out.txt` 的 E 段）。
* 它只在 `do_GET` 里，`do_POST` 没有对偶（结构断言钉死）。
