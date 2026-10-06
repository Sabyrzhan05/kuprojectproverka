'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.env.TORRE_DATA || path.join(__dirname, '..', 'data');   // TORRE_DATA — другая папка базы (проба на копии)
const BACKUP = path.join(DIR, 'backup');

/**
 * Хранилище: каждая таблица — отдельный JSON-файл в папке data.
 * Структура повторяет схему Prisma, которую получит разработчик кабинета, чтобы перенос
 * в PostgreSQL был механическим: units, owners, meters, readings,
 * contracts, tariffs, external, settings, log.
 *
 * Запись атомарная: сначала во временный файл, потом переименование.
 * Так база не портится, если питание пропадёт в момент сохранения.
 */

const TABLES = ['units', 'owners', 'meters', 'readings', 'contracts',
                'tariffs', 'external', 'settings', 'log', 'unit_names',
                'closed_periods', 'adjustments', 'replacements', 'imports', 'programs', 'offsets'];   // offsets — зачёты переплаты (04.10.2026)

const cache = {};

function file(name) { return path.join(DIR, name + '.json'); }

function load(name) {
  if (cache[name]) return cache[name];
  const f = file(name);
  if (!fs.existsSync(f)) {
    cache[name] = (name === 'settings' || name === 'unit_names') ? {} : [];   // closed_periods и adjustments — списки
    return cache[name];
  }
  cache[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
  return cache[name];
}

/**
 * Запись таблицы: во временный файл и переименованием поверх. На Windows переименование иногда отказывает
 * (EPERM / EBUSY / EACCES), когда файл в этот момент держит антивирус или копирование — например, сразу после
 * «Копии базы». 23.09.2026 так упала запись помещения: договор управления записался, собственник — нет (ответ 500).
 * Повторяем до 40 раз с паузой 25 мс — не дольше секунды, как это делает graceful-fs.
 */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** Записать файл атомарно: во временный, сбросить на диск (fsync — при отключении питания не останется пустого файла,
 *  с которым сервер не стартует; 04.10.2026), переименовать поверх с повтором при EPERM / EBUSY / EACCES. */
function writeAtomic(f, data) {
  const tmp = f + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let k = 0; ; k++) {
    try { fs.renameSync(tmp, f); return; }
    catch (e) {
      if (k >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(25);
    }
  }
}
function save(name) { writeAtomic(file(name), JSON.stringify(cache[name], null, 0)); }

function saveAll() { TABLES.forEach(t => { if (cache[t]) save(t); }); }

/**
 * Пометка копии идёт только в имя папки — без разделителей пути и служебных знаков (04.10.2026, проверка сервера: «/» в
 * пометке клала копию во вложенную папку, и её возврат стирал всю базу; «../../public» выводил копию с ФИО и телефонами
 * в public/, откуда её отдавал сервер).
 */
const safeTag = t => String(t == null ? '' : t).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[\s.-]+|[\s.]+$/g, '').slice(0, 80);
/** Копии, которые ротация не удаляет: исходная база от 09.09.2026. */
const KEEP_BACKUP = /_исходная$/;
/** Копия всей базы с отметкой времени. Держим последние 30 (исходную — всегда); keep — копия, которую сейчас возвращают. */
function backup(tag, keep) {
  if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), t = safeTag(tag);
  let dir = path.join(BACKUP, stamp + (t ? '_' + t : ''));
  for (let k = 2; fs.existsSync(dir); k++) dir = path.join(BACKUP, stamp + (t ? '_' + t : '') + '-' + k);   // две копии в одну секунду — не в одну папку
  fs.mkdirSync(dir, { recursive: true });
  TABLES.forEach(t => {
    const src = file(t);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, t + '.json'));
  });
  const rot = fs.readdirSync(BACKUP).filter(d => /^\d{4}-/.test(d) && !KEEP_BACKUP.test(d) && d !== keep && d !== path.basename(dir)).sort();
  while (rot.length > 29) {
    fs.rmSync(path.join(BACKUP, rot.shift()), { recursive: true, force: true });
  }
  return dir;
}

/** Список копий, новые сверху. info — с признаком, можно ли копию вернуть (restoreCheck; только чтение, 04.10.2026). */
function backups(info) {
  if (!fs.existsSync(BACKUP)) return [];
  const list = fs.readdirSync(BACKUP).filter(d => /^\d{4}-/.test(d) && fs.statSync(path.join(BACKUP, d)).isDirectory()).sort().reverse();
  if (!info) return list;
  const ev = restoreEvents();
  return list.map(dir => Object.assign({ dir }, restoreCheck(dir, ev)));
}

/**
 * Возврат базы к копии. Текущее состояние перед этим само уходит в копию
 * «before-restore», кэш сбрасывается — иначе сервер продолжил бы отдавать
 * старые таблицы из памяти. Возвращает имя копии текущего состояния.
 * Закрытые месяцы и корректировки копия не трогает никогда (заказчик, 03.10.2026): раньше копия, где они были, подменяла их своими —
 * возврат копии «перед закрытием» молча открывал месяц и стирал корректировки. Открыть месяц — «Открыть период заново…».
 * Журнал тоже остаётся (04.10.2026): это история того, что было, — в том числе сам возврат; поэтому и отметки
 * «Просмотрено» в настройках (regSeen, regSeenRows — указывают в журнал) остаются нынешние, не из копии (05.10.2026).
 * Проверки до первой записи (04.10.2026, проверка сервера: возврат мог стереть базу целиком):
 *   · копия — папка первого уровня в data/backup, со всеми основными таблицами (копии старых версий стенда без договоров
 *     управления не возвращаются: 157 помещений стали бы «не в управлении»);
 *   · копия не старше закрытия месяца и оформленной корректировки — иначе снимок и корректировки остались бы, а показания
 *     и договоры под ними откатились;
 *   · файлы копии читаются в память до копии «перед возвратом» — её ротация не удалит выбранную.
 */
const KEEP_ON_RESTORE = ['closed_periods', 'adjustments', 'log'];
const RESTORE_NEED = ['units', 'owners', 'meters', 'readings', 'contracts', 'tariffs', 'settings', 'programs'];
/** Закрытия месяцев и оформленные корректировки — с временем: копию, сделанную до них, вернуть нельзя. */
function restoreEvents() {
  return [...load('closed_periods').filter(c => c.status === 'closed').map(c => ({ at: c.closedAt, kind: 'close', period: c.period, what: `закрытия периода ${c.period}` })),
          ...load('adjustments').map(a => ({ at: a.at, kind: 'adj', period: a.period, unit: a.unit, what: `корректировки ${a.id}` }))].filter(e => e.at);
}
/**
 * Можно ли вернуть копию name — те же две проверки, что restore делает до первой записи (неполная копия; копия старше
 * закрытия месяца или корректировки). Одно правило и для отказа, и для списка копий: окно «Вернуть копию…» помечает такие
 * копии заранее, а не после выбора (заказчик, 04.10.2026).
 * { block: текст отказа ('' — вернуть можно), lack: [нет таблиц], after: [{ kind: close | adj, period, unit, at }] }.
 */
