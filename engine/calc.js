/**
 * engine/calc.js — движок расчёта коммунальных услуг (КУ) и эксплуатационных расходов (ЭК) апарт-отеля TOR'RE Astana.
 *
 * Один файл для пульта и для сервера.
 *   - Браузер: подключается отдельным скриптом перед скриптом пульта (public/index.html). Функции движка — глобальные; данные
 *     месяца и поля ввода даёт пульт.
 *   - Node: require('engine/calc.js').createEngine() — тот же файл исполняется в отдельном контексте; данные месяца передаются в
 *     calcMonth(состояние, месяц). Так считают начисления с сервера (GET /api/accruals) и проверка (npm run check).
 * Интерфейса и базы данных в движке нет. Формул расчёта вне этого файла нет: пульт, начисления с сервера, корректировки
 * (server/periods.js) и проверка берут их отсюда.
 *
 * Порядок расчёта, вход и выход — engine/README.md; правила — docs/ПРАВИЛА РАСЧЁТА.md.
 *
 * Что даёт хозяин (пульт или контекст Node) — глобальные имена:
 *   ROWS            помещения месяца, Unit[] — без помеченных на удаление; в закрытом месяце — только помещения его снимка
 *   TAR             строки тарифов, Tariff[]
 *   EXT             доходные месяца, ExternalRow[]; EXT_BASE — список доходных контрагентов (образец для нового месяца)
 *   BY_PERIOD       вводные по месяцам (settings.byPeriod); HEAT_BY_PERIOD — Гкал импорта ЭСФ по месяцам; SETTINGS_LIVE — настройки
 *   CLOSED          снимок закрытого выбранного месяца или null; CLOSED_PERIODS — закрытые месяцы, ГГГГ-ММ[]
 *   ADJ             корректировки выбранного закрытого месяца; CARRIES — корректировки с переносом в ОДН выбранного открытого месяца
 *   CREDITS         переплаты собственников; OFFSETS — зачёты и возвраты переплаты
 *   BASE_PERIOD     месяц, за который у приборов собраны prev / cur (показания других месяцев — в hist)
 *   CTX             контекст расчёта месяца — buildCtx(); хозяин присваивает его перед расчётом помещений
 *   el(id)          поле ввода месяца → { value, checked }:
 *                     f-per — месяц ГГГГ-ММ;
 *                     f-in-w, f-in-e, f-heat — счета-фактуры (вода м³, электроэнергия кВт·ч, тепло Гкал); f-in-w2, f-in-e2, f-heat2 —
 *                     вторые позиции при смене тарифа внутри месяца;
 *                     f-uk-w, f-uk-e, f-uk-h — нужды ЭК (вода, электроэнергия, тепло); f-ek — «ЭК берёт из ОДН», ₸;
 *                     f-bld-area — общая площадь здания, м² (пусто — 23 474,3);
 *                     f-rz — применять договоры разграничения; f-uk — компания платит КУ за помещения в управлении;
 *   gv(id)          число поля; gc(id) — отметка переключателя.
 */

/**
 * @typedef {Object} Owner              Собственник помещения (линия владения).
 * @property {string} fio               ФИО или наименование.
 * @property {?string} from             Владеет с, ГГГГ-ММ-ДД; null — с начала учёта.
 * @property {?string} to               Владеет по; null — по сей день.
 * @property {{w?:boolean,h?:boolean,e?:Object<string,boolean>}} [rz]  Ручные пометки разграничения собственника: w — вода (все
 *                                      водяные приборы), h — тепло, e — электросчётчик по номеру прибора; true — «разграничено
 *                                      вручную», false — «в счёт УК вручную».
 * @property {string} [del]             Пометка на удаление.
 *
 * @typedef {Object} Program            Договор управления.
 * @property {'none'|'trust'|'hybrid'|'share'} prog  Программа: не в управлении, доверительная, гибридная, долевая.
 * @property {string} cno               Номер договора.  @property {?string} cdt  Дата договора.
 * @property {?string} from             В управлении с.   @property {?string} to   В управлении по.
 *
 * @typedef {Object} Reading            Показания прибора за месяц.
 * @property {?number} prev             Начало месяца.  @property {?number} cur  Конец месяца.
 * @property {?number} ownRead          На дату передачи собственнику.
 * @property {boolean} [lockPrev]       Начало зафиксировано актом замены.  @property {boolean} [lockCur]  Конец зафиксирован актом.
 *
 * @typedef {Object} Meter              Прибор учёта.
 * @property {string} id                Номер прибора: «помещение|ресурс|серийный номер».
 * @property {'hvs'|'gvs'|'ee'} res     Ресурс: холодная вода, горячая вода, электроэнергия.
 * @property {string} sn                Серийный номер.  @property {number} k  Коэффициент трансформации.
 * @property {boolean} bill             Участвует в расчётах.
 * @property {?string} from             Установлен с.  @property {?string} to  Снят по.
 * @property {?number} prev  @property {?number} cur  @property {?number} ownRead   Показания месяца BASE_PERIOD.
 * @property {Object<string,Reading>} hist   Показания по месяцам ГГГГ-ММ.
 *
 * @typedef {Object} Contract           Договор разграничения (прямой договор собственника с поставщиком).
 * @property {string} no                Номер.  @property {?string} from  Дата договора.  @property {?string} to  По.
 * @property {?string} seal             Дата акта опломбировки (вода).  @property {string} sealNo  Номер акта.
 * @property {boolean} fact             «По факту» — действует без номера и даты.
 * @property {string} owner             Чей договор (ФИО собственника).  @property {?string} autoClosed  Закрыт продажей (дата).
 * @property {boolean} checked          Дата закрытия проверена оператором.
 *
 * @typedef {Object} Unit               Помещение месяца (server/db.js, buildUnit).
 * @property {string} n                 Номер.  @property {number} area  Площадь, м².  @property {boolean} inodn  Участвует в ОДН.
 * @property {string} t                 Тип.  @property {Owner[]} owners  @property {Program[]} progs  @property {Meter[]} meters
 * @property {{w?:Contract[],e?:Contract[],h?:Contract[]}} rz   Договоры разграничения по ресурсам.
 *
 * @typedef {Object} Tariff             Строка тарифа.
 * @property {'water_supply'|'water_drainage'|'electricity'|'heating'|'maintenance'|'capital_repair'} svc
 * @property {number} base              Тариф без НДС.  @property {number} vat  НДС, %.
 * @property {string} from              С, ГГГГ-ММ-ДД.  @property {string} to  По; пусто — бессрочно.
 *
 * @typedef {Object} ExternalRow        Доходный контрагент месяца.
 * @property {string} n                 Название.  @property {'water'|'electricity'|'heat'} res  Ресурс.
 * @property {number} c                 Объём за месяц.  @property {0|1} on  Учитывается («Учит.»).
 * @property {1} [need]                 Объём за месяц ещё не введён.  @property {1} [defOff]  По умолчанию не учитывается.
 *
 * @typedef {Object} MonthState         Данные месяца — ответ GET /api/state?period=ГГГГ-ММ.
 * @property {string} period            Месяц, за который собраны показания.
 * @property {Unit[]} rows              Помещения (с помеченными на удаление — их движок не берёт).
 * @property {Tariff[]} tariffs  @property {ExternalRow[]} external
 * @property {Object} settings          applyRz, ukPays, byPeriod {ГГГГ-ММ: вводные месяца}, heatByPeriod {ГГГГ-ММ: Гкал}.
 * @property {?Object} closed           Снимок закрытого месяца (server/periods.js).
 * @property {string[]} closedPeriods   @property {Object[]} adjustments  @property {Object[]} carries
 * @property {Object[]} credits         @property {Object[]} offsets
 *
 * @typedef {Object} MonthResult        Результат расчёта месяца.
 * @property {string[]} errs            Ошибки данных; есть — документа выгрузки нет.
 * @property {Object} env               Документ выгрузки (docs/API.md, схема 1.6): квитанции КУ и ЭК со строками, корректировочные,
 *                                      итоги по дому и по плательщикам.
 * @property {Object<string,{KU:number[],EK:number[],payer:string}>} units  Суммы по помещениям — по квитанциям месяца.
 * @property {Object} balance           Баланс ОДН дома: вода, электроэнергия, тепло, компенсация «ЭК берёт из ОДН».
 * @property {Object} ctx               Коэффициенты месяца: odnPerUnitW, odnPerAreaE, kOt, kOdn, ekFactor и др.
 */

// ===== tariffs.ts =====
/** Тариф с НДС. Отдельная функция, чтобы ставка не размазывалась по коду. */
function tariffWithVat(t) {
    // НДС применяется без округления: тариф — промежуточный расчёт.
    // Округление до копеек здесь давало накопленную ошибку ~511 ₸ на здание.
    return t.baseValue * (1 + t.vatRate / 100);
}

/** Округление до копеек. Промежуточные расчёты не округляем. */
function round2(n) {
    return Math.round(n * 100) / 100;
}

function dayStart(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysInMonth(period) {
    return new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Действовал ли тариф на дату. Интервал полуоткрытый: [validFrom, validTo]. */
function activeOn(t, day) {
    if (dayStart(t.validFrom) > day)
        return false;
    if (t.validTo && dayStart(t.validTo) < day)
        return false;
    return true;
}

/**
 * Отрезок месяца с одним действующим тарифом.
 * Если тариф не менялся, отрезок один на весь месяц.
 */
/**
 * Разбивает месяц на отрезки по датам смены тарифа.
 *
 * Нужно для ВОДЫ и ЭЛЕКТРИЧЕСТВА: расход снимается за месяц целиком,
 * поэтому при смене тарифа внутри месяца он делится пропорционально дням.
 *
 * Для ТЕПЛА не используется: там поставщик сам делит объём по периодам
 * и присылает двумя строками счёта.
 */
function splitMonthByTariff(tariffs, resource, service, period) {
    const total = daysInMonth(period);
    const applicable = tariffs.filter(t => t.resource === resource && t.service === service);
    const byDay = new Map();
    for (let d = 1; d <= total; d++) {
        const day = new Date(Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), d));
        const t = applicable.find(x => activeOn(x, day));
        if (!t) {
            throw new Error(`Нет тарифа: ${resource}/${service} на ${day.toISOString().slice(0, 10)}. ` +
                `Заведите тариф с датой начала действия.`);
        }
        const key = t.validFrom.toISOString();
        const acc = byDay.get(key);
        if (acc)
            acc.days += 1;
        else
            byDay.set(key, { t, days: 1 });
    }
    return [...byDay.values()].map(({ t, days }) => ({
        tariff: t,
        value: tariffWithVat(t),
        days,
        share: days / total,
    }));
}

// число из поля или текста с экрана: «−» (U+2212 — так стенд печатает минус) и «–» — тоже минус, как «-» с клавиатуры
const pnum=v=>{const s=String(v==null?'':v).replace(/[\s\u00a0\u202f]/g,'').replace(/[\u2212\u2013]/g,'-').replace(',','.');const n=parseFloat(s);return isFinite(n)?n:0;};

/** Минус в числах на экране — настоящий «−» (U+2212), в пару к «+378» (B32, проверка 05.10.2026): toLocaleString пишет дефис
 *  («-12 753,00», «КУ -2 433»). Округлённое до нуля — без знака: «-0,00» и «-0» → «0,00» и «0». Текст с экрана обратно в число
 *  читают pnum и cellNum — оба «−» понимают; выгрузки, база и JSON — числами, их это не касается. */
function mns(s){ return s.charAt(0)!=='-'?s:/[1-9]/.test(s)?'−'+s.slice(1):s.slice(1); }

const f0=n=>(n==null||!isFinite(n))?'':mns(Math.round(n).toLocaleString('ru-RU'));

/** Показание счётчика для экрана (чек-лист 2.9, 02.10.2026: в форме было «297.094» с точкой): «2 152,05», «271,796». */
const fRd=v=>(v==null||v===''||!isFinite(+v))?'—':mns((+v).toLocaleString('ru-RU',{maximumFractionDigits:6}));

/**
 * Объём, который на экране умножается на тариф: столько знаков, чтобы «объём × тариф (× коэффициент)» на калькуляторе
 * дал сумму строки — ОДН вода 2,000876 м³, тепло 0,018897 Гкал; объём по счётчику остаётся как есть (26,926).
 * min — знаков не меньше (м³ — 3, кВт·ч — 2, Гкал — 4); pairs — [[тариф, сумма строки], …] — один объём на две строки
 * (водоснабжение и водоотведение) показывается одинаково; kf — коэффициент ОДН. Если сумма — не прямое произведение
 * (часть месяца: строки округлены вверх до копейки), — min знаков.
 */
function volDec(vol,min,pairs,kf){
  const v=+vol||0, k=kf&&Math.abs(kf-1)>1e-9?+kf.toFixed(6):1;
  // строка квитанции — вверх до копейки (02.10.2026): объём показываем с тем числом знаков, при котором
  // «объём × тариф», округлённое вверх, даёт сумму строки
  // «рядом» — округлённое и усечённое: доля 14/30 = 0,4666… округлённой всегда чуть больше, «× тариф» уходит на копейку
  // вверх; усечённая 0,4666666 сходится (проверка 05.10.2026)
  if(v) for(let d=min;d<=8;d++){
    for(const vd of [+v.toFixed(d),Math.trunc(Math.round(v*10**(d+3))/1000)/10**d])
      if(pairs.every(([t,a])=>Math.abs(ceil2(vd*(+(+t||0).toFixed(4))*k)-ceil2(+a||0))<0.001)) return {v:vd,d};
  }
  return {v:+v.toFixed(min),d:min};
}

const fdt=d=>{if(!d)return'';const s=String(d).trim();const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[3]+'.'+m[2]+'.'+m[1]:s;};

/** Дата без года — для узких ячеек таблицы: 11.06 */
/** Время записи журнала (ISO, UTC) — местным: «24.09.2026 18:38». */
/** День по местным часам из отметки времени сервера (ISO по Гринвичу): закрыт в 02:00 по Астане 03.10 — сервер пишет
 *  2026-10-02T21:00Z, а на экране должно быть 03.10.2026 (03.10.2026: «закрыт 02.10» при сегодня 03.10). */
const dayLocal=iso=>{ if(!iso) return ''; const s=String(iso); if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d=new Date(s); if(isNaN(d)) return s.slice(0,10); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; };

const D=s=>new Date(s+'T00:00:00Z');

const PROG={none:'не в управлении',trust:'доверительная',share:'долевая',hybrid:'гибридная'};

const RESOF={water_supply:'water',water_drainage:'water',electricity:'electricity',heating:'heat',maintenance:'maint',capital_repair:'maint'};

function tarObjs(){
  let list=TAR.map(t=>({resource:RESOF[t.svc],service:t.svc,baseValue:pnum(t.base),vatRate:pnum(t.vat),
    validFrom:D(t.from),validTo:t.to?D(t.to):null}));
  return list;
}

/** Тариф 0 хоть на день месяца (заказчик, 03.10.2026: предупреждать, как «нет тарифа»): строка услуги 0 у всех помещений, а
 *  стенд молчал (проба 0 по воде с 22.08.2026 стояла незамеченной). «Водоснабжение с 22.08.2026» — для шапки, шагов
 *  месяца, «Проверок за месяц» и чек-листа закрытия. Нет тарифа совсем — отдельная проверка (tarOf().err). */
/** Все услуги с тарифом — и ЭК (04.10.2026, проверка денег: тариф техобслуживания 0 или пропуск в датах молча заменялся
 *  на 698 и 35 — проверки «тариф 0» и «нет тарифа» смотрели только коммунальные). */
const TAR_SVC_ALL=['water_supply','water_drainage','electricity','heating','maintenance','capital_repair'];

/** Строки тарифа одной услуги, пересекающиеся по датам: расчёт брал одну, шапка счетов-фактур — другую (проверка денег
 *  04.10.2026: новый тариф водоснабжения с 16.08 без «по» у старого — расчёт оставлял старый, недобор 137 784,96 ₸ за месяц). */
function tarOverlaps(){
  const out=[];
  TAR_SVC_ALL.forEach(sv=>{
    const rows=TAR.filter(t=>t.svc===sv&&t.from).slice().sort((a,b)=>a.from<b.from?-1:1);
    for(let i=1;i<rows.length;i++){ const a=rows[i-1], b=rows[i];
      if(!a.to||a.to>=b.from) out.push(`${(SVC_OPTS.find(o=>o.svc===sv)||{lab:sv}).lab}: с ${fdt(a.from)} ${a.to?'по '+fdt(a.to):'без даты «по»'} и с ${fdt(b.from)}`); }
  });
  return out;
}

function zeroTar(){
  const P=D(el('f-per').value+'-01'), out=[];
  TAR_SVC_ALL.forEach(sv=>{
    let sg=[]; try{ sg=splitMonthByTariff(tarObjs(),RESOF[sv],sv,P); }catch(e){ return; }
    sg.filter(x=>!(x.value>0)).forEach(x=>{ const from=x.tariff.validFrom>P?x.tariff.validFrom.toISOString().slice(0,10):null;
      out.push((SVC_OPTS.find(o=>o.svc===sv)||{lab:sv}).lab+(from?' с '+fdt(from):' весь месяц')); });
  });
  return out;
}

/** Тарифы услуги по дням отрезка [from, to]: подряд идущие дни с одной строкой тарифа — {from,to,days,v} (с НДС, как
 *  tariffWithVat). Закрытый месяц — строки тарифов из его снимка (ctx.tariffRows). Нет тарифа на день — v 0 (об этом
 *  предупреждают шапка и чек-лист закрытия). */
function tarSegsOf(svc,from,to,ctx){
  // закрытый месяц, снимок без строк тарифов (до 05.10.2026) — один тариф месяца из снимка, как считали при закрытии
  if(ctx&&ctx.closed&&!ctx.tariffRows&&ctx.t){ const k={water_supply:'ws',water_drainage:'wd',electricity:'el',maintenance:'maintBase',capital_repair:'capRepair',heating:'heat'}[svc];
    return [{from,to,days:dayCount(from,to),v:+ctx.t[k]||0}]; }
  const rows=((ctx&&ctx.tariffRows)||TAR).filter(t=>t.svc===svc);
  // скорость смены месяца (05.10.2026: день за днём — 0,8 с из 2,3 с; результат тот же, проверено): 445 помещений × 5 услуг
  // спрашивают одни и те же даты при тех же строках тарифов — ответ запоминается по услуге, датам и строкам (их «с», «по»,
  // базовому и НДС, в их порядке), так что правка тарифа даёт новый ключ
  const key=JSON.stringify([svc,from,to,rows.map(x=>[x.from,x.to,x.base,x.vat].map(String))]), M=tarSegsOf.memo||(tarSegsOf.memo=new Map());
  let res=M.get(key);
  if(!res){
    const out=[];
    const add=(t,d,e,n)=>{ const last=out[out.length-1];
      if(last&&last.row===t){ last.to=e; last.days+=n; }
      else out.push({row:t,from:d,to:e,days:n,v:t?pnum(t.base)*(1+pnum(t.vat)/100):0}); };
    const pick=d=>rows.find(x=>(!x.from||x.from<=d)&&(!x.to||x.to>=d))||null;
    // строка тарифа дня меняется только на «с» строки и на день после её «по» — отрезок между такими днями берёт строку один
    // раз, а не каждый день. Дата не настоящая ГГГГ-ММ-ДД (сравнение строк тогда меняется не на ней) — по дням, как раньше
    const real=d=>{ if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false; const x=new Date(d+'T00:00:00Z'); return !isNaN(x)&&x.toISOString().slice(0,10)===d; };
    if(real(from)&&real(to)&&rows.every(x=>(!x.from||real(x.from))&&(!x.to||real(x.to)))){
      const cut=[...new Set(rows.flatMap(x=>[x.from,x.to?dayAfter(x.to):'']).filter(d=>d&&d>from&&d<=to))].sort();
      if(from<=to) [from,...cut].forEach((d,i)=>{ const e=i<cut.length?dayBefore(cut[i]):to; add(pick(d),d,e,dayCount(d,e)); });
    }
    else for(let d=from; d<=to; d=dayAfter(d)) add(pick(d),d,d,1);
    res=out.map(x=>({from:x.from,to:x.to,days:x.days,v:x.v}));
    if(M.size>5000) M.clear();
    M.set(key,res);
  }
  return res.map(x=>Object.assign({},x));
}

function tarOf(svc){ // средневзвешенный тариф с НДС за период
  const P=D(el('f-per').value+'-01');
  try{ const sg=splitMonthByTariff(tarObjs(),RESOF[svc],svc,P); return {v:sg.reduce((a,x)=>a+x.value*x.share,0),segs:sg.length}; }
  catch(e){
    // нет тарифа на часть месяца (заказчик, 05.10.2026):
    // вода и электро — средний по дням месяца, дни без тарифа — 0, те же дни, что у строк квитанций (tarSegsOf): ОДН дома —
    // начисленный, и «ЭК берёт из ОДН» уменьшает его ровно на сумму (при тарифе 0 — июнь, водоснабжение по 15.06, 100 000 ₸ —
    // строки ОДН падали на 116 793,38). Тепло и ЭК — 0, как было; ошибка остаётся — по ней предупреждения
    let v=0;
    if(svc==='water_supply'||svc==='water_drainage'||svc==='electricity'){ const g=tarSegsOf(svc,periodStart(),periodEnd()), n=g.reduce((a,x)=>a+x.days,0); v=n?g.reduce((a,x)=>a+x.v*x.days,0)/n:0; }
    return {v,segs:0,err:e.message}; }
}

const SVC_OPTS=[
  {svc:'water_supply',lab:'водоснабжение'},
  {svc:'water_drainage',lab:'водоотведение'},
  {svc:'electricity',lab:'электроэнергия'},
  {svc:'heating',lab:'теплоэнергия'},
  {svc:'maintenance',lab:'техобслуживание МОП ₸/м²'},
  {svc:'capital_repair',lab:'взносы на капремонт ₸/м²'},
];

/** Доходные нового месяца (правило 44б, заказчик 05.10.2026): те же контрагенты, что в последнем сохранённом списке (имя, ресурс,
 *  «учитывается» включено у всех — заказчик, 05.10.2026, — кроме строк с признаком «по умолчанию не
 *  учитывается», defOff: у них галочка снята), объём 0,
 *  у каждой строки need — ячейка объёма красная «нужно заполнить», пока оператор не введёт объём за
 *  этот месяц (введённый 0 — тоже ввод). Месяц с таким списком — extSrc 'empty'; пока объёмы не введены, ОДН считается с 0. */
const extEmpty=()=>(EXT_BASE||[]).map(x=>Object.assign({n:x.n,res:x.res,c:0,on:x.defOff?0:1,need:1},extFlag(x)));

/** Признак строки доходных «по умолчанию не учитывается» — defOff (заказчик, 05.10.2026, кровля: прямой договор контрагента с
 *  поставщиком, поставщик уже вычел его объём из своего счёта — строку в доходных оставить, галочку «Учит.» снять; «новый месяц:
 *  галочка „Учит.“ по умолчанию снята»). Строка остаётся в списке; в новом месяце её «Учит.» снята, поставить за месяц оператор
 *  может. Признак — в данных (таблица external и списки месяцев), из интерфейса не ставится; имени контрагента в коде нет.
 *  Его переносит каждая пересборка строки: extEmpty, extStart, extRow, saveExternal (EXT_BASE), buildSnapshot. */
function extFlag(x){ return x&&x.defOff?{defOff:1}:{}; }

/** Месяц уже заведён — у него есть свои вводные (счёт-фактура, нужды ЭК), введённые или скопированные до 05.10.2026. Новый
 *  месяц — записи нет, её завёл только импорт ЭСФ (тепло), или она начата пустой и вводных ещё не вводили (src 'empty'). */
const bpStarted=b=>!!b&&(b.inW!==undefined||b.inE!==undefined)&&b.src!=='empty';

/** Список доходных месяца, у которого своего ещё нет: НОВЫЙ месяц (вводных месяца нет) — пусто с нулями (правило 44б);
 *  месяц, который уже заведён (есть вводные — счёт-фактура, нужды ЭК), — прежний общий список с объёмами и пометкой
 *  «скопированы — проверьте», как до 44б: его ОДН и суммы не меняются (проверка 05.10.2026). */
const extStart=b=>bpStarted(b)
  ?{ext:(EXT_BASE||[]).map(x=>Object.assign({n:x.n,res:x.res,c:pnum(x.c),on:x.on?1:0},extFlag(x))),extSrc:'copied'}:{ext:extEmpty(),extSrc:'empty'};

const extE=()=>EXT.filter(x=>x.on&&x.res==='electricity').reduce((s,x)=>s+x.c,0);

const extW=()=>EXT.filter(x=>x.on&&x.res==='water').reduce((s,x)=>s+x.c,0);

const ENGINE_VERSION='стенд 2026-10-06 · спит = поставщику · тепло без даты · тепло по формуле Бухгалтерии: коэффициент = Гкал ÷ (общая площадь здания − разграниченные по теплу), остаток после тепла неразграниченных и нужд ЭК по теплу — ОДН всем по площади · вода только с акта опломбировки · доля счёта поставщика при продаже · начало месяца = конец прошлого · строки квитанции вверх до копейки, итог = их сумма · тепло при смене тарифа — по позициям ЭСФ · правки ядра 04.10 (дни первого собственника, прибор внутри месяца, показание на дату передачи в пределах месяца, договор прежнего — только пока владеет, тариф ЭК без подстановки) · тариф по дням квитанции (строка на каждый тариф) · доходные по месяцам · новый месяц — доходные 0 «нужно заполнить» · тариф не на весь месяц — ОДН дома по дням с тарифом («ЭК берёт из ОДН» — ровно на сумму) · новый месяц — счёт-фактура и нужды ЭК (вода, электро, тепло) пустые «нужно заполнить», доходные — все «учитывается», кроме строк «по умолчанию не учитывается» · строки «Перерасчёт» и «Зачёт переплаты» — у своего счёта, отдельная квитанция прежнему (46д) · 06.10: ручная пометка разграничения — у собственника (продажа закрывает, на нового не переходит; замена счётчика переносит), договор по воде с номером и актом без даты — с акта, перенос корректировки по теплу — только в ОДН тепла, переплата — до целого по правилам математики, смена собственника — одна в месяц';

const PERIOD_FIELDS=[['f-in-w','inW'],['f-in-e','inE'],['f-uk-w','ukW'],['f-uk-e','ukE'],['f-ek','ek'],['f-in-w-amt','inWAmt'],['f-in-e-amt','inEAmt'],['f-heat-amt','heatAmt'],
  // тепло по формуле Бухгалтерии (заказчик, 05.10.2026): нужды ЭК по теплу, Гкал — ввод за месяц, как нужды по воде и электро;
  // общая площадь здания, м² — хранится только введённое, пусто — по умолчанию (bldAreaOf), «введены» не ставит (currentSettings)
  ['f-uk-h','ukH'],['f-bld-area','bldArea'],
  // вторая позиция счёта-фактуры — когда внутри месяца менялся тариф (заказчик, 22.09.2026)
  ['f-in-w2','inW2'],['f-in-w2-amt','inW2Amt'],['f-in-e2','inE2'],['f-in-e2-amt','inE2Amt'],['f-heat','heat1'],['f-heat2','heat2'],['f-heat2-amt','heat2Amt']];

/** Диапазон месяцев словами: «июнь–август 2026», «декабрь 2025 – январь 2026». */
function perRange(ps){ ps=ps.slice().sort(); if(!ps.length) return ''; if(ps.length===1||ps[0]===ps[ps.length-1]) return perLabel(ps[0]); const a=ps[0],b=ps[ps.length-1]; return a.slice(0,4)===b.slice(0,4)?`${MON[+a.slice(5,7)-1]}–${MON[+b.slice(5,7)-1]} ${a.slice(0,4)}`:`${perLabel(a)} – ${perLabel(b)}`; }

const nextPer=p=>{const [y,m]=p.split('-').map(Number);return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);};

function isClosed(){ return !!(CLOSED&&el('f-per')&&CLOSED.period===el('f-per').value); }

/** Вводные выбранного месяца — из byPeriod. Новый месяц (записи нет или её завёл только импорт ЭСФ) начинается пустым: счёт-фактура
 *  воды и электро (объём и сумма) и нужды ЭК — пустые, тепло — Гкал и сумма из импорта ЭСФ этого месяца, если он был, иначе тоже
 *  пусто; src 'empty' — «не введены — заполните», пустые поля красные (drawSfNeed), ОДН считается с тем, что введено (пусто = 0).
 *  Решение заказчика 05.10.2026. Месяцы, заведённые раньше, остаются со своими
 *  числами и состоянием («введены» / «скопированы — проверьте»). */
/**
 * Вводные месяца для расчёта: значения полей шапки (id поля → значение) и доходные месяца. Страница заполняет ими шапку при смене
 * месяца (applyPeriodInputs), сервер — расчёт месяца (engine/calc.js, calcMonth). Правила:
 *   - новый месяц (записи нет или её завёл только импорт ЭСФ) — пустой: счёт-фактура и нужды ЭК пустые, «ЭК берёт из ОДН» 0, тепло —
 *     Гкал импорта ЭСФ этого месяца (правило 44г); запись нового месяца заводится в BY_PERIOD (src 'empty');
 *   - поле, которого у записи месяца нет, — пустое (в новый месяц не переезжает число соседнего);
 *   - запись месяца, заведённая до позиций счёта-фактуры (своего Гкал нет), — Гкал импорта ЭСФ или общий, за вычетом второй позиции;
 *   - доходные — свой список месяца; нет — по правилу 44б (extStart: новый месяц — те же контрагенты с объёмом 0, «нужно заполнить»;
 *     уже заведённый — прежний общий список). Закрытый месяц — доходные из снимка (ext: null).
 * Возвращает {fields, ext}.
 */
function monthInputs(per){
  let bp=BY_PERIOD[per];
  const heat0=HEAT_BY_PERIOD[per]!=null?String(HEAT_BY_PERIOD[per]).replace('.',','):'';   // Гкал из импорта ЭСФ этого месяца; не было — пусто
  const bp0=bpStarted(bp)?bp:null;   // месяц уже заведён — доходные без своего списка как прежде (extStart)
  // компенсация ОДН («ЭК берёт из ОДН») в новый месяц не переходит — с нуля, решение за месяц — в чек-листе закрытия (заказчик,
  // 04.10.2026; раньше копировалась сумма последнего сохранённого месяца, и разовая компенсация молча повторялась)
  // нужды ЭК по теплу (ukH, 05.10.2026) — тоже пустые, «нужно заполнить»; общая площадь здания — пусто = по умолчанию, не красное
  if(!bp) bp=BY_PERIOD[per]={inW:'',inE:'',ukW:'',ukE:'',ukH:'',ek:'0',inWAmt:'',inEAmt:'',heatAmt:'',heat1:heat0,src:'empty'};
  // запись месяца завёл импорт ЭСФ (только тепло — его Гкал и сумма остаются), а сам месяц ещё не открывали — остальные вводные
  // как у нового месяца: пустые
  else if(bp.inW===undefined&&bp.inE===undefined){ ['inW','inE','ukW','ukE','ukH'].forEach(k=>{ if(bp[k]===undefined) bp[k]=''; }); if(bp.ek===undefined) bp.ek='0'; if(bp.heat1===undefined) bp.heat1=heat0; if(!bp.src) bp.src='empty'; }
  // поле, которого у месяца нет, обязательно очищаем: иначе в новый месяц переезжает число прошлого
  // (так в августе оказались июльские 4,0446 Гкал — вторая позиция июльского счёта). Так же нужды ЭК по теплу у месяцев,
  // заведённых до этого поля (05.10.2026): числа нет — поле пустое, красное «нужно заполнить», пока оператор не введёт (в расчёте
  // пусто = 0, как у воды и электро)
  const fields={}; PERIOD_FIELDS.forEach(([id,k])=>{ fields[id]=bp[k]!=null?bp[k]:''; });
  // запись месяца, заведённая до позиций счёта-фактуры (своего Гкал нет), — Гкал импорта ЭСФ или общий, за вычетом второй позиции
  if(String(fields['f-heat']).trim()===''){
    const tot=HEAT_BY_PERIOD[per]!=null?HEAT_BY_PERIOD[per]:pnum((SETTINGS_LIVE||{}).heatGcal);
    if(bp.heat1==null&&tot){ const h2=String(fields['f-heat2']).trim()!==''?pnum(fields['f-heat2']):0; fields['f-heat']=String(Math.max(0,tot-h2)).replace('.',','); }
  }
  // доходные — по месяцам, как счета-фактуры (заказчик, 05.10.2026): у месяца свой список контрагентов и объёмов; месяц без своего —
  // те же контрагенты с объёмом 0 и пометкой «нужно заполнить» (правило 44б, заказчик 05.10.2026; до этого — копия объёмов прошлого «скопированы — проверьте»). Закрытый месяц — из снимка (applyClosedMode)
  let ext=null;
  if(!(CLOSED_PERIODS||[]).includes(per)){
    if(!Array.isArray(bp.ext)){ const st0=extStart(bp0); bp.ext=st0.ext; bp.extSrc=st0.extSrc; }
    ext=bp.ext.map(x=>Object.assign({},x));
  }
  return {fields,ext};
}

/**
 * Кто платит КУ по помещению.
 *   uk        — в управлении, платит компания: собственнику в отчёт ноль,
 *               квитанция в кабинете не показывается, оператору сумма видна
 *   deduction — долевая: удерживается из доли собственника
 *   owner     — собственник платит сам по квитанции
 */
function payerOf(r){
  if(r.prog==='none'||!r.prog) return 'owner';
  if(r.prog==='share') return 'deduction';
  return gc('f-uk') ? 'uk' : 'owner';
}

// ---------- расчёт по строке ----------
/**
 * Ручная пометка разграничения — у собственника (заказчик, 06.10.2026). Хранится в записи собственника (owners[].rz):
 *   w — все водяные приборы помещения сразу (договор по воде один на помещение), h — тепло (приборов по теплу нет),
 *   e — {номер прибора: да / нет} — электросчётчик; да — «разграничено вручную», нет — «в счёт УК вручную»,
 *   ключа нет — «по договору разграничения». Пометка сильнее договора в обе стороны (правило 12) и действует в дни
 *   владения своего собственника: прежнему — по день до передачи, новому — с даты передачи.
 * o — запись собственника, key — w / e / h, m — прибор (для электро). true / false / null.
 */
function ownerMark(o,key,m){
  const z=o&&o.rz; if(!z) return null;
  const v=key==='e'?(z.e&&m?z.e[m.id]:undefined):z[key];
  return v===true||v===false?v:null;
}

/** Собственник, чью пометку показывают и правят пульт и форма за выбранный месяц, — владелец на конец месяца. */
function markOwner(r){ const sl=ownerSlices(r,periodStart(),periodEnd()); const s=sl[sl.length-1]; return s?s.seg:null; }

/** Пометка за выбранный месяц для показа и правки — собственника на конец месяца: true / false / null. */
function mkOf(r,key,m){ return ownerMark(markOwner(r),key,m); }

/**
 * Действует ли разграничение на конкретном приборе — для подписей за выбранный месяц.
 * По умолчанию договор помещения накрывает все приборы своего ресурса; ручная пометка собственника (mkOf) сильнее
 * договора. Расчёт берёт пометку по дням владения (meterIntervals).
 */
function meterRz(r,m,rzOn,sleeps){
  if(!rzOn) return false;                              // «спит» разграничение не снимает: объём у поставщика (заказчик, 21.09.2026)
  { const mk=mkOf(r,m.res==='ee'?'e':'w',m); if(mk!==null) return mk; }
  // Прежняя метка «транзит» из файла бухгалтерии (m.transit) в расчёте не участвует с 18.09.2026 и с 23.09.2026 нигде не показывается: она значила, что у собственника
  // есть договор разграничения по ЭЭ, и этот договор теперь заведён в договорах помещения (по факту
  // или с датой). Продал — договор закрыт датой смены, у нового собственника разграничения нет,
  // пока он не заключит свой (заказчик, 18.09.2026).
  return unitRz(r,m.res==='ee'?'e':'w',true,false);
}

/**
 * Применяется ли договор разграничения в расчёте.
 * Реквизиты полные — И номер, И дата начала (правила 34–37). Галочка
 * «по факту» (s.fact) включает договор и без них: разграничение есть, номер и
 * дату оператор внесёт, когда информация появится; без даты договор действует
 * весь период, с датой — включается деление внутри месяца (заказчик, 16.09.2026).
 */
function rzApplies(s,key){
  if(!s) return false;
  // Вода: разграничение начинается с акта опломбировки (заказчик, 22.09.2026). Нет акта — нет разграничения:
  // комната не разграничена, УК выставляет ей квитанцию. Су-Арнасы вычитает помещение из общего счётчика
  // тоже с акта, значит без акта его объём остаётся внутри нашего счёта-фактуры. Переключатель «вода — с
  // даты акта опломбировки» выключен → старое поведение (по дате договора), для сравнения.
  if(key==='w' && !s.seal) return false;   // по воде — только с акта опломбировки (заказчик, 22.09.2026; переключатель убран 03.10.2026)
  if(s.fact || (s.no && s.from)) return true;
  // тепло: номера достаточно — дата у бухгалтерии в файле не заполнена, оператор внесёт её в карточке позже (заказчик, 21.09.2026);
  // вода: с актом опломбировки номера тоже достаточно — договор действует с даты акта, дата договора может быть не внесена
  // (заказчик, 06.10.2026)
  return (key==='h'||key==='w') && !!s.no;
}

/** Договор по воде есть, но акта опломбировки нет — объём пока начисляет УК (жёлтая полоска у плашки). */
/** Почему договор не применяется: по воде без акта опломбировки — это акт, а не «нет номера». d — день, о котором речь:
 *  начало месяца (отчёт, пульт, форма за месяц), «сегодня», дата реестра; без d — начало расчётного месяца. Продажа — причина,
 *  только если договор закрыт ею к этому дню (rzCutBy); продажа позже — не причина, тогда акт или реквизиты (проверка
 *  05.10.2026: июньский отчёт «Все договоры разграничения» писал «закрыт сменой собственника 21.07.2026» у договора без акта). */
function rzWhyNo(s,key,r,d){
  if(!s) return 'договора нет';
  const cut=rzCutBy(r,s,d);
  if(cut) return 'закрыт сменой собственника '+fdt(cut);
  if(key==='w') return s.seal?'нет номера':(s.fact||s.no)?'нет акта опломбировки':'нет номера и акта опломбировки';   // вода: акт + номер (или «по факту»)
  return key==='h'?'нет номера':'нет номера или даты';
}

/** Дата продажи, которой договор разграничения закрыт к дню d (без d — к началу расчётного месяца): договор прежнего кончается
 *  днём раньше продажи (rzOwnerCut). Продажа позже d — в этот день (месяц) договор ею не закрыт; свой «по» раньше продажи —
 *  договор кончился сам, не продажей. Без r — отметка ownerCut договора из rzEffective. */
function rzCutBy(r,s,d){
  if(!s) return null;
  const cut=r?rzOwnerCut(r,s):(s.ownerCut||null);
  if(!cut||cut>(d||periodStart())) return null;
  return s.to&&s.to<dayBefore(cut)?null:cut;
}

/**
 * Действует ли разграничение по ресурсу в расчётном периоде — для подписей, отчётов и отбора.
 * Договор, пересекающий месяц хоть одним днём, разграничивает месяц целиком (заказчик, 22.09.2026) —
 * то же, что даёт расчёт (rzCoverage). Ручную пометку прибора смотрит meterRz.
 */
function unitRz(r,key,rzOn,sleeps){
  if(!rzOn) return false;
  const s=rzSeg(r,key);
  if(!rzApplies(s,key)) return false;
  return segState(s,periodStart(),periodEnd()).ok&&rzOwnerHere(r,s,periodStart(),periodEnd());
}

/**
 * Граница разграничения внутри месяца — с 22.09.2026 её нет: любая дата договора в месяце разграничивает месяц
 * целиком, делить объём по дате договора не нужно. Всегда null; оставлена, чтобы старые вызовы не ломались.
 */
function rzMidPeriod(r,key,rzOn,sleeps){ return null; }

/**
 * Участвует ли прибор в периоде: установлен не позже конца, снят не раньше начала.
 * Даты ставит акт замены (m.from у нового, m.to у старого). В месяце замены считаются оба,
 * дальше старый выпадает сам — галочка «снят» больше не нужна, показания остаются.
 */
function meterInPeriod(m,ps,pe){
  if(m.del) return false;                       // помечен на удаление — в расчёте его нет
  ps=ps||periodStart(); pe=pe||periodEnd();
  if(m.to && m.to<ps) return false;
  if(m.from && m.from>pe) return false;
  return true;
}

/** Расход прибора: (конец − начало) × коэффициент, отрицательный обнуляется. */
/**
 * Попадает ли прибор в счёт помещению.
 * Две независимые причины не попасть: разграничение (платит поставщику —
 * по договору помещения или ручной пометке) и ручное снятие.
 */
function meterBilled(r,m,rzOn,sleeps){
  if(!meterInPeriod(m)) return false;
  if(m.bill===false) return false;
  return !meterRz(r,m,rzOn,sleeps);
}

function meterOffReason(r,m,rzOn,sleeps){
  if(!meterInPeriod(m)) return m.to&&m.to<periodStart()?'снят '+fdt(m.to):'установлен '+fdt(m.from);
  if(meterRz(r,m,rzOn,sleeps)) return 'разгр';
  if(m.bill===false) return 'не участвует в расчётах';
  return '';
}

function meterReading(m,per){
  per=per||el('f-per').value;
  if(per===BASE_PERIOD) return {prev:m.prev,cur:m.cur};
  if(m.hist && m.hist[per]) return m.hist[per];
  return {prev:null,cur:null};
}

/** Показание на дату передачи собственнику за месяц per — как prev/cur в meterReading: загруженный месяц — m.ownRead,
 *  другие — из hist. Форма корректировки и история считают другие месяцы без перезагрузки помещений. */
function ownReadOf(m,per){
  per=per||el('f-per').value;
  if(per===BASE_PERIOD) return m.ownRead;
  return m.hist&&m.hist[per]?m.hist[per].ownRead:null;
}

/** Расход прибора: (конец − начало) × коэффициент, отрицательный обнуляется. */
function meterUsage(m,per){
  const rd=meterReading(m,per);
  if(rd.prev==null||rd.cur==null) return 0;
  const p=pnum(rd.prev), c=pnum(rd.cur);
  return Math.max(0,c-p)*(pnum(m.k)||1);
}

// ================= движок отрезков =================
/* Три линии времени на помещении режут месяц на отрезки: владение (ownerSlices), программа
 * управления (progSlices) и договоры разграничения (по ресурсу). На каждом элементарном отрезке
 * один собственник и один плательщик; разграничение «спит» только на днях, где платит УК
 * (payer === 'uk'), а не на всём месяце — заказчик, 16.09.2026: до 14.06 не в управлении → поставщику
 * напрямую, с 15.06 гибридная → в счёт УК как расход компании.
 * Объём прибора раскладывается по промежуткам между точками (границы отрезков + границы договора):
 * между известными показаниями (prev, cur, midRead на границе договора, ownRead на дату передачи) —
 * по разнице, внутри — по дням (решение заказчика 16.09.2026: без показания делим по дням владения).
 */

/** Плательщик по программе на отрезке. */
function payerOfProg(prog){
  if(!prog||prog==='none') return 'owner';
  if(prog==='share') return 'deduction';
  return gc('f-uk') ? 'uk' : 'owner';
}

/** Элементарные отрезки периода: границы = начало ∪ смены собственника ∪ вход/выход из управления. */
function periodSegments(r,ps,pe){
  ps=ps||periodStart(); pe=pe||periodEnd();
  const os=ownerSlices(r,ps,pe), pg=progSlices(r,ps,pe), dim=dayCount(ps,pe);
  const cuts=new Set([ps]);
  os.slice(1).forEach(s=>cuts.add(s.from));
  pg.slice(1).forEach(s=>cuts.add(s.from));
  const pts=[...cuts].sort();
  return pts.map((from,i)=>{
    const to=i+1<pts.length?dayBefore(pts[i+1]):pe;
    const o=os.find(s=>s.from<=from&&s.to>=from)||os[os.length-1];
    const p=pg.find(s=>s.from<=from&&s.to>=from)||pg[pg.length-1];
    const days=dayCount(from,to);
    return {from,to,days,share:days/dim,fio:o.fio||'',ownerSeg:o.seg,prog:p.prog,progSeg:p.seg,payer:payerOfProg(p.prog)};
  });
}

/**
 * Дни периода под разграничением ДОГОВОРОМ (без учёта сна): договор помещения — ВЕСЬ период, если договор пересекает его хоть
 * одним днём (заказчик, 22.09.2026: любая дата разграничения в месяце — по воде дата акта — делает месяц разграниченным целиком;
 * до этого месяц делился по дате договора/акта, с показанием на дату или по правилу 39). «По факту» без даты — тоже весь
 * период. null — разграничения договором нет. Ручная пометка собственника сильнее договора и действует в дни его владения —
 * её накладывают meterIntervals и heatIntervals по отрезкам (06.10.2026; до этого пометка была на приборе, на весь месяц).
 */
function rzCoverage(r,key,m,ps,pe){
  if(!gc('f-rz')) return null;
  const seg=rzSeg(r,key);
  if(seg&&rzApplies(seg,key)&&segState(seg,ps,pe).ok&&rzOwnerHere(r,seg,ps,pe)){
    return {from:ps,to:pe,seg,src:'contract',startsMid:false,endsMid:false,wholeMonth:true,
            contractFrom:(seg.from&&seg.from>ps)?seg.from:null, contractTo:(seg.to&&seg.to<pe)?seg.to:null};
  }
  return null;
}

