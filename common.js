const { spawn } = require('child_process');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) =>
  (s || 'video').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';

async function downloadFile(url, headers, dest, log, onProgress) {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} при скачивании ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    onProgress && onProgress(done, total);
  });
  await pipeline(body, fs.createWriteStream(dest));
  log(`Скачано ${(done / 1048576).toFixed(1)} МБ`);
}

function runFfmpeg(url, headers, dest, log) {
  return new Promise((resolve, reject) => {
    const hdr = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const args = ['-y', '-loglevel', 'error', '-stats', '-headers', hdr, '-i', url, '-c', 'copy'];
    if (dest.endsWith('.mp4')) args.push('-bsf:a', 'aac_adtstoasc');
    args.push(dest);
    const p = spawn('ffmpeg', args);
    p.stderr.on('data', (d) => {
      const m = String(d).match(/time=(\S+)/);
      if (m) log(`ffmpeg: ${m[1]}`);
    });
    p.on('error', (e) => reject(new Error('Не удалось запустить ffmpeg (он установлен?): ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg завершился с кодом ' + code))));
  });
}



// HLS без ffmpeg: качаем сегменты и склеиваем в .ts (поддерживает AES-128).
async function downloadHlsNative(playlistUrl, headers, dest, log) {
  const crypto = require('crypto');
  const get = async (u, buf) => {
    const r = await fetch(u, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} для ${u}`);
    return buf ? Buffer.from(await r.arrayBuffer()) : r.text();
  };
  let url = playlistUrl;
  let text = await get(url);
  if (/#EXT-X-STREAM-INF/.test(text)) {
    // мастер-плейлист: берём вариант с максимальным битрейтом
    const lines = text.split(/\r?\n/);
    let best = null, bw = -1;
    lines.forEach((l, i) => {
      const m = l.match(/^#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
      if (m && Number(m[1]) > bw) {
        const next = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
        if (next) { bw = Number(m[1]); best = next; }
      }
    });
    if (!best) throw new Error('Не удалось разобрать мастер-плейлист');
    url = new URL(best, url).href;
    text = await get(url);
  }
  const lines = text.split(/\r?\n/);
  const seq0 = Number((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [, 0])[1]);
  const segs = [];
  let key = null;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-KEY:')) {
      const method = (l.match(/METHOD=([^,]+)/) || [])[1];
      if (method === 'NONE') key = null;
      else if (method === 'AES-128') {
        const uri = l.match(/URI="([^"]+)"/)[1];
        const iv = (l.match(/IV=0x([0-9a-f]+)/i) || [])[1];
        key = { uri: new URL(uri, url).href, iv: iv && Buffer.from(iv.padStart(32, '0'), 'hex') };
      } else throw new Error('Шифрование ' + method + ' не поддерживается');
    } else if (l && !l.startsWith('#')) segs.push({ url: new URL(l, url).href, key, seq: seq0 + segs.length });
  }
  if (!segs.length) throw new Error('В плейлисте нет сегментов');
  const keys = {};
  const out = fs.createWriteStream(dest);
  try {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let data = null;
      for (let attempt = 0; attempt < 4 && !data; attempt++) {
        try { data = await get(s.url, true); } catch (e) { if (attempt === 3) throw e; await sleep(1000); }
      }
      if (s.key) {
        keys[s.key.uri] = keys[s.key.uri] || (await get(s.key.uri, true));
        const iv = s.key.iv || Buffer.alloc(16);
        if (!s.key.iv) iv.writeUInt32BE(s.seq, 12);
        const d = crypto.createDecipheriv('aes-128-cbc', keys[s.key.uri], iv);
        data = Buffer.concat([d.update(data), d.final()]);
      }
      if (!out.write(data)) await new Promise((r) => out.once('drain', r));
      if (i % 5 === 0 || i === segs.length - 1) log(`Сегменты: ${i + 1}/${segs.length}`);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

// Сначала ffmpeg (mp4), если не вышло — своими силами в .ts. Возвращает путь к файлу.
async function downloadHls(url, headers, outDir, base, log) {
  const path = require('path');
  const mp4 = path.join(outDir, base + '.mp4');
  try {
    await runFfmpeg(url, headers, mp4, log);
    return mp4;
  } catch (e) {
    log('ffmpeg не сработал (' + e.message + '), качаю сегменты сам (получится .ts)...');
  }
  const ts = path.join(outDir, base + '.ts');
  await downloadHlsNative(url, headers, ts, log);
  return ts;
}

module.exports = { UA, sleep, safeName, downloadFile, runFfmpeg, downloadHls };