function restoreCheck(name, ev) {
  const src = path.join(BACKUP, name);
  const lack = RESTORE_NEED.filter(t => !fs.existsSync(path.join(src, t + '.json')));
  if (lack.length) return { block: `копия «${name}» неполная (нет таблиц: ${lack.join(', ')}) — сделана старой версией стенда, вернуть её нельзя`, lack, after: [] };
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name), at = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : '';
  const events = (ev || restoreEvents()).filter(e => at && String(e.at).slice(0, 19) > at);
  if (events.length) return { block: `копия «${name}» сделана до ${events.map(e => e.what).slice(0, 3).join(', ')}${events.length > 3 ? ' и др.' : ''} — вернуть её нельзя: закрытый месяц и оформленные корректировки не откатываются, а показания и договоры под ними откатились бы. Выберите копию, сделанную позже`,
    lack: [], after: events.map(e => ({ kind: e.kind, period: e.period, unit: e.unit, at: e.at })) };
  return { block: '', lack: [], after: [] };
}
function restore(dir) {
  const name = path.basename(String(dir || '')), src = path.join(BACKUP, name);
  // отказы — с кодом (проверка 05.10.2026): копии нет — 404, вернуть нельзя — 409; раньше сервер отвечал 500 «ОШИБКА»
  if (!/^\d{4}-/.test(name) || !fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw refuse('копия не найдена: ' + dir, 404);
  const chk = restoreCheck(name);
  if (chk.block) throw refuse(chk.block);
  const data = {};
  TABLES.forEach(t => { if (KEEP_ON_RESTORE.includes(t)) return; const f = path.join(src, t + '.json'); if (fs.existsSync(f)) data[t] = fs.readFileSync(f, 'utf8'); });
  RESTORE_NEED.forEach(t => { try { JSON.parse(data[t]); } catch (e) { throw refuse(`копия «${name}»: файл ${t}.json не читается — вернуть её нельзя`); } });
  // отметки «Просмотрено» (правки реестра целиком и по строке) указывают в журнал, а журнал копия не откатывает — берём
  // нынешние (проверка 05.10.2026: после возврата отметка бухгалтерии откатывалась, и лента снова показывала «новыми»
  // правки, которых в данных уже нет)
  { const st = JSON.parse(data.settings), cur = load('settings') || {};
    if (isObj(st)) { ['regSeen', 'regSeenRows'].forEach(k => { if (k in cur) st[k] = cur[k]; else delete st[k]; }); data.settings = JSON.stringify(st); } }
  const saved = path.basename(backup('before-restore', name));
  TABLES.forEach(t => {
    if (KEEP_ON_RESTORE.includes(t)) return;
    if (data[t] != null) writeAtomic(file(t), data[t]);
    else if (fs.existsSync(file(t))) fs.unlinkSync(file(t));
    delete cache[t];
  });
  logChange('*', 'база возвращена к копии', saved, name, null);
  return saved;
}

/**
 * Кто работает — присылает браузер заголовком X-User с каждой записью (заказчик, 24.09.2026). Сервер ставит его на время запроса (setActor), журнал пишет его в поле by.
 */
const { AsyncLocalStorage } = require('async_hooks');
const ACTOR = new AsyncLocalStorage();
/** Обработать запрос от имени name — журнал возьмёт имя и после await (запросы идут вперемешку, у каждого своё). */
function runAs(name, fn) { return ACTOR.run(String(name || '').slice(0, 80), fn); }
/** Кто работает в этом запросе ('' — не представился). */
function actor() { return ACTOR.getStore() || ''; }
/** Правки реестра (собственники, контакты, представители, договоры управления) — отдельной меткой kind:'reg':
 *  по ним бухгалтерия видит «новые изменения реестра», пока не отметит «просмотрено». */
const REG_WHAT = /собственник|владеет|договор управления|в управлении|программа управления|телефон|e-mail|представител/i;
/** Запись в журнал изменений. Хранится в базе, как и должно быть в рабочей системе. */
function logChange(unit, what, before, after, period) {
  const log = load('log');
  log.push({
    at: new Date().toISOString(),
    unit, what,
    before: before == null ? '' : String(before),
    after: after == null ? '' : String(after),
    period: period || load('settings').period || '',
    ...(ACTOR.getStore() ? { by: ACTOR.getStore() } : {}),
    ...(REG_WHAT.test(String(what)) ? { kind: 'reg' } : {}),
  });
  if (LOG_BATCH) { LOG_DIRTY = true; return; }
  trimLog(); save('log');
}
/**
 * Много строк журнала подряд (импорт месяца, приведение базы при запуске) — файл журнала пишется один раз в конце, а не на
 * каждую строку (04.10.2026): журнал ~6 МБ, импорт месяца с переносом начала — ~2 750 строк, и стенд на полторы-две минуты
 * переставал отвечать. Вложенные вызовы допустимы — пишет самый внешний.
 */
let LOG_BATCH = 0, LOG_DIRTY = false;
function batchLog(fn) {
  LOG_BATCH++;
  try { return fn(); }
  finally { if (--LOG_BATCH === 0 && LOG_DIRTY) { LOG_DIRTY = false; trimLog(); save('log'); } }
}
/**
 * Журнал длиннее LOG_MAX — самые старые записи уходят в архив `log_archive.json` рядом с базой (04.10.2026; раньше просто
 * удалялись сверх 20 000: импорт месяца добавляет ~2 750 строк, через пять месяцев начала бы пропадать история). Архив
 * не входит в «Копию базы» и при «Вернуть копию» не меняется; в «Копию на Google Диск» уходит вместе с папкой базы.
 */
const LOG_KEEP = 20000, LOG_MAX = 25000;
function trimLog() {
  const log = load('log');
  if (log.length <= LOG_MAX) return;
  const n = log.length - LOG_KEEP, f = path.join(DIR, 'log_archive.json');
  // сначала архив, потом удаление из журнала; архив не читается или не пишется — ничего не удаляем (журнал подрастёт,
  // в следующий раз попробуем снова), запись данных из-за журнала не падает
  try {
    const arc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
    arc.push(...log.slice(0, n));
    fs.writeFileSync(f + '.tmp', JSON.stringify(arc), 'utf8');
    fs.renameSync(f + '.tmp', f);
  } catch (e) { return; }
  log.splice(0, n);
}

/**
 * Сборка помещения в вид, с которым работает интерфейс.
 * Это ровно тот слой, который в кабинете будет делать Prisma:
 * плоские таблицы → вложенный объект для экрана.
 */
/**
 * Договор управления, действующий на период: из пересекающих период берётся начавшийся
 * позже (как activeSeg у собственников в браузере). Нет ни одного — «не в управлении».
 */
function progOnPeriod(progs, period) {
  const [y, m] = period.split('-').map(Number);
  const ps = `${period}-01`, pe = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const act = progs.filter(p => !(p.from && p.from > pe) && !(p.to && p.to < ps));
  if (!act.length) return null;
  return act.reduce((best, p) => (!best || (p.from || '') > (best.from || '')) ? p : best, null);
}

/**
 * Строки таблиц по помещению и показания по прибору — одним проходом на весь getState (05.10.2026, скорость смены месяца:
 * buildUnit для каждого из 445 помещений перебирал все таблицы и все показания целиком — 0,3–0,4 с на ответ). Порядок
 * строк внутри помещения — как в таблице, как у filter, поэтому помещение собирается то же самое.
 */
function unitIndex() {
  const by = (rows, key) => { const m = new Map(); rows.forEach(x => { const a = m.get(x[key]); if (a) a.push(x); else m.set(x[key], [x]); }); return m; };
  return { owners: by(load('owners'), 'unit'), programs: by(load('programs'), 'unit'), meters: by(load('meters'), 'unit'),
    contracts: by(load('contracts'), 'unit'), readings: by(load('readings'), 'meter') };
}

/**
 * Ручная пометка разграничения — у собственника (заказчик, 06.10.2026). Запись собственника: rz = { w: да / нет — все водяные приборы
 * помещения, h: да / нет — тепло, e: { номер прибора: да / нет } — электросчётчик }; ключа нет — «по договору разграничения»; да —
 * «разграничено вручную», нет — «в счёт УК вручную». Расчёт берёт пометку собственника в дни его владения.
 * До 06.10.2026 пометка жила на приборе (meters.rz) и на помещении (units.rzH — тепло) и действовала во всех месяцах. Такие пометки
 * относятся к последнему собственнику помещения: migrateMarks переносит их в базе при запуске стенда, buildUnit до переноса
 * показывает их так же (ownersWithMarks), putUnit переносит пометки своего помещения до записи.
 */
const isMark = v => v === true || v === false;
/** Пометки старого вида у помещения: тепло — units.rzH; вода — одна на все водяные приборы (как ставил стенд; разные — какой больше);
 *  электро — по прибору. */
function legacyMarksOf(u, meters) {
  const z = {};
  if (u && isMark(u.rzH)) z.h = u.rzH;
  const live = (meters || []).filter(m => !m.del && isMark(m.rz));
  const w = live.filter(m => m.res !== 'ee' && m.bill !== false).map(m => m.rz);
  if (w.length) z.w = w.filter(Boolean).length * 2 >= w.length;
  const e = {}; live.filter(m => m.res === 'ee').forEach(m => { e[m.id] = m.rz; });
  if (Object.keys(e).length) z.e = e;
  return z;
}
/** Пометки собственника — только допустимые значения; пусто — null (в базу не пишется). */
function cleanMarks(z) {
  if (!z || typeof z !== 'object') return null;
  const out = {};
  if (isMark(z.w)) out.w = z.w;
  if (isMark(z.h)) out.h = z.h;
  if (z.e && typeof z.e === 'object') { const e = {}; Object.keys(z.e).forEach(id => { if (isMark(z.e[id])) e[id] = z.e[id]; }); if (Object.keys(e).length) out.e = e; }
  return Object.keys(out).length ? out : null;
}
/** Последний (по дате «с») непомеченный собственник — ему относятся пометки старого вида. */
const lastOwnerOf = owners => owners.filter(o => !o.del).slice().sort((a, b) => ((a.from || '') < (b.from || '')) ? -1 : 1).pop() || null;
/** Записи собственников с пометками старого вида, отнесёнными к последнему собственнику (без записи в базу). */
function ownersWithMarks(u, owners, meters) {
  const lg = legacyMarksOf(u, meters); if (!Object.keys(lg).length) return owners;
  const last = lastOwnerOf(owners); if (!last) return owners;
  return owners.map(o => { if (o !== last) return o;
    const z = Object.assign({}, o.rz || {});
    ['w', 'h'].forEach(k => { if (lg[k] !== undefined && !isMark(z[k])) z[k] = lg[k]; });
    if (lg.e) { const e = Object.assign({}, z.e || {}); Object.keys(lg.e).forEach(id => { if (!isMark(e[id])) e[id] = lg.e[id]; }); z.e = e; }
    return Object.assign({}, o, { rz: cleanMarks(z) }); });
}
/** Перенести пометки старого вида помещения n к собственнику. bulk — без записи файлов (запишет migrateMarks). true — что-то
 *  поменялось. */
function moveUnitMarks(n, bulk) {
  const u = load('units').find(x => x.n === n); if (!u) return false;
  const ms = load('meters').filter(m => m.unit === n), own = load('owners').filter(o => o.unit === n);
  const has = ms.some(m => 'rz' in m) || 'rzH' in u;
  if (!has) return false;
  const lg = legacyMarksOf(u, ms);
  if (Object.keys(lg).length) {
    const last = lastOwnerOf(own);
    if (!last) return false;                             // собственника нет — пометку отнести некому, остаётся как была
    const moved = ownersWithMarks(u, own, ms).find(o => o.unit === n && o.fio === last.fio && o.from === last.from && !o.del);
    if (moved && moved.rz) last.rz = moved.rz; else delete last.rz;
  }
  ms.forEach(m => { delete m.rz; }); delete u.rzH;
  if (!bulk) { save('owners'); save('meters'); save('units'); }   // все три сразу: тепло с помещения не теряется без собственника
  return true;
}
/** Перенос пометок старого вида во всей базе (при запуске стенда, с копией базы до). dry — только посчитать. Возвращает
 *  {units — помещений с пометками, fields — записей, где было старое поле}. */
function migrateMarks(dry) {
  const units = load('units'), meters = load('meters');
  const fields = meters.filter(m => 'rz' in m).length + units.filter(u => 'rzH' in u).length;
  const withMarks = units.filter(u => Object.keys(legacyMarksOf(u, meters.filter(m => m.unit === u.n))).length).map(u => u.n);
  if (dry || !fields) return { units: withMarks.length, fields };
  units.forEach(u => moveUnitMarks(u.n, true));
  save('owners'); save('meters'); save('units');
  return { units: withMarks.length, fields, list: withMarks };
}

/** ix — unitIndex() для сборки многих помещений подряд; без него — по таблицам, как раньше (одно помещение). */
function buildUnit(u, period, ix) {
  const rowsOf = (t, key, val) => ix ? (ix[t].get(val) || []) : load(t).filter(x => x[key] === val);
  // пометки разграничения — у собственника (06.10.2026); старого вида, ещё не перенесённые, — у последнего собственника
  const owners = ownersWithMarks(u, rowsOf('owners', 'unit', u.n), rowsOf('meters', 'unit', u.n))
    .map(o => ({ fio: o.fio, from: o.from, to: o.to, ...(o.del ? { del: o.del } : {}),   // del — пометка на удаление
                 ...(cleanMarks(o.rz) ? { rz: cleanMarks(o.rz) } : {}),                 // ручные пометки разграничения собственника
                 // контакты (заказчик, 24.09.2026): телефоны, e-mail и представители собственника — у каждого ФИО, телефоны, e-mail, основание
                 phones: o.phones || [], emails: o.emails || [], reps: o.reps || [] }));
  // договоры управления — датированная линия, как владение (с 17.09.2026); prog/cno/cdt — производные на период
  const progs = rowsOf('programs', 'unit', u.n)
    .map(p => ({ prog: p.prog, cno: p.cno || '', cdt: p.cdt || null, from: p.from || null, to: p.to || null, ...(p.del ? { del: p.del } : {}) }))
    .sort((a, b) => ((a.from || '') < (b.from || '')) ? -1 : 1);
  const cur = progOnPeriod(progs.filter(p => !p.del), period);   // помеченный на удаление договор не действует

  const meters = rowsOf('meters', 'unit', u.n).map(m => {
    const rd = rowsOf('readings', 'meter', m.id);   // показания этого прибора, все месяцы
    const cur = rd.find(x => x.period === period);
    const hist = {};
    rd.forEach(x => {
      // midRead/ownRead всех периодов тоже едут в hist — иначе сохранение из другого периода их стирает
      hist[x.period] = { prev: x.prev, cur: x.cur,
                         midRead: x.midRead == null ? null : x.midRead,
                         ownRead: x.ownRead == null ? null : x.ownRead,
                         // показание зафиксировано актом замены прибора — менять нельзя
                         lockPrev: !!x.lockPrev, lockCur: !!x.lockCur,
                         // начальное показание пришло каскадом корректировки закрытого месяца (или изменено после неё руками)
                         prevSrc: x.prevSrc || null, prevNote: x.prevNote || null };
    });
    return {
      id: m.id, res: m.res, sn: m.sn, k: m.k,
      prev: cur ? cur.prev : null,
      cur: cur ? cur.cur : null,
      midRead: cur ? cur.midRead : null,
      // показание на дату передачи помещения новому собственнику
      ownRead: cur ? (cur.ownRead === undefined ? null : cur.ownRead) : null,
      lockPrev: !!(cur && cur.lockPrev), lockCur: !!(cur && cur.lockCur),
      prevSrc: cur ? (cur.prevSrc || null) : null, prevNote: cur ? (cur.prevNote || null) : null,
      bill: m.bill !== false,
      transit: !!m.transit,
      note: m.note || '',
      // дата установки и дата снятия (акт замены): вне этих дат прибор в периоде не участвует
      from: m.from || null, to: m.to || null,
      del: m.del || null,                 // пометка на удаление: в расчёте прибора нет, показания хранятся
      hist,
    };
  });

  const rz = {};
  rowsOf('contracts', 'unit', u.n).forEach(c => {
    (rz[c.res] = rz[c.res] || []).push({
      no: c.no, from: c.from, to: c.to,
      // акт опломбировки: по воде разграничение действует с его даты, а не с даты договора
      seal: c.seal || null,
      // чей договор — ФИО собственника, который его заключал
      owner: c.owner || '',
      // дата смены собственника, которой договор закрыт автоматически, и отметка проверки оператором
      autoClosed: c.autoClosed || null,
      checked: !!c.checked,
      // «по факту»: договор действует и без номера/даты — сам факт разграничения (заказчик, 16.09.2026)
      fact: !!c.fact,
      // номер акта опломбировки (дата — seal) и разрешение оператора делить по дням, если показания на дату начала нет (заказчик, 21.09.2026)
      sealNo: c.sealNo || '', byDays: !!c.byDays,
      del: c.del || null,                 // пометка на удаление
      // описание, вложения (сканы и фото договора и акта) и акт, помеченный на удаление (заказчик, 02.10.2026)
      note: c.note || '', files: c.files || [], actDel: c.actDel || null,
    });
  });

  return {
    n: u.n, fl: u.fl, t: u.t, area: u.area, inodn: u.inodn !== false,
    prog: cur ? cur.prog : 'none', cno: cur ? cur.cno : '', cdt: cur ? (cur.cdt || '') : '',
    progs,
    fio: (o => o.length ? o[o.length - 1].fio : '')(owners.filter(x => !x.del)),
    owners, meters, rz,
    del: u.del || null,                   // помещение помечено на удаление — в пульте и расчёте его нет
  };
}

/** Полное состояние для интерфейса. */
/**
 * Отпечаток помещения — всё, что пишет putUnit: помещение, собственники, приборы, показания всех месяцев, договоры
 * разграничения и управления (04.10.2026, проверка сервера). Браузер получает его с помещением (_rev) и присылает при
 * записи; другой отпечаток — после загрузки помещение уже поменяли (другая вкладка или оператор, импорт, перенос начала,
 * корректировка, возврат копии) — запись отклоняется, чтобы не затереть чужое (раньше старая вкладка молча возвращала
 * прежние показания другого месяца и воссоздавала удалённое помещение).
 */
const crypto = require('crypto');
function unitRevs(only) {
  const idx = {}, at = n => idx[n] || (idx[n] = { u: null, o: [], m: [], r: [], c: [], p: [] });
  load('units').forEach(u => { if (!only || u.n === only) at(u.n).u = u; });
  const mu = {};
  load('meters').forEach(m => { if (only && m.unit !== only) return; mu[m.id] = m.unit; at(m.unit).m.push(m); });
  load('readings').forEach(r => { const n = mu[r.meter]; if (n != null) at(n).r.push(r); });
  [['owners', 'o'], ['contracts', 'c'], ['programs', 'p']].forEach(([t, k]) => load(t).forEach(x => { if (!only || x.unit === only) at(x.unit)[k].push(x); }));
  // отпечаток — от содержания, не от порядка строк в таблицах и не от пустых полей: сохранение без правок переставляет
  // записи помещения в конец таблиц — отпечаток от этого меняться не должен (иначе ложное «изменили в другом окне»)
  const canon = x => JSON.stringify(Object.keys(x).sort().filter(k => x[k] != null && x[k] !== '').reduce((a, k) => (a[k] = x[k], a), {}));
  const out = {};
  Object.keys(idx).forEach(n => {
    const e = idx[n]; if (!e.u) return;
    const parts = [canon(e.u), ...['o', 'm', 'r', 'c', 'p'].map(k => e[k].map(canon).sort().join('¶'))];
    out[n] = crypto.createHash('md5').update(parts.join('§')).digest('hex').slice(0, 16);
  });
  return out;
}
const unitRev = n => unitRevs(n)[n] || null;

function getState(period) {
  const s = load('settings');
  const per = period || s.period || '2026-06';
  const revs = unitRevs(), ix = unitIndex();
  return {
    settings: s,
    period: per,
    rows: load('units').map(u => Object.assign(buildUnit(u, per, ix), { _rev: revs[u.n] })),
    tariffs: load('tariffs'),
    external: load('external'),
    unitNames: load('unit_names'),
    periods: [...new Set(load('readings').map(r => r.period))].sort(),
    // что умеет сервер — браузер без этого не даёт делать то, что потерялось бы при записи:
    // del — пометка на удаление; contacts — телефоны, e-mail и представители собственника; who — кто внёс правку
    // files — вложения, описание и пометка акта у договоров разграничения (02.10.2026)
    caps: ['del', 'contacts', 'who', 'files', 'rev', 'refund'],   // refund — возврат переплаты деньгами (04.10.2026)
  };
}

/** Сравнение значений без ложных срабатываний на 1 против true и '' против null. */
function same(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
  // пусто против '' или [] — одно и то же; против 0 — нет (04.10.2026: «0» и «пусто» считались равными — замок акта не
  // держал начальное 0 нового счётчика, импорт и перенос не ставили показание 0 туда, где было пусто)
  if (a == null || b == null) { const x = a == null ? b : a; return x === '' || (Array.isArray(x) && !x.length); }
  return String(a) === String(b);
}

/** Отказ по проверке — с кодом ответа (проверка 05.10.2026): ошибка ввода — 400, нельзя по правилам (замок акта, серийник,
 *  закрытый месяц) — 409, копии нет — 404. Сервер отвечал на них 500 «ОШИБКА», как на сбой; сбой записи файла кода не
 *  несёт и остаётся 500 (server/index.js). */
const refuse = (msg, status) => Object.assign(new Error(msg), { status: status || 409 });
/** Даты приходят из интерфейса строками ГГГГ-ММ-ДД. Всё остальное — ошибка ввода, а не «пустая дата»:
 *  сравнение дат в расчёте строковое, и «12,05.2025» молча ломает отрезки. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(v, what) {
  if (v == null || v === '') return null;
  if (!ISO.test(String(v))) throw refuse(`${what}: дата «${v}» не в формате ГГГГ-ММ-ДД`, 400);
  // и настоящая дата: 2026-02-30 и 2026-13-01 проходили по виду, а акт с такой датой заводил «месяц 2026-13» (04.10.2026)
  const d = new Date(String(v) + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== String(v)) throw refuse(`${what}: даты «${v}» не бывает`, 400);
  return String(v);
}
/** Показание — число или пусто. «297,388» строкой раньше записывалось как есть, и перенос начала его не читал — стирал
 *  начало следующего месяца (04.10.2026). Строку с запятой или пробелами приводим к числу, не число — ошибка до записи. */
function readingNum(v, what) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { if (!isFinite(v)) throw refuse(`${what}: показание не число`, 400); return v; }
  const x = Number(String(v).replace(/\s/g, '').replace(',', '.'));   // \s — и неразрывные пробелы
  if (!isFinite(x) || String(v).trim() === '') throw refuse(`${what}: показание «${v}» — не число`, 400);
  return x;
}

