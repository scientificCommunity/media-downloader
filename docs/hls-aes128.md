# HLS AES-128 support

Introduced in source version **0.6.2**. This is standards-based handling of normally accessible keys, not key extraction or DRM bypass. A source change is not automatically a published GitHub Release.

## Supported profile

- Complete MPEG-TS segments, both VOD and live playlists.
- `EXT-X-KEY:METHOD=AES-128`, with `KEYFORMAT="identity"` or no KEYFORMAT.
- A directly retrievable 16-byte binary key, obtained with normal browser credentials and existing site authorization.
- Explicit hexadecimal IVs and implicit IVs derived from the original media sequence.
- Key rotation and transitions between AES-128 and `METHOD=NONE`.
- Stop/save and recovery from committed segments, provided the same source URL, selected format, file permissions and required segments remain available.

Use the HLS entry in the popup, then the Download Manager. Supported playlists show **Encryption: AES-128** and enable **Download & merge MP4** (VOD) or **Start recording** (live). Choose a folder for TS recordings. Keep the manager page open. Capture writes a temporary `.partial.ts`; MP4 finalization happens after the last segment or Stop & save. The temporary file is removed only after successful finalization and a completed checkpoint. The final filename includes a random suffix to reduce collisions.

## Boundaries

This first profile deliberately rejects SAMPLE-AES, non-identity/DRM key formats, custom encryption, encrypted byte ranges and encrypted fMP4/initialization maps. Multiple simultaneous key formats are treated conservatively: an unsupported format is reported instead of silently ignored. This is an implementation boundary, not a claim that every SAMPLE-AES stream is DRM.

Separate HLS audio renditions remain unsupported. LL-HLS partial segments are not downloaded independently. A detected discontinuity, changed initialization map or a missing sequence stops capture instead of silently joining an invalid timeline. Already committed TS data remains available. Recovery cannot reconstruct segments that left a live window. Source URLs with renewed signatures are not automatically matched to old tasks.

Sequence values outside JavaScript's safe integer range are rejected before an implicit IV can be calculated; this release does not claim complete unsigned-64-bit sequence support.

## Processing and data handling

```
playlist -> per-segment key/IV snapshot
         -> normally authorized key -> non-extractable CryptoKey
         -> complete ciphertext segment -> Web Crypto AES-CBC
         -> MPEG-TS framing check -> transactional disk append
         -> IndexedDB transaction complete -> next segment
         -> existing Mediabunny MP4 finalization
```

Web Crypto validates/removes PKCS#7 padding. The TS sync-byte check is a framing sanity check, not cryptographic authentication: AES-CBC does not authenticate the plaintext, and a wrong IV is not guaranteed to be detectable by this check.

Raw key bytes are never put in logs or IndexedDB, and the temporary import buffer is zeroed after import. Non-extractable key references are held in a task-local bounded cache, reset for each playlist snapshot and released at completion/cancellation. The code does not promise immediate memory erasure by the JavaScript engine.

Key URIs are resolved relative to the playlist without copying playlist query parameters. Key requests reject redirects, embedded URL credentials and HTTPS-to-HTTP downgrades. The task's temporary media Referer rule is suspended during key retrieval and restored afterward. No Cookie headers are read or injected. Normal credential inclusion does not guarantee access on every site: browser cookie restrictions and origin authorization still apply.

HTTP 401/403 key responses stop without repeated retries. Transient failures receive bounded retries. HLS errors omit signed URLs; the manager masks URL queries. Source URLs may still be stored locally for recovery, so never attach an unredacted storage dump to an issue.

Reads are capped at 16 bytes per key, 4 MiB per playlist and 64 MiB per segment. Processing is sequential and retains complete individual segments, not an entire recording; temporary copies mean peak memory can be several times a segment's size. Closing each append favors recoverability and can be expensive on large files/filesystems. This is not a promise of constant-speed multi-hour capture on every device.

## Verification

```
npm install
npm run build       # four-language validation, unit tests, TypeScript, Vite, locale bundling
npm run test:media  # requires ffmpeg and ffprobe in PATH
```

The generated-media integration tests create their own H.264/AAC test pattern, encrypt segments with fixture keys, and run the recorder and real Mediabunny conversion. They check video/audio streams, duration and decoding with ffprobe/ffmpeg. VOD, a failed-download resume and live stop/save are covered. Network responses, IndexedDB, Chrome DNR and the file picker are mocked. These tests do not replace real Chrome/CDN permission and user-gesture testing.

For a browser smoke test, use a stream you own or are authorized to save. Test both explicit and implicit IVs, mixed clear/encrypted segments, a denied key response, stop/save, and recovery. Check picture, audio, seek behavior, duration and retained temporary files on failure. Do not post actual keys, cookies or full signed URLs.

## Implementation map

- `hls-playlist.ts`: encryption snapshots, key rotation and profile detection.
- `hls-encryption.ts`: metadata, IV construction and supported-profile checks.
- `hls-key-manager.ts`: bounded task-local key cache and normal key retrieval.
- `hls-http.ts`: bounded reads, timeout, range validation, retry classification.
- `hls-decryptor.ts`: native AES-CBC and TS framing check.
- `hls-segment-writer.ts`: validate/decrypt before disk write, checkpoint after close.
- `live-task-store.ts`: await transaction completion for durable checkpoints.
- `hls-recorder.ts`: shared VOD/live pipeline and existing MP4 finalization.
- `locales/hls-encryption.json`: four-language additions, merged into native `_locales` by the production build.

References: [RFC 8216 sections 4.3.2.4 and 5](https://www.rfc-editor.org/rfc/rfc8216.html), [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/).

---

## 中文说明

源码 0.6.2 新增标准 **HLS AES-128 TS 分片**处理：正常获取有权访问的密钥，在浏览器本地解密，再复用 MP4 合并。支持点播、直播、显式 IV、按原始媒体序号生成的 IV、密钥轮换和 `METHOD=NONE` 切换。

操作：播放页面 → 插件选择 HLS → 查看“加密方式：AES-128” → 点播选择“下载并合并 MP4”，直播选择“开始录制” → 选择文件夹 → 保持管理器打开。停止后完成 MP4，成功后清理临时 TS。

当前不支持 SAMPLE-AES、DRM/非 identity 密钥、加密 fMP4/初始化段、加密 Byte Range、独立音频 HLS。密钥接口 401/403、直播分片缺失、时间轴或初始化段变化会明确报错，不会伪装成下载成功。无法补回已过期的直播分片。

密钥不写入日志或断点库；不复制密钥地址的父级签名参数，不跟随密钥重定向，不读取或注入 Cookie。密钥访问仍受来源网站和浏览器规则约束。能正常观看不代表拥有下载授权。

运行 `npm run build` 验证翻译、单元测试和编译；安装 FFmpeg 后运行 `npm run test:media` 验证自行生成的带音视频测试素材。集成测试使用真实加密和 MP4 处理，但模拟网络、磁盘选择器、DNR、IndexedDB，仍需在 Chrome 中进行实际站点测试。