/**
 * Раскладка объёма по промежуткам между точками pts (первая = начало периода) до end.
 * reads — показания в точках; между известными — по разнице, внутри — по дням.
 */
function distributeVolume(pts,end,reads,k,quiet){
  const all=pts.concat([end]);
  const vols=new Array(pts.length).fill(0);
  let byRead=false, byDays=false, a=0;
  for(let b=1;b<all.length;b++){
    if(reads[all[b]]==null) continue;
    const V=Math.max(0,pnum(reads[all[b]])-pnum(reads[all[a]]))*k;
    const span=dayCount(all[a],dayBefore(all[b]));
    if(b-a>1) byDays=true;
    if((a>0&&!(quiet&&quiet.has(all[a])))||(b<all.length-1&&!(quiet&&quiet.has(all[b])))) byRead=true;   // quiet — даты установки и снятия прибора
    for(let i=a;i<b;i++){ const d=dayCount(all[i],dayBefore(all[i+1])); vols[i]=(b-a===1)?V:V*d/span; }
    a=b;
  }
  return {vols,byRead,byDays};
}

/** Дни прибора в месяце (04.10.2026): поставлен внутри месяца — с даты установки, снят — до даты снятия (акт замены:
 *  у старого «по», у нового «с» — дата акта). null — граница не внутри месяца. */
function meterLife(m,ps,pe){
  return {from:m.from&&m.from>ps&&m.from<=pe?m.from:null,to:m.to&&m.to>ps&&m.to<=pe?m.to:null};
}

/** Показание на дату передачи, которым расчёт делит объём (04.10.2026): внесено, смена собственника в месяце есть,
 *  прибор в этот день стоит, показание между начальным и конечным месяца. Вне их делить им нельзя — объём частей вышел бы
 *  больше, чем намерил счётчик (285 при 290…297 давало новому +5 м³): делим по дням, чек-лист закрытия показывает такое
 *  показание. null — не берём. */
function ownReadUse(m,rd,ownChg,ps,pe){
  const v=ownReadOf(m);
  if(!ownChg||v==null||String(v).trim()==='') return null;
  const life=meterLife(m,ps,pe);
  if((life.from&&ownChg<=life.from)||(life.to&&ownChg>=life.to)) return null;   // в день передачи прибора ещё (уже) нет — главнее показание акта
  if(rd.prev==null||rd.cur==null) return null;
  const x=pnum(v); if(x<pnum(rd.prev)-1e-9||x>pnum(rd.cur)+1e-9) return null;
  return v;
}

/** Промежутки прибора: объём, статус (поставщику / спит / в счёт УК) и отрезок, к которому относится. */
function meterIntervals(r,m,key,segs,ps,pe){
  const rd=meterReading(m);
  const k=pnum(m.k)||1, end=dayAfter(pe);
  let cov=rzCoverage(r,key,m,ps,pe);
  const cuts=new Set(segs.map(s=>s.from));
  const cpts=[];
  if(cov&&cov.src==='contract'){ if(cov.startsMid) cpts.push(cov.from); if(cov.endsMid) cpts.push(dayAfter(cov.to)); }
  cpts.forEach(p=>cuts.add(p));
  // прибор поставлен или снят внутри месяца: начальное — на дату установки, конечное — на дату снятия; до установки и после
  // снятия объёма нет (04.10.2026, проверка ядра: было — по дням всего месяца, и при замене в день продажи прежний платил
  // часть нового счётчика, а новый — часть старого)
  const life=meterLife(m,ps,pe);
  if(life.from) cuts.add(life.from); if(life.to) cuts.add(life.to);
  const pts=[...cuts].sort();
  const has=v=>v!==null&&v!==undefined&&String(v).trim()!=='';
  const ownChg=ownerChangeDate(r,ps,pe);
  const reads={};
  if(rd.prev!=null) reads[ps]=rd.prev;
  if(rd.cur!=null) reads[end]=rd.cur;
  const own=ownReadUse(m,rd,ownChg,ps,pe); if(own!=null) reads[ownChg]=own;   // показание на дату передачи — считаемого месяца
  const ownBad=has(ownReadOf(m))&&!!ownChg&&own==null;                       // внесено, но делить им нельзя — по дням
  if(life.from&&rd.prev!=null) reads[life.from]=rd.prev;                      // показания акта — главнее
  if(life.to&&rd.cur!=null) reads[life.to]=rd.cur;
  const quiet=new Set([life.from,life.to].filter(p=>p&&!segs.some(s=>s.from===p)));   // не граница части — не «по показанию»

  // граница договора, совпавшая с датой передачи, — одна точка: показание на дату передачи главнее
  if(has(m.midRead)&&cpts.length&&reads[cpts[0]]==null) reads[cpts[0]]=m.midRead;
  // Правило 39: граница договора без показания и не совпавшая со сменой собственника или
  // программы → делить нечем, договор на месяц не применяем, прибор помечен «нужно показание».
  // Заказчик, 21.09.2026: оператор может разрешить делить по дням (галочка на договоре) — тогда правило 39 не применяется
  let need=false, byDaysForced=false;
  cpts.forEach(p=>{ if(reads[p]==null&&!segs.some(s=>s.from===p)){ if(cov&&cov.seg&&cov.seg.byDays) byDaysForced=true; else need=true; } });
  if(need) cov=null;
  const noData=rd.prev==null||rd.cur==null;
  const {vols,byRead,byDays}=noData?{vols:pts.map(()=>0),byRead:false,byDays:false}:distributeVolume(pts,end,reads,k,quiet);
  // Продажа в месяце, разграниченном договором ПРЕЖНЕГО собственника (заказчик, 24.09.2026): счёт поставщика за весь
  // месяц идёт по договору прежнего, и его расход делится между собственниками по дням владения (по показанию на
  // дату передачи, если оно внесено). Дни нового — «доля счёта поставщика», выставляется новому через УК:
  // hand=true. Объём остаётся у поставщика (direct), в базу ОДН не входит — он вычтен из счёта-фактуры УК.
  // Если на днях нового платит УК или долевая — спит как обычно (счёт поставщика оплачивает УК).
  const hs=handSlices(r,cov,ps,pe);
  const rzOn=gc('f-rz');
  const ivs=pts.map((from,i)=>{
    const to=i+1<pts.length?dayBefore(pts[i+1]):pe;
    const seg=segs.find(s=>s.from<=from&&s.to>=from)||segs[segs.length-1];
    // ручная пометка собственника этих дней (заказчик, 06.10.2026) — сильнее договора в обе стороны: прежнему — по день до
    // передачи, новому — с даты передачи; чужая пометка на нового не переходит, доли счёта поставщика по ней нет
    const man=rzOn?ownerMark(seg.ownerSeg,key,m):null;
    const byC=!!(cov&&from>=cov.from&&to<=cov.to);
    const covered=man===true||(man===null&&byC);
    // Заказчик, 21–22.09.2026: разграниченный объём всегда у поставщика (он уже вычтен из счёта-фактуры) — и когда платит УК
    // («спит»: в управлении и в долевой счёт поставщика оплачивает УК, в квитанции 0,00; в долевой УК удерживает его
    // из доли по реестру, вне стенда). «Спит» — только пометка, не объём.
    const sleeping=covered&&seg.payer!=='owner';
    const hand=man===null&&byC&&hs.some(h=>from>=h.from&&from<=h.to);
    return {from,to,seg,vol:vols[i],direct:covered,sleeping,covered,hand,man};
  });
  const billed=ivs.reduce((s,x)=>s+(x.direct?0:x.vol),0), other=ivs.reduce((s,x)=>s+(x.direct?x.vol:0),0);
  const hand=ivs.reduce((s,x)=>s+(x.hand&&!x.sleeping?x.vol:0),0);   // доля счёта поставщика, выставляемая через УК
  return {ivs,billed,other,hand,need,byRead,byDays,byDaysForced,cov:covOf(ivs,cov,ps,pe),noData,ownBad,allDirect:ivs.length>0&&ivs.every(x=>x.direct),anyDirect:ivs.some(x=>x.direct)};
}

/** Чем разграничен месяц прибора (тепла) — для подписей: все дни под ручной пометкой — пометка ({src:'manual'}, «в счёт УК вручную»
 *  на все дни — null), иначе договор (как было до пометок у собственника, 06.10.2026). */
function covOf(ivs,cov,ps,pe){
  if(ivs.length&&ivs.every(x=>x.man!==null&&x.man!==undefined)) return ivs.some(x=>x.man===true)?{from:ps,to:pe,src:'manual'}:null;
  return cov;
}

/**
 * Отрезки владения месяца, на днях которых объём — «доля счёта поставщика» (заказчик, 24.09.2026). Месяц разграничен
 * ДОГОВОРОМ (не ручной пометкой), собственник вступил во владение внутри месяца, а договор — не его. Чей договор:
 * записан на кого-то (поле «чей») — того; иначе — кто владел в день договора (без даты — первого, «был всегда»).
 * Доля — у тех, кто пришёл позже владельца договора. Кто и когда закрыл договор прежнего (продажа, оператор,
 * поставщик своим числом) — не важно: счёт поставщика за месяц идёт по нему. Две смены за месяц — доля у второго
 * и у третьего. Договор самого нового (с даты продажи и позже) — обычное разграничение, доли нет.
 */
function handSlices(r,cov,ps,pe){
  if(!cov||cov.src!=='contract'||!cov.seg) return [];
  const sl=ownerSlices(r,ps,pe); if(sl.length<2) return [];
  const sg=cov.seg, cd=('contractFrom' in sg)?sg.contractFrom:sg.from;   // дата договора: по воде from — дата акта
  const nm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  let own=sg.owner?sl.findIndex(x=>nm(x.fio)===nm(sg.owner)):-1;
  if(own<0) own=(cd&&cd>ps)?Math.max(0,sl.findIndex(x=>x.from<=cd&&x.to>=cd)):0;
  const who=nm(sl[own].fio);
  return sl.filter((x,k)=>k>own&&nm(x.fio)!==who);
}

/** Тепло по промежуткам: от площади и дней, показаний нет. */
function heatIntervals(r,segs,ps,pe,kOt){
  const cov=rzCoverage(r,'h',null,ps,pe), dim=dayCount(ps,pe);
  const cuts=new Set(segs.map(s=>s.from));
  if(cov&&cov.src==='contract'){ if(cov.startsMid) cuts.add(cov.from); if(cov.endsMid) cuts.add(dayAfter(cov.to)); }
  const pts=[...cuts].sort();
  const hs=handSlices(r,cov,ps,pe);   // доля счёта поставщика у нового собственника (заказчик, 24.09.2026)
  const rzOn=gc('f-rz');
  const ivs=pts.map((from,i)=>{
    const to=i+1<pts.length?dayBefore(pts[i+1]):pe;
    const seg=segs.find(s=>s.from<=from&&s.to>=from)||segs[segs.length-1];
    const man=rzOn?ownerMark(seg.ownerSeg,'h',null):null;   // ручная пометка собственника этих дней (06.10.2026), как у прибора
    const byC=!!(cov&&from>=cov.from&&to<=cov.to);
    const covered=man===true||(man===null&&byC), sleeping=covered&&seg.payer!=='owner';   // спит = у поставщика (заказчик, 21.09.2026)
    const days=dayCount(from,to);
    const hand=man===null&&byC&&hs.some(h=>from>=h.from&&from<=h.to);
    return {from,to,seg,days,vol:r.area*kOt*days/dim,direct:covered,sleeping,covered,hand,man};
  });
  return {ivs,billed:ivs.reduce((s,x)=>s+(x.direct?0:x.vol),0),hand:ivs.reduce((s,x)=>s+(x.hand&&!x.sleeping?x.vol:0),0),cov:covOf(ivs,cov,ps,pe),
          allDirect:ivs.length>0&&ivs.every(x=>x.direct),anyDirect:ivs.some(x=>x.direct),
          ukDays:ivs.reduce((s,x)=>s+(x.direct?0:x.days),0)};
}

function calcRow(r,ctx){
  const rzOn=gc('f-rz');
  const ps=periodStart(), pe=periodEnd();
  const segs=periodSegments(r,ps,pe);
  const payers=[...new Set(segs.map(s=>s.payer))];
  const payer=payers.length===1?payers[0]:'mixed';       // на весь месяц один плательщик или смешанный
  const sleeps=(payer==='uk');                           // для отображения там, где отрезки не нужны
  let wAll=0,wBill=0,eAll=0,eBill=0,neg=false,needMid=0,wHand=0,eHand=0;
  const slices=ownerSlices(r,ps,pe);
  const ownChg=slices.length>1?slices[1].from:null;
  const det=[];
  // прибор, снятый до периода или установленный после, для этого месяца не существует
  (r.meters||[]).filter(m=>meterInPeriod(m)).forEach(m=>{
    const u=meterUsage(m);
    const rd=meterReading(m);
    const p=rd.prev==null?null:pnum(rd.prev), c=rd.cur==null?null:pnum(rd.cur);
    if(p!==null&&c!==null&&c<p) neg=true;
    const key=m.res==='ee'?'e':'w';
    const mid=rzMidPeriod(r,key,rzOn,sleeps);            // для подписей в карточке
    let vol=0, split=null, iv=null, rz=false, billed=false, off='';
    if(m.bill===false){ off='не участвует в расчётах'; }
    else {
      iv=meterIntervals(r,m,key,segs,ps,pe);
      vol=iv.billed; billed=vol>0; rz=iv.anyDirect;
      if(iv.need) needMid++;
      // форма split — прежняя (деление по дате договора): карточка и квитанция читают её
      if(iv.other>0||iv.need||iv.byRead||iv.byDays) split={billed:iv.billed,other:iv.other,need:iv.need,byRead:iv.byRead,byDays:iv.byDays};
      if(iv.allDirect) off='разгр';
    }
    if(m.res==='ee'){ eAll+=u; eBill+=vol; if(iv) eHand+=iv.hand; }
    else { wAll+=u; wBill+=vol; if(iv) wHand+=iv.hand; }
    det.push({m,u,rz,billed,vol,split,mid,rd,off,iv});
  });

  const hi=heatIntervals(r,segs,ps,pe,ctx.kOt);
  const rzH=hi.allDirect;
  const midH=rzMidPeriod(r,'h',rzOn,sleeps);
  const heatVol=hi.billed;
  const odnW=r.inodn?ctx.odnPerUnitW:0;
  const odnE=r.inodn?ctx.odnPerAreaE*r.area:0;
  const odnH=r.inodn?r.area*ctx.kOdn:0;
  const t=ctx.t;
  const aWs=wBill*t.ws, aWd=wBill*t.wd;
  const aOdnWs=odnW*t.ws, aOdnWd=odnW*t.wd;
  const aE=eBill*t.el, aOdnE=odnE*t.el, aH=heatVol*t.heat, aOdnH=odnH*t.heat;
  const odnAmt=(aOdnWs+aOdnWd+aOdnE+aOdnH)*ctx.ekFactor;
  // доля счёта поставщика за дни нового собственника в месяце продажи (заказчик, 24.09.2026): в квитанции нового через УК,
  // по тарифу поставщика; в «в счёт УК» и в базу ОДН не входит — объём вычтен поставщиком из счёта-фактуры УК
  const hHand=hi.hand||0;
  const hand={w:wHand,e:eHand,h:hHand,aWs:wHand*t.ws,aWd:wHand*t.wd,aE:eHand*t.el,aH:hHand*t.heat};
  hand.total=hand.aWs+hand.aWd+hand.aE+hand.aH;
  const total=aWs+aWd+aE+aH+odnAmt+hand.total;
  const out={det,water:wBill,waterAll:wAll,eB:eBill,eRaw:eAll,heatVol,heat:hi,needMid,midH,
          segs,slices,ownChg,
          payer,paidByUK:0,
          odnW,odnE,odnH,aWs,aWd,aE,aH,odnAmt,hand,total,er:r.area*ctx.t.maint,neg,
          rzH,sleeps,
          rzW:det.some(d=>d.rz&&d.m.res!=='ee'),rzE:det.some(d=>d.rz&&d.m.res==='ee')};
  out.split=periodSplitCalc(r,out,ctx);
  // строки квитанции — каждая вверх до копейки (заказчик, 02.10.2026);
  // пульт, отчёты, выгрузка и квитанция показывают одну цифру: строка месяца, ОДН, ЭК и итог КУ = сумма строк квитанций
  // месяца (при смене собственника — всех частей). Точные суммы — out.raw; totalRaw / odnAmtRaw — точные итог и ОДН
  // (от них «ЭК берёт из ОДН» в buildCtx). До правила у ~200 помещений в месяц пульт и квитанция расходились на 0,01 ₸.
  const P=out.split.parts, S=(f,o)=>round2(P.reduce((s,p)=>s+(o?o(p):p)[f],0)), kf=ctx.ekFactor;
  out.raw={aWs,aWd,aE,aH,aOdnWs:aOdnWs*kf,aOdnWd:aOdnWd*kf,aOdnE:aOdnE*kf,aOdnH:aOdnH*kf,odnAmt,total,er:out.er,hand:hand.total};
  out.totalRaw=total; out.odnAmtRaw=odnAmt;
  ['aWs','aWd','aE','aH','aOdnWs','aOdnWd','aOdnE','aOdnH','odnAmt','mop','cap','er','total'].forEach(f=>out[f]=S(f));
  ['aWs','aWd','aE','aH','total'].forEach(f=>hand[f]=S(f,p=>p.hand));
  out.paidByUK=out.split.parts.filter(p=>p.payer==='uk').reduce((s,p)=>s+p.total,0);
  return out;
}

/**
 * Разбивка начислений периода по частям: часть = подряд идущие отрезки с одним собственником и
 * одним плательщиком. Каждая часть — готовая квитанция: объёмы, суммы, дни, плательщик, причина
 * деления. Одна часть — месяц не делится.
 */
function periodSplitCalc(r,c,ctx){
  const segs=c.segs, t=ctx.t, kf=ctx.ekFactor;
  const parts=[];
  segs.forEach((s,i)=>{
    const last=parts[parts.length-1];
    if(last&&last.fio===s.fio&&last.payer===s.payer){ last.to=s.to; last.days+=s.days; last.share+=s.share; last.segs.push(s); if(s.prog!==last.prog) last.progChanged=true; return; }
    parts.push({fio:s.fio||'—',from:s.from,to:s.to,days:s.days,share:s.share,payer:s.payer,prog:s.prog,progSeg:s.progSeg,segs:[s],idx:parts.length,
                reason:!last?null:(last.fio!==s.fio?'owner-change':'program-change')});
  });
  const inPart=(iv,p)=>iv.from>=p.from&&iv.to<=p.to;
  // объёмы приборов по частям: в счёт УК (vals) и ушедшее напрямую поставщику (sup)
  const meterVals=(c.det||[]).map(d=>{
    if(!d.iv) return {vals:parts.map(()=>0),sup:parts.map(()=>0),hand:parts.map(()=>0)};
    return {vals:parts.map(p=>d.iv.ivs.filter(x=>inPart(x,p)&&!x.direct).reduce((s,x)=>s+x.vol,0)),
            sup:parts.map(p=>d.iv.ivs.filter(x=>inPart(x,p)&&x.direct).reduce((s,x)=>s+x.vol,0)),
            hand:parts.map(p=>d.iv.ivs.filter(x=>inPart(x,p)&&x.hand&&!x.sleeping).reduce((s,x)=>s+x.vol,0))};   // доля счёта поставщика
  });
  parts.forEach((p,i)=>{
    p.water=0; p.eB=0;
    const hand={w:0,e:0,h:0};
    (c.det||[]).forEach((d,di)=>{ if(d.m.res==='ee'){ p.eB+=meterVals[di].vals[i]; hand.e+=meterVals[di].hand[i]; } else { p.water+=meterVals[di].vals[i]; hand.w+=meterVals[di].hand[i]; } });
    p.heatVol=c.heat?c.heat.ivs.filter(x=>inPart(x,p)&&!x.direct).reduce((s,x)=>s+x.vol,0):c.heatVol*p.share;
    hand.h=c.heat?c.heat.ivs.filter(x=>inPart(x,p)&&x.hand&&!x.sleeping).reduce((s,x)=>s+x.vol,0):0;
    // доля счёта поставщика — целиком в части нового собственника, поэтому считается прямо, без «остатка от месяца»
    hand.aWs=ceil2(hand.w*t.ws); hand.aWd=ceil2(hand.w*t.wd); hand.aE=ceil2(hand.e*t.el); hand.aH=ceil2(hand.h*t.heat);
    hand.total=round2(hand.aWs+hand.aWd+hand.aE+hand.aH);
    p.hand=hand;
    p.odnW=c.odnW*p.share; p.odnE=c.odnE*p.share; p.odnH=c.odnH*p.share;
  });
  const byRead=(c.det||[]).some(d=>d.iv&&d.iv.byRead), byDays=(c.det||[]).some(d=>d.iv&&d.iv.byDays), ownBad=(c.det||[]).some(d=>d.iv&&d.iv.ownBad);
  const whole=(c.det||[]).some(d=>d.iv&&d.iv.other>0)||(c.heat&&c.heat.anyDirect);
  // суммы: каждая строка каждой квитанции — объём её дней × тариф, вверх до копейки (заказчик, 02.10.2026);
  // строка месяца — сумма строк квитанций (calcRow). До 02.10.2026: доли вверх, последняя — остаток от месячной строки.
  parts.forEach(p=>{
    // тариф менялся внутри квитанции — строка услуги по дням каждого тарифа (заказчик, 04.10.2026): объём части делится по дням между тарифами, каждая строка — объём своих дней × свой тариф, вверх до
    // копейки; квитанция целиком в днях одного тарифа — одна строка по нему (квитанция за 01–14.06 — тариф этих дней, а не
    // средний за месяц). Тепло — одной строкой по тарифу позиций ЭСФ (решение 03.10.2026). Месяц без смены — как раньше
    const G={ws:tarSegsOf('water_supply',p.from,p.to,ctx),wd:tarSegsOf('water_drainage',p.from,p.to,ctx),el:tarSegsOf('electricity',p.from,p.to,ctx),
      mop:tarSegsOf('maintenance',p.from,p.to,ctx),cap:tarSegsOf('capital_repair',p.from,p.to,ctx)};
    const by=(g,vol,f)=>g.map(x=>{ const v=g.length===1?vol:vol*x.days/p.days; return {from:x.from,to:x.to,days:x.days,tar:x.v,vol:v,amt:ceil2(v*x.v*(f==null?1:f))}; });
    const dim=p.share>0?Math.round(p.days/p.share):p.days, ek=g=>g.map(x=>{ const sh=g.length===1?p.share:x.days/dim; return {from:x.from,to:x.to,days:x.days,tar:x.v,vol:r.area,share:sh,amt:ceil2(r.area*x.v*sh)}; });
    p.tl={ws:by(G.ws,p.water),wd:by(G.wd,p.water),el:by(G.el,p.eB),odnWs:by(G.ws,p.odnW,kf),odnWd:by(G.wd,p.odnW,kf),odnE:by(G.el,p.odnE,kf),
      hWs:by(G.ws,p.hand.w),hWd:by(G.wd,p.hand.w),hE:by(G.el,p.hand.e),mop:ek(G.mop),cap:ek(G.cap)};
    p.tsplit=['ws','wd','el','mop','cap'].some(k=>G[k].length>1);
    const sum=a=>round2(a.reduce((q,x)=>q+x.amt,0));
    p.aWs=sum(p.tl.ws); p.aWd=sum(p.tl.wd); p.aE=sum(p.tl.el); p.aH=ceil2(p.heatVol*t.heat);
    p.aOdnWs=sum(p.tl.odnWs); p.aOdnWd=sum(p.tl.odnWd); p.aOdnE=sum(p.tl.odnE); p.aOdnH=ceil2(p.odnH*t.heat*kf);
    p.mop=sum(p.tl.mop); p.cap=sum(p.tl.cap); p.er=round2(p.mop+p.cap);   // ЭК
    const H=p.hand; H.aWs=sum(p.tl.hWs); H.aWd=sum(p.tl.hWd); H.aE=sum(p.tl.hE); H.total=round2(H.aWs+H.aWd+H.aE+H.aH);
  });
  // итог части — сумма её строк (включая долю счёта поставщика), не доля месячного итога по дням
  parts.forEach(p=>{ p.odnAmt=round2(p.aOdnWs+p.aOdnWd+p.aOdnE+p.aOdnH); p.total=round2(p.aWs+p.aWd+p.aE+p.aH+p.odnAmt+p.hand.total); });
  return {parts,byRead,byDays,ownBad,needRead:0,whole,slices:c.slices,meterVals};
}