const RES_NAME = { hvs: 'ХВС', gvs: 'ГВС', ee: 'Электро' };
const PROG_NAME = { none: 'не в управлении', hybrid: 'гибридная', trust: 'доверительная', share: 'долевая' };
const RES_SUP = { w: 'вода', e: 'электро', h: 'тепло' };
const FLD_NAME = {
  fl: 'этаж', t: 'тип', area: 'площадь', inodn: 'участие в ОДН',
  prog: 'программа управления', cno: '№ договора управления', cdt: 'дата договора управления',
};
const MFLD = {
  res: 'ресурс прибора', sn: 'серийный номер', k: 'коэффициент', prev: 'прошлое показание',
  cur: 'текущее показание', midRead: 'показание на дату разграничения',
  ownRead: 'показание на дату передачи собственнику',
  rz: 'разграничение прибора', bill: 'начисление по прибору', transit: 'транзит', note: 'примечание',
  from: 'установлен', to: 'снят',
};
/** Ручная пометка разграничения (прибор, тепло помещения) — словами СЛОВАРЯ ТЕРМИНОВ, три положения (проверка 05.10.2026:
 *  журнал писал «— → true», «true → —»). */
const RZ_WORD = v => v == null ? 'по договору разграничения' : (v ? 'разграничено вручную' : 'в счёт УК вручную');
/** Разница ручных пометок собственника (06.10.2026) для журнала: [что, было, стало]. a, b — cleanMarks. Прибор — по номеру из базы. */
function marksDiff(a, b) {
  a = a || {}; b = b || {};
  const out = [], val = (z, k, id) => (k === 'e' ? (z.e && isMark(z.e[id]) ? z.e[id] : null) : (isMark(z[k]) ? z[k] : null));
  [['w', 'вода (все водяные приборы)'], ['h', 'тепло']].forEach(([k, lab]) => { if (val(a, k) !== val(b, k)) out.push([lab, val(a, k), val(b, k)]); });
  const ids = [...new Set([...Object.keys(a.e || {}), ...Object.keys(b.e || {})])];
  ids.forEach(id => { if (val(a, 'e', id) === val(b, 'e', id)) return;
    const m = load('meters').find(x => x.id === id);
    out.push([`${RES_NAME.ee} ${m ? (m.sn || 'б/н') : id.split('|').pop()}`, val(a, 'e', id), val(b, 'e', id)]); });
  return out;
}
/** Значение поля прибора в журнале — словами, не true / false и не код ресурса. */
const MFLD_WORD = { res: v => RES_NAME[v] || v, bill: v => v === false ? 'не участвует в расчётах' : 'участвует в расчётах', transit: v => v ? 'да' : 'нет' };

