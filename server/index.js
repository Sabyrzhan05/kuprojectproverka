'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const imp = require('./import');
const periods = require('./periods');
const accruals = require('./accruals');
const clean = require('./clean');
// копия проекта на Google Диск (tools/backup.js) — только на ноутбуке стенда; без папки tools кнопка в пульте скрыта
let driveBk = null;
try { driveBk = require('../tools/backup.js'); } catch (e) { driveBk = null; }
const { execFile } = require('child_process');
let DRIVE_BK_BUSY = false;
// последняя запись помещения по вкладкам: {n: {tab, rev}} — свои записи подряд не конфликт (PUT /api/unit, 04.10.2026)
const UNIT_TAB = {};

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    // строками UTF-8: «s += кусок» раскодировал каждый кусок отдельно, и русская буква на стыке двух кусков становилась «��»
    // (03.10.2026, чек-лист 11.15: в снимке закрытого мая ФИО «Кошель Мария О��еговна» — 10 испорченных букв на два снимка)
    req.setEncoding('utf8');
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 60e6) { reject(new Error('слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      if (!s) return resolve(null);
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('не JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

/**
 * Вложения — сканы и фото договоров разграничения и актов (заказчик, 02.10.2026). Файл ложится в папку базы files/ под новым
 * именем (дата-время-случайное + расширение), в договор браузер записывает только его описание (db.cleanFiles).
 * «Удалить окончательно» переносит файл в files/_deleted — его не стирает, чтобы возврат копии базы не остался без
 * сканов; GET ищет в обеих папках. В «Копию на Google Диск» папка files уходит вместе с data.
 */
const FILES = path.join(db.DIR, 'files'), FILES_DEL = path.join(FILES, '_deleted');
const FILE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif', '.pdf': 'application/pdf' };
const FILE_MAX = 25 * 1048576;
/** Тело запроса как есть (файл). Больше max — не копим, дочитываем и отвечаем ошибкой. */
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    let parts = [], n = 0;
    req.on('data', c => { n += c.length; if (parts && n <= max) parts.push(c); else parts = null; });
    req.on('end', () => (parts ? resolve(Buffer.concat(parts)) : reject(new Error('больше ' + (max / 1048576) + ' МБ'))));
    req.on('error', reject);
  });
}

/**
 * Правки тарифов — в журнал, строкой на изменённую строку тарифа, с «Кто» (заказчик, 03.10.2026 —
 * тариф водоснабжения 0 с 22.08.2026 появился между копиями 23.09 и 02.10, а кто и когда его поставил, видно не было:
 * таблица тарифов сохраняется целиком, мимо журнала). Строка тарифа — услуга + дата начала; поменяли дату начала —
 * в журнале «удалён» прежней и «добавлен» новой.
 */
const SVC_LAB = { water_supply: 'водоснабжение', water_drainage: 'водоотведение', electricity: 'электроэнергия', heating: 'теплоэнергия',
  maintenance: 'техобслуживание МОП', capital_repair: 'взносы на капремонт' };
function logTariffDiff(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return;
  const key = t => `${t.svc}|${t.from}`;
  // числа — как числа: строка, сохранённая раньше текстом («8 620,78»), и она же числом — не правка (проверка 05.10.2026)
  const nv = v => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? String(n).replace('.', ',') : String(v); };
  const txt = t => `${nv(t.base)} без НДС · НДС ${nv(t.vat)} % · по ${t.to || 'бессрочно'}`;
  const lab = t => `тариф · ${SVC_LAB[t.svc] || t.svc} с ${t.from}`;
  const A = new Map(before.map(t => [key(t), t])), B = new Map(after.map(t => [key(t), t]));
  B.forEach((t, k) => {
    const o = A.get(k);
    if (!o) db.logChange('*', lab(t) + ' — добавлен', '', txt(t), null);
    else if (txt(o) !== txt(t)) db.logChange('*', lab(t), txt(o), txt(t), null);
  });
  A.forEach((t, k) => { if (!B.has(k)) db.logChange('*', lab(t) + ' — удалён', txt(t), '', null); });
}

