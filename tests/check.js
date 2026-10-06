'use strict';
/**
 * npm run check — расчёт тестового набора движком и сверка с эталоном.
 *
 * Набор — полная копия базы за июнь 2026 (tests/fixtures/2026-06; нужды ЭК по теплу 0,2121). Эталон — tests/etalon.json: КУ и ЭК
 * по помещениям (по квитанциям месяца, при делении месяца — каждая часть), итоги дома, ОДН воды на помещение, ОДН электроэнергии
 * на м², коэффициент отопления, ОДН тепла на м². Набор копируется во временную папку — сама копия не меняется.
 * Вывод — таблица «ожидалось / получилось / расхождение»; код выхода 0 — расхождений нет, 1 — есть.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ET = JSON.parse(fs.readFileSync(path.join(__dirname, 'etalon.json'), 'utf8'));
const SRC = path.join(__dirname, ET.fixture);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'torre-check-'));
fs.readdirSync(SRC).filter(f => f.endsWith('.json')).forEach(f => fs.copyFileSync(path.join(SRC, f), path.join(TMP, f)));
process.env.TORRE_DATA = TMP;   // сервер читает базу из этой папки (server/db.js)

const { calcMonth } = require('../server/accruals');

const money = v => (v == null ? '—' : (+v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const coef = v => (v == null ? '—' : String(+(+v).toPrecision(12)).replace('.', ','));

(async () => {
  const rows = [];   // [показатель, ожидалось, получилось, расхождение, ок]
  let res;
  try { res = await calcMonth(ET.period); }
  catch (e) { console.error('Расчёт не выполнен:', e.message); cleanup(); process.exit(1); }
  if (res.errs && res.errs.length) { console.error('Ошибки данных:', res.errs.join('; ')); cleanup(); process.exit(1); }

  const addMoney = (name, exp, got) => { const d = got == null ? null : Math.round((got - exp) * 100) / 100; rows.push([name, money(exp), money(got), d == null ? 'нет значения' : money(d), d === 0]); };
  const addCoef = (name, exp, got) => {
    const d = got == null ? null : got - exp, ok = d != null && Math.abs(d) <= 1e-9 * Math.max(1, Math.abs(exp));
    rows.push([name, coef(exp), coef(got), d == null ? 'нет значения' : (ok ? '0' : coef(d)), ok]);
  };

  Object.keys(ET.units).forEach(n => {
    const e = ET.units[n], g = res.units[n] || { KU: [], EK: [] }, many = e.KU.length > 1;
    e.KU.forEach((v, i) => addMoney(`${n}${many ? ` /${i + 1}` : ''} — КУ`, v, g.KU[i]));
    e.EK.forEach((v, i) => addMoney(`${n}${many ? ` /${i + 1}` : ''} — ЭК`, v, g.EK[i]));
    if (g.KU.length !== e.KU.length) rows.push([`${n} — квитанций в месяце`, String(e.KU.length), String(g.KU.length), 'другое число', false]);
  });
  const t = res.env.totals;
  addMoney('Дом — КУ, сумма строк', ET.house.KU, t.KU.linesSum);
  addMoney('Дом — ЭК, сумма строк', ET.house.EK, t.EK.linesSum);
  addMoney('Дом — КУ к оплате', ET.house.KUpayable, t.KU.sum);
  addMoney('Дом — ЭК к оплате', ET.house.EKpayable, t.EK.sum);
  rows.push(['Дом — документов', String(ET.house.documents), String(t.documents), t.documents === ET.house.documents ? '0' : String(t.documents - ET.house.documents), t.documents === ET.house.documents]);
  addCoef('ОДН воды на помещение, м³', ET.odn.waterPerUnit, res.ctx.odnPerUnitW);
  addCoef('ОДН электроэнергии на м², кВт·ч', ET.odn.electroPerM2, res.ctx.odnPerAreaE);
  addCoef('Коэффициент отопления, Гкал/м²', ET.odn.heatK, res.ctx.kOt);
  addCoef('ОДН тепла на м², Гкал', ET.odn.heatOdnPerM2, res.ctx.kOdn);

  const W = [0, 1, 2, 3].map(i => Math.max(...[['Показатель', 'Ожидалось', 'Получилось', 'Расхождение'][i], ...rows.map(r => r[i])].map(s => String(s).length)));
  const line = cells => cells.map((c, i) => (i ? String(c).padStart(W[i]) : String(c).padEnd(W[i]))).join('  │  ');
  console.log(`Тестовый набор: ${ET.period} (${ET.fixture}) — сверка с tests/etalon.json\n`);
  console.log(line(['Показатель', 'Ожидалось', 'Получилось', 'Расхождение']));
  console.log(W.map(w => '─'.repeat(w)).join('──┼──'));
  rows.forEach(r => console.log(line(r.slice(0, 4)) + (r[4] ? '' : '   ← РАСХОЖДЕНИЕ')));
  const bad = rows.filter(r => !r[4]).length;
  console.log(`\nПоказателей: ${rows.length}. Расхождений: ${bad}.`);
  cleanup();
  process.exit(bad ? 1 : 0);
})();

function cleanup() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { } }
