const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv } = require('node:crypto');
const path = require('node:path');
global.chrome = { i18n: { getMessage: (key, args) => `${key}${args ? `:${args}` : ''}` } };
const load = (name) => require(path.join(process.env.TEST_BUILD_DIR, 'src/downloader', `${name}.js`));
const { parseHlsPlaylist, probeHls } = load('hls-playlist');
const { encryptionIv, parseHlsSequence, resolveKeyUri } = load('hls-encryption');
const { HlsKeyManager } = load('hls-key-manager');
const { decryptHlsSegment } = load('hls-decryptor');
const { fetchHlsBytes, retryHls } = load('hls-http');
const { writeHlsSegment } = load('hls-segment-writer');
const origin = 'https://media.example.test/live/index.m3u8?pkey=PRIVATE';
const encryption = (extra = {}) => ({ method: 'AES-128', keyFormat: 'identity', uri: 'https://media.example.test/key.bin', epoch: '1', ...extra });
const keyBytes = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const ts = Buffer.alloc(188 * 3, 0x55);
for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
function encrypt(plain, key = keyBytes, iv = encryptionIv(encryption(), 1001)) {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
function playlist(lines) { return parseHlsPlaylist(`#EXTM3U\n${lines}`, origin); }
function memoryFile(initial = Buffer.alloc(0), fail = '') {
  let data = Buffer.from(initial);
  const events = [];
  return {
    events, bytes: () => data, getFile: async () => new File([data], 'working.ts'),
    createWritable: async ({ keepExistingData } = {}) => {
      events.push('open');
      let pending = keepExistingData ? Buffer.from(data) : Buffer.alloc(0);
      let cursor = 0;
      return {
        seek: async (value) => { cursor = value; },
        truncate: async (size) => { pending = pending.subarray(0, size); },
        write: async (bytes) => {
          if (fail === 'write') throw new Error('disk full');
          const next = Buffer.alloc(Math.max(pending.length, cursor + bytes.byteLength));
          pending.copy(next); Buffer.from(bytes).copy(next, cursor); pending = next; cursor += bytes.byteLength;
        },
        close: async () => { if (fail === 'close') throw new Error('close failed'); data = pending; events.push('close'); },
        abort: async () => { events.push('abort'); }
      };
    }
  };
}
const emptyState = () => ({ bytesWritten: 0, segmentsWritten: 0, lastMapKey: null });
const segment = (extra = {}) => ({ sequence: 1001, url: 'https://media.example.test/1001.ts', duration: 6, discontinuity: false, encryption: encryption(), ...extra });

test('snapshots keys, IV, rotation and METHOD=NONE per segment', () => {
  const media = playlist('#EXT-X-MEDIA-SEQUENCE:1001\n#EXT-X-KEY:METHOD=AES-128,URI="key-a.bin",IV=0x1\n#EXTINF:6,\na.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key-b.bin"\n#EXTINF:6,\nb.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\nc.ts\n#EXT-X-ENDLIST');
  assert.equal(media.segments[0].encryption.iv, '0x1');
  assert.equal(media.segments[1].encryption.iv, undefined);
  assert.match(media.segments[0].encryption.uri, /key-a.bin$/);
  assert.match(media.segments[1].encryption.uri, /key-b.bin$/);
  assert.equal(media.segments[2].encryption, undefined);
  assert.equal(media.encryptionError, undefined);
  assert.equal(media.segments[1].sequence, 1002);
});
test('media retains its same-origin adapter, but keys do not inherit signing queries', () => {
  const media = playlist('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\na.ts');
  assert.match(media.segments[0].url, /pkey=PRIVATE/);
  assert.equal(media.segments[0].encryption.uri, 'https://media.example.test/live/key.bin');
});
test('foreign key retains explicit query only; unsafe key URI schemes are rejected', () => {
  assert.equal(resolveKeyUri('https://keys.example.test/k?token=own', origin), 'https://keys.example.test/k?token=own');
  for (const uri of ['', 'http://keys.example.test/k', 'file:///key', 'data:abc', 'https://user:pass@keys.example.test/k']) {
    assert.throws(() => resolveKeyUri(uri, origin), /errorHlsKeyUri/);
  }
});
test('nonzero sequence uses a 16-byte big-endian IV; explicit IV overrides it', () => {
  assert.equal(Buffer.from(encryptionIv(encryption(), 1001)).toString('hex'), '000000000000000000000000000003e9');
  assert.equal(Buffer.from(encryptionIv(encryption({ iv: '0xabc' }), 1)).toString('hex'), '00000000000000000000000000000abc');
});
test('unsafe and malformed sequences fail rather than round', () => {
  for (const value of ['9007199254740992', '-1', '1.5', 'nope']) assert.throws(() => parseHlsSequence(value), /errorHlsSequence/);
  assert.throws(() => playlist('#EXT-X-MEDIA-SEQUENCE:9007199254740991\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts'), /errorHlsSequence/);
});
test('invalid and oversized IVs fail', () => {
  for (const iv of ['', '0011', '0x', `0x${'a'.repeat(33)}`, '0xZZ']) assert.throws(() => encryptionIv(encryption({ iv }), 1), /errorHlsIv/);
});
test('malformed key declarations and byte ranges fail', () => {
  assert.throws(() => playlist('#EXT-X-KEY:URI="k"'), /errorHlsKeyTag/);
  assert.throws(() => playlist('#EXT-X-KEY:METHOD=NONE,URI="k"'), /errorHlsKeyTag/);
  assert.throws(() => playlist('#EXT-X-BYTERANGE:oops\n#EXTINF:6,\na.ts'), /errorHlsByteRange/);
  assert.equal(playlist('#EXT-X-KEY:METHOD=AES-128\n#EXTINF:6,\na.ts').encryptionError, 'errorHlsKeyUri');
});
test('SAMPLE-AES and non-identity formats remain unsupported', () => {
  assert.equal(playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:6,\na.ts').encryptionError, 'errorHlsEncryptionMethod');
  assert.equal(playlist('#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://x"\n#EXTINF:6,\na.ts').encryptionError, 'errorHlsKeyFormat');
});
test('does not erase simultaneous non-identity declarations', () => {
  const media = playlist('#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="example.drm",URI="x"\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts');
  assert.equal(media.encryptionError, 'errorHlsKeyFormat');
});
test('encrypted byte range and encrypted init map are rejected', () => {
  assert.equal(playlist('#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-BYTERANGE:32@0\n#EXTINF:6,\na.ts').encryptionError, 'errorHlsEncryptedByteRange');
  const media = playlist('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.m4s');
  assert.equal(media.segments[0].map.encryption.iv, '0x1');
  assert.equal(media.encryptionError, 'errorHlsEncryptedFmp4');
});
test('master selection and unencrypted playback remain supported', async () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nhigh.m3u8';
  const probe = await probeHls(origin, async (uri) => uri === origin ? master : '#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST');
  assert.match(probe.mediaUrl, /high.m3u8/); assert.equal(probe.isLive, false); assert.equal(probe.media.encrypted, false);
});
test('AES output exactly matches TS; key is non-extractable and padding is removed once', async () => {
  const keys = new HlsKeyManager({ fetcher: async () => new Response(Buffer.from(keyBytes)) });
  const key = await keys.get(encryption());
  assert.equal(key.extractable, false);
  assert.deepEqual(Buffer.from(await decryptHlsSegment(encrypt(ts), encryption(), 1001, key)), ts);
  keys.dispose();
});
test('wrong key, corrupted framing, invalid length and wrong IV fail', async () => {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
  await assert.rejects(decryptHlsSegment(new Uint8Array(3), encryption(), 1001, key), /errorHlsCiphertext/);
  await assert.rejects(decryptHlsSegment(encrypt(ts), encryption({ iv: '0xff000000000000000000000000000001' }), 1001, key), /errorHlsDecryptedMedia/);
  await assert.rejects(decryptHlsSegment(encrypt(Buffer.from('Not TS')), encryption(), 1001, key), /errorHlsDecryptedMedia/);
  const wrong = await crypto.subtle.importKey('raw', Buffer.alloc(16, 5), 'AES-CBC', false, ['decrypt']);
  await assert.rejects(decryptHlsSegment(encrypt(ts), encryption(), 1001, wrong), /errorHlsDecryptFailed/);
});
test('deduplicates key requests, separates rotation and clears each playlist', async () => {
  let count = 0;
  const keys = new HlsKeyManager({ fetcher: async () => { count++; return new Response(Buffer.from(keyBytes)); } });
  await Promise.all([keys.get(encryption()), keys.get(encryption())]); assert.equal(count, 1);
  await keys.get(encryption({ epoch: '2' })); assert.equal(count, 2);
  keys.beginPlaylist(); await keys.get(encryption()); assert.equal(count, 3);
  keys.dispose(); await assert.rejects(keys.get(encryption()), /closed/);
});
test('401/403 key errors stop without retry or signed-URI disclosure', async () => {
  for (const status of [401, 403]) {
    let count = 0;
    const keys = new HlsKeyManager({ fetcher: async () => { count++; return new Response('no', { status }); } });
    await assert.rejects(keys.get(encryption({ uri: 'https://keys.example.test/k?SECRET=private' })), (error) => {
      assert.match(error.message, /errorHlsKeyAccess/); assert.ok(!error.message.includes('SECRET')); return true;
    });
    assert.equal(count, 1);
  }
});
test('key length must be 16; failed cache entries may be retried', async () => {
  let count = 0;
  const keys = new HlsKeyManager({ fetcher: async () => new Response(++count === 1 ? 'login page' : Buffer.from(keyBytes)) });
  await assert.rejects(keys.get(encryption()), /errorHlsKeyLength/);
  await keys.get(encryption()); assert.equal(count, 2);
  const long = new HlsKeyManager({ fetcher: async () => new Response(Buffer.alloc(17)) });
  await assert.rejects(long.get(encryption()), /errorHlsKeyLength/);
});
test('key requests disable redirects and restore request context on errors', async () => {
  const events = [];
  const keys = new HlsKeyManager({
    beforeRequest: async () => { events.push('suspend'); }, afterRequest: async () => { events.push('restore'); },
    fetcher: async (_url, init) => {
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'include');
      assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal([...init.headers].length, 0);
      return new Response('no', { status: 403 });
    }
  });
  await assert.rejects(keys.get(encryption()), /errorHlsKeyAccess/);
  assert.deepEqual(events, ['suspend', 'restore']);
});
test('bounded reads reject oversized responses without Content-Length', async () => {
  await assert.rejects(fetchHlsBytes(origin, { maxBytes: 3, fetcher: async () => new Response(new Uint8Array(4)) }), /errorHlsResourceSize/);
});
test('already canceled requests never start', async () => {
  const controller = new AbortController(); controller.abort(); let count = 0;
  await assert.rejects(fetchHlsBytes(origin, { signal: controller.signal, maxBytes: 10, fetcher: async () => { count++; return new Response(''); } }), { name: 'AbortError' });
  assert.equal(count, 0);
});
test('disk contains plaintext before checkpoint is updated', async () => {
  const file = memoryFile(); const keys = new HlsKeyManager({ fetcher: async () => new Response(Buffer.from(keyBytes)) });
  const next = await writeHlsSegment({ segment: segment(), state: emptyState(), file, keys,
    fetchBytes: async () => encrypt(ts), checkpoint: async () => { assert.deepEqual(file.bytes(), ts); file.events.push('checkpoint'); } });
  assert.equal(next.lastSequence, 1001); assert.equal(next.bytesWritten, ts.length);
  assert.deepEqual(file.events, ['open', 'close', 'checkpoint']);
});
test('disk and decryption failures do not advance the checkpoint', async () => {
  const keys = new HlsKeyManager({ fetcher: async () => new Response(Buffer.from(keyBytes)) });
  for (const fail of ['write', 'close', 'decrypt']) {
    const file = memoryFile(Buffer.from('OLD'), fail); let checkpoints = 0;
    await assert.rejects(writeHlsSegment({ segment: segment(), state: emptyState(), file, keys,
      fetchBytes: async () => fail === 'decrypt' ? new Uint8Array(3) : encrypt(ts), checkpoint: async () => { checkpoints++; } }));
    assert.equal(checkpoints, 0); assert.equal(file.bytes().toString(), 'OLD');
  }
});
test('resume truncates an uncheckpointed tail before appending', async () => {
  const file = memoryFile(Buffer.concat([ts, Buffer.alloc(ts.length * 2, 9)]));
  const keys = new HlsKeyManager({ fetcher: async () => new Response(Buffer.from(keyBytes)) });
  const next = await writeHlsSegment({ segment: segment({ sequence: 1002 }),
    state: { bytesWritten: ts.length, segmentsWritten: 1, lastSequence: 1001, lastMapKey: null }, file, keys,
    fetchBytes: async () => encrypt(ts, keyBytes, encryptionIv(encryption(), 1002)), checkpoint: async () => {} });
  assert.equal(next.bytesWritten, ts.length * 2); assert.deepEqual(file.bytes(), Buffer.concat([ts, ts]));
});
test('gaps and discontinuities fail before writes', async () => {
  const file = memoryFile(ts); const keys = new HlsKeyManager();
  for (const extra of [{ sequence: 1003 }, { sequence: 1002, discontinuity: true }]) {
    await assert.rejects(writeHlsSegment({ segment: segment(extra), file, keys,
      state: { bytesWritten: ts.length, segmentsWritten: 1, lastSequence: 1001, lastMapKey: null },
      fetchBytes: async () => { throw new Error('must not fetch'); }, checkpoint: async () => {} }), /errorHls(SegmentGap|Discontinuity)/);
  }
  assert.deepEqual(file.events, []);
});
test('failed database commit does not mutate in-memory state', async () => {
  const state = emptyState(); const file = memoryFile();
  const keys = new HlsKeyManager({ fetcher: async () => new Response(Buffer.from(keyBytes)) });
  await assert.rejects(writeHlsSegment({ segment: segment(), state, file, keys,
    fetchBytes: async () => encrypt(ts), checkpoint: async () => { throw new Error('DB failure'); } }), /DB failure/);
  assert.equal(state.bytesWritten, 0); assert.equal(state.lastSequence, undefined);
});
test('range responses must match the requested offset, length and status', async () => {
  const options = { maxBytes: 10, range: { offset: 2, length: 4 } };
  await assert.rejects(fetchHlsBytes(origin, { ...options, fetcher: async () => new Response('1234') }), /errorHlsByteRange/);
  assert.equal((await fetchHlsBytes(origin, { ...options, fetcher: async () => new Response('1234', { status: 206, headers: { 'content-range': 'bytes 2-5/10' } }) })).length, 4);
});
test('timeouts redact fetch errors and transient HTTP failures have a bounded retry', async () => {
  await assert.rejects(fetchHlsBytes(origin, { maxBytes: 10, timeoutMs: 5,
    fetcher: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })) }), /errorHlsRequestTimeout/);
  let count = 0;
  await retryHls(() => fetchHlsBytes(origin, { maxBytes: 10, fetcher: async () => ++count < 2 ? new Response('', { status: 503 }) : new Response('ok') }));
  assert.equal(count, 2);
});
