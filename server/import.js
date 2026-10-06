'use strict';
/**
 * Импорт показаний из файлов поставщиков.
 *
 * Папка месяца: Импорт/ГГГГ/ММ (рядом с public и server). Туда кладутся файлы как есть —
 * выгрузка АРЭК, отчёт Су-Арнасы, ЭСФ Теплотранзита; тип определяется по содержимому,
 * читает их server/parse_import.py (Python: openpyxl + xlrd), сопоставление и запись — здесь.
 *
 *   preview(period) — что в папке, что сопоставилось, что нет; ничего не пишет
 *   apply(period)   — копия базы, запись показаний по приборам (по серийнику), тепло — в вводные месяца
 *                     (settings.byPeriod[period].heat1/heat2 и суммы, итог — в heatByPeriod[period]),
 *                     протокол — в таблицу imports, журнал по помещениям
 *
 * Правила сопоставления:
 *   · прибор ищется по серийному номеру среди приборов своего ресурса (ХВС/ГВС — вода, АРЭК — электро),
 *     пробелы и ведущие нули не считаются;
 *   · Су-Арнасы даёт начало и конец периода — пишутся оба;
 *   · АРЭК даёт один снимок на дату: конец периода. Начало — снимок из более раннего файла АРЭК в той же
 *     папке, если он есть, иначе конец предыдущего месяца в стенде, иначе прошлое показание не трогаем;
 *   · показание, зафиксированное актом замены (lockPrev/lockCur), не перезаписывается — попадает в отчёт;
 *   · прибор, снятый до начала периода или установленный после его конца, пропускается;
 *   · тепло: сумма Гкал по строкам «Тепловая энергия» ЭСФ; на помещения делится расчётом по площади.
 */
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const db = require('./db.js');

const ROOT = path.join(__dirname, '..');
const PARSER = path.join(__dirname, 'parse_import.py');

function folderOf(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) throw new Error('период должен быть ГГГГ-ММ');
  return path.join(ROOT, 'Импорт', m[1], m[2]);
}

function runParser(folder) {
  const tryRun = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out;
  try { out = tryRun('python', [PARSER, folder]); }
  catch (e1) {
    try { out = tryRun('py', ['-3', PARSER, folder]); }
    catch (e2) {
      const msg = String((e1.stderr || e1.message || '')).trim().split('\n').slice(-2).join(' ');
      throw new Error('не удалось запустить разбор файлов (нужен Python 3 с openpyxl и xlrd: python -m pip install openpyxl xlrd): ' + msg);
    }
  }
  return JSON.parse(out);
}