/** Подпись плательщика части: почему платит именно так и с какой даты. */
function payerNote(r,p,ps,pe){
  ps=ps||periodStart(); pe=pe||periodEnd();
  const PL={uk:'платит УК за собственника',deduction:'удерживается из доли собственника',owner:'платит собственник'};
  const seg=p.progSeg;
  const why=p.prog&&p.prog!=='none'
    ? `${PROG[p.prog]} программа${seg&&seg.cno?', договор '+seg.cno:''}${seg&&seg.cdt?' от '+fdt(seg.cdt):''}`
    : 'не в управлении';
  if(p.from===ps&&p.to===pe) return `${PL[p.payer]} — ${why}`;
  return `${PL[p.payer]} с ${fdt(p.from)} по ${fdt(p.to)} — ${why}`;
}

/** Закрытый период — контекст из снимка, ничего не пересчитывается; открытый — живой расчёт. */
function buildCtx(){ return isClosed()?closedCtx():buildCtxLive(); }

// tariffRows — строки тарифов из снимка (строка на каждый тариф): пересчёт закрытого месяца (≠ снимка, корректировка) — по тарифам на день
// закрытия, правка тарифов задним числом закрытый месяц не трогает (проверка 05.10.2026)
function closedCtx(){ return Object.assign({closed:true,period:CLOSED.period,carryW:0,carryE:0,carryH:0,tariffRows:(CLOSED.inputs||{}).tariffRows||null},CLOSED.ctx); }

/** Перенос корректировок прошлого месяца в базу ОДН этого: положительный — здание собрало лишнее, уменьшает ОДН. */
const carryOf=k=>(isClosed()?[]:CARRIES).reduce((s,a)=>s+((a.carry&&+a.carry[k])||0),0);

/**
 * Тепло дома по формуле Бухгалтерии (заказчик, 05.10.2026) — единственное место формулы: ЭСФ Теплотранзита приходит уже без
 * разграниченных по теплу, поэтому
 *   база = общая площадь здания − площадь помещений, разграниченных по теплу в этом месяце;
 *   коэффициент отопления = Гкал месяца ÷ база; «Теплоэнергия» помещения = коэффициент × площадь — только неразграниченным;
 *   остаток = Гкал − тепло всех неразграниченных − нужды ЭК по теплу (тепло помещения УК, собственникам не выставляется);
 *   коэффициент ОДН = остаток ÷ площадь всех помещений базы ОДН; «ОДН теплоэнергия» = коэффициент ОДН × площадь — всем, по площади.
 * Вход: Гкал месяца по ЭСФ, общая площадь здания, площадь разграниченных, нужды ЭК по теплу (Гкал), площадь неразграниченных помещений,
 * площадь всех помещений базы ОДН, перенос корректировок закрытого месяца по теплу (Гкал; вычитается из остатка — только ОДН тепла,
 * как у воды и электро, заказчик 06.10.2026). Выход: база, коэффициент отопления, тепло неразграниченных,
 * остаток (со знаком), коэффициент ОДН и признаки: база ≤ 0 — коэффициент 0 (baseBad); остаток < 0 — ОДН тепла 0 (restNeg).
 * Контрольный пример заказчика (июнь, файл Бухгалтерии): 10,7764 Гкал · 23 474,3 · 10 322,4 · 0,2121 · 7 203,8 · 17 526,2 →
 * база 13 151,9 · коэффициент 0,00081938 · остаток 4,6617 Гкал · коэффициент ОДН 0,00026598.
 */
function heatSplit(gcal,bldArea,areaRz,ukH,areaFree,areaOdn,carry){
  const base=bldArea-areaRz, baseBad=!(base>0);
  const kOt=baseBad?0:gcal/base, used=kOt*areaFree, rest=gcal-used-ukH-(+carry||0);   // перенос корректировок — только в остаток (06.10.2026)
  return {base,kOt,used,rest,kOdn:areaOdn>0?Math.max(0,rest)/areaOdn:0,baseBad,restNeg:rest<-1e-9};
}

/** Общая площадь здания, м², за месяц (база отопления, заказчик 05.10.2026): поле пустое — по умолчанию 23 474,3 (это не
 *  «нужно заполнить»); введённое число — как есть (0 — тоже ввод: база ≤ 0, предупреждение в «расклад…» → ТЕПЛО). */
function bldAreaOf(v){ const s=v==null?'':String(v).trim(); return s===''?23474.3:pnum(s); }

function buildCtxLive(){
  // ЭК — две строки: «Техническое обслуживание МОП (м2)» и «Взносы на капитальный ремонт» (заказчик, 21.09.2026; вывоз мусора — внутри техобслуживания)
  const t={ws:tarOf('water_supply').v,wd:tarOf('water_drainage').v,el:tarOf('electricity').v,heat:tarOf('heating').v,maint:tarOf('maintenance').v+tarOf('capital_repair').v,maintBase:tarOf('maintenance').v,capRepair:tarOf('capital_repair').v};   // ЭК — как в тарифах, без подстановки 698 / 35 (04.10.2026): тариф 0 и «нет тарифа» видны в чек-листе
  // первый проход — расход всех помещений без ОДН
  const tmp={t,kOt:0,kOdn:0,odnPerUnitW:0,odnPerAreaE:0,ekFactor:1};
  let sumW=0,sumE=0,nOdn=0,areaOdn=0,areaHeatBase=0,areaHeatRz=0,nHeatRz=0,nHeatFree=0;
  // «разграничен по теплу» — помещение целиком у поставщика по теплу (договор, пометка вручную, «спит»: c.heat.allDirect) — вне
  // базы отопления; площадь разграниченных (areaHeatRz) вычитается из общей площади здания, неразграниченных (areaHeatBase) —
  // получает строку «Теплоэнергия»
  const heatBase={};
  ROWS.forEach(r=>{const c=calcRow(r,tmp); sumW+=c.water; sumE+=c.eB; if(r.inodn){nOdn++;areaOdn+=r.area;} heatBase[r.n]=!c.heat.allDirect;
    if(heatBase[r.n]){ areaHeatBase+=r.area; nHeatFree++; } else { areaHeatRz+=r.area; nHeatRz++; } });
  const inW=sfTotal('w'), inE=sfTotal('e'), ukW=gv('f-uk-w'), ukE=gv('f-uk-e');   // в счёте-фактуре может быть две позиции (смена тарифа)
  // нужды ЭК по теплу, Гкал (пусто = 0, как у воды и электро) и общая площадь здания (пусто — по умолчанию) — вводные месяца
  const ukH=gv('f-uk-h'), bldArea=bldAreaOf(el('f-bld-area')?el('f-bld-area').value:'');
  // переносы корректировок закрытого месяца — как доходные (заказчик, 20.09.2026); тепло: перенос вычитается из Гкал месяца
  const carryW=carryOf('water'), carryE=carryOf('e'), carryH=carryOf('heat');
  const odnW=inW-sumW-ukW-extW()-carryW;
  const odnE=inE-sumE-ukE-extE()-carryE;
  // тепло: перенос корректировок закрытого месяца — только в ОДН тепла, как у воды и электро (заказчик, 06.10.2026): коэффициент отопления — от ЭСФ месяца, перенос уменьшает остаток (heatSplit). До 06.10.2026
  // перенос вычитался из Гкал месяца и через коэффициент уходил и в «Теплоэнергию» неразграниченных
  const heatGcal=sfTotal('h');
  // тепло при смене тарифа внутри месяца (две позиции ЭСФ) — средний по Гкал позиций, как выставил Теплотранзит, а не по
  // дням (заказчик, 03.10.2026): дом получает ровно сумму счёта. Позиция без объёма — по дням, как раньше.
  const hs=sfSegs('h'); let heatBySf=false;
  if(hs.length>1){ const vols=hs.map((g,i)=>{ const e=el(sfId('h',i)); return e&&String(e.value).trim()!==''?pnum(e.value):0; });
    const tot=vols.reduce((a,v)=>a+v,0);
    if(tot>0&&vols.every(v=>v>0)){ t.heat=hs.reduce((a,g,i)=>a+g.tar*vols[i],0)/tot; heatBySf=true; } }
  // тепло — по формуле Бухгалтерии (заказчик, 05.10.2026; heatSplit): коэффициент = Гкал ÷ (общая площадь здания − площадь
  // разграниченных по теплу), строка «Теплоэнергия» у неразграниченных = площадь × коэффициент, остаток (Гкал − тепло
  // неразграниченных − нужды ЭК по теплу) → ОДН тепло всем по площади (kOdn). До 05.10.2026 коэффициент = Гкал ÷ площадь всех
  // помещений базы ОДН (22.09.2026), нужд ЭК по теплу не было; до 22.09 — ÷ площадь неразграниченных, остаток всегда 0.
  const H=heatSplit(heatGcal,bldArea,areaHeatRz,ukH,areaHeatBase,areaOdn,carryH);
  const kOt=H.kOt, kOdn=H.kOdn, heatUsed=H.used;
  const ctx={t,kOt,kOdn,odnPerUnitW:nOdn?odnW/nOdn:0,odnPerAreaE:areaOdn?odnE/areaOdn:0,ekFactor:1,
    sumW,sumE,inW,inE,ukW,ukE,odnW,odnE,nOdn,areaOdn,heatGcal,heatBySf,extE:extE(),extW:extW(),areaHeatBase,heatUsed,carryW,carryE,carryH,
    // тепло дома (05.10.2026) — для «расклад…», «Как посчитано» и снимка; снимок без этих полей — закрыт до правки (прежняя схема)
    ukH,bldArea,areaHeatRz,nHeatRz,nHeatFree,heatBaseArea:H.base,heatRest:H.rest,heatBaseBad:H.baseBad,heatRestNeg:H.restNeg};
  // корректировка ЭК: доля от ОДН в деньгах
  const pre=new Map();
  const odnAmtTot=ROWS.reduce((s,r)=>{ const c=calcRow(r,ctx); pre.set(r,c); return s+c.odnAmtRaw; },0);   // ctx ещё меняется ниже — без кэша; точный ОДН, не строки
  const ek=Math.min(Math.max(0,gv('f-ek')),Math.max(0,odnAmtTot));
  ctx.ekFactor= odnAmtTot>0?(odnAmtTot-ek)/odnAmtTot:1; ctx.ek=ek; ctx.odnAmtTot=odnAmtTot;
  // ЭК не берёт из ОДН (коэффициент 1) — этот проход посчитан ровно с итоговым контекстом (ek и odnAmtTot расчёт помещения не
  // читает): drawGrid кладёт его в кэш пульта, а не считает 445 помещений третий раз (05.10.2026, скорость смены месяца).
  // Неперечисляемое — в снимок закрытого месяца и в JSON не попадает
  if(ctx.ekFactor===1) Object.defineProperty(ctx,'pre',{value:pre,configurable:true});
  return ctx;
}

const TERM={
  uk:'в счёт УК', direct:'собственник', sleep:'УК · спит', hand:'через УК', part:'частично',
  directLong:'собственник — напрямую поставщику', sleepLong:'УК · спит — счёт поставщика оплачивает УК',
  // месяц продажи: счёт поставщика за месяц — по договору прежнего; доля нового за его дни выставляется ему через УК (заказчик, 24.09.2026)
  handLong:'через УК — доля счёта поставщика за дни нового собственника (договор разграничения прежнего), выставляется новому через УК',
  noContract:'договора нет — в счёт УК', noAct:'акта НЕТ', manual:'вручную', notInCalc:'не участвует в расчётах', noData:'нет показаний',
  ek:'ЭК', ekLong:'Эксплуатационные (ЭК)',
};

/* ---- кэш расчёта помещения на один цикл перерисовки ----
 * Одна перерисовка вызывала calcRow около 4 500 раз (база здания тремя
 * проходами, баланс четырьмя, итоги пятым). Результат для одного помещения
 * и одного контекста не меняется внутри цикла — считаем один раз.
 */
let CALC_CACHE=new Map(), CALC_CTX=null;

function calcCacheReset(){ CALC_CACHE=new Map(); CALC_CTX=null; }

function calcRowC(r,ctx){
  if(CALC_CTX!==ctx){ CALC_CACHE=new Map(); CALC_CTX=ctx; }
  let c=CALC_CACHE.get(r);
  if(!c){ c=(ctx&&ctx.closed&&CLOSED&&CLOSED.units&&CLOSED.units[r.n])||calcRow(r,ctx); CALC_CACHE.set(r,c); }
  return c;
}

/** Корректировки по помещению деньгами: закрытый месяц — разница всех его корректировок (по части — по ФИО);
 *  открытый — строки «Перерасчёт за …» (способ Б), выставленные в квитанциях этого месяца. */
/**
 * В какую часть (квитанцию) месяца идёт строка перерасчёта (способ Б) собственника fio: в последнюю его часть; его нет
 * среди частей — в последнюю часть месяца. Ровно в одну: при смене программы внутри месяца у того же собственника обе части
 * с одним ФИО (8004 июль: /1 собственник, /2 платит УК), и строка попадала в обе — перерасчёт выставлялся дважды
 * (проверка денег 04.10.2026).
 */
/**
 * ФИО собственника строки «Перерасчёт за …» / «Зачёт переплаты» в открытом месяце (06.10.2026). Строка выставлена собственнику, а
 * написание его ФИО потом могли исправить — по тексту строки его уже не найти, и строка уходила в последнюю квитанцию месяца, то
 * есть новому собственнику (проверка 06.10.2026: 1221 — продажа внутри месяца и исправленное ФИО прежнего, строка 378 ₸ у нового).
 * Строка помнит, с какой даты её собственник владеет помещением (ownFrom; первый собственник — null): совпадения по ФИО нет —
 * собственник с этой датой «с», его нынешнее ФИО. Строки, выставленные до этого, — по ФИО, как раньше.
 */
function lineFio(r,l){
  if(!l||l.ownFrom===undefined) return l?l.fio:'';
  const own=(r.owners||[]).filter(o=>!o.del);
  if(own.some(o=>ownKey(o.fio)===ownKey(l.fio))) return l.fio;
  const o=own.find(o=>(o.from||null)===(l.ownFrom||null));
  return o?o.fio:l.fio;
}

function recalcPartIdx(split,fio,payer){ const ps=(split&&split.parts)||[], f=ownKey(fio);   // ФИО — без учёта пробелов и регистра
  if(payer) for(let i=ps.length-1;i>=0;i--) if(ownKey(ps[i].fio)===f&&ps[i].payer===payer) return i;   // свой счёт: собственник + плательщик (04.10.2026)
  for(let i=ps.length-1;i>=0;i--) if(ownKey(ps[i].fio)===f) return i;
  return Math.max(0,ps.length-1); }

function progOnDay(r,D){ return (r.progs||[]).filter(p=>{ if(p.del) return false; const cut=progOwnerCut(r,p); return (!p.from||p.from<=D)&&(!p.to||p.to>=D)&&!(cut&&cut<=D); }).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1)).pop()||null; }

/* ===================== выгрузка квитанций для кабинета (заказчик, 23.09.2026) =====================
 * «Готовые квитанции — разработчику кабинета файлом: он размещает их в личном кабинете, а суммы помещений в управлении
 * берёт в отчёт собственнику». По ответу разработчика кабинета 23.09.2026: JSON — основной формат, Excel — запасной, содержание
 * одинаковое. В документе — только номер помещения, без фамилии (заказчик: собственник мог смениться, а мы — не узнать).
 * КУ и ЭК — отдельные документы; маркер плательщика на каждом: company / deduction / owner (пустой — ошибка,
 * выгрузка останавливается); ноль с причиной — полями (поставщик, № и дата договора, с какой даты разграничение,
 * акт по воде); версия формата. Числа — ровно как в квитанции стенда (drawInvoicePane): те же доли при делении
 * месяца, те же строки «Перерасчёт за …».
 */
const EXPORT_SCHEMA='1.6';   // 1.6 (06.10.2026, заказчик): у документа КУ — negativeUsage [{resource, meter, prev, cur}], если у прибора конец месяца меньше начала (расход обнулён); переплата (overpayment) — до целого тенге по правилам математики, 0,50 и больше — вверх;   // 1.5 (05.10.2026, утверждено заказчиком — строка на каждый тариф): тариф менялся внутри квитанции — строка услуги повторяется с полями from / to, на каждый тариф;    // 1.4 (04.10.2026, утверждено заказчиком): объём строки ОДН — уже с компенсацией «ЭК берёт из ОДН», поля factor нет;   // 1.3 (04.10.2026, утверждено заказчиком): переплата (total ≥ 0, overpayment), строки offset — зачёт переплаты, manual — корректировка суммы; корректировочные и ЭК, по счёту «собственник + плательщик», аннулирующие;

//    // 1.2 (03.10.2026):   // 1.2 (03.10.2026, заказчик): корректировочные квитанции /К1 закрытого месяца — документы kind «корректировочная» с полем corrective;
//    // 1.1 (24.09.2026): строка с supplierShare — доля счёта поставщика за дни нового собственника
const PAYER_EXP={uk:'company',deduction:'deduction',owner:'owner'};

// вид отдельной квитанции прежнего собственника (заказчик, 05.10.2026)
const SEP_KIND='отдельная — только строки прежнего собственника';

/** Итоги документа: linesTotal — сумма строк до копейки; total — к оплате, вверх до целого тенге, не меньше нуля; rounding —
 *  округление; сумма строк в минусе (перерасчёт больше начисления) — total 0 и overpayment — переплата целыми тенге (схема 1.3,
 *  заказчик, 03.10.2026). */
function payTotals(lines){ const linesTotal=round2(lines.reduce((a,l)=>a+(+l.amount||0),0)), p=payRound(linesTotal);
  return Object.assign({linesTotal,total:Math.max(0,p),rounding:round2(p-linesTotal)},p<0?{overpayment:-p}:{}); }

/** Ноль с причиной (поле zero строки выгрузки): объём за дни документа pFrom–pTo ушёл поставщику — напрямую или «спит» (счёт
 *  поставщика оплачивает УК). c — помещение месяца с приборами (calcRow, снимок или «стало» корректировки), key — w / e / h.
 *  Обычный ноль (потребления не было) и не ноль — null. Одна и для обычной, и для корректировочной квитанции (проверка
 *  05.10.2026: у /К1 нули воды и тепла шли без причины, хотя у исходной она была). */
function zeroReason(r,c,key,amount,pFrom,pTo){
  if(Math.abs(amount)>0.004) return null;
  const SUP={w:'Су-Арнасы',e:'АРЭК',h:'Теплотранзит'}, all=[];
  if(key==='h'){ if(c.heat) all.push(...(c.heat.ivs||[])); }
  else (c.det||[]).forEach(d=>{ if(!d.iv||!d.m||d.m.bill===false) return; if((d.m.res==='ee')!==(key==='e')) return; all.push(...(d.iv.ivs||[])); });
  const ivs=all.filter(x=>x.from>=pFrom&&x.to<=pTo), slp=ivs.filter(x=>x.sleeping), dir=ivs.filter(x=>x.direct&&!x.sleeping&&!x.hand);   // доля счёта поставщика — строка через УК, не ноль
  if(!slp.length&&!dir.length) return null;              // обычный ноль — потребления не было
  const seg=rzForSlice(r,key,{from:pFrom,to:pTo},gc('f-rz'),false).seg;
  const manual=!seg&&ivs.some(x=>x.man===true);   // ручная пометка собственника этих дней без договора (06.10.2026)
  const z={reason:dir.length?'direct':(slp.some(x=>x.seg&&x.seg.payer==='deduction')?'supplier_paid_from_share':'supplier_paid_by_company'),
    supplier:SUP[key],contractNo:seg?(seg.no||null):null,contractDate:seg?rzDate(seg):null,
    effectiveFrom:seg?(seg.from||null):null,byFact:!!(seg&&seg.fact&&!(seg.no&&seg.from)),manual:!!manual};
  if(key==='w'){ z.actNo=seg?(seg.sealNo||null):null; z.actDate=seg?(seg.seal||null):null; }
  return z;
}

