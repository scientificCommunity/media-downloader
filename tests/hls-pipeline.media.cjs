// Real generated H.264/AAC -> AES -> recorder -> Mediabunny MP4.
// Browser storage, file pickers and DNR are mocked; no third-party media is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const load = (name) => require(join(process.env.TEST_BUILD_DIR, 'src/downloader', `${name}.js`));
const tasks = new Map();
const rules = new Map();
const directory = mkdtempSync(join(tmpdir(), 'media-downloader-generated-'));
const sourceUrl = 'https://media.example.test/index.m3u8';
const keyA = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const keyB = Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex');
const explicitIv = Buffer.alloc(16); explicitIv[15] = 9;
let segments;
let ciphertext;

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${name} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
before(() => {
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-threads', '1', '-g', '25', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_filename', join(directory, 'plain-%03d.ts'),
    '-f', 'hls', join(directory, 'plain.m3u8')]);
  const names = readdirSync(directory).filter((name) => name.endsWith('.ts')).sort();
  assert.equal(names.length, 3);
  segments = names.map((name) => readFileSync(join(directory, name)));
  const encrypt = (bytes, key, iv) => { const cipher = createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([cipher.update(bytes), cipher.final()]); };
  const iv = Buffer.alloc(16); iv.writeUInt32BE(1001, 12);
  ciphertext = [encrypt(segments[0], keyA, iv), segments[1], encrypt(segments[2], keyB, explicitIv)];
});
after(() => rmSync(directory, { recursive: true, force: true }));

global.chrome = {
  i18n: { getMessage: (key, args) => `${key}${args ? `:${args}` : ''}`, getUILanguage: () => 'en' },
  tabs: { getCurrent: async () => ({ id: 7 }) },
  declarativeNetRequest: {
    ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' }, RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' }, HeaderOperation: { SET: 'set' },
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    }
  }
};
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
// Simulate request success before transaction completion, as real IndexedDB does.
global.indexedDB = { open: () => {
  const request = {};
  setImmediate(() => {
    request.result = { close() {}, transaction: () => {
      const transaction = {};
      const operation = (fn) => {
        const entry = {};
        setImmediate(() => {
          entry.result = fn(); entry.onsuccess?.();
          setImmediate(() => transaction.oncomplete?.());
        });
        return entry;
      };
      transaction.objectStore = () => ({
        put: (task) => operation(() => { tasks.set(task.id, { ...task }); return task.id; }),
        get: (id) => operation(() => tasks.get(id)), getAll: () => operation(() => [...tasks.values()]),
        delete: (id) => operation(() => tasks.delete(id))
      });
      return transaction;
    } };
    request.onsuccess?.();
  });
  return request;
} };

function memoryFile(name) {
  let data = Buffer.alloc(0);
  return {
    name, bytes: () => data, queryPermission: async () => 'granted', getFile: async () => new File([data], name),
    createWritable: async ({ keepExistingData } = {}) => {
      let pending = keepExistingData ? Buffer.from(data) : Buffer.alloc(0);
      let cursor = 0;
      const truncate = async (size) => { const next = Buffer.alloc(size); pending.copy(next); pending = next; };
      const write = async (chunk) => {
        if (chunk?.type === 'seek') { cursor = chunk.position; return; }
        if (chunk?.type === 'truncate') { await truncate(chunk.size); return; }
        if (chunk?.type === 'write') { if (chunk.position != null) cursor = chunk.position; chunk = chunk.data; }
        if (chunk instanceof Blob) chunk = new Uint8Array(await chunk.arrayBuffer());
        const bytes = Buffer.from(chunk);
        const next = Buffer.alloc(Math.max(pending.length, cursor + bytes.byteLength));
        pending.copy(next); bytes.copy(next, cursor); pending = next; cursor += bytes.byteLength;
      };
      const stream = new WritableStream({ write, close: () => { data = pending; }, abort: () => {} });
      stream.write = write; stream.seek = async (position) => { cursor = position; }; stream.truncate = truncate;
      return stream;
    }
  };
}
function setup({ live = false, failLast = false } = {}) {
  tasks.clear(); rules.clear();
  const files = new Map(); const keyRequests = [];
  const settings = { live, failLast };
  const manifest = () => '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1001\n'
    + '#EXT-X-KEY:METHOD=AES-128,URI="key-a.bin"\n#EXTINF:1,\n0.ts\n'
    + '#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\n1.ts\n'
    + '#EXT-X-KEY:METHOD=AES-128,URI="key-b.bin",IV=0x9\n#EXTINF:1,\n2.ts\n'
    + (settings.live ? '' : '#EXT-X-ENDLIST\n');
  global.fetch = async (url, init) => {
    if (init.signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    const pathname = new URL(url).pathname;
    if (pathname === '/index.m3u8') return new Response(manifest());
    if (pathname.startsWith('/key-')) {
      assert.equal(rules.size, 0, 'media header rules must be suspended for key requests');
      assert.equal(init.redirect, 'error'); keyRequests.push(pathname);
      return new Response(Buffer.from(pathname === '/key-a.bin' ? keyA : keyB));
    }
    const index = Number(pathname.slice(1, -3));
    if (index === 2 && settings.failLast) return new Response('denied', { status: 403 });
    assert.ok(Number.isInteger(index) && index >= 0 && index < 3);
    return new Response(Buffer.from(ciphertext[index]));
  };
  global.showDirectoryPicker = async () => ({
    queryPermission: async () => 'granted',
    getFileHandle: async (name, options) => {
      if (!files.has(name)) { assert.equal(options?.create, true); files.set(name, memoryFile(name)); }
      return files.get(name);
    },
    removeEntry: async (name) => { files.delete(name); }
  });
  const candidate = { id: 'fixture', url: sourceUrl, kind: 'hls', source: 'network', tabId: 1, firstSeenAt: 0, lastSeenAt: 0 };
  return { files, candidate, settings, keyRequests };
}
function verifyMp4(file, name, minimumDuration) {
  const destination = join(directory, name);
  writeFileSync(destination, file.bytes());
  const info = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type',
    '-show_entries', 'format=duration', '-of', 'json', destination]));
  assert.ok(info.streams.some((stream) => stream.codec_name === 'h264' && stream.codec_type === 'video'));
  assert.ok(info.streams.some((stream) => stream.codec_name === 'aac' && stream.codec_type === 'audio'));
  assert.ok(Number(info.format.duration) >= minimumDuration, JSON.stringify(info));
  command('ffmpeg', ['-v', 'error', '-i', destination, '-map', '0', '-f', 'null', '-']);
}

