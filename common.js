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


module.exports = { UA, sleep, safeName, downloadFile, runFfmpeg };