const normSn = v => String(v == null ? '' : v).replace(/\s/g, '').replace(/^0+(?=\d)/, '');
/** Число в тексте для людей (предупреждения окна импорта) — как на экране: «2 276,14», не «2276.14» (проверка 05.10.2026). */
const ruNum = v => (v == null || v === '' || !isFinite(+v)) ? String(v == null ? '' : v) : (+v).toLocaleString('ru-RU', { maximumFractionDigits: 6 });
const prevPeriod = p => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };
const inPeriod = (m, ps, pe) => !(m.to && m.to < ps) && !(m.from && m.from > pe);
const periodBounds = p => { const [y, m] = p.split('-').map(Number); return [`${p}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)]; };

/** Собрать план записи: по каждому прибору стенда — что придёт из файлов. Ничего не пишет. */
function plan(period) {
  const folder = folderOf(period);
  if (!fs.existsSync(folder)) return { period, folder, exists: false, files: [], items: [], unmatched: [], missing: [], warnings: [], alerts: [], negative: [], stale: [], heat: null };
  const parsed = runParser(folder);
  const meters = db.load('meters').filter(m => !m.del), readings = db.load('readings');   // помеченные на удаление — мимо
  const [ps, pe] = periodBounds(period);
  const bySn = { w: {}, e: {} };
  meters.forEach(m => { const key = m.res === 'ee' ? 'e' : 'w'; (bySn[key][normSn(m.sn)] = bySn[key][normSn(m.sn)] || []).push(m); });
  const items = [], unmatched = [], warnings = [];
  // проверка 04.10.2026 перед загрузкой настоящих августа и сентября: alerts — проверить до записи (файл не за тот месяц,
  // одна ЭСФ дважды, электро без начального); negative — конец меньше начала; empty — в файле пусто или не читается;
  // stale — модем Су-Арнасы молчит с начала периода (показание могло «застыть»)
  const alerts = [], negative = [], empty = [], stale = [];
  const prevPer = prevPeriod(period);
  const seen = new Set();
  const pick = (key, sn, unitLabel, src) => {
    const list = bySn[key][normSn(sn)] || [];
    if (!list.length) { unmatched.push({ sn, unit: unitLabel || '', src }); return null; }
    const active = list.filter(m => inPeriod(m, ps, pe));
    if (!active.length) { warnings.push(`${src}: прибор ${sn} (${list[0].unit}) снят до ${period} или ещё не установлен — пропущен`); return null; }
    if (active.length > 1) warnings.push(`${src}: серийник ${sn} у нескольких приборов (${active.map(m => m.unit).join(', ')}) — взят ${active[0].unit}`);
    return active[0];
  };
  const add = (m, src, prev, cur, unitLabel) => {
    const ex = readings.find(r => r.meter === m.id && r.period === period) || {};
    // начало месяца = конец прошлого месяца в стенде (заказчик, 02.10.2026): конечные прошлого месяца совпадают с начальными
    // этого, разница уходит на ОДН; начало по файлу — только для сверки
    const pr = readings.find(x => x.meter === m.id && x.period === prevPer);
    const standStart = pr && pr.cur != null && pr.cur !== '' ? Number(pr.cur) : null;
    const adjSrc = String(ex.prevSrc || '').startsWith('adj:');
    const kept = ex.lockPrev || ex.prevSrc === 'manual' || adjSrc;
    let fileStart;
    if (standStart != null && !kept) { if (prev != null && Number(prev) !== standStart) fileStart = Number(prev); prev = standStart; }
    // начало после акта замены, внесённое руками (prevSrc 'manual') и поставленное корректировкой закрытого месяца (adj:) —
    // сильнее файла: не перезаписывается (adj: — с 04.10.2026: раньше считался «своим» только наполовину, и импорт следующего
    // месяца писал начало из файла поверх каскада корректировки — проверка импорта, 6001 ХВС 26,58 → 26,08)
    const actSrc = String(ex.prevSrc || '').startsWith('act:');
    // показание удалено корректировкой (каскад «оставить пустым») — начало только руками (решение заказчика 20.09.2026,
    // «удалённое показание — только руками»), файл его не заполняет
    // начальное, стёртое оператором (ручная правка: prevSrc 'manual', пусто), импорт тоже не заполняет — его вносят руками
    // (заказчик, 06.10.2026; до этого импорт писал туда начало из файла поставщика)
    const carried = prev != null && ((actSrc || adjSrc || ex.prevSrc === 'manual') && ex.prev != null && Number(ex.prev) !== Number(prev) || ((adjSrc || ex.prevSrc === 'manual') && ex.prev == null));
    if (carried) warnings.push(`${src}: прибор ${m.sn} (${m.unit}) — начальное ${ruNum(prev)} из файла не записано: ${actSrc ? 'после акта замены начало месяца = конечное за месяц замены' : adjSrc ? (ex.prev == null ? 'показание удалено корректировкой закрытого месяца — начальное вносится руками' : 'начальное поставлено корректировкой закрытого месяца') : ex.prev == null ? 'начальное стёрто вручную — вносится руками' : 'начальное внесено вручную'}${ex.prev == null ? '' : ` (${ruNum(ex.prev)})`}`);
    const lockP = !!(ex.lockPrev && prev != null && Number(ex.prev) !== Number(prev));
    const it = { meter: m.id, unit: m.unit, res: m.res, sn: m.sn, src,
                 prev: prev == null ? undefined : prev, cur: cur == null ? undefined : cur,
                 wasPrev: ex.prev == null ? null : ex.prev, wasCur: ex.cur == null ? null : ex.cur,
                 skipPrev: lockP || carried,
                 skipCur: !!(ex.lockCur && cur != null && Number(ex.cur) !== Number(cur)),
                 ...(fileStart !== undefined ? { fileStart } : {}), fromStand: standStart != null && !kept };
    // почему не перезаписываем — для сводки окна импорта (проверка 05.10.2026: «зафиксировано актом» считало и начало,
    // внесённое руками): act — замок акта замены или начало после акта, adj — корректировка закрытого месяца, manual — руками
    if (it.skipPrev || it.skipCur) it.keep = it.skipCur || lockP || actSrc ? 'act' : adjSrc ? 'adj' : 'manual';
    // конец меньше начала — расход обнулится, разница уйдёт в ОДН: показать до записи, а не после (проверка 04.10.2026)
    const p0 = it.skipPrev || it.prev === undefined ? ex.prev : it.prev, c0 = it.skipCur || it.cur === undefined ? ex.cur : it.cur;
    if (p0 != null && c0 != null && Number(c0) < Number(p0)) negative.push({ unit: m.unit, res: m.res, sn: m.sn, prev: Number(p0), cur: Number(c0) });
    if (unitLabel && normUnit(unitLabel) && normUnit(unitLabel) !== normUnit(m.unit))
      warnings.push(`${src}: прибор ${m.sn} в файле у «${unitLabel}», в стенде у ${m.unit}`);
    if (seen.has(m.id)) warnings.push(`${src}: прибор ${m.sn} встречается в файлах дважды — берётся последнее`);
    seen.add(m.id);
    items.push(it);
  };

  // вода: начало и конец из отчёта
  parsed.files.filter(f => f.type === 'water').forEach(f => {
    if (f.to && f.to.slice(0, 7) !== period) alerts.push(`${f.name}: период в файле ${f.from || '?'} — ${f.to}, а импорт за ${period}. Тот ли файл в папке?`);
    f.rows.forEach(r => ['hvs', 'gvs'].forEach(res => {
      const x = r[res]; if (!x || !x.sn) return;
      const m = pick('w', x.sn, r.unit || r.consumer, f.name);
      if (!m) return;
      // конца в файле нет или он не читается («н/д») — не пишем; прибор попадёт в «данных не пришло» с причиной, и
      // прежнее показание (у тестовых месяцев — пробное) не останется незамеченным (проверка 04.10.2026)
      if (x.cur == null) { empty.push({ meter: m.id, unit: m.unit, res: m.res, sn: m.sn, raw: x.curRaw || '', src: f.name }); return; }
      if (x.last && f.from && x.last < f.from) stale.push({ unit: m.unit, res: m.res, sn: m.sn, last: x.last, cur: x.cur });
      add(m, f.name, x.prev, x.cur, r.unit);
    }));
  });
  // электро: снимки АРЭК по датам
  parsed.files.filter(f => f.type === 'arek' && !f.date && !f.error).forEach(f => alerts.push(`${f.name}: дата снимка АРЭК не прочитана — файл не учтён`));
  const arek = parsed.files.filter(f => f.type === 'arek' && f.date).sort((a, b) => a.date < b.date ? -1 : 1);
  if (arek.length) {
    const last = arek[arek.length - 1], first = arek.length > 1 ? arek[0] : null;
    if (last.date.slice(0, 7) !== period) alerts.push(`${last.name}: снимок АРЭК на ${last.date} — это не ${period}. Тот ли файл в папке?`);
    if (first && first.date.slice(0, 7) !== prevPer) warnings.push(`${first.name}: снимок АРЭК для начала — на ${first.date}, ожидался ${prevPer}`);
    if (arek.length > 2) warnings.push(`АРЭК: в папке ${arek.length} снимка — начало берётся из самого раннего (${first.date}), конец — из самого позднего (${last.date})`);
    const firstBySn = {}; if (first) first.rows.forEach(r => { firstBySn[normSn(r.sn)] = r.total; });
    let noStart = 0;
    last.rows.forEach(r => {
      const m = pick('e', r.sn, '', last.name);
      if (!m) return;
      if (r.total == null) {
        warnings.push(`${last.name}: прибор ${r.sn} (${m.unit}) ${r.totalRaw ? `— показание «${r.totalRaw}» не читается` : 'без показания («–»)'} — пропущен`);
        empty.push({ meter: m.id, unit: m.unit, res: m.res, sn: m.sn, raw: r.totalRaw || '–', src: last.name });
        return;
      }
      let prev;
      if (first && firstBySn[normSn(r.sn)] != null) prev = firstBySn[normSn(r.sn)];
      else { const pr = readings.find(x => x.meter === m.id && x.period === prevPer); if (pr && pr.cur != null) prev = pr.cur; }
      if (prev == null) { const ex = readings.find(x => x.meter === m.id && x.period === period); if (!(ex && ex.prev != null)) noStart++; }
      add(m, last.name + (first ? ' + ' + first.name : ''), prev, r.total, '');
    });
    if (!first) warnings.push(`${last.name}: один снимок АРЭК — начало периода взято из конца ${prevPer} в стенде (где есть)`);
    // первый месяц в стенде (прошлого нет) и один снимок — начала взять неоткуда: расход 0, весь счёт АРЭК ушёл бы в ОДН
    if (noStart) alerts.push(`Электро: у ${pl(noStart, 'прибора', 'приборов', 'приборов')} нет начального показания — в стенде нет конца ${prevPer}, а в папке один снимок АРЭК. Расход у них будет 0, весь объём уйдёт в ОДН. Положите в папку и выгрузку АРЭК на конец ${prevPer}.`);
  }
  // тепло: одна ЭСФ двумя файлами — учесть один раз; исправленная заменяет исходную (по регистрационному номеру)
  let esf = parsed.files.filter(f => f.type === 'esf');
  const regSeen = {};
  esf = esf.filter(f => { if (!f.regNo) return true; if (regSeen[f.regNo]) { alerts.push(`ЭСФ ${f.regNo} в папке дважды (${regSeen[f.regNo]}, ${f.name}) — учтена один раз`); return false; } regSeen[f.regNo] = f.name; return true; });
  const replacedEsf = new Set(esf.map(f => f.corrects).filter(Boolean));
  esf = esf.filter(f => { if (f.regNo && replacedEsf.has(f.regNo)) { alerts.push(`ЭСФ ${f.regNo} (${f.name}) исправлена другой ЭСФ из папки — не учтена`); return false; } return true; });
  if (esf.length > 1) alerts.push(`В папке ${esf.length} ЭСФ по теплу — Гкал сложены (${esf.map(f => `${f.name}: ${ruNum(f.gcal)}`).join('; ')}). Если одна повторяет или исправляет другую — оставьте в папке одну.`);
  esf.forEach(f => { if (f.docDate && f.docDate.slice(0, 7) !== period) alerts.push(`${f.name}: оборот по ЭСФ ${f.docDate} — это не ${period}. Та ли ЭСФ в папке?`); });
  const heat = esf.length ? { gcal: +esf.reduce((a, f) => a + (f.gcal || 0), 0).toFixed(4), files: esf.map(f => ({ name: f.name, supplier: f.supplier, docDate: f.docDate, issueDate: f.issueDate, regNo: f.regNo || '', gcal: f.gcal, lines: f.lines })) } : null;
  // приборы стенда, по которым данных не пришло: нет в файлах или в файле пусто / не читается (причина — why)
  const covered = new Set(items.map(i => i.meter)), emptyBy = {}; empty.forEach(x => { emptyBy[x.meter] = x; });
  const missing = meters.filter(m => inPeriod(m, ps, pe) && !covered.has(m.id)).map(m => {
    const e = emptyBy[m.id], ex = readings.find(x => x.meter === m.id && x.period === period);
    return { meter: m.id, unit: m.unit, res: m.res, sn: m.sn, bill: m.bill !== false, why: e ? (e.raw ? `в файле «${e.raw}»` : 'в файле пусто') : 'в файлах нет',
             keeps: ex && ex.cur != null ? ex.cur : null };
  });
  const kept = missing.filter(x => x.keeps != null && x.bill).length;
  if (kept) alerts.push(`${pl(kept, 'прибор', 'прибора', 'приборов')} без данных в файлах, но с показанием в стенде за ${period} — оно останется как есть (список «данных не пришло»). Если это пробные данные — сотрите их до импорта.`);
  if (negative.length) alerts.push(`Конец меньше начала: ${pl(negative.length, 'прибор', 'прибора', 'приборов')} — расход обнулится, разница уйдёт в ОДН (список ниже).`);
  if (stale.length) warnings.push(`Су-Арнасы: у ${pl(stale.length, 'прибора', 'приборов', 'приборов')} модем молчит с начала периода (последнее сообщение раньше ${(parsed.files.find(f => f.type === 'water') || {}).from || 'периода'}) — показание могло «застыть» (список ниже)`);
  return { period, folder, exists: true, files: parsed.files.map(f => ({ name: f.name, type: f.type, error: f.error, date: f.date, from: f.from, to: f.to, rows: f.rows ? f.rows.length : undefined, gcal: f.gcal, regNo: f.regNo, docDate: f.docDate })),
           items, unmatched, missing, warnings, alerts, negative, stale, heat };
}
const normUnit = v => String(v || '').replace(/\s/g, '').replace(/^кв\.?/i, '').toUpperCase();
/** «1 прибор», «4 прибора», «7 приборов» */
const pl = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`; };

function summary(p) {
  const by = res => p.items.filter(i => i.res === res);
  // locked — только акт замены; начало, внесённое руками, и поставленное корректировкой — отдельно (manual, adj)
  const cnt = list => ({ meters: list.length, prev: list.filter(i => i.prev !== undefined && !i.skipPrev).length, cur: list.filter(i => i.cur !== undefined && !i.skipCur).length,
                         locked: list.filter(i => i.keep === 'act').length, manual: list.filter(i => i.keep === 'manual').length, adj: list.filter(i => i.keep === 'adj').length,
                         starts: list.filter(i => i.fileStart !== undefined).length });
  return { hvs: cnt(by('hvs')), gvs: cnt(by('gvs')), ee: cnt(by('ee')), unmatched: p.unmatched.length, missing: p.missing.length, warnings: p.warnings.length,
           alerts: (p.alerts || []).length, negative: (p.negative || []).length, stale: (p.stale || []).length };
}

function preview(period) {
  const p = plan(period);
  return Object.assign(p, { summary: summary(p) });
}

/** Записать показания по плану. Копия базы — до записи; журнал — по помещениям. */
function apply(period) {
  const p = plan(period);
  if (!p.exists) throw new Error('папки нет: ' + p.folder);
  if (!p.items.length && !p.heat) throw new Error('в папке нет данных для импорта');
  db.backup('pre-import-' + period);
  // журнал — одной записью файла в конце (batchLog): строка на прибор переписывала весь журнал, и импорт месяца с переносом
  // начала в следующий шёл 1 мин 46 с, стенд всё это время не отвечал (проверка 04.10.2026)
  return db.batchLog(() => applyPlan(p, period));
}
function applyPlan(p, period) {
  const readings = db.load('readings');
  let written = 0;
  const byUnit = {};
  p.items.forEach(it => {
    let rec = readings.find(r => r.meter === it.meter && r.period === period);
    if (!rec) { rec = { meter: it.meter, period, prev: null, cur: null, midRead: null, ownRead: null }; readings.push(rec); }
    const changes = [];
    if (it.prev !== undefined && !it.skipPrev && !db.same(rec.prev, it.prev)) {
      changes.push(`начало ${rec.prev == null ? '—' : rec.prev} → ${it.prev}${it.fileStart !== undefined ? ` (конец прошлого месяца; в файле ${it.fileStart})` : ''}`); rec.prev = it.prev;
      // начало из файла (конца прошлого месяца в стенде нет) — пометка «перенесено» больше не про это число, снимаем
      if (!it.fromStand && rec.prevSrc === 'carry') { delete rec.prevSrc; delete rec.prevNote; }
    }
    if (it.cur !== undefined && !it.skipCur && !db.same(rec.cur, it.cur)) { changes.push(`конец ${rec.cur == null ? '—' : rec.cur} → ${it.cur}`); rec.cur = it.cur; }
    if (changes.length) { written++; (byUnit[it.unit] = byUnit[it.unit] || []).push({ tag: `${db.RES_NAME[it.res] || it.res} ${it.sn}`, text: changes.join(', ') + ` (${it.src})` }); }
  });
  db.save('readings');
  Object.keys(byUnit).forEach(u => byUnit[u].forEach(x => db.logChange(u, 'импорт показаний · ' + x.tag, '', x.text, period)));
  db.carryStarts(null);   // пришли конечные этого месяца — начало следующего (если он уже заведён) следом
  const settings = db.load('settings');
  if (p.heat) {
    settings.heatByPeriod = settings.heatByPeriod || {};
    settings.heatByPeriod[period] = p.heat.gcal;
    // Гкал и сумма по ЭСФ — в вводные месяца, в поля позиций счёта-фактуры (heat1 / heat2 и суммы): расчёт берёт тепло
    // оттуда (сумма позиций), а не из heatByPeriod. Раньше писалась только сумма, и в месяце, который уже открывали,
    // расчёт оставался на прежнем числе (найдено проверкой 24.09.2026).
    settings.byPeriod = settings.byPeriod || {};
    const bp = Object.assign({}, settings.byPeriod[period] || {});
    const lines = [].concat(...p.heat.files.map(f => f.lines || []));
    const fmt = (v, d) => String(+(+v).toFixed(d)).replace('.', ',');
    const heatAmt = +lines.reduce((b, l) => b + (+l.total || 0), 0).toFixed(2);
    // позиции — по цене строки; тариф менялся в месяце — в ЭСФ две цены, в стенде две позиции (как в самом счёте),
    // если в тарифах стенда на этот месяц тоже две строки тепла; порядок позиций — по дате начала тарифа
    const pos = [];
    lines.forEach(l => { const g = pos.find(x => Math.abs(x.price - (+l.price || 0)) < 0.005); if (g) { g.qty += +l.qty || 0; g.total += +l.total || 0; } else pos.push({ price: +l.price || 0, qty: +l.qty || 0, total: +l.total || 0 }); });
    const ms = period + '-01', me = period + '-31';
    const tar = db.load('tariffs').filter(t => t.svc === 'heating' && t.from <= me && (!t.to || t.to >= ms)).sort((a, b) => (a.from < b.from ? -1 : 1));
    if (pos.length === 2 && tar.length === 2) {
      // тариф, сохранённый стендом текстом («8 620,78» — до проверки 05.10.2026), — тоже число: +«8620,78» давало NaN, и
      // позиции оставались в порядке файла
      const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
      const at = x => { const i = tar.findIndex(t => Math.abs(num(t.base) - x.price) < 0.005); return i < 0 ? 9 : i; };
      pos.sort((a, b) => at(a) - at(b));
      bp.heat1 = fmt(pos[0].qty, 4); bp.heatAmt = fmt(pos[0].total, 2); bp.heat2 = fmt(pos[1].qty, 4); bp.heat2Amt = fmt(pos[1].total, 2);
    } else {
      bp.heat1 = fmt(p.heat.gcal, 4); if (heatAmt > 0) bp.heatAmt = fmt(heatAmt, 2); delete bp.heat2; delete bp.heat2Amt;
      if (pos.length !== tar.length && (pos.length > 1 || tar.length > 1))
        (p.warnings = p.warnings || []).push(`тепло: в ЭСФ цен ${pos.length}, строк тарифа тепла в стенде на месяц ${tar.length} — записано одной позицией ${fmt(p.heat.gcal, 4)} Гкал; проверьте тарифы и шапку месяца`);
    }
    settings.byPeriod[period] = bp;
    if (settings.period === period) settings.heatGcal = String(p.heat.gcal).replace('.', ',');
    db.save('settings');
    db.logChange('*', `импорт тепла ${period}`, '', `${p.heat.gcal} Гкал по ЭСФ (${p.heat.files.map(f => f.name).join(', ')})`, period);
  }
  const rec = { period, at: new Date().toISOString(), folder: p.folder, files: p.files.map(f => f.name), written,
                summary: summary(p), heat: p.heat ? p.heat.gcal : null, unmatched: p.unmatched, missing: p.missing.length, warnings: p.warnings };
  db.load('imports').push(rec); db.save('imports');
  return Object.assign(p, { summary: summary(p), written, record: rec });
}

module.exports = { preview, apply, folderOf };