test('AES + clear + rotated-key VOD saves a decodable H.264/AAC MP4', async () => {
  const env = setup(); const { probeHlsCandidate, recordHlsLive } = load('hls-recorder');
  const options = { candidate: env.candidate, sourcePageUrl: 'https://media.example.test/watch' };
  const probe = await probeHlsCandidate(options);
  const stages = [];
  const result = await recordHlsLive({ ...options, probe, suggestedName: 'test.mp4', onProgress: (progress) => stages.push(progress.stage) });
  assert.equal(result.segmentsWritten, 3); assert.equal(result.lastSequence, 1003);
  assert.equal(result.bytesWritten, segments.reduce((sum, bytes) => sum + bytes.length, 0));
  assert.deepEqual(env.keyRequests, ['/key-a.bin', '/key-b.bin']);
  assert.ok(stages.includes('fetching-key') && stages.includes('decrypting') && stages.includes('remuxing'));
  assert.equal(env.files.size, 1); assert.equal(rules.size, 0);
  const task = [...tasks.values()][0]; assert.equal(task.status, 'completed');
  assert.equal('key' in task, false); assert.equal('encryption' in task, false);
  verifyMp4(env.files.get(result.finalFileName), 'vod.mp4', 2.8);
});

test('failed VOD keeps committed TS and resumes with a freshly fetched key', async () => {
  const env = setup({ failLast: true }); const { probeHlsCandidate, recordHlsLive, resumeHlsLive } = load('hls-recorder');
  const options = { candidate: env.candidate, sourcePageUrl: 'https://media.example.test/watch' };
  const probe = await probeHlsCandidate(options);
  await assert.rejects(recordHlsLive({ ...options, probe, suggestedName: 'recover.mp4' }), /errorHlsResourceHttp/);
  const task = [...tasks.values()][0];
  assert.equal(task.status, 'failed'); assert.equal(task.lastSequence, 1002);
  assert.deepEqual(task.fileHandle.bytes(), Buffer.concat(segments.slice(0, 2)));
  assert.equal(rules.size, 0);
  env.settings.failLast = false;
  const result = await resumeHlsLive({ ...options, task });
  assert.equal(result.segmentsWritten, 3);
  assert.equal(env.keyRequests.filter((name) => name === '/key-b.bin').length, 2);
  verifyMp4(env.files.get(result.finalFileName), 'resumed.mp4', 2.8);
});

test('stopping an AES live recording saves already committed media to MP4', async () => {
  const env = setup({ live: true }); const { probeHlsCandidate, recordHlsLive } = load('hls-recorder');
  const options = { candidate: env.candidate, sourcePageUrl: 'https://media.example.test/watch' };
  const probe = await probeHlsCandidate(options); assert.equal(probe.isLive, true);
  const controller = new AbortController();
  const result = await recordHlsLive({ ...options, probe, suggestedName: 'live.mp4', signal: controller.signal,
    onProgress: (progress) => { if (progress.stage === 'recording' && progress.segmentsWritten === 1) controller.abort(); } });
  assert.equal(result.stoppedByUser, true); assert.equal(result.segmentsWritten, 1); assert.equal(rules.size, 0);
  verifyMp4(env.files.get(result.finalFileName), 'live.mp4', 0.8);
});