/**
 * Какая прежняя запись стала какой присланной (собственники, договоры управления и разграничения) — для журнала и для
 * полей, которых старый интерфейс не присылает (04.10.2026, проверка сервера: сопоставление шло по номеру строки, и
 * удаление первой записи журнал писал правкой всех следующих — «собственник: Абразахова → Досов», «удалён собственник:
 * Досов»). Проходы: совпадают все ключевые поля → совпадает одно из них (по порядку важности) → по порядку среди
 * оставшихся. Возвращает pair[i] — номер прежней записи для i-й присланной (−1 — новая) и removed — прежние без пары.
 */
function matchRecs(prev, next, keys) {
  const pair = next.map(() => -1), used = new Set();
  const val = (x, k) => (x[k] == null || x[k] === '' ? null : String(x[k]));
  const sigs = [x => JSON.stringify(keys.map(k => val(x, k))), ...keys.map(k => x => val(x, k))];
  sigs.forEach(sig => next.forEach((x, i) => {
    if (pair[i] >= 0) return;
    const v = sig(x); if (v == null) return;
    const j = prev.findIndex((y, j) => !used.has(j) && sig(y) === v);
    if (j >= 0) { pair[i] = j; used.add(j); }
  }));
  let j = 0;
  next.forEach((x, i) => { if (pair[i] >= 0) return; while (j < prev.length && used.has(j)) j++; if (j < prev.length) { pair[i] = j; used.add(j); j++; } });
  return { pair, removed: prev.filter((_, k) => !used.has(k)) };
}

/** Прибор, посчитанный в снимке закрытого месяца, окончательно не удаляется и на сервере (в браузере — тоже): иначе
 *  закрытый месяц у помещения разошёлся бы со снимком без корректировки (04.10.2026, проверка сервера). */
function checkClosedRemoval(n, row) {
  if (!row.meters) return;
  const ids = new Set();
  load('closed_periods').forEach(c => { if (c.status === 'closed' && c.units && c.units[n]) (c.units[n].det || []).forEach(d => { if (d && d.m && d.m.id) ids.add(d.m.id); }); });
  if (!ids.size) return;
  load('meters').filter(m => m.unit === n && ids.has(m.id)).forEach(old => {
    if (!row.meters.some(m => (m.id && m.id === old.id) || ((m.sn || 'noSN') === (old.sn || 'noSN') && m.res === old.res)))
      throw refuse(`прибор ${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'} посчитан в закрытом месяце — удалить его окончательно нельзя`);
  });
}

/** Минус в числе для текста людям — «−» (U+2212), как на экране стенда; округлённое до нуля — без знака (B32, 05.10.2026). */
const ruMinus = s => (s.charAt(0) !== '-' ? s : /[1-9]/.test(s) ? '−' + s.slice(1) : s.slice(1));

/**
 * Замки актов замены: показание, зафиксированное актом, клиент менять не может, а прибор с таким
 * показанием — удалять и помечать на удаление; даты акта (у снятого — «по», у поставленного — «с») тоже не меняются.
 * Проверяется до первой записи, вместе с датами.
 */
function checkLocks(n, row, period) {
  if (!row.meters) return;
  const fv = v => (v == null || v === '' || !isFinite(+v) ? String(v) : ruMinus((+v).toLocaleString('ru-RU', { maximumFractionDigits: 6 })));   // «271,796», не «271.796» (проверка 05.10.2026)
  const rd = load('readings'), prevM = load('meters').filter(m => m.unit === n);
  row.meters.forEach(m => {
    const id = m.id || `${n}|${m.res}|${m.sn || 'noSN'}`;
    const per = new Set([...Object.keys(m.hist || {}), period]);
    per.forEach(p => {
      const ex = rd.find(r => r.meter === id && r.period === p);
      if (!ex || !(ex.lockPrev || ex.lockCur)) return;
      const src = p === period ? m : (m.hist || {})[p];
      if (!src) return;
      if (ex.lockPrev && src.prev !== undefined && !same(ex.prev, src.prev))
        throw refuse(`${RES_NAME[m.res] || m.res} ${m.sn || 'б/н'}, ${p}: прошлое показание ${fv(ex.prev)} зафиксировано актом замены — изменить нельзя`);
      if (ex.lockCur && src.cur !== undefined && !same(ex.cur, src.cur))
        throw refuse(`${RES_NAME[m.res] || m.res} ${m.sn || 'б/н'}, ${p}: текущее показание ${fv(ex.cur)} зафиксировано актом замены — изменить нельзя`);
    });
  });
  // как прибор участвует в акте: снят им (замок конечного) или поставлен (замок начального) — для текста отказа
  // (проверка 05.10.2026: новому прибору писалось «он снят датой акта»)
  const actHow = old => {
    const lk = rd.filter(r => r.meter === old.id && (r.lockPrev || r.lockCur));
    if (!lk.length) return '';
    return lk.some(r => r.lockCur) ? `он снят датой акта${old.to ? ' ' + old.to : ''}` : `он поставлен актом замены${old.from ? ' ' + old.from : ''}`;
  };
  // даты акта зафиксированы, как и его показания (проверка 05.10.2026): стёртое «по» у снятого актом возвращало старый прибор
  // в расчёт следующих месяцев вместе с новым, и у него снова появлялась «Заменить…» — второй акт на тот же прибор
  const acts = load('replacements').filter(a => a && a.unit === n);
  row.meters.forEach(m => {
    const was = m.id && prevM.find(x => x.id === m.id); if (!was) return;
    const tag = `${RES_NAME[was.res] || was.res} ${was.sn || 'б/н'}`;
    if (m.to !== undefined && (m.to || null) !== (was.to || null) && acts.some(a => a.old && a.old.id === was.id))
      throw refuse(`${tag}: снят ${was.to || ''} актом замены — дата снятия зафиксирована актом, изменить нельзя`);
    if (m.from !== undefined && (m.from || null) !== (was.from || null) && acts.some(a => a.new && a.new.id === was.id))
      throw refuse(`${tag}: поставлен ${was.from || ''} актом замены — дата установки зафиксирована актом, изменить нельзя`);
  });
  // пометка на удаление — первый шаг удаления, из расчёта прибор уходит сразу (проверка 05.10.2026: сервер её принимал, и
  // показания акта выпадали из месяца). Снять пометку и сохранить уже помеченный — можно
  row.meters.forEach(m => {
    if (!m.del) return;
    const old = prevM.find(x => (m.id && x.id === m.id) || (!m.id && (x.sn || 'noSN') === (m.sn || 'noSN') && x.res === m.res));
    const how = old && !old.del ? actHow(old) : '';
    if (how) throw refuse(`${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}: прибор участвует в акте замены, пометить на удаление нельзя — ${how}`);
  });
  prevM.forEach(old => {
    const kept = row.meters.some(m => (m.id && m.id === old.id) || ((m.sn || 'noSN') === (old.sn || 'noSN') && m.res === old.res));
    const how = kept ? '' : actHow(old);
    if (how) throw refuse(`${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}: прибор участвует в акте замены, удалить нельзя — ${how}`);
  });
}

/**
 * Серийный номер счётчика с показаниями не меняется (заказчик, 02.10.2026) — новый счётчик ставит акт замены (`replaceMeter`). Перепечатанный серийник переносил показания
 * всех месяцев на «новый» прибор без даты замены. Поправить опечатку можно, пока у счётчика нет показаний.
 * Ресурс — так же (проверка 05.10.2026): номер прибора — помещение|ресурс|серийник, и ХВС → Электро переносил показания всех
 * месяцев на «электро» — кубометры воды начислялись как кВт·ч.
 */
function checkSerials(n, row) {
  if (!row.meters) return;
  const prevM = load('meters').filter(m => m.unit === n), rd = load('readings');
  const has = id => rd.some(r => r.meter === id && [r.prev, r.cur, r.midRead, r.ownRead].some(v => v != null && v !== ''));
  row.meters.forEach(m => {
    const old = m.id && prevM.find(x => x.id === m.id);
    if (old && (m.sn || '') !== (old.sn || '') && has(old.id))
      throw refuse(`${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}: у счётчика есть показания — серийный номер не меняется; новый счётчик — «Заменить…»`);
    if (old && m.res !== old.res && has(old.id))
      throw refuse(`${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}: у счётчика есть показания — ресурс не меняется; другой прибор — «+ ХВС» / «+ ГВС» / «+ Электро» или «Заменить…»`);
  });
}

/**
 * Вложения договора разграничения — сканы и фото договора и акта (заказчик, 02.10.2026). Файл лежит в data/files под именем id (его выдаёт POST /api/files),
 * в договоре — только его описание. part — к чему: dog — договор, act — акт опломбировки; del — пометка на удаление.
 */
const FILE_ID = /^[\w.-]{1,80}$/;
function cleanFiles(list) {
  return (Array.isArray(list) ? list : []).filter(f => f && FILE_ID.test(String(f.id || ''))).map(f => ({
    id: String(f.id), name: String(f.name || f.id).slice(0, 200), type: String(f.type || '').slice(0, 60),
    size: Math.max(0, Number(f.size) || 0), at: String(f.at || ''), by: String(f.by || '').slice(0, 80),
    part: f.part === 'act' ? 'act' : 'dog', ...(f.del ? { del: String(f.del) } : {}),
  }));
}
/** Акт опломбировки, помеченный на удаление: в расчёте акта нет (seal пуст), «снять пометку» возвращает дату и номер. */
function cleanActDel(a, no) {
  if (!a || !a.seal) return null;
  return { seal: isoDate(a.seal, `помеченный акт опломбировки ${no || 'б/н'}`), sealNo: String(a.sealNo || ''), del: String(a.del || '') };
}

/** Следующий месяц ГГГГ-ММ. */
const nextPer = p => { const [y, m] = String(p).split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
/**
 * Начало месяца = конец прошлого месяца в стенде — у всех приборов (заказчик, 02.10.2026): в квитанции конечные показания
 * прошлого месяца совпадают с начальными этого, разница с файлом поставщика уходит на ОДН. Начальное месяца Q = конечное
 * месяца P (предыдущего) у того же прибора: пометка prevSrc 'carry'; у нового
 * счётчика в месяце после акта замены — 'act:<акт>' и подпись «конечное за месяц замены» (там же правило «новый счётчик
 * после акта замены»). Поправили конечное — начало следующего месяца следом; стёрли — перенесённое снимается.
 * Не трогаем: замок акта (lockPrev), начальное, внесённое руками ('manual') или корректировкой ('adj:…'), закрытый месяц Q.
 * Месяц Q — только уже заведённый в базе (будущий месяц переносом не заводится); прибор вне месяца Q (снят, ещё не
 * установлен, помечен на удаление) — его запись не создаётся и не меняется (проверка 05.10.2026: акт замены переписывал
 * начало следующего месяца у снятого прибора — лишняя строка журнала и серый «расход» в форме; в квитанции его нет).
 * Прибор вернулся в месяц (сняли пометку, стёрли дату «по») — начало подтянется при следующей записи помещения.
 * n — помещение (null — вся база); dry — только посчитать.
 * Возвращает, сколько начальных показаний изменено (или изменилось бы).
 */
const isAutoStart = s => s === 'carry' || String(s || '').startsWith('act:');
function carryStarts(n, dry) {
  if (!dry && !LOG_BATCH) return batchLog(() => carryStarts(n, dry));   // журнал — одной записью файла в конце
  const rd = load('readings');
  const periods = [...new Set(rd.map(r => r.period))].sort(), known = new Set(periods);
  const closed = new Set(load('closed_periods').filter(c => c.status === 'closed').map(c => c.period));
  const acts = {}; load('replacements').forEach(a => { if (a && a.new && a.new.id && a.period) acts[a.new.id + '|' + a.period] = a; });
  const idx = {}; rd.forEach(r => { idx[r.meter + '|' + r.period] = r; });
  const bounds = p => { const [y, m] = p.split('-').map(Number); return [`${p}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)]; };
  let changed = 0;
  load('meters').filter(m => !n || m.unit === n).forEach(m => {
    periods.forEach(P => {
      const Q = nextPer(P); if (!known.has(Q) || closed.has(Q)) return;
      const [qs, qe] = bounds(Q);
      if (m.del || (m.to && m.to < qs) || (m.from && m.from > qe)) return;               // прибора в месяце Q нет — его запись не трогаем
      const src = idx[m.id + '|' + P], end = src && src.cur != null && src.cur !== '' ? Number(src.cur) : null;
      let rec = idx[m.id + '|' + Q];
      if (rec && (rec.lockPrev || (rec.prevSrc && !isAutoStart(rec.prevSrc)))) return;   // замок акта, руками, корректировкой
      const act = acts[m.id + '|' + P], tag = act ? 'act:' + act.id : 'carry';
      const what = `начальное показание · ${RES_NAME[m.res] || m.res} ${m.sn || 'б/н'} (${act ? 'конечное за месяц замены' : 'конец прошлого месяца'} ${P})`;
      if (end == null) {                                                                  // конечное стёрли — перенесённое снять
        if (rec && isAutoStart(rec.prevSrc)) { changed++; if (!dry) { logChange(m.unit, what, rec.prev, '', Q); rec.prev = null; delete rec.prevSrc; delete rec.prevNote; } }
        return;
      }
      if (rec && same(rec.prev, end) && (rec.prevSrc === tag || (!rec.prevSrc && !act))) return;   // уже так
      changed++;
      if (dry) return;
      if (!rec) { rec = { meter: m.id, period: Q, prev: null, cur: null, midRead: null, ownRead: null }; rd.push(rec); idx[m.id + '|' + Q] = rec; }
      if (!same(rec.prev, end)) logChange(m.unit, what, rec.prev == null ? '' : rec.prev, end, Q);
      rec.prev = end; rec.prevSrc = tag;
      if (act) rec.prevNote = `конечное за месяц замены (${P}) — новый счётчик`; else delete rec.prevNote;
    });
  });
  if (changed && !dry) save('readings');
  return changed;
}

/** Разбор помещения обратно в таблицы. Пишет только то, что изменилось. */
function putUnit(n, row, period) {
  const units = load('units');
  let u = units.find(x => x.n === n);
  // номер помещения не меняется (заказчик, 02.10.2026): смена номера задваивала собственника,
  // приборы и договоры помещения, а на занятый номер сливала два помещения в одно (чек-лист 1.4)
  if (row.n && row.n !== n) throw refuse(`номер помещения не меняется: ${n}`);
  // проверяем даты до первой записи, чтобы ошибка ввода не оставила помещение сохранённым наполовину
  if (row.cdt !== undefined) row.cdt = isoDate(row.cdt, 'дата договора управления') || '';
  (row.owners || []).forEach(o => { o.from = isoDate(o.from, `владеет с (${o.fio || 'без имени'})`); o.to = isoDate(o.to, `владеет по (${o.fio || 'без имени'})`); });
  Object.keys(row.rz || {}).forEach(res => (row.rz[res] || []).forEach(s => {
    s.from = isoDate(s.from, `договор ${s.no || 'б/н'} с`); s.to = isoDate(s.to, `договор ${s.no || 'б/н'} по`); s.seal = isoDate(s.seal, `акт опломбировки ${s.no || 'б/н'}`);
    // помеченный акт, вложения, описание (02.10.2026): не прислал — останутся прежние (см. запись ниже)
    if (s.actDel !== undefined) s.actDel = cleanActDel(s.actDel, s.no);
    if (s.files !== undefined) s.files = cleanFiles(s.files);
    if (s.note !== undefined) s.note = String(s.note == null ? '' : s.note).slice(0, 4000);
  }));
  (row.meters || []).forEach(m => {
    if (!RES_NAME[m.res]) throw refuse(`прибор ${m.sn || 'б/н'}: неизвестный ресурс «${m.res}»`, 400);
    if (m.from !== undefined) m.from = isoDate(m.from, `прибор ${m.sn || 'б/н'} установлен`);
    if (m.to !== undefined) m.to = isoDate(m.to, `прибор ${m.sn || 'б/н'} снят`);
    const tag = `${RES_NAME[m.res] || m.res} ${m.sn || 'б/н'}`;
    ['prev', 'cur', 'midRead', 'ownRead'].forEach(f => { if (m[f] !== undefined) m[f] = readingNum(m[f], tag); });
    Object.keys(m.hist || {}).forEach(p => { const h = m.hist[p]; if (h) ['prev', 'cur', 'midRead', 'ownRead'].forEach(f => { if (h[f] !== undefined) h[f] = readingNum(h[f], `${tag}, ${p}`); }); });
  });
  (row.progs || []).forEach(p => {
    if (!PROG_NAME[p.prog]) throw refuse(`неизвестная программа управления «${p.prog}»`, 400);
    p.cdt = isoDate(p.cdt, `дата договора управления ${p.cno || 'б/н'}`); p.from = isoDate(p.from, `в управлении с (${p.cno || 'б/н'})`); p.to = isoDate(p.to, `в управлении по (${p.cno || 'б/н'})`);
  });
  checkLocks(n, row, period);
  checkSerials(n, row);
  checkClosedRemoval(n, row);
  if (!u) { u = { n }; units.push(u); logChange(n, 'помещение создано', '', n, period); }

  // одна смена собственника в месяц (заказчик, 06.10.2026) — до первой записи
  if (row.owners) {
    const own = row.owners.filter(o => o && !o.del).slice().sort((a, b) => ((a.from || '') < (b.from || '')) ? -1 : 1), seen = new Set();
    own.slice(1).forEach(o => { if (!o.from) return; const mm = String(o.from).slice(0, 7);
      if (seen.has(mm)) throw refuse(`помещение ${n}: в этом месяце уже есть смена собственника (${mm})`); seen.add(mm); });
  }
  // пометки разграничения старого вида (на приборе, тепло на помещении) — к собственнику, до записи (06.10.2026); row.rzH и meters[].rz
  // больше не пишутся: пометка — у собственника (owners[].rz)
  moveUnitMarks(n);
  if (row.del !== undefined && !same(u.del || null, row.del || null)) {
    logChange(n, row.del ? 'помещение помечено на удаление' : 'снята пометка удаления с помещения', u.del || '', row.del || '', period);
    if (row.del) u.del = row.del; else delete u.del;
  }
  ['fl', 't', 'area'].forEach(f => {
    if (row[f] !== undefined && !same(u[f], row[f])) {
      logChange(n, FLD_NAME[f] || f, u[f], row[f], period);
      u[f] = row[f];
    }
  });
  // участие в ОДН — «да / нет», в базе true / false (проверка 05.10.2026: журнал писал «1 → false»); не участвует только
  // false — как читает buildUnit
  if (row.inodn !== undefined && (u.inodn !== false) !== (row.inodn !== false)) {
    const yn = v => v === false ? 'нет' : 'да';
    logChange(n, FLD_NAME.inodn, yn(u.inodn), yn(row.inodn), period);
    u.inodn = row.inodn !== false;
  }
  // ---- договоры управления ----
  if (row.progs) {
    const prev = load('programs').filter(p => p.unit === n), mp = matchRecs(prev, row.progs, ['cno', 'from', 'prog', 'cdt', 'to']);
    row.progs.forEach((p, i) => {
      const was = mp.pair[i] >= 0 ? prev[mp.pair[i]] : null;
      const tag = `${PROG_NAME[p.prog]} ${p.cno || 'б/н'}`;
      if (!was) return logChange(n, 'добавлен договор управления', '', `${tag}${p.from ? ' с ' + p.from : ''}`, period);
      if (!same(was.del || null, p.del || null))
        logChange(n, p.del ? 'договор управления помечен на удаление' : 'снята пометка удаления · договор управления', tag, p.del ? 'помечен' : 'действует', period);
      ['prog', 'cno', 'cdt', 'from', 'to'].forEach(f => {
        if (!same(was[f], p[f]))
          logChange(n, `${({ prog: 'программа управления', cno: '№ договора управления', cdt: 'дата договора управления', from: 'в управлении с', to: 'в управлении по' })[f]} · ${p.cno || 'б/н'}`,
                    f === 'prog' ? PROG_NAME[was[f]] : was[f], f === 'prog' ? PROG_NAME[p[f]] : p[f], period);
      });
    });
    mp.removed.forEach(x => logChange(n, 'удалён договор управления', `${PROG_NAME[x.prog]} ${x.cno || 'б/н'}`, '', period));
    const others = load('programs').filter(p => p.unit !== n);
    row.progs.forEach(p => others.push({ unit: u.n, prog: p.prog, cno: p.cno || '', cdt: p.cdt || null, from: p.from || null, to: p.to || null, ...(p.del ? { del: p.del } : {}) }));
    cache.programs = others; save('programs');
    // units.prog/cno/cdt — кэш последнего договора для внешних читателей (сверка); источник — programs
    const last = row.progs.filter(p => !p.del).sort((a, b) => ((a.from || '') < (b.from || '')) ? -1 : 1).pop();
    u.prog = last ? last.prog : 'none'; u.cno = last ? (last.cno || '') : ''; u.cdt = last ? (last.cdt || '') : '';
  }
  save('units');

  // ---- собственники ----
  if (row.owners) {
    const prev = load('owners').filter(o => o.unit === n), mo = matchRecs(prev, row.owners, ['fio', 'from', 'to']);
    row.owners.forEach((o, i) => {
      const p = mo.pair[i] >= 0 ? prev[mo.pair[i]] : null;
      if (!p) { logChange(n, 'добавлен собственник', '', o.fio || '(без имени)', period);
        marksDiff(null, cleanMarks(o.rz)).forEach(([what, a, b]) => logChange(n, `ручная пометка разграничения · ${what} · ${o.fio || 'собственник'}`, RZ_WORD(a), RZ_WORD(b), period));
        return; }
      if (!same(p.del || null, o.del || null))
        logChange(n, o.del ? 'запись о собственнике помечена на удаление' : 'снята пометка удаления · собственник', o.fio || '', o.del ? 'помечена' : 'действует', period);
      // контакты: телефоны и e-mail — списком, представители — «ФИО · телефоны · e-mail · основание»
      const L = a => (a || []).filter(Boolean).join(', ');
      const R = a => (a || []).map(x => [x.fio, L(x.phones), L(x.emails), x.basis].filter(Boolean).join(' · ')).join('; ');
      if (o.phones !== undefined && L(p.phones) !== L(o.phones)) logChange(n, `телефон собственника · ${o.fio || ''}`, L(p.phones), L(o.phones), period);
      if (o.emails !== undefined && L(p.emails) !== L(o.emails)) logChange(n, `e-mail собственника · ${o.fio || ''}`, L(p.emails), L(o.emails), period);
      if (o.reps !== undefined && R(p.reps) !== R(o.reps)) logChange(n, `представитель собственника · ${o.fio || ''}`, R(p.reps), R(o.reps), period);
      if (o.rz !== undefined) marksDiff(cleanMarks(p.rz), cleanMarks(o.rz)).forEach(([what, a, b]) => logChange(n, `ручная пометка разграничения · ${what} · ${o.fio || 'собственник'}`, RZ_WORD(a), RZ_WORD(b), period));
      ['fio', 'from', 'to'].forEach(f => {
        if (!same(p[f], o[f]))
          logChange(n, ({ fio: 'собственник', from: 'владеет с', to: 'владеет по' })[f], p[f], o[f], period);
      });
    });
    mo.removed.forEach(x => logChange(n, 'удалён собственник', x.fio || '(без имени)', '', period));

    const others = load('owners').filter(o => o.unit !== n);
    // контакты с прежней записи, если браузер их не прислал (старый интерфейс) — не терять
    row.owners.forEach((o, i) => { const p = (mo.pair[i] >= 0 ? prev[mo.pair[i]] : null) || {}; const pick = f => (o[f] !== undefined ? o[f] : p[f]) || [];
      const ph = pick('phones').map(x => String(x).trim()).filter(Boolean), em = pick('emails').map(x => String(x).trim()).filter(Boolean);
      const rp = pick('reps').map(x => ({ fio: String(x.fio || '').trim(), phones: (x.phones || []).map(y => String(y).trim()).filter(Boolean),
        emails: (x.emails || []).map(y => String(y).trim()).filter(Boolean), basis: String(x.basis || '').trim(), note: String(x.note || '').trim() }))
        .filter(x => x.fio || x.phones.length || x.emails.length);
      // ручные пометки разграничения (06.10.2026): не прислал браузер — с прежней записи
      const mk = cleanMarks(o.rz !== undefined ? o.rz : p.rz);
      others.push({ unit: u.n, fio: o.fio || '', from: o.from || null, to: o.to || null, ...(o.del ? { del: o.del } : {}),
        ...(ph.length ? { phones: ph } : {}), ...(em.length ? { emails: em } : {}), ...(rp.length ? { reps: rp } : {}), ...(mk ? { rz: mk } : {}) }); });
    cache.owners = others; save('owners');
  }

  // ---- приборы и показания ----
  if (row.meters) {
    const prevM = load('meters').filter(m => m.unit === n);
    const prevR = load('readings');
    const others = load('meters').filter(m => m.unit !== n);
    const rdOthers = prevR.filter(r => !r.meter.startsWith(n + '|'));
    // номер прибора (id) постоянный (04.10.2026, проверка сервера): раньше пересчитывался по порядку — после удаления
    // первого из двух приборов «б/н» второй получал его номер и его показания, а счётчик после акта замены терял связь с
    // актом. Свой id прибор сохраняет, пока тот же ресурс и серийник; новый (или с исправленным серийником) получает
    // свободный «помещение|ресурс|серийник[#k]»
    const keep = new Set(row.meters.filter(m => m.id && prevM.some(x => x.id === m.id && x.res === m.res && (x.sn || '') === (m.sn || ''))).map(m => m.id));
    const taken = new Set(keep), remap = {};

    row.meters.forEach(m => {
      let id;
      if (m.id && keep.has(m.id)) { id = m.id; keep.delete(m.id); }   // тот же id дважды в присланном — второй получит новый
      else { const base = `${u.n}|${m.res}|${m.sn || 'noSN'}`; id = base; for (let k = 2; taken.has(id); k++) id = `${base}#${k}`; }
      taken.add(id);
      const old = prevM.find(x => x.id === (m.id || id)) || prevM.find(x => x.id === id);
      const tag = `${RES_NAME[m.res] || m.res} ${m.sn || 'б/н'}`;

      if (old && !same(old.del || null, m.del || null))
        logChange(n, m.del ? `прибор помечен на удаление · ${tag}` : `снята пометка удаления · ${tag}`, '', '', period);
      if (!old) logChange(n, 'добавлен прибор', '', tag, period);
      else {
        // значения словами (проверка 05.10.2026): разграничение — три положения, сравнение явное — same() считает пусто и
        // false равными, и «по договору ↔ в счёт УК вручную» в журнал не попадало; галочки — по смыслу, как их читает buildUnit
        const flag = { bill: v => v !== false, transit: v => !!v };
        ['res', 'sn', 'k', 'bill', 'transit', 'note', 'from', 'to'].forEach(f => {
          if (m[f] === undefined || (flag[f] ? flag[f](old[f]) === flag[f](m[f]) : same(old[f], m[f]))) return;
          const w = MFLD_WORD[f] || (v => v);
          logChange(n, `${MFLD[f] || f} · ${tag}`, w(old[f]), w(m[f]), period);
        });
      }

      const oldRd = prevR.find(r => r.meter === (m.id || id) && r.period === period);
      ['prev', 'cur', 'midRead', 'ownRead'].forEach(f => {
        const was = oldRd ? oldRd[f] : null;
        if (m[f] !== undefined && !same(was, m[f]))
          logChange(n, `${MFLD[f]} · ${tag}`, was, m[f], period);
      });

      if (m.id && m.id !== id) remap[m.id] = id;   // номер прибора сменился (исправлен серийник без показаний) — пометку электро следом
      others.push({ id, unit: u.n, res: m.res, sn: m.sn || '', k: m.k == null ? 1 : m.k,
                    transit: !!m.transit, bill: m.bill !== false, note: m.note || '',
                    from: m.from !== undefined ? (m.from || null) : (old && old.from) || null,
                    to: m.to !== undefined ? (m.to || null) : (old && old.to) || null,
                    ...(m.del ? { del: m.del } : {}) });

      const hist = m.hist || {};
      new Set([...Object.keys(hist), period]).forEach(p => {
        const src = p === period ? { prev: m.prev, cur: m.cur, midRead: m.midRead, ownRead: m.ownRead, prevSrc: m.prevSrc, prevNote: m.prevNote } : hist[p];
        if (!src) return;
        // для других периодов midRead/ownRead берём из hist, а если клиент их не прислал — из прежней записи; не обнуляем
        const ex = prevR.find(r => r.meter === (m.id || id) && r.period === p);
        const pick = f => src[f] !== undefined ? (src[f] == null ? null : src[f]) : (ex && ex[f] != null ? ex[f] : null);
        const rec = { meter: id, period: p, prev: src.prev == null ? null : src.prev, cur: src.cur == null ? null : src.cur,
                      midRead: pick('midRead'), ownRead: pick('ownRead') };
        // замки ставит только акт замены (replaceMeter); клиент их не присылает и не снимает
        if (ex && ex.lockPrev) rec.lockPrev = true;
        if (ex && ex.lockCur) rec.lockCur = true;
        // пометка каскада корректировки: клиент присылает её, только когда правит начальное показание руками ('manual')
        const ps = src.prevSrc !== undefined ? src.prevSrc : (ex ? ex.prevSrc : null);
        if (ps) { rec.prevSrc = ps; const pn = src.prevNote !== undefined ? src.prevNote : (ex ? ex.prevNote : null); if (pn != null) rec.prevNote = pn; }   // пустую подпись не пишем (04.10.2026: сохранение без правок добавляло prevNote:null 783 записям)
        // прибор без показаний за период — пустую запись не плодим (если её не было раньше)
        if (rec.prev == null && rec.cur == null && rec.midRead == null && rec.ownRead == null && !ex) return;
        rdOthers.push(rec);
      });
    });

    prevM.forEach(old => {
      // прибор удалён, если его нет ни по id (переименованный серийник приходит со старым id), ни по серийнику
      if (!row.meters.some(m => (m.id && m.id === old.id) || ((m.sn || 'noSN') === (old.sn || 'noSN') && m.res === old.res)))
        logChange(n, 'удалён прибор', `${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}`, '', period);
    });
    // месяц, которого браузер не прислал (открыт до импорта или до переноса начала), — не теряем: браузер показания
    // не удаляет, а стирает значения; запись пропадает только вместе с прибором
    prevR.forEach(r => {
      if (!r.meter.startsWith(n + '|')) return;
      if (!others.some(m => m.id === r.meter) || rdOthers.some(x => x.meter === r.meter && x.period === r.period)) return;
      rdOthers.push(r);
    });

    cache.meters = others; save('meters');
    cache.readings = rdOthers; save('readings');
    // пометка электросчётчика — по номеру прибора: номер сменился (исправлен серийник без показаний) — пометка следом (06.10.2026)
    if (Object.keys(remap).length) {
      let ch = false;
      load('owners').filter(o => o.unit === n && o.rz && o.rz.e).forEach(o => { const e = {};
        Object.keys(o.rz.e).forEach(id => { const to = remap[id] || id; if (to !== id) ch = true; e[to] = o.rz.e[id]; });
        o.rz = Object.assign({}, o.rz, { e }); });
      if (ch) save('owners');
    }
  }

  // ---- договоры разграничения ----
  if (row.rz) {
    const prevC = load('contracts').filter(c => c.unit === n);
    const actTxt = a => `${a.seal || ''}${a.sealNo ? ' №' + a.sealNo : ''}`, PART = { dog: 'договор', act: 'акт' };
    const resAll = [...new Set([...Object.keys(row.rz), ...prevC.map(c => c.res)])], mc = {};
    resAll.forEach(res => { mc[res] = matchRecs(prevC.filter(c => c.res === res), row.rz[res] || [], ['no', 'from', 'seal', 'to']); });
    resAll.forEach(res => {
      const was = prevC.filter(c => c.res === res);
      (row.rz[res] || []).forEach((s, i) => {
        const p = mc[res].pair[i] >= 0 ? was[mc[res].pair[i]] : null;
        if (!p) return logChange(n, `добавлен договор разграничения · ${RES_SUP[res]}`, '', s.no || '(без номера)', period);
        const tag = `${RES_SUP[res]} № ${s.no || 'б/н'}`;
        if (!same(p.del || null, s.del || null))
          logChange(n, s.del ? `договор разграничения помечен на удаление · ${RES_SUP[res]}` : `снята пометка удаления · договор разграничения · ${RES_SUP[res]}`, s.no || 'б/н', s.del ? 'помечен' : 'действует', period);
        // акт помечен на удаление / пометка снята / помеченный удалён окончательно — одной строкой, без «акт: дата → пусто»
        const ad0 = p.actDel || null, ad1 = s.actDel === undefined ? ad0 : s.actDel;
        const actMark = !ad0 && !!ad1 && !s.seal, actBack = !!ad0 && !ad1 && !!s.seal && !p.seal;
        if (actMark) logChange(n, `акт опломбировки помечен на удаление · ${tag}`, actTxt(ad1), 'помечен', period);
        else if (actBack) logChange(n, `снята пометка удаления · акт опломбировки · ${tag}`, 'помечен', actTxt(s), period);
        else if (ad0 && !ad1) logChange(n, `удалён помеченный акт опломбировки · ${tag}`, actTxt(ad0), '', period);
        ['no', 'from', 'to', 'seal', 'sealNo', 'owner'].forEach(f => {
          if ((actMark || actBack) && (f === 'seal' || f === 'sealNo')) return;
          if (!same(p[f], s[f]))
            logChange(n, `${({ no: '№ договора', from: 'договор с', to: 'договор по',
                               seal: 'акт опломбировки', sealNo: '№ акта опломбировки', owner: 'чей договор' })[f]} · ${RES_SUP[res]}`, p[f], s[f], period);
        });
        if (!same(p.byDays, s.byDays))
          logChange(n, `делить по дням без показания на дату начала · ${RES_SUP[res]} № ${s.no || 'б/н'}`, p.byDays ? 'да' : 'нет', s.byDays ? 'да' : 'нет', period);
        if (!same(p.autoClosed, s.autoClosed) && s.autoClosed)
          logChange(n, `договор ${s.no || 'б/н'} закрыт при смене собственника · ${RES_SUP[res]}`, p.to || 'бессрочно', s.to, period);
        if (!same(p.fact, s.fact))
          logChange(n, `по факту · ${RES_SUP[res]}`, p.fact ? 'да' : 'нет', s.fact ? 'да' : 'нет', period);
        if (s.note !== undefined && !same(p.note || '', s.note || ''))
          logChange(n, `описание договора · ${tag}`, p.note || '', s.note || '', period);
        if (s.files !== undefined) {
          const pf = p.files || [], sf = s.files || [];
          sf.forEach(f => {
            const o = pf.find(x => x.id === f.id);
            if (!o) logChange(n, `вложение добавлено · ${tag} · ${PART[f.part]}`, '', f.name, period);
            else if (!same(o.del || null, f.del || null))
              logChange(n, f.del ? `вложение помечено на удаление · ${tag}` : `снята пометка удаления · вложение · ${tag}`, f.name, f.del ? 'помечено' : 'действует', period);
          });
          pf.forEach(o => { if (!sf.some(f => f.id === o.id)) logChange(n, `вложение удалено · ${tag}`, o.name, '', period); });
        }
      });
      mc[res].removed.forEach(x => logChange(n, `удалён договор разграничения · ${RES_SUP[res]}`, x.no || 'б/н', '', period));
    });

    const others = load('contracts').filter(c => c.unit !== n);
    Object.keys(row.rz).forEach(res => {
      const was = prevC.filter(c => c.res === res);
      (row.rz[res] || []).forEach((s, i) => {
        // описание, вложения и помеченный акт: интерфейс до 02.10.2026 их не присылает — берём из прежней записи
        const p = (mc[res].pair[i] >= 0 ? was[mc[res].pair[i]] : null) || {};
        const note = s.note !== undefined ? s.note : (p.note || ''), files = s.files !== undefined ? s.files : (p.files || []);
        const actDel = s.actDel !== undefined ? s.actDel : (p.actDel || null);
        others.push({ unit: u.n, res, no: s.no || '', from: s.from || null, to: s.to || null,
                      seal: s.seal || null, sealNo: s.sealNo || '', byDays: !!s.byDays, owner: s.owner || '',
                      autoClosed: s.autoClosed || null, checked: !!s.checked, fact: !!s.fact, ...(s.del ? { del: s.del } : {}),
                      ...(note ? { note } : {}), ...(files.length ? { files } : {}), ...(actDel ? { actDel } : {}) });
      });
    });
    cache.contracts = others; save('contracts');
  }

  carryStarts(n);   // начало месяца = конец прошлого (и у нового счётчика после акта замены — конечное за месяц замены)
  return buildUnit(u, period);
}

