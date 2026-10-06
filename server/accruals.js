'use strict';
/**
 * Начисления за месяц, посчитанные на сервере, — GET /api/accruals?period=ГГГГ-ММ (заказчик, 05.10.2026: серверный расчёт с отдачей
 * начислений — «за весь месяц»).
 *
 * Ответ — документ выгрузки для личного кабинета (docs/API.md, схема 1.6): все квитанции КУ и ЭК месяца и корректировочные, итоги;
 * status closed — закрытый месяц из снимка, open — текущий расчёт (черновик). Тот же документ даёт кнопка пульта «Отчёты» →
 * «Квитанции за месяц» → «Для кабинета: JSON».
 *
 * Считает движок engine/calc.js — тот же, что в пульте; формул здесь нет. Данные месяца — как их получает пульт (ответ /api/state
 * за месяц: db.getState + снимок, корректировки, переносы, переплаты и зачёты — periods.info). Только чтение: движок работает со
 * своей копией данных в отдельном контексте, в базу ничего не пишется. Контекст — свой на каждый запрос.
 */
const db = require('./db');
const periods = require('./periods');
const ENGINE = require('../engine/calc.js');

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Данные месяца — ровно то, что получает пульт на GET /api/state за этот месяц, — и признак «месяц в стенде есть». */
function stateOf(per) {
  const st = db.getState(per), info = periods.info(per, true);
  const known = new Set([...(st.periods || []), ...(info.closedPeriods || []), ...Object.keys((st.settings && st.settings.byPeriod) || {})]);
  return { known: [...known].sort(), state: known.has(per) ? JSON.parse(JSON.stringify(Object.assign(st, info))) : null };
}

/**
 * Ответ на GET /api/accruals?period=ГГГГ-ММ: {code, body}. 400 — нет месяца или он не ГГГГ-ММ; 404 — месяца в стенде нет (ни
 * показаний, ни вводных месяца, ни закрытия); 500 — в данных ошибка, выгрузка остановлена, с полным списком errors; 200 — документ
 * выгрузки строкой JSON. Сбой самого расчёта — исключение (обработчик сервера ответит 500).
 */
async function month(period) {
  const per = period == null ? '' : String(period).trim();
  if (!per) return { code: 400, body: { error: 'укажите месяц: /api/accruals?period=ГГГГ-ММ, например period=2026-06' } };
  if (!PERIOD_RE.test(per)) return { code: 400, body: { error: `месяц «${per.slice(0, 40)}» — не в виде ГГГГ-ММ: например /api/accruals?period=2026-06` } };
  const s = stateOf(per);
  if (!s.state)
    return { code: 404, body: { error: `месяца ${per} в стенде нет — ни показаний, ни вводных месяца, ни закрытия; есть: ${s.known.join(', ') || 'ни одного'}` } };
  let r;
  try { r = ENGINE.calcMonth(s.state, per); }
  catch (e) { throw new Error(`расчёт начислений за ${per} на сервере не выполнен: ${(e && e.message) || e}`); }
  if (r.errs.length) {
    console.error(`ОШИБКА: начисления ${per} — выгрузка остановлена, ошибок в данных: ${r.errs.length}`);
    return { code: 500, body: { error: 'Выгрузка остановлена — в данных ошибка:\n' + r.errs.slice(0, 12).join('\n'), errors: r.errs } };
  }
  return { code: 200, body: JSON.stringify(r.env) };
}

/**
 * Расчёт месяца для проверки (`npm run check`, tests/check.js): документ выгрузки, суммы по помещениям (КУ и ЭК по квитанциям
 * месяца — по частям), баланс ОДН дома и коэффициенты: ОДН воды на помещение, ОДН электроэнергии на м², коэффициент отопления, ОДН
 * тепла на м². Только чтение.
 */
async function calcMonth(per) {
  const s = stateOf(per);
  if (!s.state) throw new Error(`месяца ${per} в базе нет — есть: ${s.known.join(', ') || 'ни одного'}`);
  return ENGINE.calcMonth(s.state, per);
}

module.exports = { month, calcMonth, stateOf, PERIOD_RE };
