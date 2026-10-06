'use strict';
/**
 * Очистка данных месяцев — убрать из базы всё, что относится к выбранным месяцам, и оставить справочники (заказчик, 06.10.2026:
 * подготовка базы к загрузке настоящих месяцев). Доступно только «Руководителю» и «Бухгалтерии». Закрытый месяц не очищается.
 *
 * УДАЛЯЕТСЯ за каждый выбранный месяц:
 *   - показания приборов — таблица readings, записи месяца: начальное, конечное, на дату договора (midRead), на дату передачи (ownRead);
 *   - вводные месяца — settings.byPeriod[месяц]: счета-фактуры по воде, электро и теплу (объёмы, суммы, вторые позиции), нужды ЭК по
 *     воде, электро и теплу, «ЭК берёт из ОДН», общая площадь здания месяца, доходные месяца (объёмы и отметки «Учит.») и их состояние;
 *     settings.heatByPeriod[месяц] — Гкал импорта ЭСФ;
 *   - переносы корректировок в ОДН этого месяца — adjustments[].carry с этим месяцем: объёмы обнуляются, прежние — в carryCleared;
 *   - зачёты переплаты в квитанции этого месяца — offsets (type KU / EK, period = месяц);
 *   - записи импорта этого месяца — imports (протоколы импорта; повторный импорт тех же файлов не считается повторным).
 * НЕ ТРОГАЕТСЯ: помещения и площади; собственники, линии владения, контакты, представители, ручные пометки разграничения;
 *   приборы (серийные номера, ресурс, коэффициенты, даты установки и снятия); договоры управления и разграничения, акты опломбировки;
 *   тарифы; список доходных контрагентов с отметками «Учит.» (таблица external — образец для новых месяцев); журнал изменений;
 *   закрытые месяцы и корректировки; возвраты переплаты деньгами; вложения договоров.
 * Особые случаи:
 *   - акт замены прибора: показания, зафиксированные актом (конечное снятого, начальное поставленного), — часть акта, не удаляются;
 *     остальные показания тех же записей удаляются;
 *   - месяц, следующий за очищаемым (если он не очищается): начальные показания, внесённые вручную или поставленные корректировкой
 *     и актом, не трогаются; начальные, перенесённые из конца очищаемого месяца (пометка «перенесено»), остаются числом, пометка
 *     снимается — перенос начала их больше не сотрёт, следующая загрузка очищенного месяца поставит начало заново.
 * Перед удалением — копия базы (data/backup, пометка «перед очисткой месяцев»), после — запись в журнал («весь дом»: кто, какие
 * месяцы, сколько удалено).
 */
const db = require('./db');
const periods = require('./periods');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Поля шапки месяца, которые страница повторяет в общих настройках (вводные выбранного месяца). */
const MIRROR = ['inW', 'inE', 'ukW', 'ukE', 'ukH', 'heatGcal', 'ek', 'bldArea', 'inWAmt', 'inEAmt', 'heatAmt', 'heat1', 'heat2', 'heat2Amt', 'inW2', 'inW2Amt', 'inE2', 'inE2Amt'];
const nextPer = p => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const perLab = p => { const [y, m] = p.split('-'); return ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][+m - 1] + ' ' + y; };
const refuse = (t, code) => Object.assign(new Error(t), { status: code || 409 });

/** Кто работает — по имени из заголовка X-User (или поля by): «Руководитель» и «Бухгалтерия» — можно, «Работа с собственниками» — нет. */
function checkRole(by) {
  const who = db.actor() || by || '';
  const list = db.load('settings').users || [{ name: 'Бухгалтерия', dept: 'k' }, { name: 'Работа с собственниками', dept: 'r' }, { name: 'Руководитель', dept: '' }];
  const u = list.find(x => x.name === who);
  if (!u || u.dept === 'r') throw refuse('очистить данные месяцев могут только «Руководитель» и «Бухгалтерия» — выберите в верхней полосе, кто работает', 403);
  return who;
}

