# 第三方代码与内容

本项目原创部分采用 [MIT](LICENSE)。下列第三方代码及改编部分保留其各自许可，MIT 声明不替代这些许可。依赖及精确版本记录在 [package-lock.json](package-lock.json)，通过 npm 安装，不将 `node_modules` 放入源码仓库。

## 扫码适配的来源与修改

[server/auth.ts](server/auth.ts) 中的 Cookie 候选凭据解析、校验和有效期处理，参考并改编自 **xzxzzx / `@xzxzzx/bilibili-mcp` 1.14.2** 的 `dist/bilibili/qr-login.js`（源文件为 `src/bilibili/qr-login.ts`），原许可为 **Apache License 2.0**。

- 上游项目：[XZXZZX-Ai/bilibili-mcp](https://github.com/XZXZZX-Ai/bilibili-mcp)。本项目使用的准确版本以锁文件及已安装包的 `package.json` 为准。
- 本项目于 2026-10-14 将终端流程改为网页二维码会话：增加请求边界、取消及过期处理，明确验证候选凭据，仅在本地服务内存中保留登录状态。没有修改已安装的上游包。
- 本文件下方完整收录上游安装包的 `LICENSE`。该版本的安装包未附带 `NOTICE` 文件，`qr-login.js` 也未包含独立版权声明；这里保留项目、作者、版本及来源归属，不补造上游未提供的版权年份。
- 分发此改编代码时，请连同本文件、项目 `LICENSE` 和源文件中的来源/修改声明一起保留。若以后升级依赖，需重新核对包内许可与 `NOTICE`。

## 直接依赖

| 依赖 | 版本 | 许可 | 当前用途 |
| --- | --- | --- | --- |
| `@xzxzzx/bilibili-mcp` | 1.14.2 | Apache-2.0 | 公开 HTTP 请求、元数据和显式候选凭据验证 |
| `react` / `react-dom` | 19.3.0 | MIT | 页面与播放器 |
| `zod` | 3.25.76 | MIT | 输入、元数据及旧协议校验 |
| `qrcode-generator` | 2.0.4 | MIT | 本地生成二维码图片 |
| `dashjs` | 5.2.1 | BSD-3-Clause | 播放已授权的 DASH 音视频，不使用其界面控件 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | 保留的旧 CLI / MCP 诊断链路 |
| `vite` | 8.3.4 | MIT | 开发服务与前端构建 |
| `typescript` | 5.9.3 | Apache-2.0 | 类型检查 |
| `tsx` | 4.20.6 | MIT | 运行 TypeScript 服务与测试 |
| `@types/node` | 24.10.1 | MIT | Node.js 类型声明 |
| `@types/react` / `@types/react-dom` | 19.2.6 / 19.2.3 | MIT | React 类型声明 |

其余传递依赖见锁文件。各包自己的许可随 npm 包提供；分发打包产物或依赖副本时，还应保留被分发部分对应的许可与版权声明。`qrcode-generator` 的安装包标注 `Copyright (c) 2009 Kazuhiko Arase`，并注明 “QR Code” 是 DENSO WAVE INCORPORATED 的注册商标。

正常网页路径始终匿名请求名单，并只在本人网页扫码确认后显式传入当前进程的凭据；不调用上游全局凭据读取、安装或保存流程。遗留的终端诊断例外见 [CONTRIBUTING.md](CONTRIBUTING.md#遗留诊断代码)。

## 赛事内容

B 站赛事视频、音频、封面、画面及账号标识不属于本项目代码许可。MP4 由浏览器直接连接 B 站 CDN；DASH 分段由本机服务按需流式连接 B 站，不落盘缓存；项目不附带媒体文件，不因代码开源而取得赛事内容的再分发权。

本地调试截图可能包含第三方赛事画面、临时二维码或账号信息，不能直接作为仓库宣传素材。根目录预览截图与 `screenshots/`、`.local/` 均在忽略范围内；需要公开示意图时应另行准备可公开的素材。

## Apache License 2.0 原文

以下原样保留 `@xzxzzx/bilibili-mcp` 1.14.2 安装包的 `LICENSE`：

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

```
