# 无剧透回放 · Spoiler-Free Replays

把悬念留到观看时。

**「无剧透回放」是一个开源、免费的防剧透项目。** 目前提供 B 站英雄联盟赛事回放，在自己的电脑上打开，选一场比赛，从第一局看起。

A free, open-source project for spoiler-free viewing, starting with League of Legends replays from Bilibili.

[下载项目](https://github.com/cooleryu/spoiler-free-replays/archive/refs/heads/main.zip) · [两步开始观看](#快速开始) · [观看演示](https://github.com/cooleryu/spoiler-free-replays/releases/download/v0.1.1-preview/spoiler-free-replays-demo.mp4) · [反馈问题](https://github.com/cooleryu/spoiler-free-replays/issues/new)

## 观看体验

- **把结果留到观看时**：比赛列表只显示对阵、赛事和日期，隐藏界面中的比分、封面、时长、进度条和总局数。
- **一局接着一局看**：当前正片结束后自动接下一局，全程没有弹幕。
- **按自己的节奏观看**：支持前后跳转 **5 / 30 / 60 秒**，以及播放、暂停、音量和全屏。

<p>
  <a href="docs/images/01-match-list.png"><img src="docs/images/01-match-list.png" width="32%" alt="比赛列表"></a>
  <a href="docs/images/02-watch.png"><img src="docs/images/02-watch.png" width="32%" alt="沉浸观看"></a>
  <a href="docs/images/03-small-seek.png"><img src="docs/images/03-small-seek.png" width="32%" alt="有限跳转"></a>
</p>

## 快速开始

### 1. 下载项目，让 AI 帮你启动

[下载项目 ZIP](https://github.com/cooleryu/spoiler-free-replays/archive/refs/heads/main.zip)，解压后，用**能运行本机项目的 AI 助手**打开这个文件夹，把下面这句话发给它：

> 请按这个项目的 README 帮我准备运行环境、安装依赖并启动服务，然后在浏览器打开 http://127.0.0.1:4318。请保持本地服务运行。

首次安装也可以交给 AI。启动后，打开的是你自己电脑上的网页；观看期间保持本地服务运行。

### 2. 首页点「刷新」，选一场比赛观看

点击「刷新」获取比赛列表，再点击想看的对阵即可。**首页也会自动加载一次名单，已经有比赛时可以直接点开。** 不用搜索视频、粘贴链接或输入 BV 号。

<details>
<summary>自己手动启动</summary>

需要 Node.js **22.12 或更新版本**，建议使用 Node.js 24。

```sh
git clone https://github.com/cooleryu/spoiler-free-replays.git
cd spoiler-free-replays
npm ci --ignore-scripts
npm run dev
```

已经下载并解压 ZIP 的用户，可直接在项目文件夹中运行最后两条命令。

打开 [http://127.0.0.1:4318](http://127.0.0.1:4318)，使用期间保持服务运行，按 `Ctrl+C` 停止。

</details>

## 使用说明

- **目前看什么**：来自[哔哩哔哩英雄联盟赛事](https://space.bilibili.com/50329118)的近期回放，当前支持 **2026 全球总决赛**。
- **是否需要登录**：不登录也能观看；想提升画质，可点击「登录提升画质」，用 B 站 App 扫码。
- **是否需要 API Key**：不需要。AI 可以帮忙启动，日常观看直接在页面操作。
- **快捷操作**：点击画面可播放/暂停；点击播放器后，空格播放/暂停，左右方向键各跳 5 秒，`M` 静音，`F` 全屏。

当前为早期预览，比赛名单可能有延迟或遗漏。工具隐藏的是界面提示，视频画面和解说仍可能透露比赛结果。

## 反馈与参与

欢迎 [反馈问题](https://github.com/cooleryu/spoiler-free-replays/issues/new)、提交改进，或把项目分享给同样想避开剧透的人。反馈比赛问题时，标题请不要写比分或胜负。

[贡献指南](CONTRIBUTING.md) · [开发与维护说明](docs/IMPLEMENTATION.md) · [预览版本](https://github.com/cooleryu/spoiler-free-replays/releases)

本项目开源、免费，不盈利。原创代码采用 [MIT 许可证](LICENSE)，第三方说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。