function deleteUnit(n) {
  backup('del-' + n);   // удаление необратимо: показания за все периоды уходят вместе с помещением — копия обязательна
  cache.units = load('units').filter(u => u.n !== n); save('units');
  ['owners', 'meters', 'contracts'].forEach(t => {
    cache[t] = load(t).filter(x => x.unit !== n); save(t);
  });
  cache.readings = load('readings').filter(r => !r.meter.startsWith(n + '|')); save('readings');
  cache.replacements = load('replacements').filter(x => x.unit !== n); save('replacements');
  cache.programs = load('programs').filter(x => x.unit !== n); save('programs');
  logChange(n, 'помещение удалено', n, '', null);
}

/**
 * Акт замены прибора. Старый снимается датой акта с конечным показанием, новый ставится
 * той же датой с начальным; оба показания фиксируются (lockCur / lockPrev) и больше не
 * меняются ни из карточки, ни импортом. В месяце замены считаются оба прибора: старый —
 * от прошлого показания до конечного, новый — от начального до текущего; со следующего
 * месяца старый в расчёт не входит по дате снятия, показания за все периоды остаются.
 * Показания акта — неизменяемая фиксация на день замены (заказчик, 16.09.2026).
 */
function replaceMeter(n, spec, period) {
  const u = load('units').find(x => x.n === n);
  if (!u) throw new Error('помещение не найдено');
  const old = load('meters').find(m => m.unit === n && m.id === spec.oldId);
  if (!old) throw new Error('прибор не найден');
  if (old.to) throw new Error(`прибор ${old.sn || 'б/н'} уже снят ${old.to}`);
  // второй акт на тот же прибор — нет (проверка 05.10.2026: со стёртой датой «по» старый прибор принимал ещё один акт)
  if (load('replacements').some(a => a && a.unit === n && a.old && a.old.id === old.id)) throw new Error(`прибор ${old.sn || 'б/н'} уже снят актом замены`);
  const date = isoDate(spec.date, 'дата замены');
  if (!date) throw new Error('нужна дата замены');
  const fin = Number(spec.finalRead), ini = Number(spec.initialRead);
  if (spec.finalRead === '' || spec.finalRead == null || !isFinite(fin)) throw new Error('нужно конечное показание старого прибора');
  if (spec.initialRead === '' || spec.initialRead == null || !isFinite(ini)) throw new Error('нужно начальное показание нового прибора');
  const newSn = String(spec.newSn || '').trim();
  if (!newSn) throw new Error('нужен серийный номер нового прибора');
  if (load('meters').some(m => m.unit === n && m.res === old.res && m.sn === newSn && !m.to))
    throw new Error(`прибор ${newSn} уже есть в помещении`);
  const per = date.slice(0, 7);
  // дата акта в закрытом месяце (или раньше последнего закрытого) — отказ (04.10.2026, проверка сервера): акт фиксирует
  // показания закрытого месяца под замок, расхождение со снимком потом не убрать ни правкой, ни корректировкой
  const lastClosed = load('closed_periods').filter(c => c.status === 'closed').map(c => c.period).sort().pop();
  if (lastClosed && per <= lastClosed) throw new Error(`дата замены ${date} — в закрытом периоде (последний закрытый — ${lastClosed}); замена прибора задним числом в закрытом месяце не оформляется`);
  const rd = load('readings');
  const oldRd = rd.find(r => r.meter === old.id && r.period === per);
  if (oldRd && oldRd.lockCur) throw new Error('конечное показание уже зафиксировано другим актом');
  if (oldRd && oldRd.prev != null && fin < Number(oldRd.prev))
    throw new Error(`конечное показание ${fin} меньше прошлого ${oldRd.prev} за ${per}`);
  const k = spec.newK == null || spec.newK === '' ? (old.k == null ? 1 : old.k) : Number(spec.newK);
  const tagOld = `${RES_NAME[old.res] || old.res} ${old.sn || 'б/н'}`, tagNew = `${RES_NAME[old.res] || old.res} ${newSn}`;

  // старый: снят датой акта, конечное показание за месяц замены зафиксировано
  old.to = date;
  old.note = ((old.note || '') + ` · снят ${date}, замена на ${newSn}`).replace(/^ · /, '');
  if (oldRd) { oldRd.cur = fin; oldRd.lockCur = true; }
  else rd.push({ meter: old.id, period: per, prev: null, cur: fin, midRead: null, ownRead: null, lockCur: true });
  // новый: установлен датой акта, начальное показание зафиксировано
  const base = `${n}|${old.res}|${newSn}`;
  const id = load('meters').some(m => m.id === base) ? `${base}#${Date.now()}` : base;
  load('meters').push({ id, unit: n, res: old.res, sn: newSn, k, transit: false, bill: true,
                        note: `установлен ${date} взамен ${old.sn || 'б/н'}`, from: date, to: null });
  // ручная пометка разграничения старого счётчика — и на новый (заказчик, 06.10.2026): электро — по номеру прибора у каждого собственника; вода — одна на все водяные
  // приборы помещения, новый получает её сам
  moveUnitMarks(n);
  load('owners').filter(o => o.unit === n && o.rz && o.rz.e && isMark(o.rz.e[old.id])).forEach(o => {
    o.rz = Object.assign({}, o.rz, { e: Object.assign({}, o.rz.e, { [id]: o.rz.e[old.id] }) });
    logChange(n, `ручная пометка разграничения · ${RES_NAME[old.res] || old.res} ${newSn} · ${o.fio || 'собственник'} (перенесена с ${old.sn || 'б/н'} актом замены)`, RZ_WORD(null), RZ_WORD(o.rz.e[id]), per);
  });
  save('owners'); save('units');
  rd.push({ meter: id, period: per, prev: ini, cur: null, midRead: null, ownRead: null, lockPrev: true });
  save('meters'); save('readings');

  const act = { id: `${n}|${old.res}|${date}|${old.sn || 'б/н'}→${newSn}`, unit: n, res: old.res, date, period: per,
                old: { id: old.id, sn: old.sn || '', final: fin }, new: { id, sn: newSn, k, initial: ini },
                note: spec.note || '', at: new Date().toISOString() };
  load('replacements').push(act); save('replacements');
  logChange(n, `акт замены · ${tagOld} → ${tagNew}`, `${tagOld} конечное ${fin}`, `${tagNew} начальное ${ini}, ${date}`, period);
  carryStarts(n);
  return Object.assign(buildUnit(u, period), { _rev: unitRev(n) });
}

