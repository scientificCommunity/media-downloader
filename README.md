<div align="center">
  <img src="public/icons/icon128.png" width="112" height="112" alt="Media Downloader icon" />

# Media Downloader

**Open-source Chrome extension for detecting and saving web media you are authorized to access and save.**

[![CI](https://github.com/scientificCommunity/media-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/scientificCommunity/media-downloader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)

Direct media downloads · Local MP4 muxing · HLS recording · Standard AES-128 TS support

**[Releases](https://github.com/scientificCommunity/media-downloader/releases) · [AES-128 guide](docs/hls-aes128.md) · [中文说明](#中文说明)**
</div>

---

## Highlights

- Detect direct video/audio files, HLS manifests, DASH/MSE `.m4s` tracks and HTTP Range responses.
- Pair supported separate video/audio tracks and mux one MP4 locally with [Mediabunny](https://github.com/Vanilagy/mediabunny).
- Download supported HLS VOD and record live HLS with quality selection, retries and incremental disk writes.
- **New in source 0.6.2:** locally decrypt complete **HLS AES-128 MPEG-TS** segments using normally accessible, authorized keys. Supports key rotation, explicit/implicit IVs and clear/encrypted transitions.
- Retain committed recording data and recover unfinished tasks when the source, remaining segments, saved file and permissions are still available.
- Remux TS recordings into MP4 after completion or stop/save.
- English, Simplified Chinese, Traditional Chinese and Japanese UI, using native Chrome i18n.
- No project backend is required for media downloading, decryption or muxing.

## Current support

| Media / capability | Status | Scope |
| --- | --- | --- |
| Direct MP4/WebM/audio | Supported | Detection and direct download |
| MSE / fMP4 / HTTP Range | Supported | Track discovery and local pairing |
| Separate video + audio to MP4 | Supported | Compatible tracks and accessible resources |
| HLS manifests | Supported | Master and media playlists |
| HLS VOD / live | Supported | Supported TS and unencrypted fMP4 layouts |
| HLS AES-128 | Supported, limited profile | Complete TS segments; identity keys; normal authorization |
| HLS quality selection | Supported | Master-playlist variants |
| HLS recovery | Supported, conditional | Local checkpoints; still-available segments and matching source |
| TS to MP4 | Supported | Local finalization with compatible codecs |
| DASH live / generic MSE live | In development | Not a completed recording feature |
| Encrypted fMP4 / encrypted byte ranges | Not yet supported | Explicit error instead of writing ciphertext |
| SAMPLE-AES / custom encryption | Not supported | Different processing profiles |
| DRM / access-control bypass | Not supported | Outside project scope |

Detection does not guarantee downloadability, codec compatibility or permission to save. A standard AES-128 stream is not automatically DRM; this project also does not make protected playback systems downloadable.

## Install a prebuilt release

Download the **`media-downloader-vX.Y.Z.zip` asset** from [Releases](https://github.com/scientificCommunity/media-downloader/releases), not GitHub's automatically generated **Source code** archive. Extract it, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`. Pin the extension to the toolbar.

Prebuilt packages require no Node.js or npm. Check the release version: the newest source code is not necessarily published as a release yet. Unpacked installations do not receive Chrome Web Store automatic updates; rebuild or install a newer package manually.

## Install from source

Use desktop Chrome/Chromium 120+ with File System Access available. Build with Node.js 22+ and npm:

```bash
git clone https://github.com/scientificCommunity/media-downloader.git
cd media-downloader
npm install
npm run build
```

Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select `dist/`.
After updating and rebuilding, click **Reload** on the existing extension card. Do not reload the extension or close the Download Manager during an active capture unless you intend to interrupt it.

## Usage

### Direct files and separate tracks

Play the source media for a few seconds, open the extension and click **Download**. A direct file uses Chrome's download flow. For supported separate video/audio tracks, the Download Manager selects a pair; click **Download & merge MP4** and choose the output file.

### HLS VOD and live streams

Select an HLS entry and choose a quality when variants are available. For VOD, click **Download & merge MP4**. For live streams, click **Start recording**, keep the manager page open and use **Stop & save** when finished.

TS captures use a selected folder and a temporary `.partial.ts`. Finalization produces MP4; the TS is removed only after successful completion. A failed task retains committed media. Refresh/recovery is conditional, not a guarantee that a closed tab continues recording.

### AES-128 HLS

Supported playlists display **Encryption: AES-128**. The extension retrieves the declared 16-byte key using normal browser authorization, decrypts each complete TS segment locally, and writes plaintext only after a framing check. Explicit IVs, sequence-derived IVs, key rotation and `METHOD=NONE` are supported.

Key responses that deny access are not bypassed. Raw keys are not stored in IndexedDB or logs. See the [implementation, error handling and testing guide](docs/hls-aes128.md) for the exact profile and limitations.

## How it works

```text
Page DOM + observed network responses
  -> per-tab media candidate registry
     -> direct file -> Chrome download
     -> video + audio -> local MP4 mux
     -> HLS playlist -> segment scheduler
        -> optional authorized AES-128 TS decryption
        -> disk commit -> recovery checkpoint
        -> local MP4 finalization
```

## Development and tests

```bash
npm install
npm run build          # locales + unit tests + TypeScript + Vite + native locale bundling
npm test               # parser, IV, keys, network limits, decryption and checkpoint tests
npm run test:media     # generated H.264/AAC -> AES -> recorder -> MP4; requires ffmpeg/ffprobe
npm run typecheck
npm run validate:i18n
npm run dev            # UI development server, not an installed extension
```

CI runs the build and generated-media integration tests. Integration tests use real AES operations and Mediabunny, but mock browser APIs/network/file selection. They verify MP4 audio/video streams, duration and decodeability; they do not claim live-site end-to-end compatibility.

New HLS messages live in `locales/hls-encryption.json`. The build validates all four translations and merges them into `dist/_locales/*/messages.json`. Runtime translation remains `chrome.i18n`; do not skip the final locale-bundling build step.

```text
media-downloader/
├── .github/workflows/       # CI and release packaging
├── public/                 # manifest, native base locales, icons
├── locales/                # four-language HLS additions
├── scripts/                # tests and locale validation/bundling
├── tests/                  # unit and generated-media pipeline tests
├── docs/hls-aes128.md
├── src/
│   ├── background/         # request observation and candidate registry
│   ├── detector/           # media / track classification
│   ├── download-manager/   # download and recording UI
│   ├── downloader/         # HLS, AES, checkpoints, local mux, DASH foundation
│   ├── popup/
│   └── shared/
├── download.html
├── popup.html
├── package.json
└── vite.config.ts
```

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `activeTab` | Inspect the active page |
| `scripting` | Scan video/audio/source elements |
| `webRequest` | Observe media and response metadata |
| `downloads` | Save direct files through Chrome |
| `storage` | Store candidates and extension state |
| `declarativeNetRequestWithHostAccess` | Temporary, scoped source-page request context for media |
| HTTP/HTTPS host access | Detect/fetch page and CDN media resources |

Media and recovery metadata are processed locally. Downloads still make network requests to the originating website/CDN. This repository contains no analytics/ad SDK or project download-proxy backend. AES raw keys are imported as non-extractable task-local keys; temporary raw buffers are zeroed and references released, without claiming guaranteed immediate JavaScript memory erasure.

Key requests do not inherit playlist signing queries, reject redirects/HTTPS downgrades, and suspend the task's media Referer rule. Authentication remains subject to origin and browser restrictions. Signed source URLs may exist in local recovery metadata; redact tokens, cookies and key bytes before filing issues.

## Limitations and responsible use

Use only media you are **authorized to access and save**. No DRM circumvention, paywall/authentication bypass or extraction from protected playback systems is implemented.

The AES profile excludes SAMPLE-AES, custom/non-identity key formats, encrypted fMP4/init maps and encrypted byte ranges. Separate HLS audio renditions remain unsupported. LL-HLS waits for full segments. Sequence values outside the safe integer range are rejected instead of generating an incorrect IV.

Capture stops explicitly on missing segments, timeline discontinuities or initialization-map changes. Recovery requires the same source URL and available segments; it cannot reconstruct an expired live window. Closing the manager interrupts active recording. Complete individual segments are held in memory with read limits; multi-hour performance depends on the filesystem and device.

## Roadmap

- [x] Direct media / MSE / Range discovery and download
- [x] Video/audio pairing and local MP4 mux
- [x] HLS VOD/live, quality selection, checkpoints and TS finalization
- [x] Standard AES-128 TS processing with key rotation
- [x] Automated parser/decryptor/recorder tests
- [x] Prebuilt GitHub release packaging
- [ ] Encrypted fMP4 / initialization-map support
- [ ] Independent HLS audio renditions
- [ ] DASH live and generic MSE live recording
- [ ] Improved representation selection and long-recording performance

## Contributing

Focused issues and pull requests are welcome. Explain the delivery pattern and reproduction steps, run `npm run build`, and run `npm run test:media` when changing the recording pipeline. Keep all four locales in sync. Do not submit real keys, cookies or unredacted signed URLs. Do not add DRM/access-control circumvention.

## License

[MIT](LICENSE).

---

## 中文说明

Media Downloader 是开源 Chrome 网页媒体检测与下载插件，面向**用户有权访问和保存的内容**。支持直链、MSE/Range 轨道检测、音视频本地合并、HLS 点播下载和直播录制、清晰度选择、条件性断点恢复，以及英/简中/繁中/日语界面。

**源码 0.6.2 新增标准 HLS AES-128 TS 分片处理**：使用正常授权取得的密钥，在浏览器本地逐分片解密，支持密钥轮换、显式 IV、原始媒体序号生成 IV、加密和未加密切换，再生成 MP4。不支持 DRM、SAMPLE-AES、加密 fMP4、加密字节范围或独立音频 HLS。

### 安装

普通用户在 [Releases](https://github.com/scientificCommunity/media-downloader/releases) 下载预构建 `media-downloader-vX.Y.Z.zip`（不要下载 Source code），解压后打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择包含 `manifest.json` 的目录。不需要 npm。请核对 Release 版本，源码更新不代表已经发布新版安装包。

从源码安装：

```bash
git clone https://github.com/scientificCommunity/media-downloader.git
cd media-downloader
npm install
npm run build
```

在 Chrome 中加载 `dist/`。后续 `git pull`、重新构建，再点击扩展卡片上的“重新加载”。

### AES 视频怎么用

播放页面 → 插件中选 HLS → 查看“加密方式：AES-128” → 点播点“下载并合并 MP4”，直播点“开始录制” → 选择文件夹 → 保持管理器打开。停止后完成 MP4，成功后清理临时 TS。

密钥拒绝访问、分片丢失、格式变化会明确报错，不会显示成下载成功；已过期的直播分片无法补回。原始密钥不写入日志或断点库，不提供付费墙、登录限制或 DRM 绕过。

更多说明和测试步骤见 [HLS AES-128 指南](docs/hls-aes128.md)。
