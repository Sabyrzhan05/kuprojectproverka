'use strict';
/**
 * Фиксация периода и корректировки задним числом — решения заказчика 20.09.2026; правила — docs/ПРАВИЛА РАСЧЁТА.md, 94–98.
 *
 *   closed_periods — список снимков: { period, status:'closed'|'reopened', closedAt, closedBy, forced, note, checklist,
 *                    engineVersion, inputs, ctx, totals, units:{[n]:UnitResult}, history:[…] }.
 *                    Снимок считает браузер (там движок), сервер проверяет тождества и хранит.
 *   adjustments    — список корректировок: { id, period, unit, seq, at, by, type, reason, billing, changes,
 *                    before, after, delta, carry, invoices, cascade, status }.
 *
 * Правила: закрывать только по порядку; переоткрыть — только последний закрытый и только без корректировок;
 * корректировать — только последний закрытый; снимок никогда не правится; перенос в базу ОДН следующего
 * месяца хранится в carry и материализуется в inputs.external при закрытии того месяца.
 */
const db = require('./db');

const nextPeriod = p => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };
const prevPeriod = p => { const [y, m] = p.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };
const PERIOD_RE = /^\d{4}-\d{2}$/;
// числа в текстах для людей (журнал, причина корректировки, перенос в ОДН, ошибки) — как на экране стенда: «38 493,60»,
// «2 286,14», а не «38493.60» (03.10.2026, чек-лист 11.8: причина «2276.14 → 2286.14» уходила в квитанцию и журнал)
// минус — «−» (U+2212), как на экране стенда (B32, 05.10.2026: «электро -58,74 кВт·ч», «корректировка суммы КУ: -500 ₸»);
// округлённое до нуля — без знака («-0,00» → «0,00»). Тексты, записанные раньше, остаются с дефисом
const mns = s => (s.charAt(0) !== '-' ? s : /[1-9]/.test(s) ? '−' + s.slice(1) : s.slice(1));
const fmtN = (v, d) => mns((+v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtV = v => mns((+v).toLocaleString('ru-RU', { maximumFractionDigits: 6 }));
const sgn = v => (v > 0 ? '+' : '');

function all() { return db.load('closed_periods'); }
function findClosed(p) { return all().find(c => c.period === p && c.status === 'closed') || null; }
function closedPeriods() { return all().filter(c => c.status === 'closed').map(c => c.period).sort(); }
function lastClosed() { const l = closedPeriods(); return l.length ? l[l.length - 1] : null; }
function header(c) { if (!c) return null; const h = Object.assign({}, c); delete h.units; h.unitCount = Object.keys(c.units || {}).length; return h; }
function adjustments(p, unit) { return db.load('adjustments').filter(a => (!p || a.period === p) && (!unit || a.unit === unit)); }
function carriesInto(q) { return db.load('adjustments').filter(a => a.carry && a.carry.period === q && a.status === 'applied'); }
function inAnySnapshot(n) { return all().some(c => c.units && c.units[n]); }

/**
 * Переплата собственника (заказчик, 03–04.10.2026): напоминание о переплате и зачёт кнопкой. Учёт по помещению и собственнику: Учёт по помещению и собственнику:
 *   начислено переплаты (credits) — квитанции собственника, ушедшие в минус, на закрытии месяца (их считает браузер,
 *     сервер хранит в снимке: closed.credits) и корректировочные квитанции собственника с разницей «к зачёту»
 *     (adjustments[].credits);
 *   зачтено (offsets, type KU | EK) — строки «Зачёт переплаты» в квитанциях открытого месяца, только по кнопке в форме помещения;
 *   возвращено деньгами (offsets, type REFUND) — отметка оператора, что переплату вернули собственнику переводом или
 *     наличными (заказчик, 04.10.2026); квитанций не меняет. Нужно прежнему
 *     собственнику после продажи: квитанций у него больше не будет, зачесть некуда.
 * Остаток = начислено − зачтено − возвращено. Сама переплата никуда не зачитывается.
 */
function allCredits() {
  return [...all().filter(c => c.status === 'closed').flatMap(c => (c.credits || []).map(x => Object.assign({ source: 'close' }, x))),
          ...db.load('adjustments').filter(a => a.status === 'applied').flatMap(a => (a.credits || []).map(x => Object.assign({ source: 'adjustment' }, x)))];
}
function offsets() { return db.load('offsets'); }
const fioKey = x => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
/** Сколько всего зачтено и возвращено по помещению и собственнику — для проверки «окно видело то же, что сервер». */
function usedOf(n, fio) { const f = fioKey(fio); return offsets().filter(x => x.unit === n && fioKey(x.fio) === f).reduce((a, x) => a + (+x.amount || 0), 0); }
/** Окно открыто давно, а переплату этого собственника уже зачли или вернули в другом окне — не записываем дважды
 *  (проверка 04.10.2026: вкладка А вернула деньгами, вкладка Б по старым данным зачла ту же сумму в квитанцию). */
function checkSeen(b, n, fio) {
  if (b.seen == null) return;   // старая страница — без проверки
  if (Math.round(+b.seen) !== Math.round(usedOf(n, fio))) throw new Error('переплату этого собственника уже зачли или вернули в другом окне — обновите страницу (F5) и посмотрите остаток');
}
/** Зачесть переплату в квитанцию открытого месяца: {unit, fio, amount (целые тенге), period, type: KU | EK, note}.
 *  type REFUND — записать возврат деньгами: {unit, fio, amount, date (ГГГГ-ММ-ДД), note — как вернули, обязательно}. */
function addOffset(body) {
  if (body && body.type === 'REFUND') return addRefund(body);
  const b = body || {}, n = String(b.unit || ''), per = String(b.period || ''), type = b.type === 'EK' ? 'EK' : b.type === 'KU' ? 'KU' : null;
  if (!db.load('units').some(u => u.n === n)) throw new Error('помещение не найдено: ' + n);
  if (!PERIOD_RE.test(per)) throw new Error('месяц должен быть вида ГГГГ-ММ');
  if (findClosed(per) || (lastClosed() && per <= lastClosed())) throw new Error(`месяц ${per} закрыт — зачесть можно только в квитанцию открытого месяца`);
  if (!type) throw new Error('куда зачесть: KU или EK');
  const amount = +b.amount;
  if (!(amount > 0) || !Number.isInteger(amount)) throw new Error('сумма зачёта — целые тенге больше нуля');
  // ФИО — как в квитанции (без обрезки пробелов): по нему строка зачёта находит свою часть месяца
  const fio = String(b.fio || ''); if (!fio.trim()) throw new Error('нет собственника');
  checkSeen(b, n, fio);
  const list = offsets(), k = list.filter(x => x.unit === n && x.period === per).length + 1;
  // с какой даты владеет собственник зачёта (null — первый): строка находит его и после исправления написания ФИО (06.10.2026)
  const ownFrom = b.ownFrom === undefined ? undefined : (db.isoDate(b.ownFrom, 'владеет с') || null);
  const rec = { id: `OFF-${per}-${n}-${k}-${Date.now().toString(36)}`, unit: n, fio, ...(ownFrom !== undefined ? { ownFrom } : {}), amount, period: per, type, note: String(b.note || '').slice(0, 300),
                at: new Date().toISOString(), by: b.by || db.actor() || 'оператор' };
  list.push(rec); db.save('offsets');
  db.logChange(n, `зачёт переплаты · ${type === 'EK' ? 'эксплуатационная' : 'коммунальная'} квитанция ${per}`, '', `−${fmtN(amount, 0)} ₸${rec.note ? ' · ' + rec.note : ''}`, per);
  return rec;
}
/** Сколько переплаты собственника по помещению можно вернуть деньгами: начислено (закрытые месяцы и корректировки) минус
 *  зачтено и уже возвращено. Переплата открытого месяца сюда не входит — её считает только браузер; вернуть её можно
 *  после закрытия месяца. */
function refundable(n, fio) {
  const f = fioKey(fio);
  return allCredits().filter(x => x.unit === n && fioKey(x.fio) === f).reduce((a, x) => a + (+x.amount || 0), 0) - usedOf(n, fio);
}
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function addRefund(b) {
  const n = String(b.unit || '');
  if (!db.load('units').some(u => u.n === n)) throw new Error('помещение не найдено: ' + n);
  if (!String(b.fio || '').trim()) throw new Error('нет собственника');
  // ФИО — как в его переплате (в базе бывает пробел на конце): по нему стенд складывает начислено и возвращено
  const cr = allCredits().find(x => x.unit === n && fioKey(x.fio) === fioKey(b.fio)), fio = cr ? cr.fio : String(b.fio);
  const amount = +b.amount;
  if (!(amount > 0) || !Number.isInteger(amount)) throw new Error('сумма возврата — целые тенге больше нуля');
  const date = db.isoDate(b.date, 'дата возврата'); if (!date) throw new Error('нужна дата возврата');
  if (date > today()) throw new Error('дата возврата — в будущем: отметку ставят, когда деньги уже ушли');
  checkSeen(b, n, fio);
  const note = String(b.note || '').trim().slice(0, 300);
  if (note.length < 3) throw new Error('напишите, как вернули: перевод, наличные, № платёжки');
  const lim = refundable(n, fio);
  if (amount > lim) throw new Error(lim > 0 ? `вернуть можно не больше ${fmtN(lim, 0)} ₸ — столько переплаты по закрытым месяцам`
    : cr ? 'переплаты к возврату нет: она уже зачтена или возвращена (переплата открытого месяца — после его закрытия)' : 'у этого собственника переплаты по закрытым месяцам нет');
  // без поля period: страница, открытая до обновления, взяла бы запись с period за строку «Зачёт переплаты» в квитанции
  const list = offsets(), month = date.slice(0, 7), k = list.filter(x => x.unit === n && x.type === 'REFUND').length + 1;
  const rec = { id: `REF-${n}-${k}-${Date.now().toString(36)}`, unit: n, fio, amount, date, month, type: 'REFUND', note,
                at: new Date().toISOString(), by: b.by || db.actor() || 'оператор' };
  list.push(rec); db.save('offsets');
  db.logChange(n, `переплата возвращена деньгами ${dmy(date)} — ${fio.trim()}`, '', `−${fmtN(amount, 0)} ₸ · ${note}`, month);
  return rec;
}
const dmy = d => String(d || '').split('-').reverse().join('.');
function delOffset(id) {
  const list = offsets(), i = list.findIndex(x => x.id === id);
  if (i < 0) throw new Error('зачёт не найден');
  const rec = list[i];
  if (rec.type === 'REFUND') {   // возврат квитанций не меняет — отметку можно снять в любой момент (ошибка оператора)
    list.splice(i, 1); db.save('offsets');
    db.logChange(rec.unit, `отметка о возврате переплаты снята (${dmy(rec.date)}) — ${String(rec.fio || '').trim()}`, `−${fmtN(rec.amount, 0)} ₸ · ${rec.note || ''}`, '', rec.month || String(rec.date || '').slice(0, 7));
    return { ok: true };
  }
  if (findClosed(rec.period) || (lastClosed() && rec.period <= lastClosed())) throw new Error(`месяц ${rec.period} закрыт — зачёт уже в квитанции, отменить нельзя`);
  list.splice(i, 1); db.save('offsets');
  db.logChange(rec.unit, `зачёт переплаты отменён · ${rec.type === 'EK' ? 'эксплуатационная' : 'коммунальная'} квитанция ${rec.period}`, `−${fmtN(rec.amount, 0)} ₸`, '', rec.period);
  return { ok: true };
}

/** Всё, что нужно интерфейсу о периоде: снимок (целиком, если закрыт), корректировки, переносы, переплаты и зачёты. */
function info(p, full) {
  const c = findClosed(p);
  return {
    period: p,
    closed: full ? c : header(c),
    closedPeriods: closedPeriods(),
    lastClosed: lastClosed(),
    adjustments: adjustments(p),
    carries: carriesInto(p),
    credits: allCredits(),
    offsets: offsets(),
  };
}

const near = (a, b, eps) => Math.abs((+a || 0) - (+b || 0)) <= eps;

/** Закрыть период: проверки → копия базы → материализация переносов → запись → журнал. */
function close(p, body) {
  if (!PERIOD_RE.test(p)) throw new Error('период должен быть вида ГГГГ-ММ');
  if (findClosed(p)) throw new Error(`период ${p} уже закрыт`);
  const last = lastClosed();
  if (last && nextPeriod(last) !== p) throw new Error(`закрывать только по порядку: следующий к закрытию — ${nextPeriod(last)}`);
  const snap = body && body.snapshot;
  if (!snap || snap.period !== p) throw new Error('снимок не совпадает с периодом');
  if (!snap.inputs || !snap.ctx || !snap.units || !snap.totals) throw new Error('в снимке нет inputs / ctx / units / totals');
  // помеченные на удаление в расчёте месяца не участвуют и в снимок не идут (04.10.2026, проверка сервера: из-за одной
  // пометки месяц нельзя было закрыть — «в снимке нет помещений: 1002»)
  const units = db.load('units').filter(u => !u.del);
  const missing = units.filter(u => !snap.units[u.n]).map(u => u.n);
  if (missing.length) throw new Error('в снимке нет помещений: ' + missing.slice(0, 10).join(', '));
  // снимок считал браузер — по данным, какими он их загрузил; помещение с тех пор поменяли (другое окно, импорт,
  // корректировка) — снимок устарел, не записываем (отпечатки db.unitRevs, 04.10.2026)
  if (body.revs) {
    const cur = db.unitRevs(), stale = Object.keys(snap.units).filter(n => body.revs[n] && cur[n] && body.revs[n] !== cur[n]);
    if (stale.length) throw new Error(`данные помещений изменились после загрузки страницы (${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ' и ещё ' + (stale.length - 8) : ''}) — обновите страницу (F5) и закройте период заново`);
  }
  // строки «Зачёт переплаты» в снимке — только настоящие зачёты этого месяца в КУ / ЭК (04.10.2026: страница, открытая до
  // обновления, могла принять отметку о возврате деньгами за зачёт)
  const offIds = new Set(offsets().filter(o => o.period === p && (o.type === 'KU' || o.type === 'EK')).map(o => o.id));
  const badOff = Object.keys(snap.units).filter(n => (snap.units[n].offsets || []).some(o => !offIds.has(o.id)));
  // и наоборот: зачёт, сделанный в другом окне после загрузки страницы, не должен выпасть из закрытой квитанции
  offsets().filter(o => offIds.has(o.id) && !((snap.units[o.unit] || {}).offsets || []).some(x => x.id === o.id)).forEach(o => { if (!badOff.includes(o.unit)) badOff.push(o.unit); });
  if (badOff.length) throw new Error(`зачёты переплаты изменились после загрузки страницы (${badOff.slice(0, 8).join(', ')}) — обновите страницу (F5) и закройте снова`);
  // тождества: сумма по помещениям = итог, части = помещение (± копейка округления строк)
  let sum = 0;
  Object.values(snap.units).forEach(u => {
    sum += +u.total || 0;
    const parts = (u.split && u.split.parts) || [];
    if (parts.length) {
      const ps = parts.reduce((s, x) => s + (+x.total || 0), 0);
      // итог части — сумма её строк, округлённых до копейки (до 9 строк) — допуск полкопейки на строку
      if (!near(ps, u.total, 0.05 * parts.length)) throw new Error(`помещение ${u.n}: сумма квитанций ${fmtN(ps, 2)} ≠ начислено ${fmtN(u.total, 2)}`);
    }
  });
  if (!near(sum, snap.totals.accrued, 0.01 * units.length)) throw new Error(`сумма по помещениям ${fmtN(sum, 2)} ≠ итог снимка ${fmtN(snap.totals.accrued, 2)}`);
  const cl = snap.checklist || {};
  const red = Object.keys(cl).filter(k => cl[k] && cl[k].ok === false);
  if (red.length && !body.force) throw new Error('чек-лист не пройден: ' + red.map(k => cl[k].label || k).join('; '));
  if (red.length && !(body.note || '').trim()) throw new Error('принудительное закрытие требует причину');

  db.backup('close-' + p);
  // переносы корректировок прошлых месяцев, адресованные этому периоду, — теперь часть его доходных
  const carries = carriesInto(p);
  snap.inputs.external = (snap.inputs.external || []).filter(x => !x.carryOf);
  carries.forEach(a => {
    [['water', 'water'], ['e', 'electricity'], ['heat', 'heat']].forEach(([k, res]) => {
      const v = +a.carry[k] || 0;
      if (Math.abs(v) < 1e-9) return;
      snap.inputs.external.push({ n: a.carry.note || `корректировка за ${a.period}: ${a.unit}`, res, c: v, on: 1, carryOf: a.id });
    });
  });
  const rec = {
    period: p, status: 'closed',
    closedAt: new Date().toISOString(), closedBy: body.by || db.actor() || 'оператор',
    forced: !!red.length, note: body.note || '', checklist: cl,
    engineVersion: snap.engineVersion || '',
    inputs: snap.inputs, ctx: snap.ctx, totals: snap.totals, units: snap.units,
    // квитанции собственника, ушедшие в минус (с перерасчётом, зачётами) — переплата: браузер считает, сервер хранит
    credits: (Array.isArray(snap.credits) ? snap.credits : []).filter(x => x && x.unit && x.fio && +x.amount > 0)
      .map(x => ({ unit: String(x.unit), fio: String(x.fio), period: p, code: String(x.code || ''), type: x.type === 'EK' ? 'EK' : 'KU', amount: Math.round(+x.amount) })),
    history: [],
  };
  const list = all(); list.push(rec); db.save('closed_periods');
  db.logChange('*', `период ${p} закрыт${rec.forced ? ' принудительно' : ''}`, '',
    `начислено ${fmtN(snap.totals.accrued, 2)} ₸, помещений ${units.length}, квитанций ${snap.totals.invoices || ''}` +
    (rec.forced ? `; не пройдено: ${red.map(k => cl[k].label || k).join('; ')}; причина: ${rec.note}` : ''), p);
  return header(rec);
}

/** Переоткрыть: только последний закрытый и только без корректировок; снимок остаётся в истории. */
function reopen(p, body) {
  const c = findClosed(p);
  if (!c) throw new Error(`период ${p} не закрыт`);
  // открыть заново могут только руководитель (администратор) и бухгалтерия (заказчик, 05.10.2026). Кто работает — заголовок X-User стенда; паролей пока нет, настоящий вход — в кабинете
  { const who = db.actor() || (body && body.by) || '';
    const list = db.load('settings').users || [{ name: 'Бухгалтерия', dept: 'k' }, { name: 'Работа с собственниками', dept: 'r' }, { name: 'Руководитель', dept: '' }];
    const u = list.find(x => x.name === who);
    if (!u || u.dept === 'r') throw new Error('открыть период заново могут только «Руководитель» и «Бухгалтерия» — выберите в верхней полосе, кто работает'); }
  if (lastClosed() !== p) throw new Error(`открыть можно только последний закрытый период (${lastClosed()})`);
  if (adjustments(p).length) throw new Error('по периоду есть корректировки — переоткрытие запрещено (оформите отменяющую корректировку)');
  if (!(body && (body.reason || '').trim())) throw new Error('нужна причина переоткрытия');
  // переплату этого месяца уже зачли в следующем месяце или вернули деньгами — открывать нельзя (заказчик, 04.10.2026):
  // после переоткрытия она снова стала бы «будет» (квитанция открытого месяца в минусе), а её уже израсходовали. Зачёт в самом
  // этом месяце не мешает — он остаётся строкой его квитанции. Другая переплата собственника (прошлых месяцев), которой
  // хватает на всё израсходованное, тоже не мешает.
  const busy = [];
  [...new Set((c.credits || []).filter(x => +x.amount > 0).map(x => JSON.stringify([x.unit, fioKey(x.fio)])))].forEach(k => {
    const [n, f] = JSON.parse(k);
    const other = allCredits().filter(x => x.unit === n && fioKey(x.fio) === f && !(x.source === 'close' && x.period === p)).reduce((a, x) => a + (+x.amount || 0), 0);
    const spent = offsets().filter(o => o.unit === n && fioKey(o.fio) === f && (o.type === 'REFUND' || o.period !== p)).reduce((a, o) => a + (+o.amount || 0), 0);
    if (spent > other + 0.5) busy.push(`${n} — ${(c.credits.find(x => x.unit === n && fioKey(x.fio) === f) || {}).fio || ''}`.trim());
  });
  if (busy.length) throw new Error(`переплату этого месяца уже зачли в следующем месяце или вернули деньгами (${busy.join('; ')}) — открыть заново нельзя. Если это ошибка — сначала отмените зачёт или снимите отметку о возврате`);
  db.backup('reopen-' + p);
  c.status = 'reopened';
  c.history.push({ closedAt: c.closedAt, closedBy: c.closedBy, reopenedAt: new Date().toISOString(), reopenedBy: body.by || db.actor() || 'оператор', reason: body.reason });
  db.save('closed_periods');
  db.logChange('*', `период ${p} открыт заново`, '', body.reason, p);
  return { ok: true };
}

// «к оплате», счета квитанций, разница по строкам и перенос в ОДН — формулы движка (engine/calc.js), те же, что в пульте
const ENG = require('../engine/calc.js').createEngine();
const TYPES = ['contract', 'reading', 'reading-delete', 'owner', 'other', 'amount'];
/** Счета квитанций месяца: «собственник + плательщик» → к оплате КУ и ЭК (целые тенге) — части одного счёта складываются
 *  (acctMap движка; копия помещения — движок дописывает части одночастному). */
function acctsOf(u) { return ENG.acctMap(JSON.parse(JSON.stringify(u || {}))); }

/**
 * Разница «после − до» по строкам и по частям (квитанциям); accounts — по счетам квитанций «собственник + плательщик»,
 * к оплате КУ и ЭК целыми тенге (заказчик, 04.10.2026: разницу считать по каждому плательщику — доверительная задним числом:
 * собственнику к зачёту, УК к доплате; раньше части сравнивались по номеру, и выходило «разницы нет»).
 */
function deltaOf(before, after) {
  const delta = ENG.fieldDelta(before, after);
  const bParts = (before.split && before.split.parts) || [], aParts = (after.split && after.split.parts) || [];
  delta.parts = aParts.map((x, i) => ({ idx: i, fio: x.fio, total: +((+x.total || 0) - (bParts[i] ? +bParts[i].total || 0 : 0)).toFixed(2) }));
  const A = acctsOf(before), B = acctsOf(after);
  delta.accounts = [...new Set([...Object.keys(A), ...Object.keys(B)])].map(k => {
    const a = A[k] || { ku: 0, ek: 0 }, b = B[k] || { ku: 0, ek: 0 }, x = B[k] || A[k];
    return { fio: x.fio, payer: x.payer, ku: b.ku - a.ku, ek: b.ek - a.ek };
  }).filter(x => x.ku || x.ek);
  return delta;
}
/** Перенос в базу ОДН: Δ «в счёт УК» + Δ ОДН помещения, адресован месяцу q. */
function carryOf(delta, q, p, n, reason) {
  const carry = Object.assign({ period: q }, ENG.carryFromDelta(delta));
  carry.note = `корректировка за ${p}: ${n}` + [carry.water ? `вода ${sgn(carry.water)}${fmtV(carry.water)} м³` : '', carry.e ? `электро ${sgn(carry.e)}${fmtV(carry.e)} кВт·ч` : '', carry.heat ? `тепло ${sgn(carry.heat)}${fmtV(carry.heat)} Гкал` : ''].filter(Boolean).map(s => ', ' + s).join('') + (reason ? ` (${reason})` : '');
  return carry;
}
/**
 * Каскад: изменённое конечное показание закрытого месяца → начальное следующего (только полная корректировка). При любой
 * причине (04.10.2026, проверка корректировок: правка показания в карточке с причиной «другое» каскада не давала, начало
 * следующего месяца оставалось прежним — 10 кВт·ч выставлялись и перерасчётом, и в расходе следующего; принцип 5 плана:
 * «исправленное конечное показание закрытого месяца становится начальным следующего — всегда»). «Ввести вручную» —
 * и при исправлении показания (раньше для него всегда брался новый конец).
 */
function cascadeReadings(p, n, seq, before, after, type, casc) {
  const cascade = [];
  const q = nextPeriod(p), readings = db.load('readings');
  const bm = {}; (before.det || []).forEach(d => { bm[d.m.id] = d; });
  (after.det || []).forEach(d => {
    const was = bm[d.m.id]; if (!was) return;
    const oldCur = was.rd ? was.rd.cur : null, newCur = d.rd ? d.rd.cur : null;
    if (db.same(oldCur, newCur)) return;
    let rec = readings.find(x => x.meter === d.m.id && x.period === q);
    const mode = casc && casc.mode === 'manual' ? 'manual' : newCur != null ? 'auto' : ((casc && casc.mode) || 'empty');
    const val = mode === 'auto' ? newCur : mode === 'manual' ? (casc && casc.value != null ? casc.value : null) : null;
    const isNew = !rec;
    if (!rec) {
      if (val == null && mode !== 'empty') return;
      rec = { meter: d.m.id, period: q, prev: null, cur: null, midRead: null, ownRead: null }; readings.push(rec);
    }
    if (rec.lockPrev) { cascade.push({ meter: d.m.id, period: q, field: 'prev', before: rec.prev, after: rec.prev, mode: 'locked' }); return; }
    // «было» — прежнее начало (проверка 05.10.2026): страница записывает помещение (PUT /api/unit) до adjust-group, и перенос
    // «начало = конец прошлого» (db.carryStarts) уже поставил новый конец закрытого месяца — в корректировке и журнале
    // выходило «2286.14 → 2286.14». Перенесённое автоматически и равное новому концу (или снятое вместе со стёртым) — до
    // переноса было прежним концом; внесённое руками или прежней корректировкой перенос не трогает — берём как есть
    const auto = !rec.prevSrc || db.isAutoStart(rec.prevSrc);
    const wasPrev = !isNew && auto && db.same(rec.prev, newCur) ? oldCur : rec.prev;
    cascade.push({ meter: d.m.id, period: q, field: 'prev', before: wasPrev, after: val, mode });
    rec.prev = val;
    rec.prevSrc = 'adj:' + `ADJ-${p}-${n}-${seq}` + (mode === 'manual' ? '/manual' : '');
    rec.prevNote = mode === 'empty' ? 'нет данных — показание удалено корректировкой' : `из корректировки за ${p}`;
    db.logChange(n, `начальное показание ${q} · ${db.RES_NAME[d.m.res] || d.m.res} ${d.m.sn || 'б/н'} (каскад корректировки)`, wasPrev == null ? '' : String(wasPrev), val == null ? '' : String(val), q);
  });
  db.save('readings');
  return cascade;
}
/** Подпись причины по структурным полям — для журнала и квитанции (даты — дд.мм.гггг). */
const fdt = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : (d || ''); };
function causeLabel(cause, text, doc) {
  const RES = { w: 'воде', e: 'электро', h: 'теплу' };
  let s = '';
  if (!cause || !cause.kind) s = '';
  else if (cause.kind === 'contract') s = `разграничение по ${RES[cause.res] || cause.res}, договор №${cause.no || 'б/н'}${cause.from ? ' с ' + fdt(cause.from) : ''}${cause.seal ? ', акт ' + (cause.sealNo ? '№' + cause.sealNo + ' ' : '') + 'от ' + fdt(cause.seal) : ''}`;
  else if (cause.kind === 'reading') s = `показание ${cause.meter || ''}: ${cause.was == null ? '—' : fmtV(cause.was)} → ${cause.now == null ? 'удалено' : fmtV(cause.now)}`;
  // doc — текст, который уходит в документы (перенос в «Доходные» снимка): без ФИО
  else if (cause.kind === 'owner') s = doc ? `смена собственника с ${fdt(cause.date)}` : `смена собственника ${fdt(cause.date)}: ${cause.fio || ''}`;
  else if (cause.kind === 'amount') s = `корректировка суммы ${cause.target === 'EK' ? 'ЭК' : 'КУ'}: ${sgn(+cause.amount)}${fmtN(+cause.amount || 0, 0)} ₸`;
  return [s, text].filter(Boolean).join(' — ');
}

/**
 * Номер корректировочной квитанции — один на документ (проверка 05.10.2026): браузер нумерует сам (adjCodesUnique), здесь —
 * страховка от страницы со старым кодом. Совпали номера у КУ (или у ЭК) одной корректировки — по порядку документов
 * /1К<n>, /2К<n>, … (аннулирующая прежнему /1, новая другому /2); без совпадений — как есть.
 */
function codesUnique(invs) {
  ['KU', 'EK'].forEach(T => {
    const ds = invs.filter(v => v.kind === 'corrective' && v.code && (v.target === 'EK' ? 'EK' : 'KU') === T);
    if (new Set(ds.map(v => v.code)).size < ds.length) ds.forEach((v, i) => { v.code = String(v.code).replace(/\/\d*К(\d+)$/, `/${i + 1}К$1`); });
  });
  return invs;
}

/**
 * Группа корректировок — одно действие оператора, несколько закрытых месяцев (ТЗ заказчика 21.09.2026):
 * последний закрытый — полная (каскад, перенос, документ за месяц), более ранние — суммарные
 * (без каскада, документ — строкой в первом открытом месяце). Все переносы — в первый открытый месяц.
 * Тело: { cause, text, billing, by, periods:[{period, after, invoices, cascade?}] }. Атомарно.
 */
function adjustGroup(n, body) {
  const last = lastClosed();
  if (!last) throw new Error('закрытых периодов нет — корректировка не нужна, данные просто правятся');
  const cause = body.cause || { kind: 'other' };
  const type = cause.kind === 'reading' ? (cause.now == null ? 'reading-delete' : 'reading') : (cause.kind || 'other');
  if (!TYPES.includes(type)) throw new Error('тип корректировки: ' + TYPES.join(' / '));
  const reason = causeLabel(cause, body.text);
  if (!reason.trim()) throw new Error('нужна причина корректировки');
  const items = (body.periods || []).slice().sort((a, b) => a.period < b.period ? -1 : 1);
  if (!items.length) throw new Error('нет задетых закрытых месяцев');
  items.forEach(it => {
    const c = findClosed(it.period);
    if (!c) throw new Error(`период ${it.period} не закрыт`);
    if (!c.units[n]) throw new Error(`помещения ${n} нет в снимке ${it.period}`);
    if (it.period > last) throw new Error('период позже последнего закрытого');
    if (it.period !== last && (type === 'reading' || type === 'reading-delete')) throw new Error('показания правятся только в последнем закрытом месяце');
    if (!it.after || it.after.n !== n) throw new Error(`нет пересчёта помещения за ${it.period}`);
    // расклад считался, когда корректировок по месяцу было it.seen; с тех пор оформили ещё (второе нажатие, другое окно) —
    // не записывать: строки посчитаны от старой базы, деньги ушли бы дважды (04.10.2026, проверка корректировок)
    if (it.seen != null && adjustments(it.period, n).length !== +it.seen)
      throw new Error(`по помещению ${n} за ${it.period} корректировку уже оформили (повторное нажатие или другое окно) — закройте форму и посмотрите расклад заново`);
    // показания более раннего закрытого месяца (не последнего) правятся только через последний — и с причиной «другое»
    // тоже (там каскада нет, начало следующего закрытого осталось бы прежним, объём выставился бы дважды)
    if (it.period !== last) {
      const c = findClosed(it.period), prev = adjustments(it.period, n), base = prev.length ? prev[prev.length - 1].after : c.units[n];
      const rd = u => { const o = {}; (u.det || []).forEach(d => { if (d && d.m) o[d.m.id] = d.rd ? [d.rd.prev, d.rd.cur] : [null, null]; }); return o; };
      const a = rd(base), b = rd(it.after), diff = Object.keys(Object.assign({}, a, b)).filter(k => !db.same((a[k] || [])[0], (b[k] || [])[0]) || !db.same((a[k] || [])[1], (b[k] || [])[1]));
      if (diff.length) throw new Error(`показания за ${it.period} изменены (${diff.map(k => { const [, res, sn] = k.split('|'); return `${db.RES_NAME[res] || res} ${sn || 'б/н'}`; }).join(', ')}) — показания правятся только в последнем закрытом месяце (${last}); верните их и исправьте через ${last}`);
    }
  });
  const q = nextPeriod(last);
  const groupNo = db.load('adjustments').filter(a => a.group && a.group.startsWith(`ADJG-${last}-${n}-`)).length + 1;
  const group = `ADJG-${last}-${n}-${groupNo}`;
  const list = db.load('adjustments');
  const made = [];
  items.forEach(it => {
    const p = it.period, c = findClosed(p);
    const prev = adjustments(p, n), seq = prev.length + 1;
    const before = prev.length ? prev[prev.length - 1].after : c.units[n];
    const delta = deltaOf(before, it.after);
    const scope = p === last ? 'full' : 'summary';
    // способ — по документам, которые браузер выставил (А, Б или оба при «собственника там нет»), а не по сумме месяца:
    // смена плательщика при той же сумме — документы есть, хотя Δ месяца 0 (04.10.2026)
    const kinds = new Set((it.invoices || []).map(x => x.kind));
    const billing = !kinds.size ? 'none' : kinds.size > 1 ? 'mixed' : kinds.has('corrective') ? 'corrective' : 'next-period';
    made.push({ p, seq, before, delta, scope, billing, id: `ADJ-${p}-${n}-${seq}`, it });
  });
  // всё проверено — записываем; каскад только у полной
  made.forEach(m => {
    const cascade = m.scope === 'full' ? cascadeReadings(m.p, n, m.seq, m.before, m.it.after, type, m.it.cascade) : [];
    const a = {
      id: m.id, period: m.p, unit: n, seq: m.seq, group, scope: m.scope,
      at: new Date().toISOString(), by: body.by || db.actor() || 'оператор',
      type, cause, text: body.text || '', reason,
      changes: body.changes || [],
      before: m.before, after: m.it.after, delta: m.delta, billing: m.billing,
      // номер корректировочной квитанции получает порядковый номер корректировки: КВ-НП1-2026-06/К2 (при частях /1К2)
      invoices: codesUnique((m.it.invoices || []).map(inv => Object.assign({}, inv, { adjustment: m.id, group, code: inv.code ? String(inv.code).replace('К?', 'К' + m.seq) : inv.code }))),
      carry: carryOf(m.delta, q, m.p, n, causeLabel(cause, body.text, true)), cascade, status: 'applied',
    };
    // корректировочная квитанция собственника «к зачёту» — его переплата (заказчик, 03.10.2026: напоминалка и зачёт по кнопке)
    // переплата меняется на: «к зачёту» деньгами (собственник заплатил больше, чем стало) + изменение минуса квитанции
    // (была в минусе — доплата сначала уменьшает переплату). Знак — со знаком: минус уменьшает остаток (04.10.2026)
    a.credits = a.invoices.filter(x => x.kind === 'corrective' && (x.payer || 'owner') === 'owner')
      .map(x => ({ unit: n, fio: x.fio || '—', period: m.p, code: x.code, type: x.target === 'EK' ? 'EK' : 'KU', amount: Math.round((+x.settle < 0 ? -x.settle : 0) + (+x.creditDelta || 0)), adj: m.id }))
      .filter(x => x.amount);
    list.push(a);
    db.logChange(n, `корректировка ${a.id} (${a.type}${a.scope === 'summary' ? ', суммарная' : ''}, группа ${group})`, fmtN(m.before.total, 2), fmtN(m.it.after.total, 2) + ` · ${a.billing === 'corrective' ? 'корректировочная квитанция' : a.billing === 'next-period' ? 'строкой в ' + q : a.billing === 'mixed' ? 'строкой в ' + q + ' и корректировочной квитанцией' : 'без выставления'} · ${reason}`, m.p);
  });
  db.save('adjustments');
  return { group, adjustments: made.map(m => list.find(a => a.id === m.id)) };
}

/**
 * Оформить корректировку по помещению в последнем закрытом периоде.
 * Тело: { type, reason, billing, by, after (UnitResult в ctx снимка), invoices, cascade:{mode,value}, changes }.
 * Сервер сам считает seq, before, delta и перенос; делает каскад показаний в следующий месяц.
 */
function adjust(p, n, body) {
  const c = findClosed(p);
  if (!c) throw new Error(`период ${p} не закрыт — корректировка не нужна, просто правьте данные`);
  if (lastClosed() !== p) throw new Error(`корректировать можно только последний закрытый период (${lastClosed()})`);
  const snapUnit = c.units[n];
  if (!snapUnit) throw new Error(`помещения ${n} нет в снимке ${p}`);
  if (!TYPES.includes(body.type)) throw new Error('тип корректировки: ' + TYPES.join(' / '));
  const reasonTxt = (body.reason || '').trim() || causeLabel(body.cause, body.text);
  if (!reasonTxt) throw new Error('нужна причина корректировки');
  body.reason = reasonTxt;
  if (!body.after || body.after.n !== n) throw new Error('нет пересчёта помещения (after)');
  const prev = adjustments(p, n);
  const seq = prev.length + 1;
  const before = prev.length ? prev[prev.length - 1].after : snapUnit;
  const after = body.after;
  const delta = deltaOf(before, after);
  const billing = Math.abs(delta.total) < 0.005 ? 'none' : (body.billing === 'corrective' ? 'corrective' : 'next-period');
  const q = nextPeriod(p);
  const carry = carryOf(delta, q, p, n, body.reason);
  const cascade = cascadeReadings(p, n, seq, before, after, body.type, body.cascade);
  const a = {
    id: `ADJ-${p}-${n}-${seq}`, period: p, unit: n, seq, scope: 'full', group: null,
    at: new Date().toISOString(), by: body.by || db.actor() || 'оператор',
    type: body.type, cause: body.cause || null, text: body.text || '', reason: body.reason,
    changes: body.changes || [],
    before, after, delta, billing,
    invoices: (body.invoices || []).map(inv => Object.assign({}, inv, { adjustment: `ADJ-${p}-${n}-${seq}` })),
    carry, cascade, status: 'applied',
  };
  const list = db.load('adjustments'); list.push(a); db.save('adjustments');
  db.logChange(n, `корректировка ${a.id} (${a.type})`, fmtN(before.total, 2), fmtN(after.total, 2) + ` · ${a.billing === 'corrective' ? 'корректировочная квитанция' : a.billing === 'next-period' ? 'строкой в ' + q : 'без выставления'} · ${a.reason}`, p);
  return a;
}

module.exports = { info, close, reopen, adjust, adjustGroup, causeLabel, findClosed, closedPeriods, lastClosed, adjustments, carriesInto, inAnySnapshot, nextPeriod, prevPeriod, header,
                   allCredits, offsets, addOffset, delOffset };