function putTable(name, data) {
  if (!TABLES.includes(name)) throw new Error('нет такой таблицы: ' + name);
  cache[name] = data; save(name);
}

/**
 * Настройки — слиянием, а не целиком (04.10.2026, проверка сервера: вкладка, открытая раньше, при простой смене месяца
 * записывала свои настройки целиком и стирала Гкал из импорта ЭСФ, отметки «проверено», «просмотрено», список
 * пользователей, правки соседней вкладки). Браузер присылает свои настройки и _base — какими он их получил или записал в
 * прошлый раз. Тройное слияние по ключам: что браузер поменял относительно _base — берётся его, что не трогал — остаётся
 * как сейчас на сервере. Без _base (старый интерфейс) — целиком, как раньше.
 */
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const deepEq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
function merge3(base, mine, cur) {
  if (!(isObj(base) && isObj(mine) && isObj(cur))) return deepEq(base, mine) ? cur : mine;
  const out = Object.assign({}, cur);
  new Set([...Object.keys(base), ...Object.keys(mine)]).forEach(k => {
    if (!(k in mine)) { if (k in base && deepEq(base[k], cur[k])) delete out[k]; return; }   // браузер убрал ключ, на сервере его не меняли
    if (k in base && deepEq(base[k], mine[k])) return;                                     // браузер не трогал — остаётся серверное
    out[k] = (k in base) && k in cur ? merge3(base[k], mine[k], cur[k]) : mine[k];
  });
  return out;
}
/** Правки настроек — в журнал (04.10.2026: объёмы счетов-фактур, нужды ЭК, переключатели меняли ОДН всего дома, а кто и
 *  когда — видно не было). Служебное (запомненный месяц, отметки «проверено», «просмотрено», пользователи) — нет. */