/** Что лежит в базе по месяцу p — числа для предпросмотра. */
function countsOf(p, all) {
  const rd = db.load('readings').filter(r => r.period === p);
  const locked = rd.filter(r => r.lockPrev || r.lockCur).length;
  const st = db.load('settings'), bp = (st.byPeriod || {})[p];
  const ext = bp && Array.isArray(bp.ext) ? bp.ext.length : 0;
  const inputs = bp ? Object.keys(bp).filter(k => !['ext', 'extSrc', 'src'].includes(k) && bp[k] !== '' && bp[k] != null).length : 0;
  const carries = db.load('adjustments').filter(a => a.carry && a.carry.period === p && ['water', 'e', 'heat'].some(k => +a.carry[k])).length;
  const offs = db.load('offsets').filter(o => o.period === p && (o.type === 'KU' || o.type === 'EK')).length;
  const imports = db.load('imports').filter(x => x.period === p).length;
  // следующий месяц, если его не очищают: перенесённые из этого месяца начала — пометка снимется; ручные — не трогаются
  const q = nextPer(p), nq = all && all.includes(q) ? null : db.load('readings').filter(r => r.period === q);
  return {
    period: p, label: perLab(p), closed: !!periods.findClosed(p),
    readings: rd.length, readingsActKept: locked, inputs: bp ? 1 : 0, inputFields: inputs, heatImport: st.heatByPeriod && st.heatByPeriod[p] != null ? 1 : 0,
    ext, carries, offsets: offs, imports,
    nextCarriedStarts: nq ? nq.filter(r => r.prevSrc === 'carry').length : 0,
    nextManualStarts: nq ? nq.filter(r => r.prevSrc === 'manual' || String(r.prevSrc || '').startsWith('adj:') || String(r.prevSrc || '').startsWith('act:')).length : 0,
  };
}

/** Месяцы, в которых есть данные (показания, вводные, Гкал ЭСФ, переносы, зачёты, записи импорта), — с числами. */
function months() {
  const set = new Set();
  db.load('readings').forEach(r => set.add(r.period));
  const st = db.load('settings');
  Object.keys(st.byPeriod || {}).forEach(p => set.add(p));
  Object.keys(st.heatByPeriod || {}).forEach(p => set.add(p));
  db.load('adjustments').forEach(a => { if (a.carry && a.carry.period) set.add(a.carry.period); });
  db.load('offsets').forEach(o => { if (o.period && (o.type === 'KU' || o.type === 'EK')) set.add(o.period); });
  db.load('imports').forEach(x => { if (x.period) set.add(x.period); });
  const list = [...set].filter(p => PERIOD_RE.test(p)).sort();
  return list.map(p => countsOf(p, null));
}

/** Предпросмотр: что будет удалено по каждому из выбранных месяцев. */
function preview(list) {
  const ps = norm(list);
  return { periods: ps.map(p => countsOf(p, ps)) };
}
function norm(list) {
  const ps = [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map(x => String(x).trim()).filter(Boolean))].sort();
  if (!ps.length) throw refuse('выберите месяцы', 400);
  const bad = ps.filter(p => !PERIOD_RE.test(p)); if (bad.length) throw refuse('месяц — в виде ГГГГ-ММ: ' + bad.join(', '), 400);
  return ps;
}

/**
 * Очистка. body: { periods: [ГГГГ-ММ, …], by }. Закрытый месяц — отказ с причиной (ничего не удаляется). Перед удалением —
 * копия базы. Возвращает {backup, periods: [числа по месяцу], total}.
 */