function serveStatic(req, res, url) {
  let p = url === '/' ? '/index.html' : url;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const f = path.join(PUBLIC, p);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    return send(res, 404, 'не найдено', 'text/plain; charset=utf-8');
  }
  send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
}

// кто работает — для журнала: браузер присылает имя с каждой записью (закодировано — заголовки только латиницей)
const server = http.createServer((req, res) => {
  let who = ''; try { who = decodeURIComponent(req.headers['x-user'] || ''); } catch (e) { who = ''; }
  // ошибка вне try внутри handle (кривой адрес, сбой чтения файла) раньше роняла весь сервер — теперь ответ 500
  Promise.resolve(db.runAs(who, () => handle(req, res))).catch(e => {
    console.error('ОШИБКА:', e.message);
    try { if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); } catch (e2) { }
  });
});
async function handle(req, res) {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { return send(res, 400, { error: 'неверный адрес: ' + req.url.slice(0, 80) }); }
  const query = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));

  // движок расчёта — один файл для пульта и сервера (engine/calc.js): пульт подключает его отдельным скриптом
  if (url === '/engine/calc.js') return send(res, 200, fs.readFileSync(path.join(__dirname, '..', 'engine', 'calc.js')), MIME['.js']);
  if (!url.startsWith('/api/')) return serveStatic(req, res, url);
  // запись — только от стенда и служебных скриптов (04.10.2026, проверка сервера): чужая страница в том же браузере
  // могла простым POST дёрнуть «Вернуть копию» или импорт. Стенд шлёт X-Tab, скрипты — X-User или JSON; такие заголовки
  // со сторонней страницы без разрешения сервера не уходят
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['x-tab'] && !req.headers['x-user'] && !/application\/json/i.test(String(req.headers['content-type'] || '')))
    return send(res, 403, { error: 'запись принимается только от стенда' });

  try {
    // ---- состояние целиком ----
    if (url === '/api/state' && req.method === 'GET') {
      const st = db.getState(query.period);
      // закрытый период: снимок целиком (браузер показывает из него), корректировки и переносы
      return send(res, 200, Object.assign(st, periods.info(st.period, true)));
    }
    // ---- начисления за месяц — считает сервер тем же движком, что стенд (server/accruals.js); только чтение ----
    // заказчик, 05.10.2026; ответ — документ «Для кабинета: JSON» (docs/КОНТРАКТ ВЫГРУЗКИ КУ.md)
    if (url === '/api/accruals' && req.method === 'GET') {
      const r = await accruals.month(query.period);
      return send(res, r.code, r.body);
    }

    // ---- очистка данных месяцев (06.10.2026): GET — месяцы с данными или предпросмотр (?periods=ГГГГ-ММ,…), POST — очистить ----
    // только «Руководитель» и «Бухгалтерия»; закрытый месяц — отказ; перед удалением — копия базы; docs/ОЧИСТКА ДАННЫХ.md
    if (url === '/api/clean-months' && req.method === 'GET') return send(res, 200, query.periods ? clean.preview(query.periods) : { periods: clean.months() });
    if (url === '/api/clean-months' && req.method === 'POST') { const body = await readBody(req); return send(res, 200, clean.clean(body || {})); }

    // ---- фиксация периода и корректировки (docs/ПРАВИЛА РАСЧЁТА.md, 94–98) ----
    const mPer = url.match(/^\/api\/period\/(\d{4}-\d{2})(?:\/(close|reopen|adjust\/(.+)))?$/);
    if (mPer) {
      const p = mPer[1], act = mPer[2] || '';
      try {
        if (!act && req.method === 'GET') return send(res, 200, periods.info(p, query.full === '1'));
        if (req.method !== 'POST') return send(res, 405, { error: 'нужен POST' });
        const body = await readBody(req);
        if (act === 'close') return send(res, 200, periods.close(p, body || {}));
        if (act === 'reopen') return send(res, 200, periods.reopen(p, body || {}));
        if (act.startsWith('adjust/')) return send(res, 200, periods.adjust(p, mPer[3], body || {}));
      } catch (e) { return send(res, 409, { error: e.message }); }
    }
    const mGrp = url.match(/^\/api\/adjust-group\/(.+)$/);
    if (mGrp && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, periods.adjustGroup(mGrp[1], body || {})); }
      catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (url === '/api/adjustments' && req.method === 'GET') {
      return send(res, 200, query.carry ? periods.carriesInto(query.carry) : periods.adjustments(query.period, query.unit));
    }

    // ---- зачёт переплаты собственника в квитанцию открытого месяца (утверждено заказчиком 04.10.2026) ----
    if (url === '/api/offsets' && req.method === 'GET') return send(res, 200, periods.offsets());
    if (url === '/api/offsets' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, periods.addOffset(body)); } catch (e) { return send(res, 409, { error: e.message }); }
    }
    const mOff = url.match(/^\/api\/offsets\/([^/]{1,160})$/);   // в коде зачёта — номер помещения, у нежилых с буквами: OFF-…-НП8-…
    if (mOff && req.method === 'DELETE') {
      try { return send(res, 200, periods.delOffset(mOff[1])); } catch (e) { return send(res, 409, { error: e.message }); }
    }

    // ---- акт замены прибора: старый снимается датой с конечным показанием, новый ставится с начальным, оба фиксируются ----
    const mRepl = url.match(/^\/api\/unit\/(.+)\/replace$/);
    if (mRepl && req.method === 'POST') {
      const body = await readBody(req);
      if (body == null) return send(res, 400, { error: 'пустое тело запроса' });
      const per = query.period || db.load('settings').period;
      try { const out = db.replaceMeter(mRepl[1], body, per), tab = String(req.headers['x-tab'] || ''); if (tab) UNIT_TAB[mRepl[1]] = { tab, rev: out._rev }; return send(res, 200, out); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // ---- импорт показаний из папки Импорт/ГГГГ/ММ: GET — предпросмотр, POST — запись ----
    if (url === '/api/import') {
      const per = query.period || db.load('settings').period;
      if (periods.findClosed(per)) return send(res, 409, { error: `период ${per} закрыт — импорт в закрытый период невозможен, сначала откройте его заново` });
      try {
        if (req.method === 'GET') return send(res, 200, imp.preview(per));
        if (req.method === 'POST') return send(res, 200, imp.apply(per));
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    // ---- вложения: POST — принять файл, GET — отдать, DELETE — убрать в files/_deleted ----
    if (url === '/api/files' && req.method === 'POST') {
      const name = String(query.name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 200) || 'файл';
      const ext = path.extname(name).toLowerCase();
      if (!FILE_MIME[ext]) return send(res, 415, { error: `«${name}»: прикрепить можно скан или фото — JPG, PNG, HEIC, TIFF или PDF` });
      let buf;
      try { buf = await readRaw(req, FILE_MAX); } catch (e) { return send(res, 413, { error: `«${name}» ${e.message}` }); }
      if (!buf.length) return send(res, 400, { error: `«${name}» — пустой файл` });
      fs.mkdirSync(FILES, { recursive: true });
      const d = new Date(), p2 = x => String(x).padStart(2, '0');
      const id = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${crypto.randomBytes(3).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(FILES, id), buf);
      const at = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
      return send(res, 200, { id, name, type: FILE_MIME[ext], size: buf.length, at, by: db.actor() });
    }
    const mFile = url.match(/^\/api\/files\/([\w.-]{1,80})$/);
    if (mFile && req.method === 'GET') {
      // только файл (не папка «_deleted»), ошибка чтения — ответом, а не падением процесса (04.10.2026, проверка сервера:
      // GET /api/files/_deleted ронял сервер — у потока не было обработчика ошибки)
      const f = [path.join(FILES, mFile[1]), path.join(FILES_DEL, mFile[1])].find(x => fs.existsSync(x) && fs.statSync(x).isFile());
      if (!f) return send(res, 404, { error: 'файл не найден: ' + mFile[1] });
      const st = fs.createReadStream(f);
      st.on('error', e => { if (!res.headersSent) send(res, 500, { error: 'файл не читается: ' + e.message }); else res.destroy(); });
      st.once('open', () => {
        res.writeHead(200, {
          'Content-Type': FILE_MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
          'Content-Disposition': `${query.dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(query.name || mFile[1])}`,
          'Cache-Control': 'private, max-age=86400',
        });
        st.pipe(res);
      });
      return;
    }
    if (mFile && req.method === 'DELETE') {
      if (db.load('contracts').some(c => (c.files || []).some(x => x.id === mFile[1])))
        return send(res, 409, { error: 'файл ещё во вложениях договора — сначала уберите его оттуда' });
      const f = path.join(FILES, mFile[1]);
      if (fs.existsSync(f)) { fs.mkdirSync(FILES_DEL, { recursive: true }); fs.renameSync(f, path.join(FILES_DEL, mFile[1])); }
      return send(res, 200, { ok: true });
    }

    // ---- одно помещение ----
    const mUnit = url.match(/^\/api\/unit\/(.+)$/);
    if (mUnit) {
      const n = mUnit[1];
      if (req.method === 'GET') {
        const u = db.load('units').find(x => x.n === n);
        if (!u) return send(res, 404, { error: 'помещение не найдено' });
        return send(res, 200, Object.assign(db.buildUnit(u, query.period || db.load('settings').period), { _rev: db.unitRev(n) }));
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readBody(req);
        if (body == null || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'пустое тело запроса или не помещение' });
        const per = query.period || db.load('settings').period;
        // номер помещения не меняется (заказчик, 02.10.2026; чек-лист 1.4) — та же проверка в db.putUnit
        if (body && body.n && body.n !== n) return send(res, 409, { error: `номер помещения не меняется: ${n}` });
        // помещение поменяли после того, как этот браузер его загрузил, — не затирать (db.unitRevs, 04.10.2026). Свои же
        // записи вкладки подряд (вторая ушла раньше, чем пришёл ответ на первую) — не конфликт: X-Tab и последний отпечаток
        const tab = String(req.headers['x-tab'] || '');
        if (body && body._rev) {
          const cur = db.unitRev(n), last = UNIT_TAB[n];
          if (!cur) return send(res, 409, { error: `помещение ${n} удалено в другом окне — обновите страницу (F5)`, conflict: true });
          if (cur !== body._rev && !(tab && last && last.tab === tab && last.rev === cur))
            return send(res, 409, { error: `помещение ${n} изменили в другом окне, импортом или корректировкой после того, как оно открыто здесь. Обновите страницу (F5) и внесите правку ещё раз`, conflict: true });
        }
        if (body) delete body._rev;
        // пометить на удаление помещение из снимка закрытого месяца нельзя и на сервере (в браузере — markDel)
        if (body && body.del && !db.load('units').some(x => x.n === n && x.del) && periods.inAnySnapshot(n))
          return send(res, 409, { error: `помещение ${n} есть в снимке закрытого периода — пометить на удаление нельзя` });
        // отказ проверки putUnit (дата, показание, замок акта, серийник, ресурс, закрытый месяц) — 400 / 409 с текстом,
        // общим обработчиком ниже по e.status (проверка 05.10.2026; было 500)
        const out = db.putUnit(n, body, per);
        out._rev = db.unitRev(n); if (tab) UNIT_TAB[n] = { tab, rev: out._rev };
        if (periods.findClosed(per)) out.closedPeriod = per;   // данные закрытого периода изменены — стенд покажет расхождение со снимком
        return send(res, 200, out);
      }
      if (req.method === 'DELETE') {
        if (periods.inAnySnapshot(n)) return send(res, 409, { error: `помещение ${n} есть в снимке закрытого периода — удалить нельзя` });
        db.deleteUnit(n); return send(res, 200, { ok: true });
      }
    }

    // ---- справочные таблицы ----
    const mTable = url.match(/^\/api\/table\/(\w+)$/);
    if (mTable) {
      const name = mTable[1];
      if (req.method === 'GET') return send(res, 200, db.load(name));
      if (req.method === 'PUT') {
        // целиком заменяются только справочники; помещения, приборы, показания, договоры и журнал идут через /api/unit
        const EDITABLE = ['tariffs', 'external', 'settings', 'unit_names'];
        if (!EDITABLE.includes(name)) return send(res, 403, { error: 'таблица ' + name + ' не редактируется целиком' });
        const body = await readBody(req);
        if (body == null) return send(res, 400, { error: 'пустое тело запроса' });
        // базовый и НДС — числом (проверка 05.10.2026: страница писала текст поля «467,62», импорт ЭСФ читал его как 0)
        if (name === 'tariffs' && Array.isArray(body)) body.forEach(t => { if (t && typeof t === 'object') ['base', 'vat'].forEach(k => {
          if (typeof t[k] === 'string') { const n = parseFloat(t[k].replace(/\s/g, '').replace(',', '.')); t[k] = isFinite(n) ? n : 0; } }); });
        if (name === 'tariffs') logTariffDiff(db.load('tariffs'), body);
        if (name === 'settings') return send(res, 200, { ok: true, settings: db.putSettings(body) });   // слиянием, с журналом
        db.putTable(name, body);
        return send(res, 200, { ok: true });
      }
    }

    // ---- журнал ----
    if (url === '/api/log' && req.method === 'GET') {
      const all = db.load('log');
      // ?kind=reg&since=ISO — правки реестра после отметки «просмотрено» (для бухгалтерии)
      if (query.kind) return send(res, 200, all.filter(x => x.kind === query.kind && (!query.since || (x.at || '') > query.since)));
      if (query.unit) return send(res, 200, all.filter(x => x.unit === query.unit));
      // последние 500 и сколько записей всего — заголовком X-Log-Total (проверка 05.10.2026: отчёт «Журнал» писал
      // «последние 500 из 500» при ~4 700 записях — всего он не знал)
      res.setHeader('X-Log-Total', String(all.length));
      return send(res, 200, all.slice(-500));
    }

    // ---- копия проекта на Google Диск: кнопка в пульте; то же, что «Копия на Google Диск.bat» ----
    if (url.startsWith('/api/drive-backup') && !driveBk) return req.method === 'GET' ? send(res, 200, { off: true }) : send(res, 404, { error: 'копия на Google Диск в этой сборке не подключена' });
    if (url === '/api/drive-backup' && req.method === 'GET') return send(res, 200, { roots: driveBk.driveRoots(), last: driveBk.lastCopies(), busy: DRIVE_BK_BUSY });
    if (url === '/api/drive-backup' && req.method === 'POST') {
      if (DRIVE_BK_BUSY) return send(res, 409, { error: 'копия уже делается — дождитесь окончания' });
      DRIVE_BK_BUSY = true;
      const r = await new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'tools', 'backup.js')],
        { cwd: path.join(__dirname, '..'), timeout: 600000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, so, se) => resolve({ ok: !err, out: String(so || '') + String(se || '') })));
      DRIVE_BK_BUSY = false;
      console.log('  копия на Google Диск: ' + (r.ok ? 'готово' : 'ошибка'));
      return send(res, r.ok ? 200 : 500, Object.assign(r, { last: driveBk.lastCopies() }));
    }

    // ---- резервная копия ----
    if (url === '/api/backup' && req.method === 'POST') {
      return send(res, 200, { dir: path.basename(db.backup(query.tag)) });
    }
    // ?info=1 — у каждой копии признак, можно ли её вернуть ({ dir, block, after, lack }; только чтение, 04.10.2026): окно
    // «Вернуть копию…» помечает копии, сделанные до закрытия месяца или корректировки, заранее. Без info — имена, как раньше
    if (url === '/api/backups' && req.method === 'GET') return send(res, 200, db.backups(query.info === '1'));
    // возврат к копии — для повторного прогона тестовых сценариев; текущее состояние сохраняется копией before-restore;
    // отказ (копии нет — 404, вернуть нельзя — 409) — общим обработчиком ниже по e.status (проверка 05.10.2026; было 500)
    if (url === '/api/restore' && req.method === 'POST') {
      if (!query.dir) return send(res, 400, { error: 'не указана копия (dir)' });
      return send(res, 200, { ok: true, saved: db.restore(query.dir) });
    }

    // ---- выгрузка всей базы одним файлом ----
    if (url === '/api/dump' && req.method === 'GET') {
      const dump = {};
      db.TABLES.forEach(t => { dump[t] = db.load(t); });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="torre-dump-${new Date().toISOString().slice(0,10)}.json"`,
      });
      return res.end(JSON.stringify(dump, null, 1));
    }

    send(res, 404, { error: 'неизвестный запрос ' + req.method + ' ' + url });
  } catch (e) {
    // отказ проверки (db.refuse: 400 — ошибка ввода, 409 — нельзя по правилам, 404 — нет такого) — его код и текст, без
    // «ОШИБКА» в окне сервера (проверка 05.10.2026); остальное — сбой, 500
    if (e.status >= 400 && e.status < 500) return send(res, e.status, { error: e.message });
    console.error('ОШИБКА:', e.message);
    send(res, 500, { error: e.message });
  }
}

// начало месяца = конец прошлого месяца (заказчик, 02.10.2026): при запуске база приводится к правилу — после
// обновления один раз (июль 2026: 781 водяной прибор), дальше ничего не меняет; перед изменением — копия базы
try {
  if (db.carryStarts(null, true)) {
    db.backup('pre-start-carry');
    const k = db.carryStarts(null);
    db.logChange('*', 'начало месяца = конец прошлого месяца — база приведена при запуске стенда', '', `${k} начальных показаний`, null);
    console.log(`  Начало месяца = конец прошлого: поправлено начальных показаний — ${k} (копия базы до — pre-start-carry)`);
  }
} catch (e) { console.error('ОШИБКА: перенос начальных показаний при запуске —', e.message); }
// ручная пометка разграничения — у собственника (заказчик, 06.10.2026): пометки старого вида (на приборе, тепло на помещении) база
// переносит к последнему собственнику помещения один раз, с копией базы до переноса
try {
  const mk = db.migrateMarks(true);
  if (mk.fields) {
    db.backup('pre-start-marks');
    const done = db.migrateMarks(false);
    if (done.units) db.logChange('*', 'ручные пометки разграничения перенесены к собственникам (пометка — у собственника, 06.10.2026)', '', `${done.units} помещений: ${done.list.join(', ')}`, null);
    console.log(`  Ручные пометки разграничения перенесены к собственникам: ${done.units} помещений (копия базы до — pre-start-marks)`);
  }
} catch (e) { console.error('ОШИБКА: перенос ручных пометок разграничения при запуске —', e.message); }

server.listen(PORT, '127.0.0.1', () => {
  const s = db.getState();
  console.log('');
  console.log('  Стенд КУ запущен');
  console.log('  ---------------------------------------------');
  console.log('  Откройте в браузере:  http://localhost:' + PORT);
  console.log('');
  console.log('  База:      ' + db.DIR);
  console.log('  Помещений: ' + s.rows.length);
  console.log('  Приборов:  ' + db.load('meters').length);
  console.log('  Периоды:   ' + s.periods.join(', '));
  console.log('');
  console.log('  Чтобы остановить — закройте это окно.');
  console.log('');
});

process.on('SIGINT', () => { db.saveAll(); process.exit(0); });