const SET_LAB = { inW: 'вода по счёту-фактуре, м³', inW2: 'вода, вторая позиция счёта-фактуры, м³', inE: 'электро по счёту-фактуре, кВт·ч',
  inE2: 'электро, вторая позиция счёта-фактуры, кВт·ч', ukW: 'нужды ЭК, вода, м³', ukE: 'нужды ЭК, электро, кВт·ч', ek: '«ЭК берёт из ОДН», ₸',
  // тепло по формуле Бухгалтерии (заказчик, 05.10.2026): нужды ЭК по теплу и общая площадь здания (пусто — по умолчанию 23 474,3)
  ukH: 'нужды ЭК, тепло, Гкал', bldArea: 'общая площадь здания, м² (пусто — по умолчанию 23 474,3)',
  heat1: 'тепло по ЭСФ, Гкал', heat2: 'тепло, вторая позиция ЭСФ, Гкал', inWAmt: 'вода по счёту-фактуре, ₸', inW2Amt: 'вода, вторая позиция, ₸',
  inEAmt: 'электро по счёту-фактуре, ₸', inE2Amt: 'электро, вторая позиция, ₸', heatAmt: 'тепло по ЭСФ, ₸', heat2Amt: 'тепло, вторая позиция, ₸' };
// сумма позиции счёта-фактуры → объём той же позиции: ввели одно — страница пересчитала другое (sfCalc в браузере, только из
// ввода оператора с 05.10.2026); сумма без своего объёма в журнал не идёт
const AMT_VOL = { inWAmt: 'inW', inW2Amt: 'inW2', inEAmt: 'inE', inE2Amt: 'inE2', heatAmt: 'heat1', heat2Amt: 'heat2' };
function logSettingsDiff(was, now) {
  const v = x => (x == null || x === '' ? '' : String(x));
  // числа — как числа: «40446,41» импорта и «40 446,41» шапки — одно и то же (проверка 05.10.2026)
  const numS = x => { const s = v(x).replace(/\s/g, '').replace(',', '.'); return s === '' ? null : +s; };
  const eqN = (x, y) => { const p = numS(x), q = numS(y); return p === null || q === null || isNaN(p) || isNaN(q) ? v(x) === v(y) : Math.abs(p - q) < 1e-9; };
  [['applyRz', 'переключатель «применять договоры разграничения»'], ['ukPays', 'переключатель «компания платит КУ за помещения в управлении»']].forEach(([k, lab]) => {
    if ((was[k] !== false) !== (now[k] !== false)) logChange('*', lab, was[k] !== false ? 'вкл.' : 'выкл.', now[k] !== false ? 'вкл.' : 'выкл.', null);
  });
  const A = was.byPeriod || {}, B = now.byPeriod || {};
  new Set([...Object.keys(A), ...Object.keys(B)]).forEach(P => {
    const a = A[P] || {}, b = B[P] || {};
    // доходные месяца (05.10.2026: по месяцам) — правкой оператора; ресурс и выключенные — тоже (смена ресурса меняет ОДН)
    if ((b.extSrc === 'manual' || a.extSrc === 'manual') && JSON.stringify(a.ext || null) !== JSON.stringify(b.ext || null)) {
      const RX = { electricity: 'электро', water: 'вода', heat: 'тепло' };
      // объём — как на экране: «120,5», не «120.5» (проверка 05.10.2026)
      const ru = c => (c == null || c === '' || !isFinite(+c) ? String(c == null ? '' : c) : ruMinus((+c).toLocaleString('ru-RU', { maximumFractionDigits: 6 })));
      // строка, объём которой за месяц ещё не введён (новый месяц — объём 0, «нужно заполнить», правило 44б), — с пометкой:
      // иначе ввод 0 в такую строку писался бы «0 → 0»
      const tot = l => (l || []).map(x => `${x.n} (${RX[x.res] || x.res}${x.on ? '' : ', выкл.'}${x.need ? ', не введено' : ''}): ${ru(x.c)}`).join('; ');
      logChange('*', 'вводные месяца · доходные', tot(a.ext), tot(b.ext), P);
    }
    if (!A[P] && b.src !== 'manual') return;   // месяц только что открыли — вводные скопированы, это не правка
    // сумма в тенге — правка, только когда оператор поменял и объём той же позиции (ввёл сумму — шапка пересчитала объём);
    // пересчёт суммы от тарифа после импорта ЭСФ или смены тарифа — не правка (проверка 05.10.2026: каждый импорт писал
    // «тепло по ЭСФ, ₸: 40446,41 → 40 446,42» от имени оператора)
    Object.keys(SET_LAB).forEach(k => {
      if (eqN(a[k], b[k])) return;
      if (/Amt$/.test(k) && ((b.src !== 'manual' && a.src !== 'manual') || eqN(a[AMT_VOL[k]], b[AMT_VOL[k]]))) return;
      logChange('*', `вводные месяца · ${SET_LAB[k]}`, v(a[k]), v(b[k]), P);
    });
  });
}
function putSettings(body) {
  const cur = load('settings');
  let next;
  if (isObj(body) && '_base' in body) { const base = body._base || {}, mine = Object.assign({}, body); delete mine._base; next = merge3(base, mine, cur); }
  else next = body;
  // доходные месяца (05.10.2026): список, заведённый страницей сама (скопированный — до правила 44б, «нужно заполнить» с объёмом
  // 0 — после), не заменяет тот, что уже есть на сервере, — вкладка, открытая раньше, иначе затёрла бы введённые в другой
  // вкладке доходные
  const nb = (next && next.byPeriod) || {}, cb = (cur && cur.byPeriod) || {};
  Object.keys(nb).forEach(P => { const n = nb[P], c = cb[P];
    if (isObj(n) && (n.extSrc === 'copied' || n.extSrc === 'empty') && isObj(c) && Array.isArray(c.ext) && !deepEq(n.ext, c.ext)) { n.ext = c.ext; n.extSrc = c.extSrc; } });
  logSettingsDiff(cur, next);
  cache.settings = next; save('settings');
  return next;
}

module.exports = { runAs, actor, load, save, saveAll, backup, backups, restore, logChange, batchLog, getState, buildUnit, unitRev, unitRevs,
                   putUnit, deleteUnit, putTable, putSettings, merge3, replaceMeter, carryStarts, isAutoStart, isoDate, same, refuse, RES_NAME, PROG_NAME, progOnPeriod, DIR, TABLES,
                   migrateMarks, cleanMarks };