function invoiceDocs(r,c,t,kf,ps,pe,per){
  const split=c.split&&c.split.parts&&c.split.parts.length>1?c.split:null, parts=split?split.parts:[null];
  const dim=new Date(pe+'T00:00:00Z').getUTCDate(), docs=[];
  // квитанции месяца: отдельная квитанция прежнего собственника (только его строки, правило 46д) — первой, потом части месяца
  const S=invSlots(r,c,per), many=S.slots.length>1, recalcAll_=S.rec, offs=S.offs;   // закрытый месяц — строки из снимка
  // отрицательный расход (конец месяца меньше начала, расход обнулён) — признаком у документа КУ (заказчик, 06.10.2026; схема 1.6)
  const negU=(c.det||[]).filter(d=>d.m&&d.m.bill!==false&&d.rd&&d.rd.prev!=null&&d.rd.cur!=null&&pnum(d.rd.cur)<pnum(d.rd.prev))
    .map(d=>({resource:d.m.res==='ee'?'electricity':'water',meter:d.m.sn||null,prev:pnum(d.rd.prev),cur:pnum(d.rd.cur)}));
  const SUP={w:'Су-Арнасы',e:'АРЭК',h:'Теплотранзит'};
  // отдельная квитанция прежнего собственника (заказчик, 05.10.2026): дней владения в месяце нет (days 0, без
  // «с / по»), строки — только его «Перерасчёт за …» и «Зачёт переплаты»; КУ и ЭК — только тот документ, где они есть
  S.slots.forEach((sl,j)=>{ if(!sl.sep) return;
    const payer=PAYER_EXP[sl.payer]; if(!payer) throw new Error(`${r.n}/${j+1}: плательщик «${sl.payer}» — не из трёх значений`);
    const inS=x=>S.idx(x)===j, ln=T=>[...recalcAll_.filter(x=>(x.target==='EK')===(T==='EK')&&inS(x)).map(x=>({code:'recalc',name:x.line,unit:null,volume:null,tariff:null,amount:round2(+x.amount||0)})),
      ...offs.filter(o=>o.target===T&&inS(o)).map(o=>({code:'offset',name:o.line,unit:null,volume:null,tariff:null,amount:round2(o.amount)}))];
    const base={unit:r.n,area:+areaOf(r,c)||0,period:per,from:null,to:null,days:0,daysInMonth:dim,part:j+1,parts:S.slots.length,splitReason:'owner-change',payer,management:null};
    const ku=ln('KU'), ek=ln('EK');
    if(ku.length) docs.push(Object.assign({code:`КВ-${r.n}-${per}/${j+1}`,type:'KU'},base,{kind:SEP_KIND,issueMonth:nextPer(per),lines:ku},payTotals(ku)));
    if(ek.length) docs.push(Object.assign({code:`ЭК-${r.n}-${per}/${j+1}`,type:'EK'},base,{kind:SEP_KIND,issueDate:`${per}-25`,dueDate:`${nextPer(per)}-10`,lines:ek},payTotals(ek)));
  });
  parts.forEach((part,i)=>{
    const j=S.sepN+i;   // номер квитанции в месяце
    const pFrom=part?part.from:ps, pTo=part?part.to:pe, suffix=many?'/'+(j+1):'';
    const V=part?{water:part.water,eB:part.eB,heatVol:part.heatVol,odnW:part.odnW,odnE:part.odnE,odnH:part.odnH,
                  aWs:part.aWs,aWd:part.aWd,aE:part.aE,aH:part.aH,aOdnWs:part.aOdnWs,aOdnWd:part.aOdnWd,aOdnE:part.aOdnE,aOdnH:part.aOdnH,total:part.total,er:part.er,hand:part.hand}
                :{water:c.water,eB:c.eB,heatVol:c.heatVol,odnW:c.odnW,odnE:c.odnE,odnH:c.odnH,
                  aWs:c.aWs,aWd:c.aWd,aE:c.aE,aH:c.aH,aOdnWs:odnLines(c,t,kf).ws,aOdnWd:odnLines(c,t,kf).wd,aOdnE:odnLines(c,t,kf).e,aOdnH:odnLines(c,t,kf).h,total:c.total,er:c.er,hand:c.hand};
    const H=V.hand||{w:0,e:0,h:0,aWs:0,aWd:0,aE:0,aH:0,total:0};   // доля счёта поставщика — дни нового собственника в месяце продажи
    const pin=part?part.payer:c.payer, payer=PAYER_EXP[pin];
    if(!payer) throw new Error(`${r.n}${suffix}: плательщик «${pin}» — не из трёх значений`);
    // закрытый месяц — как в снимке (04.10.2026, проверка корректировок: после входа в управление задним числом июньская
    // квитанция уходила с payer:owner и программой из текущих данных одновременно)
    const sp0=part||(c.split&&c.split.parts&&c.split.parts[0])||null;
    const pg=isClosed()?(sp0&&sp0.progSeg&&sp0.progSeg.prog&&sp0.progSeg.prog!=='none'?sp0.progSeg:null):progOnDay(r,pFrom);
    const management=pg?{program:pg.prog,contractNo:pg.cno||null,contractDate:pg.cdt||null,from:pg.from||null}:null;
    // ноль с причиной: объём за дни этого документа ушёл поставщику — напрямую или «спит» (счёт поставщика оплачивает УК)
    const zero=(key,amount)=>zeroReason(r,c,key,amount,pFrom,pTo);
    // объём — с тем числом знаков, при котором «объём × тариф (4 знака) [× коэффициент]», вверх до копейки, даёт сумму строки,
    // как в квитанции стенда (fVol; 04.10.2026, проверка денег: объём, округлённый до 3–4 знаков, на калькуляторе давал
    // другую сумму у всех строк ОДН воды и у части строк тепла); ОДН при «ЭК берёт из ОДН» — объём уже с компенсацией
    // (объём × коэффициент): строка сходится на калькуляторе, компенсацию собственник не видит (заказчик, 04.10.2026; схема 1.4 —
    // до неё объём был полный, а коэффициент шёл полем factor)
    const L=(code,name,unit,vol,tar,amt,key)=>{ const o={code,name,unit,volume:vol,tariff:+(+tar||0).toFixed(4),amount:round2(+amt||0)};   // тариф с НДС — до 4 знаков, сумма считана от точного
      const z=key?zero(key,amt):null; if(z) o.zero=z; return o; };
    // тарифы квитанции (строка на каждый тариф, утверждено заказчиком 05.10.2026): тариф менялся внутри квитанции — строка услуги на каждый
    // тариф с полями from / to (схема 1.5); один тариф на все дни квитанции — одна строка по нему (не средний за месяц)
    const TL=(part||(c.split&&c.split.parts&&c.split.parts.length===1?c.split.parts[0]:null)||{}).tl||null;
    const tarK=(k,dflt)=>TL&&TL[k]&&TL[k].length===1?TL[k][0].tar:dflt;
    const LL=(code,name,unit,dec,amt,key,k,hk,f,one)=>{ const g=TL&&TL[k]; if(!(g&&g.length>1)) return [one];
      if(Math.abs(amt)<=0.004){ one.tariff=+(+g[g.length-1].tar||0).toFixed(4); return [one]; }   // ноль — одна строка, тариф последних дней квитанции
      const hg=hk&&TL[hk]; return g.map((x,j)=>{ const vol=x.vol*(f==null?1:f)+(hg?hg[j].vol:0), a=x.amt+(hg?hg[j].amt:0);
        return Object.assign(L(code,name,unit,volDec(vol,dec,[[x.tar,a]]).v,x.tar,a,null),{from:x.from,to:x.to}); }); };
    const tWs=tarK('ws',t.ws), tWd=tarK('wd',t.wd), tEl=tarK('el',t.el);
    // объём воды — один на водоснабжение и водоотведение, пока ни одно не делится по тарифам; делится одно — у другого свой подбор знаков
    const spl=k=>!!(TL&&TL[k]&&TL[k].length>1), wJ=!spl('ws')&&!spl('wd'), oJ=!spl('odnWs')&&!spl('odnWd');
    const vW=volDec(V.water+H.w,3,wJ?[[tWs,V.aWs+H.aWs],[tWd,V.aWd+H.aWd]]:[[tWs,V.aWs+H.aWs]]).v, vWd=wJ?vW:volDec(V.water+H.w,3,[[tWd,V.aWd+H.aWd]]).v,
      vOW=volDec(V.odnW*kf,3,oJ?[[tWs,V.aOdnWs],[tWd,V.aOdnWd]]:[[tWs,V.aOdnWs]]).v, vOWd=oJ?vOW:volDec(V.odnW*kf,3,[[tWd,V.aOdnWd]]).v,
      vE=volDec(V.eB+H.e,2,[[tEl,V.aE+H.aE]]).v, vOE=volDec(V.odnE*kf,3,[[tEl,V.aOdnE]]).v,
      vH=volDec(V.heatVol+H.h,4,[[t.heat,V.aH+H.aH]]).v, vOH=volDec(V.odnH*kf,4,[[t.heat,V.aOdnH]]).v;
    const ku=[...LL('water_supply','Водоснабжение','м3',3,V.aWs+H.aWs,'w','ws','hWs',null,L('water_supply','Водоснабжение','м3',vW,tWs,V.aWs+H.aWs,'w')),
      ...LL('water_drainage','Водоотведение','м3',3,V.aWd+H.aWd,'w','wd','hWd',null,L('water_drainage','Водоотведение','м3',vWd,tWd,V.aWd+H.aWd,'w')),
      ...LL('odn_water_supply','ОДН водоснабжение','м3',3,V.aOdnWs,null,'odnWs',null,kf,L('odn_water_supply','ОДН водоснабжение','м3',vOW,tWs,V.aOdnWs,null)),
      ...LL('odn_water_drainage','ОДН водоотведение','м3',3,V.aOdnWd,null,'odnWd',null,kf,L('odn_water_drainage','ОДН водоотведение','м3',vOWd,tWd,V.aOdnWd,null)),
      ...LL('electricity','Электроэнергия','кВт·ч',2,V.aE+H.aE,'e','el','hE',null,L('electricity','Электроэнергия','кВт·ч',vE,tEl,V.aE+H.aE,'e')),
      ...LL('odn_electricity','ОДН электроэнергия','кВт·ч',3,V.aOdnE,null,'odnE',null,kf,L('odn_electricity','ОДН электроэнергия','кВт·ч',vOE,tEl,V.aOdnE,null)),
      L('heat','Теплоэнергия','Гкал',vH,t.heat,V.aH+H.aH,'h'),L('odn_heat','ОДН теплоэнергия','Гкал',vOH,t.heat,V.aOdnH,null)];
    // доля счёта поставщика (схема 1.1): объём строки — за дни этого документа, и он НЕ входит в счёт-фактуру УК —
    // счёт за месяц поставщик выставил прежнему собственнику; кабинет показывает строку как обычную, с пометкой
    const covSegOf=key=>key==='h'?(c.heat&&c.heat.cov&&c.heat.cov.seg):((c.det||[]).map(d=>d.iv&&d.iv.cov&&(d.m.res==='ee')===(key==='e')?d.iv.cov.seg:null).find(Boolean));
    [['water_supply','w',H.w],['water_drainage','w',H.w],['electricity','e',H.e],['heat','h',H.h]].forEach(([code,key,vol])=>{
      if(!(vol>1e-9)) return;
      const l=ku.find(x=>x.code===code), seg=covSegOf(key);
      l.supplierShare={reason:'previous_owner_contract',supplier:SUP[key],contractNo:seg?(seg.no||null):null,contractDate:seg?rzDate(seg):null,
        days:part?part.days:dim,daysInMonth:dim,volume:+vol.toFixed(key==='e'?2:key==='h'?4:3),
        note:'месяц продажи: счёт поставщика за месяц — по договору прежнего собственника; доля нового за его дни выставляется через УК'};
    });
    const inP=x=>S.idx(x)===j;
    recalcAll_.filter(x=>x.target!=='EK'&&inP(x)).forEach(x=>ku.push({code:'recalc',name:x.line,unit:null,volume:null,tariff:null,amount:round2(+x.amount||0)}));
    offs.filter(o=>o.target==='KU'&&inP(o)).forEach(o=>ku.push({code:'offset',name:o.line,unit:null,volume:null,tariff:null,amount:round2(o.amount)}));
    const kv=kvKind(c,part||undefined);
    const base={unit:r.n,area:+areaOf(r,c)||0,period:per,from:pFrom,to:pTo,days:part?part.days:dim,daysInMonth:dim,
      part:many?j+1:1,parts:many?S.slots.length:1,splitReason:part?(part.reason||null):(S.sepN?'owner-change':null),payer,management};
    docs.push(Object.assign({code:`КВ-${r.n}-${per}${suffix}`,type:'KU'},base,{
      kind:kv.title.replace(/^Квитанция /,''),
      issueMonth:nextPer(per),lines:ku},payTotals(ku),negU.length?{negativeUsage:negU}:{}));
    // площадь строк ЭК — та же, что у документа: закрытый месяц — из снимка (суммы из снимка; проверка 05.10.2026: площадь
    // поменяли после закрытия — «30 × 698 = 19 264,80», а сумма посчитана на 27,6)
    const sh=part?part.share:1, EKL=ekLines(part||c,r,t), mop=EKL.mop, cap=EKL.cap, ar=base.area;
    // доля дней — с числом знаков, при котором «площадь × доля × тариф» даёт строку (было 4 знака — до 0,94 ₸ разницы)
    const tM=tarK('mop',t.maintBase), tC=tarK('cap',t.capRepair);
    const shP=[TL&&TL.mop&&TL.mop.length>1?null:[ar*tM,mop],TL&&TL.cap&&TL.cap.length>1?null:[ar*tC,cap]].filter(Boolean);   // строки, поделённые по тарифам, — свой подбор знаков
    const shV=sh===1?1:shP.length?volDec(sh,4,shP).v:+(+sh).toFixed(4);
    // эксплуатационная — тоже по тарифам квитанции (строка на каждый тариф): тариф менялся внутри — строка на каждый, с долей своих дней
    const ekL=(code,name,k,tar,amt)=>{ const g=TL&&TL[k]; if(!(g&&g.length>1)) return [{code,name,unit:'м2',volume:+ar.toFixed(2),share:shV,tariff:tar,amount:round2(amt)}];
      return g.map(x=>({code,name,unit:'м2',volume:+ar.toFixed(2),share:volDec(x.share,4,[[ar*x.tar,x.amt]]).v,tariff:x.tar,amount:round2(x.amt),from:x.from,to:x.to})); };
    const ek=[...ekL('maintenance',EK_LINES.mop,'mop',tM,mop),...ekL('capital_repair',EK_LINES.cap,'cap',tC,cap)];
    recalcAll_.filter(x=>x.target==='EK'&&inP(x)).forEach(x=>ek.push({code:'recalc',name:x.line,unit:null,volume:null,tariff:null,amount:round2(+x.amount||0)}));
    offs.filter(o=>o.target==='EK'&&inP(o)).forEach(o=>ek.push({code:'offset',name:o.line,unit:null,volume:null,tariff:null,amount:round2(o.amount)}));
    docs.push(Object.assign({code:`ЭК-${r.n}-${per}${suffix}`,type:'EK'},base,{
      issueDate:`${per}-25`,dueDate:`${nextPer(per)}-10`,lines:ek},payTotals(ek)));
  });
  return docs;
}

/** Корректировочные квитанции закрытого месяца (способ А) — документами выгрузки (схема 1.2 — заказчик, 03.10.2026;
 *  1.3 — 04.10.2026: и ЭК, по счёту «собственник + плательщик», аннулирующие, корректировка суммы). Строки — как у обычной
 *  квитанции, по тарифам снимка; строки перерасчёта и зачёта заменяемой квитанции остаются; corrective — что заменяет (коды),
 *  разница к оплате счёта целыми тенге, номер корректировки, когда выставлена, причина без ФИО. */
function correctiveDocs(regular,t,per){
  // по помещению, счёту и квитанции — последний выставленный документ: /К2 заменяет /К1, а не исходную. Помещение — в ключе
  // (проверка 05.10.2026: один собственник в двух помещениях — «КВ-5016…/2К1 заменяет КВ-5020…/2К1», и /2К1 другого помещения
  // считалась заменённой и выпадала из итога корректировочных)
  const out=[], last={};
  const kf=(CTX&&CTX.ekFactor!=null)?CTX.ekFactor:1, dim=new Date(periodEnd()+'T00:00:00Z').getUTCDate();
  const list=isClosed()?ADJ.slice().sort((x,y)=>(x.seq||0)-(y.seq||0)):[];
  // строки перерасчёта и зачёта снимка по квитанциям каждой корректировки помещения (правило 46д): step — номер корректировки
  // в цепочке помещения (1 — первая)
  const LP={}, step=new Map();
  list.forEach(a=>{ const e=LP[a.unit]||(LP[a.unit]={chain:[]}); e.chain.push(a.after); step.set(a,e.chain.length); });
  Object.keys(LP).forEach(n=>{ const sU=CLOSED&&CLOSED.units?CLOSED.units[n]:null; LP[n].lines=sU?linesPath(sU,LP[n].chain):[]; });
  list.forEach(a=>(a.invoices||[]).filter(x=>x.kind==='corrective').forEach(inv=>{
    const T=inv.target==='EK'?'EK':'KU', repl=Array.isArray(inv.replaces)?inv.replaces:(inv.replaces?[inv.replaces]:[]);
    const bases=repl.map(code=>regular.find(d=>d.type===T&&d.code===code)).filter(Boolean), b0=bases[0]||null;
    const ck=a.unit+'|'+acctKey(inv.fio,inv.payer||(b0&&b0.payer==='owner'?'owner':null))+'|'+T, prev=last[ck]||null;
    const V=inv.lines||{}, H=V.hand||{w:0,e:0,h:0,aWs:0,aWd:0,aE:0,aH:0};
    const L=(code,name,unit,vol,tar,amt,dec,odn)=>({code,name,unit,volume:inv.annul?0:volDec(vol*(odn?kf:1),dec,[[tar,amt]]).v,tariff:+(+tar||0).toFixed(4),amount:inv.annul?0:round2(+amt||0)});   // ОДН — объём с компенсацией (схема 1.4)
    // тарифы квитанции (строка на каждый тариф): корректировка хранит строки по тарифам части (lines.tl) — как в обычной квитанции:
    // тариф менялся внутри — строка на каждый с from / to; один тариф на все дни — он, не средний; старые корректировки без tl — средний
    const sm_=g=>g?g.reduce((q,x)=>q+(+x.amt||0),0):0;
    const TC=inv.annul?null:(V.tl||null), sp=(k,hk)=>!!(TC&&TC[k]&&TC[k].length>1&&Math.abs(sm_(TC[k])+sm_(hk&&TC[hk]))>0.004), tK=(k,d)=>TC&&TC[k]&&TC[k].length?TC[k][TC[k].length-1].tar:d;   // ноль при смене тарифа — одна строка, тариф последних дней
    const LS=(code,name,unit,dec,k,hk,f,one)=>{ if(!sp(k,hk)) return [one]; const hg=hk&&TC[hk];
      return TC[k].map((x,j)=>{ const v=x.vol*(f==null?1:f)+(hg?hg[j].vol:0), a=x.amt+(hg?hg[j].amt:0);
        return {code,name,unit,volume:volDec(v,dec,[[x.tar,a]]).v,tariff:+(+x.tar||0).toFixed(4),amount:round2(a),from:x.from,to:x.to}; }); };
    let lines;
    if(T==='EK'){ const ar=+inv.area||0, sh=inv.share!=null?inv.share:1, tM=tK('mop',t.maintBase), tC=tK('cap',t.capRepair);
      // аннулирующая — доля 0: «площадь × тариф × доля» = сумма 0, как нулевые объёмы КУ (проверка 05.10.2026: стояло 27,5 × 698 × 1 = 0)
      const shP=[sp('mop')?null:[ar*tM,V.mop],sp('cap')?null:[ar*tC,V.cap]].filter(Boolean), shV=inv.annul?0:sh===1?sh:shP.length?volDec(sh,4,shP).v:+(+sh).toFixed(4);
      const ekS=(code,name,k,tar,amt)=>sp(k)?TC[k].map(x=>({code,name,unit:'м2',volume:+ar.toFixed(2),share:volDec(x.share,4,[[ar*x.tar,x.amt]]).v,tariff:x.tar,amount:round2(x.amt),from:x.from,to:x.to}))
        :[{code,name,unit:'м2',volume:+ar.toFixed(2),share:shV,tariff:tar,amount:inv.annul?0:round2(+amt||0)}];
      lines=[...ekS('maintenance',EK_LINES.mop,'mop',tM,V.mop),...ekS('capital_repair',EK_LINES.cap,'cap',tC,V.cap)]; }
    else { const tWs=tK('ws',t.ws), tWd=tK('wd',t.wd), tEl=tK('el',t.el), wJ=!sp('ws','hWs')&&!sp('wd','hWd'), oJ=!sp('odnWs')&&!sp('odnWd');
      const W=(V.water||0)+(H.w||0), aWs=(V.aWs||0)+(H.aWs||0), aWd=(V.aWd||0)+(H.aWd||0);
      const vW=inv.annul?0:volDec(W,3,wJ?[[tWs,aWs],[tWd,aWd]]:[[tWs,aWs]]).v, vWd=inv.annul?0:wJ?vW:volDec(W,3,[[tWd,aWd]]).v,
        vOW=inv.annul?0:volDec(V.odnW*kf,3,oJ?[[tWs,V.aOdnWs],[tWd,V.aOdnWd]]:[[tWs,V.aOdnWs]]).v, vOWd=inv.annul?0:oJ?vOW:volDec(V.odnW*kf,3,[[tWd,V.aOdnWd]]).v;
      lines=[...LS('water_supply','Водоснабжение','м3',3,'ws','hWs',null,L('water_supply','Водоснабжение','м3',vW,tWs,aWs,3)),
        ...LS('water_drainage','Водоотведение','м3',3,'wd','hWd',null,L('water_drainage','Водоотведение','м3',vWd,tWd,aWd,3)),
        ...LS('odn_water_supply','ОДН водоснабжение','м3',3,'odnWs',null,kf,L('odn_water_supply','ОДН водоснабжение','м3',vOW,tWs,V.aOdnWs,3,0)),
        ...LS('odn_water_drainage','ОДН водоотведение','м3',3,'odnWd',null,kf,L('odn_water_drainage','ОДН водоотведение','м3',vOWd,tWd,V.aOdnWd,3,0)),
        ...LS('electricity','Электроэнергия','кВт·ч',2,'el','hE',null,L('electricity','Электроэнергия','кВт·ч',(V.eB||0)+(H.e||0),tEl,(V.aE||0)+(H.aE||0),2)),
        ...LS('odn_electricity','ОДН электроэнергия','кВт·ч',3,'odnE',null,kf,L('odn_electricity','ОДН электроэнергия','кВт·ч',V.odnE,tEl,V.aOdnE,3,1)),
        L('heat','Теплоэнергия','Гкал',(V.heatVol||0)+(H.h||0),t.heat,(V.aH||0)+(H.aH||0),4),L('odn_heat','ОДН теплоэнергия','Гкал',V.odnH,t.heat,V.aOdnH,4,1)].map(l=>{ if(inv.annul){ l.volume=0; l.amount=0; } return l; });
      // ноль с причиной — как у обычной квитанции (zeroReason по «стало» корректировки и дням этой квитанции; суммы не меняются):
      // аннулирующая — без причин, она обнуляется целиком
      if(!inv.annul&&a.after){ const ru=ROWS.find(x=>x.n===a.unit), one=(inv.parts||1)<=1, zf=one?periodStart():inv.from, zt=one?periodEnd():inv.to, ZK={water_supply:'w',water_drainage:'w',electricity:'e',heat:'h'};
        if(ru&&zf&&zt) lines.forEach(l=>{ const k=ZK[l.code]; if(k&&!l.from){ const z=zeroReason(ru,a.after,k,l.amount,zf,zt); if(z) l.zero=z; } }); } }
    (inv.manual||[]).forEach(m=>lines.push({code:'manual',name:m.name,unit:null,volume:null,tariff:null,amount:round2(+m.amount||0)}));
    // строки «Перерасчёт за …» и «Зачёт переплаты» снимка — в квитанции счёта, где они стоят после этой корректировки (правило
    // 46д, заказчик 05.10.2026; linesPath): у своего собственника; продал внутри месяца — в его квитанции за свои дни, новому не
    // идут; сменился только плательщик — в квитанции «платит УК»; собственника в месяце больше нет — в его аннулирующей
    linesIn(LP[a.unit].lines,step.get(a),inv).forEach(e=>lines.push({code:e.kind,name:e.l.line,unit:null,volume:null,tariff:null,amount:round2(+e.l.amount||0)}));
    const tot=payTotals(lines);
    const wasP=inv.was!=null?inv.was:(prev?prev.total:(b0?b0.total:0)), was=Math.max(0,wasP), diff=inv.was!=null?inv.settle:tot.total-was;
    // номер части — после отдельных квитанций прежнего собственника месяца, что остаются (как номер документа /2К1)
    const sU=CLOSED&&CLOSED.units?CLOSED.units[a.unit]:null, m=sU&&inv.part!=null?sepLeft(sU,a.after):0;
    const doc=Object.assign({code:inv.code,type:T,unit:a.unit,area:inv.area!=null?inv.area:(b0?b0.area:0),period:per,from:inv.from||(b0&&b0.from),to:inv.to||(b0&&b0.to),
      days:inv.days||(b0&&b0.days)||dim,daysInMonth:dim,part:inv.part!=null?inv.part+1+m:(b0?b0.part:1),parts:inv.parts!=null&&inv.part!=null?inv.parts+m:(inv.parts||(b0?b0.parts:1)),splitReason:b0?b0.splitReason:null,
      payer:inv.payer&&PAYER_EXP[inv.payer]?PAYER_EXP[inv.payer]:(b0?b0.payer:'owner'),management:inv.mgmt!==undefined?inv.mgmt:(b0?b0.management:null),kind:'корректировочная',
      corrective:{replaces:prev?[prev.code]:repl,original:repl,annul:!!inv.annul,adjustment:a.id,group:a.group||null,issuedAt:a.at||null,reason:a.cause?causeText(a.cause,a.text,true):(a.reason||''),
        replacedTotal:was,difference:diff,overpaymentChange:inv.creditDelta||0}},
      T==='KU'?{issueMonth:nextPer(per)}:{issueDate:dayLocal(a.at)||`${nextPer(per)}-25`},{lines},tot);
    if(prev) prev.corrective.replacedBy=doc.code;   // /К1, заменённая /К2, — в итог не идёт
    out.push(doc); last[ck]=doc;
  }));
  return out;
}

