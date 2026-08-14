<div align="center">
  <img src="public/icons/icon128.png" width="112" height="112" alt="Media Downloader icon" />

# Media Downloader

**Open-source Chrome extension for detecting and saving user-accessible, non-DRM web media.**

[![CI](https://github.com/scientificCommunity/media-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/scientificCommunity/media-downloader/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)

Detect direct media, HLS manifests, DASH/MSE tracks and HTTP Range media requests, then save or locally mux supported streams without routing media bytes through a project server.

**[中文说明](#中文说明)**
</div>

---

## Highlights

- **Direct media downloads** — detects common video/audio URLs exposed by the page or network layer.
- **MSE / fMP4 track detection** — discovers `.m4s`, CMAF/fMP4 and Range-based video/audio resources used by modern players.
- **Local video + audio muxing** — pairs separate video/audio tracks and writes a single MP4 locally with [Mediabunny](https://github.com/Vanilagy/mediabunny).
- **HLS live recording** — records supported unencrypted live playlists with segment deduplication, retries and incremental disk writes.
- **Quality selection** — exposes HLS master-playlist variants when multiple renditions are available.
- **Crash/refresh recovery** — live-recording checkpoints are stored in IndexedDB and can resume from the last committed segment.
- **MPEG-TS → MP4 finalization** — TS-based HLS recordings are remuxed to MP4 locally after recording stops.
- **Internationalized UI** — English, Simplified Chinese, Traditional Chinese and Japanese.
- **Manifest V3** — built for modern Chromium-based browsers.

## Current support

| Media type / capability | Status | Notes |
| --- | --- | --- |
| Direct MP4/WebM/audio files | ✅ | Detect and download directly |
| HTTP Range media | ✅ | Detects ranged media responses |
| MSE / fMP4 `.m4s` tracks | ✅ | Video/audio detection and local pairing |
| Separate video + audio → MP4 | ✅ | Local mux, bounded-memory streaming output |
| HLS manifest detection | ✅ | Master and media playlists |
| HLS live recording | ✅ | Unencrypted supported layouts |
| HLS quality selection | ✅ | Selects master-playlist variants |
| HLS recording resume | ✅ | IndexedDB + File System Access handles |
| MPEG-TS HLS → MP4 | ✅ | Local remux after stop/end |
| DASH manifest parsing | 🚧 | Dynamic MPD parsing foundation exists |
| DASH live recording | 🚧 | Planned / under development |
| MSE live recording | 🚧 | Planned / under development |
| DRM / access-control bypass | ❌ | Intentionally unsupported |

> Support depends on how each website delivers media. A detected resource is not necessarily downloadable or muxable, and protected media is intentionally outside the scope of this project.

## How it works

```text
Web page
  │
  ├─ DOM scan: <video>, <audio>, <source>
  │
  └─ Network observation: manifests, media responses, Range/fMP4 segments
          │
          ▼
   Media candidate registry
          │
          ├─ Direct file ───────────────► Chrome download
          │
          ├─ Video + audio tracks ──────► Local MP4 mux
          │
          └─ Supported HLS live stream ─► Segment recorder
                                           │
                                           ├─ fMP4 ─► MP4
                                           └─ TS ───► temporary TS ─► MP4 remux
```

The extension keeps media transfer and processing in the browser. The open-source project does not require a backend service for downloading or muxing media.

## Install from source

### Requirements

- Chrome / Chromium **120+**
- Node.js **22+** recommended
- npm

### Build

```bash
git clone https://github.com/scientificCommunity/media-downloader.git
cd media-downloader
npm install
npm run build
```

The unpacked extension is generated in:

```text
dist/
```

### Load into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `dist/` directory.
5. Open a page containing user-accessible media and click the Media Downloader extension icon.

After rebuilding, return to `chrome://extensions` and click **Reload** on the extension card.

## Usage

### Direct files

When a regular downloadable media file is detected, click **Download** in the popup and Chrome will open the normal save flow.

### Separate video/audio tracks

Modern MSE/DASH-style players often request video and audio separately. When both tracks are detected:

1. Play the media for a few seconds so both tracks appear.
2. Open the extension popup.
3. Click **Download** on the relevant stream resource.
4. The Download Manager chooses the detected video/audio pair.
5. Click **Download & merge MP4**.
6. Choose a destination file.

Muxing is performed locally in the browser.

### HLS live recording

For a supported live HLS playlist:

1. Start playback on the page.
2. Open the extension and select the HLS resource.
3. Choose a quality when multiple variants are available.
4. Click **Start recording**.
5. Keep the Download Manager page open while actively recording.
6. Click **Stop & save** when finished.

For MPEG-TS streams, the extension first commits resumable TS data segment-by-segment and then remuxes it to MP4. If the manager page or browser is interrupted, an unfinished recording can be resumed when the same stream is opened again.

## Development

```bash
# Install dependencies
npm install

# Validate locale files + type-check + production build
npm run build

# TypeScript only
npm run typecheck

# Verify all locale key sets
npm run validate:i18n

# Vite development server
npm run dev
```

### Project structure

```text
media-downloader/
├── public/
│   ├── _locales/                 # Chrome i18n messages
│   ├── icons/                    # Extension icons
│   └── manifest.json             # Manifest V3
├── scripts/
│   └── validate-locales.mjs
├── src/
│   ├── background/
│   │   ├── media-registry.ts     # Per-tab media candidate registry
│   │   └── service-worker.ts     # Network media discovery
│   ├── detector/
│   │   └── classify.ts           # Media / track classification
│   ├── download-manager/
│   │   ├── main.tsx
│   │   └── manager.css
│   ├── downloader/
│   │   ├── hls-playlist.ts       # HLS parser
│   │   ├── hls-recorder.ts       # Resumable HLS live recorder
│   │   ├── track-muxer.ts        # Local video/audio mux
│   │   ├── playback-context.ts   # Temporary request context rules
│   │   ├── live-task-store.ts    # IndexedDB checkpoints
│   │   └── dash-*.ts             # DASH parsing foundation
│   ├── popup/
│   │   ├── main.tsx
│   │   └── popup.css
│   └── shared/
│       ├── i18n.ts
│       └── media.ts
├── download.html
├── popup.html
├── package.json
└── vite.config.ts
```

## Permissions

Media Downloader asks for broad web access because media resources are usually delivered from CDN domains that differ from the page domain.

| Permission | Why it is used |
| --- | --- |
| `activeTab` | Work with the page the user is actively inspecting |
| `scripting` | Scan the active page's `<video>`, `<audio>` and `<source>` elements |
| `webRequest` | Observe media/manifests and response metadata such as Range headers |
| `downloads` | Save directly downloadable files through Chrome |
| `storage` | Keep per-tab candidates and extension state |
| `declarativeNetRequestWithHostAccess` | Reproduce the source-page request context for supported media requests |
| `http://*/*`, `https://*/*` | Detect media hosted on page/CDN domains across the web |

The project should continue to minimize permissions where practical. Changes that add permissions should include a clear technical reason.

## Privacy

This repository contains no analytics SDK, advertising SDK or download proxy backend.

For the current open-source build:

- detected media URLs and temporary state are processed inside the browser;
- media bytes are requested from the media origin/CDN and written locally;
- media files are not uploaded to a server operated by this project;
- live-recording recovery metadata is stored locally in IndexedDB / extension storage.

Always review the source and the permissions yourself before installing any browser extension.

## Responsible use

Media Downloader is intended for media that **you are authorized to access and save**.

The project intentionally does **not** implement:

- DRM circumvention;
- paywall or authentication bypass;
- access-control bypass;
- extraction of protected/decrypted media from protected playback systems.

Website terms, copyright law and download permissions vary by service and jurisdiction. Users are responsible for ensuring that their use is permitted.

## Known limitations

- Encrypted HLS is not supported by the live recorder.
- HLS variants that require a separate audio rendition are not yet supported for live recording.
- LL-HLS partial segments (`EXT-X-PART`) are not recorded until complete segments become available.
- Active live recording currently depends on the Download Manager page remaining open; checkpoints allow later recovery, but recording does not continue invisibly after that page is closed.
- DASH live recording and generic MSE live recording are still under development.
- CDN URLs can expire; retry/re-probe logic helps in some cases but cannot make every origin compatible.

## Roadmap

- [x] Direct media discovery and download
- [x] MSE/fMP4 and Range media discovery
- [x] Video/audio track pairing
- [x] Streaming local MP4 mux
- [x] HLS live recorder
- [x] HLS quality selection
- [x] Resumable live-recording checkpoints
- [x] MPEG-TS → MP4 finalization
- [ ] Complete DASH live segment addressing and recorder
- [ ] Generic MSE live recording
- [ ] Improve automatic representation/track selection
- [ ] Add automated parser/recorder tests
- [ ] Add packaged releases

## Contributing

Issues and pull requests are welcome.

When contributing:

1. Keep changes focused and explain the media delivery pattern being handled.
2. Do not add DRM/access-control circumvention.
3. Run `npm run build` before opening a pull request.
4. Keep all four locale files in sync when adding UI strings.
5. Avoid platform-specific hacks when a protocol-level solution is possible.

## License

Released under the [MIT License](LICENSE).

---

## 中文说明

Media Downloader 是一个开源 Chrome 视频/媒体检测与下载扩展，主要面向**用户本身有权访问和保存的非 DRM 媒体**。

目前已经支持：

- 普通 MP4/WebM 等媒体直链检测与下载；
- MSE / fMP4 `.m4s` / HTTP Range 媒体轨道检测；
- 分离视频轨 + 音频轨在浏览器本地合并为 MP4；
- HLS 直播检测、清晰度选择和录制；
- HLS 录制断点恢复；
- MPEG-TS 直播录制结束后本地转换为 MP4；
- 英文、简体中文、繁体中文、日语界面。

本项目不提供 DRM、付费墙、登录权限或其他访问控制绕过能力。下载和媒体处理主要在浏览器本地完成，开源版本不依赖媒体代理后端。

### 本地安装

```bash
git clone https://github.com/scientificCommunity/media-downloader.git
cd media-downloader
npm install
npm run build
```

然后打开：

```text
chrome://extensions
```

开启 **开发者模式** → **加载已解压的扩展程序** → 选择：

```text
dist/
```

如果你发现某种公开、非 DRM 的媒体格式无法正确识别，欢迎提交 Issue，并尽量附上媒体类型、响应头和可复现方式。
