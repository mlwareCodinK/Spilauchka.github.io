// Режим без браузера (для Termux): качаем HTML страницы с чистого листа (без куки),
// ищем ссылку на видео в коде страницы, её iframe и скриптах, и скачиваем.
const fs = require('fs');
const path = require('path');
const { UA, sleep, safeName, downloadFile, downloadHls } = require('./common');

const MEDIA_RE = /(?:https?:)?(?:\/\/|\/)[^"'\s<>\\()]+?\.(?:m3u8|mp4|webm|flv)(?:\?[^"'\s<>\\()]*)?/gi;

function unescapeJs(s) {
  return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

async function getText(url, jar, referer) {
  const headers = { 'User-Agent': UA };
  if (referer) headers.Referer = referer;
  if (jar.length) headers.Cookie = jar.join('; ');
  const res = await fetch(url, { headers, redirect: 'follow' });
  for (const c of res.headers.getSetCookie?.() || []) jar.push(c.split(';')[0]);
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  return { text: await res.text(), url: res.url };
}

function extract(html, baseUrl) {
  const found = new Set();
  for (const m of unescapeJs(html).matchAll(MEDIA_RE)) {
    try {
      found.add(new URL(m[0].startsWith('//') ? 'https:' + m[0] : m[0], baseUrl).href);
    } catch {}
  }
  return [...found];
}

// ищем в странице, затем в iframe и первых скриптах
async function scan(pageUrl, jar) {
  const { text, url } = await getText(pageUrl, jar);
  let found = extract(text, url);
  const title = (text.match(/<title[^>]*>([^<]*)/i) || [])[1];
  if (!found.length) {
    const sub = [...text.matchAll(/<(?:iframe|script)[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((u) => !/google|yandex|analytics|metrika|jquery|cloudflare/i.test(u))
      .slice(0, 8);
    for (const s of sub) {
      try {
        const r = await getText(new URL(s, url).href, jar, url);
        found = extract(r.text, r.url);
        if (!found.length && /<iframe/i.test(r.text)) {
          const inner = (r.text.match(/<iframe[^>]+src=["']([^"']+)["']/i) || [])[1];
          if (inner) found = extract((await getText(new URL(inner, r.url).href, jar, r.url)).text, r.url);
        }
      } catch {}
      if (found.length) break;
    }
  }
  return { found, title, base: url };
}

async function grabLite(pageUrl, opts = {}) {
  const { outDir = path.join(process.cwd(), 'downloads'), waitMs = 60000, log = console.log, onProgress } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const jar = []; // пустая куки-банка = чистый старт; она живёт только в этой функции
  const end = Date.now() + waitMs;
  let result;
  log('Ищу ссылку на видео в коде страницы (куки пустые)...');
  while (true) {
    try {
      result = await scan(pageUrl, jar);
      if (result.found.length) break;
    } catch (e) {
      log('Попытка не удалась: ' + e.message);
    }
    if (Date.now() >= end) throw new Error('Ссылка на видео не найдена в коде страницы (возможно, она подгружается скриптом — нужен режим с браузером).');
    log(`Пока не нашёл, повторю через 5 сек (осталось ${Math.ceil((end - Date.now()) / 1000)} сек)`);
    await sleep(5000);
  }
  const hls = result.found.find((u) => /\.m3u8/i.test(u));
  const best = hls || result.found[0];
  log('Найдено: ' + best.slice(0, 120));
  const headers = { 'User-Agent': UA, Referer: pageUrl };
  if (jar.length) headers.Cookie = jar.join('; ');
  const base = safeName(result.title);
  let dest;
  if (hls) {
    log('Скачиваю HLS-поток...');
    dest = await downloadHls(best, headers, outDir, base, log);
  } else {
    const ext = (best.split('?')[0].match(/\.(\w{2,4})$/) || [, 'mp4'])[1];
    dest = path.join(outDir, `${base}.${ext}`);
    log('Скачиваю файл...');
    await downloadFile(best, headers, dest, log, onProgress);
  }
  log('Готово: ' + dest);
  return { file: dest, title: result.title, source: best };
}

module.exports = { grabLite };