function exportEnvelope(){
  const per=el('f-per').value, c0=CTX, ps=periodStart(), pe=periodEnd(), docs=[], errs=[];
  calcCacheReset();
  ROWS.forEach(r=>{ try{ docs.push(...invoiceDocs(r,calcRowC(r,c0),c0.t,c0.ekFactor,ps,pe,per)); }catch(e){ errs.push(e.message); } });
  try{ docs.push(...correctiveDocs(docs,c0.t,per)); }catch(e){ errs.push('корректировочные квитанции: '+e.message); }
  // обычные квитанции и корректировочные (заменяют их) — в итогах отдельно, чтобы сумма месяца не удвоилась
  const reg=docs.filter(d=>!d.corrective), cor=docs.filter(d=>d.corrective);
  const pick=ty=>reg.filter(d=>d.type===ty), sum=a=>round2(a.reduce((x,d)=>x+d.total,0)), sumL=a=>round2(a.reduce((x,d)=>x+d.linesTotal,0));
  const byPayer={}; ['company','deduction','owner'].forEach(k=>{ const a=reg.filter(d=>d.payer===k); byPayer[k]={KU:sum(a.filter(d=>d.type==='KU')),EK:sum(a.filter(d=>d.type==='EK')),documents:a.length}; });
  return {errs,env:{schemaVersion:EXPORT_SCHEMA,source:'engine',object:"TOR'RE Astana",period:per,status:isClosed()?'closed':'open',
    generatedAt:new Date().toISOString(),engineVersion:ENGINE_VERSION,
    rounding:'total = сумма строк (linesTotal), округлённая вверх до целого тенге, не меньше 0; сумма строк в минусе — total 0 и overpayment (переплата — до целого тенге по правилам математики, 0,50 и больше — вверх); rounding — только округление',
    totals:{units:new Set(docs.map(d=>d.unit)).size,documents:docs.length,
      KU:{count:pick('KU').length,sum:sum(pick('KU')),linesSum:sumL(pick('KU'))},EK:{count:pick('EK').length,sum:sum(pick('EK')),linesSum:sumL(pick('EK'))},byPayer,
      corrective:{count:cor.length,sum:sum(cor.filter(d=>!d.corrective.replacedBy)),difference:round2(cor.reduce((x,d)=>x+(+d.corrective.difference||0),0))},
      // переплата: квитанции с суммой строк в минусе — к оплате 0, переплата собственнику (только обычные квитанции)
      overpayment:{documents:reg.filter(d=>d.overpayment>0).length,sum:reg.reduce((x,d)=>x+(+d.overpayment||0),0)}},
    documents:docs}};
}

function ownerOnDay(r,D){ return (r.owners||[]).filter(o=>!o.del&&(!o.from||o.from<=D)&&(!o.to||o.to>=D)).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1)).pop()||null; }

/** Договоры по теплу с номером без даты, не закрытые до расчётного месяца (в том числе продажей — срок берётся как в расчёте,
 *  rzEffective): договор действует по номеру (правило 36), дату вносят позже — напоминание в «Проверках за месяц» (заказчик,
 *  05.10.2026). [номер помещения, индекс договора в r.rz.h] */
function heatNoDate(){ const ps=periodStart(), out=[];
  ROWS.forEach(r=>{ ((r.rz||{}).h||[]).forEach((x,ix)=>{ if(x.del||!String(x.no||'').trim()||x.from||x.fact) return;
    const e=rzEffective(x,'h',r); if(!(e.to&&e.to<ps)) out.push([r.n,ix]); }); });
  return out; }

/** Проверки смены собственника / исправления ФИО без изменений: текст отказа или null. Окно реестра зовёт её до «Вы уверены?»
 *  (проверка 05.10.2026: оператор подтверждал смену, которой не будет), regApplyOwner — ещё раз перед записью. */
/**
 * Смена собственника — одна на месяц (заказчик, 06.10.2026). Смена — дата «с» каждого собственника, кроме самого
 * первого (помеченные на удаление не считаются). owners — записи, какими они станут после правки. Возвращает месяц ГГГГ-ММ, где
 * смен две и больше, или null. Сервер проверяет то же (putUnit).
 */
function ownerChangeClash(owners){
  const own=(owners||[]).filter(o=>o&&!o.del).slice().sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  const seen=new Set();
  for(const o of own.slice(1)){ if(!o.from) continue; const m=String(o.from).slice(0,7); if(seen.has(m)) return m; seen.add(m); }
  return null;
}

function periodStart(){const [y,m]=el('f-per').value.split('-').map(Number);return `${y}-${String(m).padStart(2,'0')}-01`;}

function periodEnd(){const [y,m]=el('f-per').value.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);}

/**
 * Отрезок действует в периоде, если начался не позже его конца
 * и не закончился до его начала. Пустая дата начала означает «был всегда»,
 * пустая дата окончания — «действует до сих пор».
 */
function segActive(s,ps,pe){
  if(s.from && s.to && s.from>s.to) return false;   // пустой отрезок: начало позже конца (например, акт опломбировки после продажи)
  if(s.from && s.from>pe) return false;
  if(s.to && s.to<ps) return false;
  return true;
}

/**
 * Человеческое объяснение, как отрезок соотносится с расчётным периодом.
 * Возвращает текст и признак, действует ли отрезок и не обрывается ли он внутри периода.
 */
function segState(s,ps,pe){
  if(s.from && s.to && s.from>s.to) return {ok:false,mid:false,text:`пустой: с ${fdt(s.from)} по ${fdt(s.to)} — начало позже конца`};
  if(s.from && s.from>pe) return {ok:false,mid:false,text:`начинается ${fdt(s.from)} — после периода`};
  if(s.to && s.to<ps)     return {ok:false,mid:false,text:`закончился ${fdt(s.to)} — до периода`};
  // Строгое сравнение: договор, начинающийся ровно в первый день периода или
  // закрытый ровно последним, покрывает период целиком — делить нечего.
  // С нестрогим договор, закрытый 11.06 на отрезке владения 01.06–11.06,
  // считался «частичным», и разграничение у прежнего собственника пропадало.
  const startsMid = s.from && s.from>ps;
  const endsMid   = s.to   && s.to<pe;
  if(startsMid && endsMid) return {ok:true,mid:true,text:`только с ${fdt(s.from)} по ${fdt(s.to)} внутри периода`};
  if(startsMid)            return {ok:true,mid:true,text:`начинается ${fdt(s.from)} — в середине периода`};
  if(endsMid)              return {ok:true,mid:true,text:`заканчивается ${fdt(s.to)} — в середине периода`};
  return {ok:true,mid:false,text:'действует весь период'};
}

/** Действующий отрезок на период. Если их несколько, берётся начавшийся позже. */
function activeSeg(list,ps,pe){
  const a=(list||[]).filter(s=>segActive(s,ps,pe));
  if(!a.length) return null;
  return a.reduce((best,s)=>(!best||((s.from||'')>(best.from||''))?s:best),null);
}

/** Собственник на период. */
function ownerOf(r,ps,pe){
  const s=activeSeg((r.owners||[]).filter(o=>!o.del),ps,pe);
  return s?s.fio:(r.fio||'');
}

/* ================= деление периода между собственниками =================
 * Правила, утверждённые заказчиком 14.09.2026:
 *  · приборы, ОДН, тепло и ЭР делятся ПО ДНЯМ ВЛАДЕНИЯ;
 *  · делитель — фактическое число дней месяца (30 / 31 / 28 / 29);
 *  · день смены засчитывается НОВОМУ собственнику — отрезки складываются
 *    в полный месяц без нахлёста и без пропуска;
 *  · первая часть округляется вверх до копейки, последняя берётся остатком
 *    от целого, чтобы сумма квитанций сошлась с месячной копейка в копейку;
 *  · если показание на дату передачи внесено — объём делится по нему,
 *    оно точнее; нет показания — по дням.
 */
function dayBefore(iso){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }

function dayAfter(iso){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().slice(0,10); }

function dayCount(a,b){ return Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000)+1; }

/** Округление вверх до копейки — для всех долей, кроме последней. */
/** К оплате по квитанции: сумма строк (каждая — до копейки), округлённая вверх до целого тенге (заказчик, 23.09.2026). Сам расчёт — с копейками, как был: ОДН, баланс,
 *  начислено по дому не меняются; округление — только в «к оплате» квитанции. Сумма строк в минусе — переплата: целыми тенге по
 *  правилам математики, 0,50 и больше — вверх (заказчик, 06.10.2026; до этого копейки переплаты отбрасывались). */
function payRound(v){ const x=round2(+v||0); if(x>=0) return Math.ceil(x-1e-9)||0; const k=Math.round(-x*100); return -Math.floor((k+50)/100)||0; }

// вверх до копейки; сумма, которая в копейках целая с точностью до шума float (27,6 × 698 = 19 264,800000000003), — как есть:
// с 02.10.2026 так округляется каждая строка квитанции, и допуск 1e-9 копейки на суммах от ~10 000 ₸ уже меньше шума
function ceil2(n){ const k=n*100, kr=Math.round(k), v=(Math.abs(k-kr)<1e-6?kr:Math.ceil(k))/100; return v===0?0:v; } // v===0 ловит и -0

/** Строки ОДН и ЭК помещения (месяц) или части — готовые строки квитанции из calcRow / periodSplitCalc (вверх до копейки,
 *  02.10.2026); показ их не пересчитывает от объёма. У снимка, закрытого до правила, полей нет — тогда как раньше. */
function odnLines(c,t,kf){ return c&&c.aOdnWs!=null?{ws:c.aOdnWs,wd:c.aOdnWd,e:c.aOdnE,h:c.aOdnH}
  :{ws:c.odnW*t.ws*kf,wd:c.odnW*t.wd*kf,e:c.odnE*t.el*kf,h:c.odnH*t.heat*kf}; }

function ekLines(c,r,t){
  if(c&&c.mop!=null) return c.tl&&c.tl.mop?{mop:c.mop,cap:c.cap,tl:{mop:c.tl.mop,cap:c.tl.cap}}:{mop:c.mop,cap:c.cap};   // tl — по тарифам части (строка на каждый тариф)
  if(c&&c.share!=null){ const mop=ceil2(r.area*t.maintBase*c.share); return {mop,cap:round2(c.er-mop)}; }   // часть из старого снимка
  return {mop:r.area*t.maintBase,cap:r.area*t.capRepair};
}

/** Площадь рядом с суммами отчёта: закрытый месяц — из снимка (как в выгрузке квитанций, invoiceDocs), иначе площадь поменяли
 *  после закрытия — «30,00 м²» стояло рядом с ЭК и Гкал, посчитанными на 27,6 (проверка 05.10.2026). x — calcRowC помещения. */
const areaOf=(r,x)=>isClosed()&&x&&x.area!=null?x.area:r.area;

/**
 * Отрезки владения внутри расчётного периода, нормализованные по дням.
 * Нахлёст снимается принудительно: конец отрезка обрезается днём раньше
 * начала следующего. Это и реализует правило «день смены — новому».
 */
function ownerSlices(r,ps,pe){
  ps=ps||periodStart(); pe=pe||periodEnd();
  const dim=new Date(pe+'T00:00:00Z').getUTCDate();
  const act=(r.owners||[]).filter(s=>!s.del&&segActive(s,ps,pe))
    .sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  if(!act.length) return [{fio:r.fio||'',from:ps,to:pe,days:dim,share:1,seg:null,whole:true}];
  const out=[];
  act.forEach((s,idx)=>{
    const from=(s.from&&s.from>ps)?s.from:ps;
    let to=(s.to&&s.to<pe)?s.to:pe;
    const nx=act[idx+1];
    if(nx){
      const nf=(nx.from&&nx.from>ps)?nx.from:ps;
      const lim=dayBefore(nf);
      if(lim<to) to=lim;
    }
    if(to<from) return;
    out.push({fio:s.fio||'',from,to,seg:s});
  });
  if(!out.length) return [{fio:r.fio||'',from:ps,to:pe,days:dim,share:1,seg:null,whole:true}];
  // без пропущенных дней (04.10.2026, проверка ядра): дни до первого собственника месяца — его, разрыв между владениями —
  // прежнего, после последнего — последнего, как и считает расчёт (periodSegments). Было: первый вступил внутри месяца и в
  // месяце есть ещё смена — его дни уходили последнему, квитанция выходила одна, на последнего
  out[0].from=ps;
  out.forEach((x,i)=>{ x.to=i+1<out.length?dayBefore(out[i+1].from):pe; x.days=dayCount(x.from,x.to); x.share=x.days/dim; x.whole=x.days===dim; });
  return out;
}

/**
 * Договор управления — договор с собственником: продажа закрывает договор прежнего днём до передачи, новый не в
 * управлении, пока не заключит свой (заказчик, 23.09.2026). В базе это делает
 * autoCloseProgOnOwnerChange при правке владения; здесь — то же при расчёте (как rzOwnerCut у разграничения), чтобы
 * договор, переживший смену собственника в данных (импорт, старые записи), не делал нового «в управлении».
 * Возвращает дату смены, которой договор закрыт, или null.
 */
function progOwnerCut(r,p){
  if(!p||!r) return null;
  const own=(r.owners||[]).filter(o=>!o.del).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  for(let i=1;i<own.length;i++){
    const o=own[i]; if(!o.from) continue;
    if(p.from&&p.from>=o.from) continue;              // договор заключён этим собственником или позже
    return (p.to&&p.to<o.from)?null:o.from;           // кончился до смены — резать нечего
  }
  return null;
}

/**
 * Отрезки программы управления в периоде — зеркало ownerSlices: день входа в управление
 * засчитан новому статусу, без нахлёста, пропуски между договорами = «не в управлении».
 * Пока расчёт берёт одну программу на месяц (r.prog — договор, действующий на период);
 * деление по дням — следующий шаг (docs/ПЛАН программы по датам).
 */
function progSlices(r,ps,pe){
  ps=ps||periodStart(); pe=pe||periodEnd();
  const dim=new Date(pe+'T00:00:00Z').getUTCDate();
  const act=(r.progs||[]).filter(p=>!p.del).map(p=>{ const cut=progOwnerCut(r,p); return cut?Object.assign({},p,{to:dayBefore(cut),ownerCut:cut}):p; })
    .filter(p=>segActive(p,ps,pe)).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  const out=[]; let cursor=ps;
  act.forEach((p,idx)=>{
    const from=(p.from&&p.from>ps)?p.from:ps;
    let to=(p.to&&p.to<pe)?p.to:pe;
    const nx=act[idx+1];
    if(nx){ const nf=(nx.from&&nx.from>ps)?nx.from:ps; const lim=dayBefore(nf); if(lim<to) to=lim; }
    if(from>cursor){ const d=dayCount(cursor,dayBefore(from)); out.push({prog:'none',from:cursor,to:dayBefore(from),days:d,share:d/dim,seg:null}); }
    if(to<from) return;
    const days=dayCount(from,to);
    out.push({prog:p.prog,from,to,days,share:days/dim,seg:p});
    cursor=dayAfter(to);
  });
  if(cursor<=pe){ const d=dayCount(cursor,pe); out.push({prog:'none',from:cursor,to:pe,days:d,share:d/dim,seg:null}); }
  return out;
}

/** Дата смены собственника внутри периода (начало второго отрезка) или null. */
function ownerChangeDate(r,ps,pe){
  const sl=ownerSlices(r,ps,pe);
  return sl.length>1?sl[1].from:null;
}

/**
 * Полная разбивка начислений периода по собственникам.
 * Возвращает null, если собственник за период один — тогда всё как раньше.
 * Каждый элемент — готовая строка квитанции: объёмы, суммы, доля, дни.
 */
/**
 * По воде разграничение начинает действовать не с даты договора, а с даты
 * акта опломбировки счётчиков. Пока акт не внесён — по дате договора,
 * а в карточке подсвечивается, что акта нет.
 */
/**
 * По воде разграничение начинает действовать с даты акта опломбировки,
 * а не с даты договора: договор может быть подписан раньше, но пока счётчики
 * не опломбированы, он не работает. Переключатель позволяет сравнить оба варианта.
 */
/**
 * Договор разграничения — договор СОБСТВЕННИКА с поставщиком. Продал помещение — его договор
 * закончился датой смены; у нового собственника разграничения нет, пока он не заключит свой
 * (заказчик, 18.09.2026 про «транзит», 23.09.2026: «почему у Тест Тестовича осталось разграниченным
 * тепло? это же у старого собственника было»).
 *
 * Возвращает дату смены, которой договор закрыт, или null. Считается по данным, а не по тому,
 * нажал ли кто-то кнопку: автозакрытие (`autoCloseRzOnOwnerChange`) срабатывает только на правке
 * дат владения в открытой форме, поэтому у НП1 договор по теплу №30293 (номер есть, даты нет)
 * пережил продажу 12.06.2026 и считался действующим у нового собственника.
 *
 * Правило: первая смена собственника после начала договора закрывает его. Договор без даты начала
 * «был всегда» — значит, заключён первым собственником. Исключения: договор записан на этого
 * собственника (поле «чей») или дату закрытия проверил оператор (`checked` — поставщик закрыл
 * своим числом).
 */
function rzOwnerCut(r,s){
  if(!s||!r) return null;
  if(s.checked&&s.to) return null;
  const nm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  const own=(r.owners||[]).filter(o=>!o.del).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  for(let i=1;i<own.length;i++){
    const o=own[i]; if(!o.from) continue;
    if(s.from&&s.from>=o.from) continue;              // договор заключён этим собственником или позже
    if(s.owner&&o.fio&&nm(s.owner)===nm(o.fio)) continue;  // договор записан на него
    return o.from;
  }
  return null;
}

/**
 * Чей договор разграничения — запись собственника: записан на кого-то (поле «чей») — того; иначе — кто владел в день
 * договора (по воде — дата договора, не акта); без даты — первый («был всегда», как в rzOwnerCut). null — в базе
 * собственников нет.
 */
function rzOwnerOf(r,s){
  const nm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  const own=(r.owners||[]).filter(o=>!o.del).sort((a,b)=>(((a.from||'')<(b.from||''))?-1:1));
  if(!s||!own.length) return null;
  if(s.owner){ const o=own.find(x=>nm(x.fio)===nm(s.owner)); if(o) return o; }
  const cd=('contractFrom' in s)?s.contractFrom:s.from;
  if(!cd) return own[0];
  let o=own[0]; own.forEach(x=>{ if(!x.from||x.from<=cd) o=x; });
  return o;
}

/**
 * Владел ли собственник договора помещением в месяце хоть день (04.10.2026, проверка ядра). Договор прежнего, закрытый
 * поставщиком числом следующего месяца (дата проверена оператором — `checked`), в месяцах, где прежний уже не владеет, не
 * действует: со следующего месяца после продажи новый — в счёт УК, свой договор или по программе (заказчик, 24.09.2026). Было:
 * месяц с датой договора разграничен целиком, доли нет — новый не платил за воду (электро, тепло) целый месяц.
 */
function rzOwnerHere(r,s,ps,pe){
  const o=rzOwnerOf(r,s); if(!o) return true;
  const nm=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();
  return ownerSlices(r,ps,pe).some(x=>nm(x.fio)===nm(o.fio));
}

function rzEffective(s,key,r){
  if(!s) return s;
  let out=s;
  // вода: разграничение начинает действовать с даты акта опломбировки, а не с даты договора
  if(key==='w'&&s.seal) out=Object.assign({},s,{from:s.seal,contractFrom:s.from});
  // смена собственника закрывает договор прежнего — и когда дата закрытия не проставлена в базе
  const cut=rzOwnerCut(r,s);
  if(cut){
    const lim=dayBefore(cut);
    if(!out.to||out.to>lim) out=Object.assign({},out,{to:lim,autoClosed:out.autoClosed||cut,ownerCut:cut});
  }
  return out;
}

/** Дата самого договора разграничения (не акта): по воде действующая запись (rzEffective) несёт дату акта в from, а дату договора —
 *  в contractFrom; договор по воде без даты, но с актом — даты договора нет (заказчик, 06.10.2026), дата акта её не подменяет. */
const rzDate=s=>s?(('contractFrom' in s)?s.contractFrom:s.from)||null:null;

function rzList(r,key){ return ((r.rz||{})[key]||[]).filter(s=>!s.del).map(s=>rzEffective(s,key,r)); }   // помеченные на удаление — мимо

function rzSeg(r,key){
  // из договоров месяца — применимый (rzApplies): договор нового собственника без акта или без реквизитов не должен
  // заслонять действующий договор прежнего в месяце продажи; применимого нет — самый поздний, для подписей
  const list=rzList(r,key), ps=periodStart(), pe=periodEnd();
  return activeSeg(list.filter(s=>rzApplies(s,key)&&rzOwnerHere(r,s,ps,pe)),ps,pe)||activeSeg(list,ps,pe);
}