function clean(body) {
  const b = body || {}, ps = norm(b.periods);
  const who = checkRole(b.by);
  const closed = ps.filter(p => periods.findClosed(p));
  if (closed.length) throw refuse(`закрытые месяцы не очищаются: ${closed.map(perLab).join(', ')} — снимок закрытого месяца неприкосновенен; данные закрытого месяца меняются только корректировкой`);
  const before = ps.map(p => countsOf(p, ps));
  const dir = require('path').basename(db.backup('перед очисткой месяцев ' + ps.join(' ')));
  const at = new Date().toISOString(), set = new Set(ps);

  // показания: записи месяца — прочь; показания акта замены (замок) остаются частью акта
  const rd = db.load('readings'), keep = [];
  rd.forEach(r => {
    if (!set.has(r.period)) return keep.push(r);
    if (!(r.lockPrev || r.lockCur)) return;
    keep.push({ meter: r.meter, period: r.period, prev: r.lockPrev ? r.prev : null, cur: r.lockCur ? r.cur : null, midRead: null, ownRead: null,
      ...(r.lockPrev ? { lockPrev: true } : {}), ...(r.lockCur ? { lockCur: true } : {}), ...(r.lockPrev && r.prevSrc ? { prevSrc: r.prevSrc } : {}) });
  });
  // следующий месяц (не очищается): начало, перенесённое из конца очищаемого, — числом, без пометки «перенесено»
  keep.forEach(r => { if (!set.has(r.period) && set.has(prevPer(r.period)) && r.prevSrc === 'carry') { delete r.prevSrc; delete r.prevNote; } });
  rd.length = 0; keep.forEach(r => rd.push(r));
  db.save('readings');

  // вводные месяца и Гкал импорта ЭСФ
  const st = db.load('settings');
  ps.forEach(p => { if (st.byPeriod) delete st.byPeriod[p]; if (st.heatByPeriod) delete st.heatByPeriod[p]; });
  // вводные выбранного месяца, повторённые страницей в общих настройках (поля шапки), — если этот месяц очищается
  if (set.has(st.period)) MIRROR.forEach(k => { delete st[k]; });
  db.save('settings');

  // переносы корректировок в ОДН этих месяцев — объёмы 0, прежние — в carryCleared
  let carryN = 0;
  db.load('adjustments').forEach(a => {
    if (!a.carry || !set.has(a.carry.period)) return;
    const was = { water: +a.carry.water || 0, e: +a.carry.e || 0, heat: +a.carry.heat || 0 };
    if (!was.water && !was.e && !was.heat) return;
    a.carryCleared = { at, by: who, was };
    a.carry = Object.assign({}, a.carry, { water: 0, e: 0, heat: 0 });
    carryN++;
  });
  if (carryN) db.save('adjustments');

  // зачёты переплаты в квитанции этих месяцев; записи импорта этих месяцев
  const offs = db.load('offsets'), offKeep = offs.filter(o => !(set.has(o.period) && (o.type === 'KU' || o.type === 'EK')));
  if (offKeep.length !== offs.length) { offs.length = 0; offKeep.forEach(o => offs.push(o)); db.save('offsets'); }
  const imp = db.load('imports'), impKeep = imp.filter(x => !set.has(x.period));
  if (impKeep.length !== imp.length) { imp.length = 0; impKeep.forEach(x => imp.push(x)); db.save('imports'); }

  const sum = k => before.reduce((a, x) => a + x[k], 0);
  const txt = `показаний ${sum('readings')}${sum('readingsActKept') ? ` (из них показаний актов замены оставлено ${sum('readingsActKept')})` : ''}, вводных месяцев ${sum('inputs')}, `
    + `доходных строк ${sum('ext')}, переносов корректировок ${carryN}, зачётов ${sum('offsets')}, записей импорта ${sum('imports')}; копия базы — ${dir}`;
  db.logChange('*', `очистка данных месяцев · ${ps.map(perLab).join(', ')}`, '', txt, null);
  return { backup: dir, by: who, periods: before, total: { readings: sum('readings'), readingsActKept: sum('readingsActKept'), inputs: sum('inputs'), ext: sum('ext'), carries: carryN, offsets: sum('offsets'), imports: sum('imports') } };
}
const prevPer = p => { const [y, m] = p.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

module.exports = { months, preview, clean };
