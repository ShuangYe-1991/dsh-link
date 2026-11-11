# 第三方代码声明（随包携带）

本项目源码全部在仓库里（ESM 明文 .js/.mjs，无压缩、无编译产物）。
以下两个文件是"直接放进来"的第三方库，各自遵循自己的许可证：

## 1. `vendor/qrcode.cjs`

- 项目：qrcode-generator
- 版权：Copyright (c) 2009 Kazuhiko Arase
- 许可：MIT License
- 来源：https://github.com/kazuhikoarase/qrcode-generator

用途：在状态页生成局域网/公网地址的二维码。

## 2. `vendor/jsqr.js`

- 项目：jsQR
- 版权：Copyright (c) 2016 Cosmo Wolfe
- 许可：Apache License, Version 2.0
- 来源：https://github.com/cozmo/jsQR
- 许可证全文：https://www.apache.org/licenses/LICENSE-2.0

用途：手机端扫码添加电脑时解码二维码图片。该文件为官方发布的打包产物，未做修改；
其原始许可头在打包过程中被移除，故在此保留版权与许可声明以满足 Apache-2.0 的要求。

## 其他

- `cloudflared` 二进制由使用者机器自行下载（Cloudflare 发布，遵循其自身许可），不随本包分发。
- 用户数据（`$DSH_HOME/dsh-link/` 下的 state.json、tunnel.json、日志）不进入仓库与安装包。