/* ===================== счета-фактуры поставщиков =====================
 * Объём и сумма стоят рядом и пересчитываются друг из друга по тарифу позиции: ввели объём —
 * видно сумму, ввели сумму из счёта — видно объём. Это для сверки с бумагой (заказчик, 22.09.2026).
 * Если внутри месяца менялся тариф, в счёте-фактуре две позиции — стенд показывает две строки
 * с датами, объём месяца = их сумма.
 * Пересчитывается только то поле пары, которое оператор не вводил, и только в ответ на ввод (заказчик, 05.10.2026): перерисовка, смена месяца, импорт ЭСФ, правка
 * тарифа сумму и объём не трогают — сохранённые и пришедшие из файла числа остаются как есть (до 05.10.2026 каждая
 * перерисовка писала в сумму объём × тариф: тепло июля из ЭСФ 40 446,41 становилось 40 446,42). Так же — поле суммы в
 * «Настройки месяца» (drawBal → sfChanged).
 */
const SF_RES={w:{lab:'Су-Арнасы, вода',unit:'м³',dec:3,svc:'water_supply',hint:'объём по счёту-фактуре, уже без разграниченных'},
              e:{lab:'АРЭК, электро',unit:'кВт·ч',dec:2,svc:'electricity',hint:'объём по счёту-фактуре, уже без разграниченных'},
              h:{lab:'Теплотранзит, тепло',unit:'Гкал',dec:4,svc:'heating',hint:'по ЭСФ'}};

/** Тариф услуги с НДС на конкретный день месяца. */
function tarOnDay(svc,day){
  const t=tarObjs().filter(x=>x.service===svc&&activeOn(x,day));
  return t.length?tariffWithVat(t[t.length-1]):0;
}

/** Отрезки месяца по смене тарифа: [{from,to,tar}] — для воды тариф = водоснабжение + водоотведение. */
function sfSegs(key){
  const per=el('f-per').value, r=SF_RES[key];
  const [y,m]=per.split('-').map(Number), dim=new Date(Date.UTC(y,m,0)).getUTCDate();   // daysInMonth ждёт Date, тут проще по числу месяца
  let sg=[]; try{ sg=splitMonthByTariff(tarObjs(),RESOF[r.svc],r.svc,D(per+'-01')); }catch(e){ sg=[]; }
  if(!sg.length) return [{from:1,to:dim,tar:0}];
  const out=[]; let d0=1;
  sg.forEach(g=>{ const from=d0, to=Math.min(dim,d0+g.days-1); d0=to+1;
    const day=new Date(Date.UTC(y,m-1,from));
    const tar=key==='w'? g.value+tarOnDay('water_drainage',day) : g.value;
    out.push({from,to,tar}); });
  return out;
}

const sfId=(key,i)=>(key==='h'?'f-heat':'f-in-'+key)+(i?String(i+1):'');

/** Сумма объёмов всех позиций счёта-фактуры по ресурсу — её и использует расчёт. */
function sfTotal(key){
  let v=0; sfSegs(key).forEach((g,i)=>{ const e=el(sfId(key,i)); if(e&&String(e.value).trim()!=='') v+=pnum(e.value); });
  return v;
}

/* ===================== статусная строка ===================== */
const MON=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function perLabel(per){ const [y,m]=(per||'').split('-').map(Number); return m?`${MON[m-1]} ${y}`:per; }

const DIFF_FIELDS=['water','eB','heatVol','odnW','odnE','odnH','aWs','aWd','aE','aH','odnAmt','total','er'];

/** Разница «стало − было» по строкам помещения (DIFF_FIELDS): вода — 3 знака, тепло и ОДН тепла — 4, остальное — 2. Одна для «≠ снимка»,
 *  расклада корректировки и записи корректировки на сервере (server/periods.js). */
function fieldDelta(base,live){ const d={}; DIFF_FIELDS.forEach(k=>{ d[k]=+((+live[k]||0)-(+base[k]||0)).toFixed(k==='water'?3:(k==='heatVol'||k==='odnH')?4:2); }); return d; }

/** Изменение заметно: вода от 0,0005 м³, тепло и ОДН тепла от 0,00005 Гкал, остальное от 0,005. */
const deltaAny=d=>DIFF_FIELDS.some(k=>Math.abs(d[k])>=(k==='water'?0.0005:(k==='heatVol'||k==='odnH')?0.00005:0.005));

/** Перенос корректировки закрытого месяца в ОДН первого открытого (заказчик, 20.09.2026): изменение объёма «в счёт УК» + изменение
 *  ОДН помещения — по воде, электроэнергии и теплу. Тепло — только в остаток ОДН тепла (06.10.2026). */
function carryFromDelta(d){ return {water:+(d.water+d.odnW).toFixed(3),e:+(d.eB+d.odnE).toFixed(2),heat:+(d.heatVol+d.odnH).toFixed(4)}; }

const eqv=(a,b)=>String(a==null?'':a)===String(b==null?'':b);

/** Как поделён месяц: части, их собственники, плательщики и даты. Смена собственника задним числом без разграниченных
 *  приборов или смена программы суммы месяца могут не менять, а квитанций становится две и получатели другие. */
const partsSig=c=>((c&&c.split&&c.split.parts)||[]).map(p=>[p.fio||'',p.payer||'',p.from||'',p.to||''].join('|')).join(';')+'#'+((c&&c.payer)||'');

/** Приборы, у которых изменились показания или объём в счёт УК, против снимка (или последней корректировки). Одна проверка
 *  для «≠ снимка» (unitDiff) и формы корректировки (adjPreview): иначе метка оставалась, а форма писала «разницы нет»
 *  (проверка 05.10.2026, НП1: показание разграниченного прибора — деньги УК те же). */
function meterDiffs(base,live){
  const sm={}; (base.det||[]).forEach(x=>{ sm[x.m.id]=x; });
  return (live.det||[]).filter(x=>{ const s=sm[x.m.id]; return !s||!eqv(s.rd.prev,x.rd.prev)||!eqv(s.rd.cur,x.rd.cur)||Math.abs((s.iv?s.iv.billed:0)-(x.iv?x.iv.billed:0))>1e-6; }).map(x=>x.m.id);
}

/** Живой пересчёт помещения в замороженном контексте против снимка (или последней корректировки). null — расхождений нет. */
function unitDiff(r){
  if(!isClosed()) return null;
  const snap=CLOSED.units[r.n]; if(!snap) return null;
  const adjs=ADJ.filter(a=>a.unit===r.n), base=adjs.length?adjs[adjs.length-1].after:snap;
  const live=calcRow(r,CTX);
  const d=fieldDelta(base,live); let any=deltaAny(d);
  const meters=meterDiffs(base,live);
  if(meters.length) any=true;
  const parts=partsSig(live)!==partsSig(base); if(parts) any=true;   // квитанции делятся иначе
  return any?{live,base,delta:d,meters,parts}:null;
}

/** Помещение для снимка: результат calcRow как есть, без служебных полей приборов; коды квитанций. sepN — сколько в месяце
 *  отдельных квитанций прежнего собственника (invSlots): они первые (/1 …), номера частей месяца — после них. */
function snapshotUnit(r,c,per,ps,pe,sepN){
  const u=JSON.parse(JSON.stringify(c,(k,v)=>(k==='hist'||k==='owners'||k==='progs'||k==='log')?undefined:v));
  u.n=r.n; u.area=r.area; u.inodn=r.inodn!==false; u.fio=ownerOf(r,ps,pe)||''; u.prog=r.prog; u.cno=r.cno||''; u.cdt=r.cdt||'';
  const parts=(u.split&&u.split.parts)||[], m=sepN||0, sx=i=>parts.length+m>1?'/'+(i+1+m):'';
  parts.forEach((p,i)=>{ p.code=`КВ-${r.n}-${per}${sx(i)}`; p.codeEr=`ЭК-${r.n}-${per}${sx(i)}`; });
  return u;
}

function buildSnapshot(checklist){
  const per=el('f-per').value, ps=periodStart(), pe=periodEnd(), ctx=CTX||buildCtx();
  const units={}, tot={accrued:0,er:0,odnAmt:0,byPayer:{uk:0,deduction:0,owner:0},units:0,invoices:0,direct:{w:0,e:0,h:0}}, credits=[];
  ROWS.forEach(r=>{ const c=calcRowC(r,ctx), S=invSlots(r,c,per); units[r.n]=snapshotUnit(r,c,per,ps,pe,S.sepN);
    // строки «Перерасчёт за …» (способ Б), пришедшие в этот месяц, — часть его квитанций: в снимок, иначе после закрытия пропадут;
    // строка в отдельной квитанции прежнего собственника (invSlots, заказчик 05.10.2026) — с пометкой sep: после закрытия она там же
    const sp=l=>S.isSep(l)?Object.assign({},l,{sep:true}):l;
    const rl=S.rec.map(sp); if(rl.length) units[r.n].recalc=rl;
    const ol=S.offs.map(sp); if(ol.length) units[r.n].offsets=ol;   // зачёты переплаты — тоже часть квитанций месяца
    // квитанции собственника в минусе — его переплата (сервер хранит в снимке: closed.credits)
    receiptsOf(r,c,per).filter(x=>x.payer==='owner'&&x.pay<0).forEach(x=>credits.push({unit:r.n,fio:x.fio,code:x.code,type:x.type,amount:-x.pay}));
    tot.accrued+=c.total; tot.er+=c.er; tot.odnAmt+=c.odnAmt; tot.units++; tot.invoices+=S.sepN;
    ((c.split&&c.split.parts)||[]).forEach(p=>{ tot.byPayer[p.payer]=(tot.byPayer[p.payer]||0)+p.total; tot.invoices++; });
    (c.det||[]).forEach(d=>{ if(d.iv) tot.direct[d.m.res==='ee'?'e':'w']+=d.iv.other||0; });
    if(c.heat) tot.direct.h+=c.heat.ivs.filter(x=>x.direct).reduce((s,x)=>s+x.vol,0); });
  ['accrued','er','odnAmt'].forEach(k=>tot[k]=round2(tot[k])); Object.keys(tot.byPayer).forEach(k=>tot.byPayer[k]=round2(tot.byPayer[k]));
  // суммы счетов-фактур — итог всех позиций, как объёмы (sfTotal): раньше в снимок шла сумма только первой позиции при объёме
  // обеих (проверка денег 04.10.2026); позиции по отдельности — sfPositions
  const amtSum=(...ids)=>{ const has=ids.filter(x=>el(x)&&String(el(x).value).trim()!==''); return has.length?round2(has.reduce((s,x)=>s+gv(x),0)):null; };
  const sfPos=k=>sfSegs(k).map((g,i)=>({from:g.from||null,to:g.to||null,vol:el(sfId(k,i))&&String(el(sfId(k,i)).value).trim()!==''?pnum(el(sfId(k,i)).value):null}));
  const inputs={inW:sfTotal('w'),inE:sfTotal('e'),inWAmt:amtSum('f-in-w-amt','f-in-w2-amt'),inEAmt:amtSum('f-in-e-amt','f-in-e2-amt'),heatAmt:amtSum('f-heat-amt','f-heat2-amt'),
    sfPositions:{w:sfPos('w'),e:sfPos('e'),h:sfPos('h'),amt:{w:[amtSum('f-in-w-amt'),amtSum('f-in-w2-amt')],e:[amtSum('f-in-e-amt'),amtSum('f-in-e2-amt')],h:[amtSum('f-heat-amt'),amtSum('f-heat2-amt')]}},heatGcal:sfTotal('h'),ukW:gv('f-uk-w'),ukE:gv('f-uk-e'),ek:gv('f-ek'),
    // тепло (05.10.2026): нужды ЭК по теплу, Гкал, и общая площадь здания — та, что взял расчёт (пусто — по умолчанию)
    ukH:gv('f-uk-h'),bldArea:ctx.bldArea,
    applyRz:gc('f-rz'),ukPays:gc('f-uk'),sealFrom:true,
    external:EXT.map(x=>Object.assign({n:x.n,res:x.res,c:x.c,on:x.on?1:0},extFlag(x))),
    tariffs:Object.assign({},ctx.t),
    tariffRows:TAR.filter(x=>x.from<=pe&&(!x.to||x.to>=ps)).map(x=>({svc:x.svc,base:pnum(x.base),vat:pnum(x.vat),from:x.from,to:x.to||null}))};
  const cx={t:Object.assign({},ctx.t)};
  // тепло дома (05.10.2026): по этим полям закрытый месяц показывает цепочку «ТЕПЛО»; снимок без них — закрыт до правки
  ['sumW','sumE','inW','inE','ukW','ukE','odnW','odnE','nOdn','areaOdn','odnPerUnitW','odnPerAreaE','areaHeatBase','heatUsed','heatGcal','kOt','kOdn','extW','extE','carryW','carryE','carryH','odnAmtTot','ek','ekFactor',
   'ukH','bldArea','areaHeatRz','nHeatRz','nHeatFree','heatBaseArea','heatRest','heatBaseBad','heatRestNeg'].forEach(k=>{ cx[k]=ctx[k]; });
  return {period:per,engineVersion:ENGINE_VERSION,checklist,inputs,ctx:cx,totals:tot,units,credits};
}

// tl — строки по тарифам части (строка на каждый тариф, 05.10.2026): корректировочная квитанция выводит их так же, как обычная
const pickLines=p=>Object.assign({water:p.water,eB:p.eB,heatVol:p.heatVol,odnW:p.odnW,odnE:p.odnE,odnH:p.odnH,aWs:p.aWs,aWd:p.aWd,aE:p.aE,aH:p.aH,aOdnWs:p.aOdnWs,aOdnWd:p.aOdnWd,aOdnE:p.aOdnE,aOdnH:p.aOdnH,odnAmt:p.odnAmt,total:p.total,er:p.er,hand:p.hand||null},
  p.tl?{tl:{ws:p.tl.ws,wd:p.tl.wd,el:p.tl.el,odnWs:p.tl.odnWs,odnWd:p.tl.odnWd,odnE:p.tl.odnE,hWs:p.tl.hWs,hWd:p.tl.hWd,hE:p.tl.hE}}:{});

/**
 * Вид первой (коммунальной) квитанции по словарю заказчика (21.09.2026): «полностью» — разграничения нет;
 * «только с ОДН» — все ресурсы у поставщика; «ОДН + не разграниченные» — разграничена часть ресурсов.
 * Плательщик: собственник / УК (комната в управлении) / из доли (долевая программа).
 */
function kvKind(c,part){
  const ivsOf=d=>part?d.iv.ivs.filter(x=>x.from>=part.from&&x.to<=part.to):d.iv.ivs;
  const res=[]; // ресурсы с начислением: {lab, direct: весь ресурс у поставщика, uk: есть строка в квитанции}
  const w=(c.det||[]).filter(d=>d.iv&&d.m.res!=='ee'), e=(c.det||[]).filter(d=>d.iv&&d.m.res==='ee');
  // ресурс из нескольких приборов может быть разграничен частично (НП3: один электросчётчик у АРЭК, второй в счёт УК)
  // доля счёта поставщика (hand, не спит) — строка в квитанции через УК, а не «у поставщика»
  const isHand=x=>x.hand&&!x.sleeping, isDir=x=>x.direct&&!isHand(x);
  const st=ivs=>({direct:ivs.length>0&&ivs.every(isDir), any:ivs.some(isDir), uk:ivs.some(x=>!x.direct), hand:ivs.some(isHand)});
  if(w.length){ const x=st(w.flatMap(ivsOf)); res.push(Object.assign({lab:'вода'},x)); }
  if(e.length){ const x=st(e.flatMap(ivsOf)); res.push(Object.assign({lab:'электро'},x)); }
  if(c.heat&&c.heat.ivs.length){ const iv=part?c.heat.ivs.filter(x=>x.from>=part.from&&x.to<=part.to):c.heat.ivs; res.push(Object.assign({lab:'тепло'},st(iv))); }
  const dir=res.filter(x=>x.any).map(x=>({lab:x.lab+(x.direct?'':' (частично)')})), uk=res.filter(x=>x.uk).map(x=>({lab:x.lab+(x.any?' (частично)':'')})), hand=res.filter(x=>x.hand).map(x=>({lab:x.lab}));
  const kind=(!dir.length&&!hand.length)?'full':(!uk.length&&!hand.length)?'odn':'mixed';
  const plus=uk.map(x=>x.lab).concat(hand.length?[`доля счёта поставщика (${hand.map(x=>x.lab).join(', ')})`]:[]);
  const title=kind==='full'?'Квитанция УК полностью':kind==='odn'?'Квитанция УК только с ОДН':`Квитанция УК: ОДН + ${plus.join(', ')}`;
  const payer=part?part.payer:c.payer;
  const who=payer==='uk'?'платит УК — комната в управлении':payer==='deduction'?'удерживается из доли собственника':'платит собственник';
  let sup=dir.length?(payer==='uk'?`счета поставщиков (${dir.map(x=>x.lab).join(', ')}) оплачивает УК за собственника`:payer==='deduction'?`счета поставщиков (${dir.map(x=>x.lab).join(', ')}) оплачивает УК по реестру и удерживает из доли собственника`:`${dir.map(x=>x.lab).join(', ')} — собственник платит напрямую поставщику`):'';
  if(hand.length) sup+=(sup?'; ':'')+`${hand.map(x=>x.lab).join(', ')} — доля счёта поставщика за дни нового собственника по договору прежнего, выставляется через УК`;
  return {kind,title,who,sup,dir:dir.map(x=>x.lab),uk:uk.map(x=>x.lab),hand:hand.map(x=>x.lab),payer};
}

/** Строки эксплуатационной квитанции — названия ровно как в образце заказчика (21.09.2026). */
const EK_LINES={mop:'Техническое обслуживание МОП (м2)',cap:'Взносы на капитальный ремонт'};

/** Подпись причины по полям — как на сервере (causeLabel). */
/** doc — текст для квитанции и выгрузки в кабинет: без ФИО (чек-лист 10.7 и 11.12, 03.10.2026: «смена собственника …: ФИО» попадало в
 *  строку перерасчёта квитанции нового собственника, в корректировочную квитанцию продавца и в выгрузку). */
function causeText(cause,text,doc){
  const RES={w:'воде',e:'электро',h:'теплу'}; let t='';
  if(cause&&cause.kind==='contract') t=`разграничение по ${RES[cause.res]||cause.res}, договор №${cause.no||'б/н'}${cause.from?' с '+fdt(cause.from):''}${cause.seal?', акт '+(cause.sealNo?'№'+cause.sealNo+' ':'')+'от '+fdt(cause.seal):''}`;
  else if(cause&&cause.kind==='reading') t=`показание ${cause.meter||''}: ${cause.was==null?'—':fRd(cause.was)} → ${cause.now==null?'удалено':fRd(cause.now)}`;
  else if(cause&&cause.kind==='owner') t=doc?`смена собственника с ${cause.date?fdt(cause.date):''}`:`смена собственника ${cause.date?fdt(cause.date):''}: ${cause.fio||''}`;
  else if(cause&&cause.kind==='amount') t=`корректировка суммы ${cause.target==='EK'?'ЭК':'КУ'}: ${cause.amount>0?'+':''}${f0(cause.amount)} ₸`;
  return [t,text].filter(Boolean).join(' — ');
}

/** Строки перерасчёта (способ Б) для квитанций месяца: одна на группу корректировок и счёт квитанции («собственник +
 *  плательщик», КУ или ЭК; 04.10.2026), помесячные — в отчёте. */
function groupRecalcLines(adjs){
  const g={};
  adjs.forEach(a=>(a.invoices||[]).filter(x=>x.kind==='next-period').forEach(x=>{
    const tg=x.target==='EK'?'EK':'KU', key=(a.group||a.id)+'|'+acctKey(x.fio,x.payer)+'|'+tg;
    const e=g[key]=g[key]||{adj:a.group||a.id,fio:x.fio,payer:x.payer||null,target:tg,amount:0,periods:new Set(),cause:a.cause,text:a.text,reason:a.reason,ownFrom:x.ownFrom};
    e.amount=round2(e.amount+(+x.amount||0)); e.periods.add(a.period);
  }));
  return Object.values(g).map(e=>({adj:e.adj,fio:e.fio,payer:e.payer,target:e.target,amount:e.amount,...(e.ownFrom!==undefined?{ownFrom:e.ownFrom}:{}),
    line:`Перерасчёт${e.target==='EK'?' ЭК':''} за ${perRange([...e.periods])} — ${e.cause?causeText(e.cause,e.text,true):e.reason}`}));
}

/** Счёт квитанции — «собственник + плательщик» (заказчик, 04.10.2026: разницу корректировки считать по каждому плательщику). */
const acctKey=(fio,payer)=>(fio||'—')+'|'+(payer||'owner');

/** Части месяца помещения (квитанции); у старого снимка без частей — одна. */
function unitParts(u){
  if(!(u&&u.split&&u.split.parts&&u.split.parts.length)){ u.split=Object.assign({},u.split||{},{parts:[{fio:u.fio||'—',payer:u.payer||'owner',total:u.total,er:u.er,from:null,to:null,days:null,share:1}]}); }
  return u.split.parts;
}

/** Счета квитанций месяца: «собственник + плательщик» → номера частей и к оплате КУ и ЭК целыми тенге. */
function acctMap(u){ const m={}; unitParts(u).forEach((p,i)=>{ const k=acctKey(p.fio,p.payer); const e=m[k]||(m[k]={key:k,fio:p.fio||'—',payer:p.payer||'owner',parts:[],ku:0,ek:0}); e.parts.push(i); e.ku+=payRound(p.total); e.ek+=payRound(p.er); }); return m; }

/** Разница по счетам: «было» — снимок (или прошлая корректировка), «стало» — пересчёт; к оплате целыми тенге. */
function acctDelta(base,after){
  const A=acctMap(base), B=acctMap(after);
  return [...new Set([...Object.keys(A),...Object.keys(B)])].map(k=>{ const a=A[k]||{ku:0,ek:0,parts:[]}, b=B[k]||{ku:0,ek:0,parts:[]}, x=B[k]||A[k];
    return {key:k,fio:x.fio,payer:x.payer,bParts:a.parts,aParts:b.parts,ku:{b:a.ku,a:b.ku,d:b.ku-a.ku},ek:{b:a.ek,a:b.ek,d:b.ek-a.ek}}; });
}

/** Строки «Зачёт переплаты» помещения за месяц: открытый — из таблицы зачётов, закрытый — из снимка. */
function offsetLinesOf(r,c,per){
  if(isClosed()) return (c&&c.offsets)||[];
  return OFFSETS.filter(o=>o.unit===r.n&&o.period===per&&(o.type==='KU'||o.type==='EK')).map(o=>({id:o.id,fio:o.fio,payer:'owner',target:o.type==='EK'?'EK':'KU',amount:-Math.abs(+o.amount||0),...(o.ownFrom!==undefined?{ownFrom:o.ownFrom}:{}),
    line:`Зачёт переплаты${o.note?' — '+o.note:''}`}));
}

/**
 * Квитанции помещения за месяц: части месяца и отдельная квитанция прежнего собственника — только с его строками «Перерасчёт
 * за …» / «Зачёт переплаты» (заказчик, 05.10.2026; правило 46д). Прежний: собственника строки нет среди частей месяца (ни дня
 * владения), а среди собственников помещения он есть — исправленное ФИО не прежний, строка, как раньше, в последнюю часть;
 * закрытый месяц — строки снимка с пометкой sep (её ставит buildSnapshot). Отдельная квитанция — на счёт строки (собственник +
 * плательщик). Номера — как при продаже внутри месяца: сначала прежний (/1), потом части месяца (/2 …). Продажа внутри месяца
 * (у прежнего есть дни) — строка в его части, как было.
 * slots — отдельные квитанции ({fio, payer, sep:true}) и части месяца; idx(строка) — номер квитанции, куда строка идёт.
 */
function invSlots(r,c,per){
  const parts=unitParts(c), split=parts.length>1?c.split:null;
  const rec=isClosed()?((c&&c.recalc)||[]):groupRecalcLines(CARRIES.filter(a=>a.unit===r.n)), offs=offsetLinesOf(r,c,per);
  // ФИО строки — нынешнее ФИО её собственника (lineFio, 06.10.2026: исправленное написание не уводит строку новому); закрытый
  // месяц — как в снимке
  const LF=l=>isClosed()?l.fio:lineFio(r,l);
  const isSep=isClosed()?(l=>!!l.sep):(l=>!parts.some(p=>ownKey(p.fio)===ownKey(LF(l)))&&(r.owners||[]).some(o=>!o.del&&ownKey(o.fio)===ownKey(LF(l))));
  const sep=[];
  [...rec,...offs].forEach(l=>{ if(!isSep(l)) return; const k=acctKey(LF(l),l.payer); if(!sep.some(s=>s.key===k)) sep.push({key:k,fio:LF(l)||'—',payer:l.payer||'owner',sep:true}); });
  const idx=l=>isSep(l)?sep.findIndex(s=>s.key===acctKey(LF(l),l.payer)):sep.length+(split?recalcPartIdx(split,LF(l),l.payer):0);
  return {slots:[...sep,...parts],sepN:sep.length,parts,split,rec,offs,idx,isSep};
}

/** Квитанции помещения за месяц с к оплате: строки расчёта + перерасчёт + зачёт; pay < 0 — переплата. Для переплаты,
 *  пульта, чек-листа и снимка (credits). Отдельная квитанция прежнего собственника (invSlots) — только его строки, КУ и ЭК —
 *  только та, где они есть. */
function receiptsOf(r,c,per){
  const S=invSlots(r,c,per), many=S.slots.length>1, sum=a=>a.reduce((q,x)=>q+(+x.amount||0),0);
  const out=[];
  S.slots.forEach((p,i)=>{ const sfx=many?'/'+(i+1):'', inP=x=>S.idx(x)===i;
    const rk=S.rec.filter(x=>x.target!=='EK'&&inP(x)), ok=S.offs.filter(o=>o.target==='KU'&&inP(o)), re=S.rec.filter(x=>x.target==='EK'&&inP(x)), oe=S.offs.filter(o=>o.target==='EK'&&inP(o));
    const ku=round2((p.sep?0:(+p.total||0))+sum(rk)+sum(ok)), ek=round2((p.sep?0:(+p.er||0))+sum(re)+sum(oe));
    if(!p.sep||rk.length||ok.length) out.push({fio:p.fio||'—',payer:p.payer||c.payer||'owner',part:i,code:`КВ-${r.n}-${per}${sfx}`,type:'KU',lines:ku,pay:payRound(ku)});
    if(!p.sep||re.length||oe.length) out.push({fio:p.fio||'—',payer:p.payer||c.payer||'owner',part:i,code:`ЭК-${r.n}-${per}${sfx}`,type:'EK',lines:ek,pay:payRound(ek)});
  });
  return out;
}

/**
 * Переплата собственников помещения (заказчик, 03.10.2026): начислено — квитанции собственника в минусе на закрытии месяца и
 * корректировочные «к зачёту»; «будет» — квитанция открытого месяца в минусе (месяц ещё не закрыт); зачтено — по кнопке
 * «Зачесть переплату…». Остаток = начислено + будет − зачтено. Сама никуда не зачитывается.
 */
/** Ключ собственника для учёта переплаты: пробелы и регистр не важны (в базе бывает «… Жанабыловна » с пробелом на конце —
 *  квитанция и переплата берут ФИО как есть, а возврат с обрезкой распался бы на двух «разных» людей; 04.10.2026). */
const ownKey=x=>String(x||'').replace(/\s+/g,' ').trim().toLowerCase();

function overpayOf(r){
  const m={}, at=f=>{ const k=ownKey(f); return m[k]||(m[k]={fio:f,credit:0,pending:0,used:0,refunded:0,items:[],refunds:[]}); };
  CREDITS.filter(x=>x.unit===r.n).forEach(x=>{ const e=at(x.fio); e.credit+=+x.amount||0; e.items.push(x); });
  // зачтено в квитанции (KU / EK) и возвращено деньгами (REFUND, заказчик, 04.10.2026) — отдельно
  OFFSETS.filter(o=>o.unit===r.n).forEach(o=>{ const e=at(o.fio); if(o.type==='REFUND'){ e.refunded+=+o.amount||0; e.refunds.push(o); }
    else e.used+=+o.amount||0; });
  if(!isClosed()&&CTX){ const per=el('f-per').value;
    try{ receiptsOf(r,calcRowC(r,CTX),per).filter(x=>x.payer==='owner'&&x.pay<0).forEach(x=>{ const e=at(x.fio); e.pending+=-x.pay; e.items.push({period:per,code:x.code,type:x.type,amount:-x.pay,pending:true}); }); }catch(e){} }
  // refundable — сколько можно вернуть деньгами: переплата закрытых месяцев (как считает сервер); «будет» — после закрытия
  return Object.values(m).map(e=>Object.assign(e,{balance:e.credit+e.pending-e.used-e.refunded,refundable:Math.max(0,e.credit-e.used-e.refunded)}))
    .filter(e=>e.credit||e.pending||e.used||e.refunded);
}

/**
 * Где стоят строки «Перерасчёт за …» и «Зачёт переплаты» закрытого месяца после каждой его корректировки — правило 46д
 * (заказчик, 05.10.2026): строка принадлежит счёту квитанции «собственник + плательщик», которому выставлена, и идёт за своим
 * собственником:
 *  – продажа внутри месяца, исправленная задним числом: у прежнего остаётся квитанция за его дни — строка в ней, новому не идёт;
 *  – собственник тот же, сменился только плательщик (договор управления с 1-го числа): строка — в квитанции того же собственника
 *    с другим плательщиком, «платит УК»;
 *  – собственника в месяце больше нет (смена с 1-го числа): строка остаётся в его аннулирующей квитанции (прежнему возможен
 *    возврат наличными).
 * S — помещение в снимке месяца (строки recalc, offsets), chain — «стало» корректировок помещения по порядку. Для каждой строки
 * pos[k] — где она после k-й корректировки (0 — снимок): {key, fio, payer, part}; part — номер части или null (квитанций у
 * собственника строки нет: аннулирующая или отдельная квитанция прежнего, sep). В снимке — та квитанция, где строка стоит
 * (recalcPartIdx, как в квитанции и выгрузке); дальше — квитанция того же счёта (собственник и плательщик квитанции снимка), нет —
 * последняя квитанция того же собственника с другим плательщиком, нет и такой — без части: остаётся, где была. kind — recalc /
 * offset (код строки в выгрузке).
 */
function linesPath(S,chain){
  const ps=unitParts(S), split=ps.length>1?S.split:null, at=(fio,payer,part)=>({key:acctKey(fio,payer),fio,payer,part});
  return [...((S&&S.recalc)||[]).map(l=>({l,kind:'recalc'})),...((S&&S.offsets)||[]).map(l=>({l,kind:'offset'}))].map(e=>{
    const l=e.l, i=l.sep?-1:recalcPartIdx(split,l.fio,l.payer), p0=ps[i];
    const o=p0?at(p0.fio||'—',p0.payer||'owner',i):at(l.fio||'—',l.payer||'owner',null), f=ownKey(o.fio);
    e.pos=[o];
    (chain||[]).forEach(U=>{ const prev=e.pos[e.pos.length-1], up=unitParts(U); let j=-1;
      for(let q=up.length-1;q>=0;q--) if(ownKey(up[q].fio)===f&&(up[q].payer||'owner')===o.payer){ j=q; break; }
      if(j<0) for(let q=up.length-1;q>=0;q--) if(ownKey(up[q].fio)===f){ j=q; break; }
      e.pos.push(j<0?at(prev.fio,prev.payer,null):at(up[j].fio||'—',up[j].payer||'owner',j)); });
    return e;
  });
}

/** Строки снимка (linesPath), которые стоят в корректировочной квитанции inv k-й корректировки: счёт квитанции, её часть;
 *  аннулирующая — строки, у собственника которых в месяце квитанций больше нет. */
function linesIn(LP,k,inv){
  const T=inv.target==='EK'?'EK':'KU', key=acctKey(inv.fio,inv.payer);
  return (LP||[]).filter(e=>{ const p=e.pos[k]; if(!p||(e.l.target==='EK')!==(T==='EK')||p.key!==key) return false;
    return inv.annul?p.part==null:(p.part!=null&&(inv.part==null||p.part===inv.part)); });
}

/** Отдельные квитанции прежнего собственника в снимке месяца (invSlots): счета строк с пометкой sep по порядку строк — /1, /2 … */
function sepAcctsOf(S){
  const out=[]; [...((S&&S.recalc)||[]),...((S&&S.offsets)||[])].forEach(l=>{ if(!l.sep) return; const k=acctKey(l.fio,l.payer); if(!out.some(s=>s.key===k)) out.push({key:k,fio:l.fio||'—',payer:l.payer||'owner',sep:true}); });
  return out;
}

/** Сколько отдельных квитанций прежнего собственника (sepAcctsOf) остаётся при частях месяца U — у их собственника в U нет ни
 *  дня: номера квитанций месяца за дни — после них (/2 …). */
function sepLeft(S,U){ const up=unitParts(U); return sepAcctsOf(S).filter(s=>!up.some(p=>ownKey(p.fio)===ownKey(s.fio))).length; }

/**
 * Корректировочные квитанции счёта a (собственник + плательщик) за месяц x, квитанция T (KU / ЭК): по одной на каждую часть
 * счёта «после»; счёта «после» нет (другой плательщик, другой собственник) — аннулирующая «к зачёту». settle — разница к оплате
 * счёта целыми тенге (на первой квитанции счёта), was — к оплате «было».
 */
function correctiveInvFor(r,x,after,a,T,t){
  const aParts=unitParts(after), bParts=unitParts(x.base), pf=T==='EK'?'ЭК':'КВ';
  const snapU=x.snap&&x.snap.units?x.snap.units[r.n]:null;
  // КВ-5017-2026-07/К1, при частях /2К1; отдельные квитанции прежнего собственника месяца (sepLeft) — первыми, номера частей после них
  const codeOf=(i,n,m)=>`${pf}-${r.n}-${x.period}/${n+m>1?(i+1+m):''}К?`;
  // строки «Перерасчёт за …» и «Зачёт переплаты» снимка месяца — по счёту квитанции, где стоят (правило 46д, linesPath): к оплате
  // «было» — со строками, что стояли в заменяемых квитанциях счёта, «стало» — со строками, что встают в его новые; квитанция в
  // минусе — переплата: доплата сначала уменьшает её, а не просит денег (04.10.2026). Продажа внутри месяца — строки прежнего
  // новому не идут; сменился только плательщик — строки уходят в квитанцию «платит УК»; собственника в месяце больше нет —
  // остаются в его аннулирующей (заказчик, 05.10.2026)
  const chain=x.chain||[], LP=snapU?linesPath(snapU,[...chain,after]):[], kB=chain.length;
  const rsAt=k=>round2(LP.filter(e=>(e.l.target==='EK')===(T==='EK')&&e.pos[k].key===a.key).reduce((q,e)=>q+(+e.l.amount||0),0));
  const rsOld=rsAt(kB), rsNew=rsAt(kB+1);
  const own=(u,idx)=>idx.reduce((q,i)=>q+(+(T==='EK'?unitParts(u)[i].er:unitParts(u)[i].total)||0),0);
  const pOld=payRound(own(x.base,a.bParts)+rsOld), pNew=payRound(own(after,a.aParts)+rsNew);
  const P=v=>Math.max(0,v), M=v=>Math.max(0,-v);
  const was=pOld, d=P(pNew)-P(pOld), credit=M(pNew)-M(pOld);   // d — к доплате (+) / к зачёту деньгами (−); credit — изменение переплаты по квитанции
  const repl=a.bParts.map(i=>T==='EK'?bParts[i].codeEr:bParts[i].code).filter(Boolean);
  // счёт — отдельная квитанция прежнего собственника в снимке (квитанций за дни месяца у него не было): новая заменяет её
  if(!a.bParts.length&&!chain.length&&snapU){ const j=sepAcctsOf(snapU).findIndex(s=>s.key===a.key);
    if(j>=0&&LP.some(e=>e.l.sep&&e.pos[0].key===a.key&&(e.l.target==='EK')===(T==='EK'))) repl.push(`${pf}-${r.n}-${x.period}/${j+1}`); }
  const mA=snapU?sepLeft(snapU,after):0, mB=snapU?sepLeft(snapU,x.base):0;
  const man=(after.manual||[]).filter(m=>m.key===a.key&&m.target===T).map(m=>({name:`Корректировка суммы${m.text?' — '+m.text:''}`,amount:+m.amount||0}));
  const linesOf=p=>T==='EK'?Object.assign({},ekLines(p,r,t)):pickLines(p);
  const out=[];
  if(a.aParts.length) a.aParts.forEach((pi,j)=>{ const p=aParts[pi], pg=progOnDay(r,p.from);
    out.push({kind:'corrective',target:T,code:codeOf(pi,aParts.length,mA),replaces:repl,part:pi,parts:aParts.length,fio:a.fio,payer:a.payer,from:p.from,to:p.to,days:p.days,share:p.share,
      area:+r.area||0,mgmt:pg?{program:pg.prog,contractNo:pg.cno||null,contractDate:pg.cdt||null,from:pg.from||null}:null,
      lines:linesOf(p),before:a.bParts.length===1?linesOf(bParts[a.bParts[0]]):null,manual:j?[]:man,
      total:round2(T==='EK'?(+p.er||0):(+p.total||0)),was:j?0:was,now:j?0:pNew,settle:j?0:d,creditDelta:j?0:credit}); });
  else { const bi=a.bParts[0], bp=bParts[bi];
    out.push({kind:'corrective',target:T,annul:true,code:codeOf(bi,bParts.length,mB),replaces:repl,part:null,parts:aParts.length,fio:a.fio,payer:a.payer,from:bp.from,to:bp.to,days:bp.days,share:bp.share,
      area:+r.area||0,mgmt:null,lines:null,before:a.bParts.length===1?linesOf(bp):null,manual:[],total:0,was,now:pNew,settle:d,creditDelta:credit}); }
  return out;
}

/**
 * Разграничение по ресурсу на одном отрезке владения — не на весь месяц.
 * Нужно, когда собственник сменился внутри периода: у прежнего договор мог
 * быть, у нового — нет, и показывать одно «да» на обоих неверно.
 */
function rzForSlice(r,key,sl,rzOn,sleeps){
  if(!rzOn)  return {ok:false,seg:null,why:'разграничения выключены'};
  if(sleeps) return {ok:false,seg:null,why:'спит — платит УК'};
  const seg=activeSeg(rzList(r,key),sl.from,sl.to);
  if(!seg) return {ok:false,seg:null,why:TERM.noContract};
  if(!rzApplies(seg,key)) return {ok:false,seg:null,why:rzWhyNo(seg,key,null,sl.from)+' — '+TERM.uk};
  const st=segState(seg,sl.from,sl.to);
  return {ok:st.ok,seg,mid:st.mid,text:st.text};
}

/** Промежутки ресурса за месяц по расчёту (x — calcRowC): приборы ресурса, кроме «не участвует в расчётах», или тепло. */
function rzIvsOf(x,key){ return key==='h'?((x&&x.heat&&x.heat.ivs)||[]):((x&&x.det)||[]).filter(d=>d.iv&&d.m&&d.m.bill!==false&&(d.m.res==='ee')===(key==='e')).flatMap(d=>d.iv.ivs); }

/** Разграничение ресурса в месяце по расчёту — договор и ручная пометка собственника, как в квитанции (06.10.2026: отчёты брали
 *  только договор и не видели пометку). 'all' — весь объём ресурса у поставщика, 'part' — часть дней или приборов, null — нет. */
function rzByCalc(x,key){
  const ivs=rzIvsOf(x,key); if(!ivs.length) return null;
  const n=ivs.filter(v=>v.direct).length;
  return !n?null:n===ivs.length?'all':'part';
}

/** Ручная пометка ресурса в месяце по расчёту: true / false — у всех дней и приборов одна, 'mixed' — разные, null — пометки нет. */
function rzManOf(x,key){
  const vs=[...new Set(rzIvsOf(x,key).map(v=>v.man==null?null:v.man))];
  if(!vs.length||(vs.length===1&&vs[0]===null)) return null;
  return vs.length===1?vs[0]:'mixed';
}

/* ======================= Расчёт месяца по данным — хозяин Node ======================= */

/**
 * Расчёт месяца по данным: вход — состояние месяца (ответ GET /api/state?period=…), выход — квитанции КУ и ЭК со строками, суммы по
 * помещениям, баланс ОДН дома и коэффициенты. Порядок — как у пульта при смене месяца: данные месяца → вводные месяца (monthInputs;
 * закрытый месяц — переключатели и доходные из снимка) → контекст расчёта (buildCtx) → помещения (calcRowC) → документы
 * (exportEnvelope). В браузере не вызывается: там данные месяца держит пульт.
 * @param {MonthState} state
 * @param {string} per  Месяц ГГГГ-ММ.
 * @returns {MonthResult}
 */
function calcMonth(state,per){
  const st=state||{}, settings=st.settings||{};
  ROWS=(st.rows||[]).filter(r=>!r.del);
  TAR=st.tariffs||[];
  EXT_BASE=(st.external||[]).map(x=>Object.assign({},x)); EXT=EXT_BASE.map(x=>Object.assign({},x));
  BY_PERIOD=JSON.parse(JSON.stringify(settings.byPeriod||{})); HEAT_BY_PERIOD=settings.heatByPeriod||{}; SETTINGS_LIVE=settings;
  CLOSED=st.closed||null; CLOSED_PERIODS=st.closedPeriods||[]; LAST_CLOSED=st.lastClosed||null;
  ADJ=st.adjustments||[]; CARRIES=st.carries||[]; CREDITS=st.credits||[]; OFFSETS=st.offsets||[];
  BASE_PERIOD=st.period||per;
  FIELDS={'f-per':per}; FLAGS={'f-rz':settings.applyRz!==false,'f-uk':settings.ukPays!==false,'f-seal':settings.sealFrom!==false};
  // закрытый месяц — только помещения его снимка; переключатели и доходные — из снимка, расчёт — из снимка (closedCtx)
  if(CLOSED&&CLOSED.units&&CLOSED.period===per) ROWS=ROWS.filter(r=>CLOSED.units[r.n]);
  if(isClosed()){ const inp=CLOSED.inputs||{}; FLAGS['f-rz']=inp.applyRz!==false; FLAGS['f-uk']=inp.ukPays!==false; EXT=(inp.external||[]).map(x=>Object.assign({},x)); }
  else { const mi=monthInputs(per); Object.assign(FIELDS,mi.fields); if(mi.ext) EXT=mi.ext; }
  CTX=buildCtx(); calcCacheReset();
  const x=exportEnvelope(), units={};
  ROWS.forEach(r=>{ const c=calcRowC(r,CTX); units[r.n]={KU:c.split.parts.map(p=>p.total),EK:c.split.parts.map(p=>p.er),payer:c.payer}; });
  const c=CTX;
  const balance={
    water:{invoice:c.inW,inUK:c.sumW,ukNeeds:c.ukW,income:c.extW,carry:c.carryW,odn:c.odnW,units:c.nOdn,perUnit:c.odnPerUnitW},
    electricity:{invoice:c.inE,inUK:c.sumE,ukNeeds:c.ukE,income:c.extE,carry:c.carryE,odn:c.odnE,area:c.areaOdn,perM2:c.odnPerAreaE},
    heat:{invoice:c.heatGcal,buildingArea:c.bldArea,delimitedArea:c.areaHeatRz,base:c.heatBaseArea,coefficient:c.kOt,used:c.heatUsed,
      ukNeeds:c.ukH,carry:c.carryH,rest:c.heatRest,perM2:c.kOdn,baseBad:!!c.heatBaseBad,restNegative:!!c.heatRestNeg},
    compensation:{ek:c.ek||0,factor:c.ekFactor}};
  const ctx={}; ['odnPerUnitW','odnPerAreaE','kOt','kOdn','ekFactor','nOdn','areaOdn','heatBaseArea','heatRest'].forEach(k=>{ if(c[k]!==undefined) ctx[k]=c[k]; });
  return {errs:x.errs,env:x.env,units,balance,ctx};
}
/** Что движок отдаёт хозяину Node. */
function engineApi(){
  return {calcMonth,monthInputs,payRound,payTotals,round2,ceil2,acctKey,acctMap,acctDelta,fieldDelta,deltaAny,carryFromDelta,
    ENGINE_VERSION,EXPORT_SCHEMA};
}

/* ======================= Node ======================= */
// require('engine/calc.js'): createEngine() — новый контекст движка (свои данные месяца, расчёты в разных контекстах не мешают друг
// другу); calcMonth(состояние, месяц) — расчёт в новом контексте. В браузере и внутри контекста этот блок не исполняется.
if(typeof module==='object'&&module&&module.exports&&typeof window==='undefined'){
  const vm=require('vm'), fs=require('fs');
  const SCRIPT=new vm.Script(fs.readFileSync(__filename,'utf8'),{filename:__filename});
  // данные месяца и поля ввода — у хозяина; в контексте Node — здесь
  const HOST=`var ROWS=[],TAR=[],EXT=[],EXT_BASE=[],BY_PERIOD={},HEAT_BY_PERIOD={},SETTINGS_LIVE={},CLOSED=null,CLOSED_PERIODS=[],LAST_CLOSED=null,
    ADJ=[],CARRIES=[],CREDITS=[],OFFSETS=[],BASE_PERIOD='',CTX=null,FIELDS={},FLAGS={};
    var el=id=>({value:FIELDS[id]!=null?FIELDS[id]:'',checked:!!FLAGS[id]}), gv=id=>pnum(el(id).value), gc=id=>!!FLAGS[id];`;
  const createEngine=()=>{ const ctx=vm.createContext({console}); vm.runInContext(HOST,ctx); SCRIPT.runInContext(ctx); return vm.runInContext('engineApi()',ctx); };
  module.exports={createEngine,calcMonth:(state,per)=>createEngine().calcMonth(state,per)};
}
