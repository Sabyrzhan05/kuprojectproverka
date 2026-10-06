# -*- coding: utf-8 -*-
"""Разбор файлов поставщиков из папки месяца (Импорт/ГГГГ/ММ) → JSON в stdout.

Типы файлов определяются по содержимому, не по имени:
  arek  — выгрузка АРЭК «Апартаменты ДД.ММ.ГГ.xlsx»: серийник, дата, показание «Всего» — один снимок на дату
  water — отчёт Су-Арнасы water_meters_consumption_report…xlsx: по строке помещение, ХВС и ГВС
          с серийником, показаниями «Начало» и «Конец»
  esf   — ЭСФ Теплотранзита (xls/xlsx): строки «Тепловая энергия» — количество (Гкал), цена, сумма

Запуск: python parse_import.py <папка>   (нужны openpyxl и xlrd)
Сопоставление с приборами стенда делает сервер (server/import.js) — здесь только чтение.
"""
import sys, os, re, json, datetime

sys.stdout.reconfigure(encoding='utf-8')


def s(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


SPACES = (' ', '\u00a0', '\u202f', '\u2009', '\u2007')   # пробел, неразрывный, узкий неразрывный, тонкий, цифровой


def num_raw(v):
    """(число или None, исходный текст, если ячейка не пустая и не прочерк, но числом не читается).
    '5 769,70' / '5\u202f769,70' / '4.0446' / '1.234,56' / '1,234.56' / 4.5 → число; '–', '' → (None, None)."""
    if v is None:
        return None, None
    if isinstance(v, bool):
        return None, str(v)
    if isinstance(v, (int, float)):
        return float(v), None
    t = str(v).strip()
    for ch in SPACES:
        t = t.replace(ch, '')
    if not t or t in ('–', '-', '—'):
        return None, None
    if ',' in t and '.' in t:
        # и точка, и запятая: последний знак — дробная часть, первый — разделитель тысяч
        t = t.replace('.', '').replace(',', '.') if t.rfind(',') > t.rfind('.') else t.replace(',', '')
    else:
        t = t.replace(',', '.')
    try:
        return float(t), None
    except ValueError:
        return None, str(v).strip()


def num(v):
    """Число или None (пусто, прочерк, не читается)."""
    return num_raw(v)[0]


def iso(v):
    if v is None or v == '':
        return ''
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m-%d')
    t = str(v).strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', t)
    if m:
        return t[:10]
    m = re.match(r'^(\d{1,2})[.,/](\d{1,2})[.,/](\d{2,4})', t)
    if m:
        d, mo, y = m.groups()
        y = ('20' + y) if len(y) == 2 else y
        return f'{y}-{int(mo):02d}-{int(d):02d}'
    return ''


def read_rows(path):
    """Все строки первого листа как списки значений (xlsx через openpyxl, xls через xlrd)."""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.xlsx' or ext == '.xlsm':
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb.worksheets[0]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        wb.close()
        return rows
    if ext == '.xls':
        import xlrd
        bk = xlrd.open_workbook(path)
        sh = bk.sheets()[0]
        out = []
        for i in range(sh.nrows):
            row = []
            for j in range(sh.ncols):
                c = sh.cell(i, j)
                if c.ctype == xlrd.XL_CELL_DATE:
                    row.append(datetime.datetime(*xlrd.xldate_as_tuple(c.value, bk.datemode)))
                else:
                    row.append(c.value)
            out.append(row)
        return out
    raise ValueError('не xls/xlsx')


def detect(rows):
    head = ' '.join(s(c) for r in rows[:12] for c in r if c is not None).lower()
    if 'сер. №' in head or ('счетчик' in head and 'показания' in head and 'позиция' in head):
        return 'arek'
    if 'счётчики воды' in head or 'счетчики воды' in head or ('холодная вода' in head and 'горячая вода' in head):
        return 'water'
    if 'электронный счет' in head or 'электронный счёт' in head:
        return 'esf'
    return ''


def parse_arek(rows):
    # шапка: строка с '#' в первой колонке и 'Сер. №' во второй
    start = None
    for i, r in enumerate(rows[:15]):
        if len(r) > 1 and s(r[0]) == '#' and 'сер' in s(r[1]).lower():
            start = i + 1
            break
    if start is None:
        start = 4
    # столбцы — по подписям шапки: «Дата» и первое «Всего» в блоке «Активная энергия» (04.10.2026; раньше — номерами
    # столбцов: дата 3-й, «Всего» 6-й, и при другой выгрузке АРЭК импорт молча взял бы не тот столбец)
    c_date, c_total = 2, 5
    hv = [s(c).lower() for c in rows[start - 1]] if 0 < start <= len(rows) else []
    if 'дата' in hv:
        c_date = hv.index('дата')
    act = None
    for r in rows[:start]:
        js = [j for j, c in enumerate(r) if 'активная' in s(c).lower()]
        if js:
            act = js[0]
            break
    tot = [j for j, v in enumerate(hv) if v == 'всего' and (act is None or j >= act)]
    if tot:
        c_total = tot[0]
    out, dates = [], {}
    for r in rows[start:]:
        sn = s(r[1]) if len(r) > 1 else ''
        if not sn or not re.match(r'^\d+$', sn):
            continue
        dt = iso(r[c_date]) if len(r) > c_date else ''
        total, raw = num_raw(r[c_total]) if len(r) > c_total else (None, None)
        rec = {'sn': sn, 'date': dt, 'total': total}
        if raw:
            rec['totalRaw'] = raw
        out.append(rec)
        if dt:
            dates[dt] = dates.get(dt, 0) + 1
    date = max(dates, key=dates.get) if dates else ''
    return {'type': 'arek', 'date': date, 'rows': out}


def parse_water(rows):
    # период из второй строки: «за период с 24.06.2026 по 25.07.2026»
    period_from = period_to = ''
    for r in rows[:6]:
        t = s(r[0])
        m = re.search(r'с\s*(\d{2}\.\d{2}\.\d{4})\s*по\s*(\d{2}\.\d{2}\.\d{4})', t)
        if m:
            period_from, period_to = iso(m.group(1)), iso(m.group(2))
    # колонки: ищем строку заголовков с «Холодная вода» и «Горячая вода», ниже — «Начало»/«Конец»
    c_h = c_g = None
    hdr = None
    for i, r in enumerate(rows[:15]):
        vals = [s(c).lower() for c in r]
        if 'холодная вода' in vals and 'горячая вода' in vals:
            c_h, c_g, hdr = vals.index('холодная вода'), vals.index('горячая вода'), i
            break
    if hdr is None:
        raise ValueError('не найдена шапка «Холодная вода / Горячая вода»')
    # строка с «Начало»/«Конец» (через 2 строки от шапки)
    sub = None
    for i in range(hdr, min(hdr + 4, len(rows))):
        vals = [s(c).lower() for c in rows[i]]
        if 'начало' in vals and 'конец' in vals:
            sub = vals
            start = i + 1
            break
    if sub is None:
        raise ValueError('не найдена строка «Начало / Конец»')
    # подписи блока прибора (серийник, модем, «Последнее сообщение», …) — строкой ниже шапки
    lab = None
    for i in range(hdr, min(hdr + 3, len(rows))):
        vals = [s(c).lower() for c in rows[i]]
        if any('последнее сообщение' in v for v in vals):
            lab = vals
            break

    def cols(base, upto):
        # серийник — первая колонка блока; начало/конец — по подписям внутри блока; «последнее сообщение» модема — если есть
        b = [j for j in range(base, upto) if sub[j] == 'начало'][0]
        e = [j for j in range(base, upto) if sub[j] == 'конец'][0]
        ls = [j for j in range(base, min(upto, len(lab))) if 'последнее сообщение' in lab[j]] if lab else []
        return base, b, e, (ls[0] if ls else None)
    h_cols = cols(c_h, c_g)
    g_cols = cols(c_g, len(sub))

    def meter(r, c):
        sn_c, b, e, lc = c
        prev, prev_raw = num_raw(r[b]) if len(r) > b else (None, None)
        cur, cur_raw = num_raw(r[e]) if len(r) > e else (None, None)
        x = {'sn': s(r[sn_c]), 'prev': prev, 'cur': cur}
        if prev_raw:
            x['prevRaw'] = prev_raw
        if cur_raw:
            x['curRaw'] = cur_raw
        if lc is not None and len(r) > lc and iso(r[lc]):
            x['last'] = iso(r[lc])     # последнее сообщение модема: давнее — показание могло «застыть»
        return x
    out = []
    for r in rows[start:]:
        if not r or not s(r[0]).isdigit():
            continue
        unit, consumer = s(r[2]), s(r[3])
        rec = {'unit': unit, 'consumer': consumer, 'floor': s(r[1])}
        hs = s(r[h_cols[0]]) if len(r) > h_cols[0] else ''
        gs = s(r[g_cols[0]]) if len(r) > g_cols[0] else ''
        if hs:
            rec['hvs'] = meter(r, h_cols)
        if gs:
            rec['gvs'] = meter(r, g_cols)
        out.append(rec)
    return {'type': 'water', 'from': period_from, 'to': period_to, 'rows': out}


def parse_esf(rows):
    supplier, doc_date, issue_date = '', '', ''
    reg_no, corrects, corrected = '', '', False
    lines = []
    for i, r in enumerate(rows):
        vals = [s(c) for c in r]
        # регистрационный номер ЭСФ — чтобы два файла одной ЭСФ не сложились (04.10.2026); строка «4.» — «Исправленный»,
        # строка «4.2 … 4.3 Регистрационный номер» — номер исправляемой ЭСФ
        if 'Регистрационный номер' in vals:
            j = vals.index('Регистрационный номер')
            esf = next((v for v in vals[j + 1:] if v.upper().startswith('ESF-')), '')
            if esf:
                if '4.3' in vals[:j]:
                    corrects = corrects or esf
                elif not reg_no:
                    reg_no = esf
        if 'Исправленный' in vals:
            j = vals.index('Исправленный')
            for v in vals[j + 1:]:
                if re.match(r'^\d+\.\d', v):
                    break
                if v:
                    corrected = True
                    break
        if 'Поставщик' in vals and not supplier:
            # название — в следующих строках, первая непустая ячейка
            for rr in rows[i + 1:i + 4]:
                cand = [s(c) for c in rr if s(c)]
                if cand:
                    supplier = cand[0]
                    break
        # «Дата выписки» — первая дата после подписи; «Дата совершения оборота» — период счёта
        for label, key in (('Дата выписки', 'issue'), ('Дата совершения оборота', 'turn')):
            if label in vals:
                j = vals.index(label)
                for c in r[j + 1:]:
                    if iso(c):
                        if key == 'issue' and not issue_date:
                            issue_date = iso(c)
                        if key == 'turn' and not doc_date:
                            doc_date = iso(c)
                        break
        if any('тепловая энергия' in v.lower() for v in vals):
            nums = [(j, num(c)) for j, c in enumerate(r) if num(c) is not None and not (isinstance(c, str) and c.strip().isdigit() and j < 5)]
            # порядок в ЭСФ: количество, цена, стоимость, …, НДС, всего с НДС — берём первые три и последнее
            qty = price = summ = total = None
            if len(nums) >= 3:
                qty, price, summ = nums[0][1], nums[1][1], nums[2][1]
                # стоимость с НДС — наибольшее число правее суммы (дальше идут акциз, НДС, идентификаторы)
                rest = [v for _, v in nums[3:]]
                total = max(rest) if rest else None
            lines.append({'row': i + 1, 'name': next(v for v in vals if 'тепловая энергия' in v.lower()), 'qty': qty, 'price': price, 'sum': summ, 'total': total})
    gcal = round(sum(l['qty'] or 0 for l in lines), 4)
    return {'type': 'esf', 'supplier': supplier, 'issueDate': issue_date, 'docDate': doc_date, 'regNo': reg_no,
            'corrected': corrected, 'corrects': corrects, 'lines': lines, 'gcal': gcal}


def main():
    folder = sys.argv[1]
    files = []
    for name in sorted(os.listdir(folder)):
        if name.startswith('~$') or name.startswith('.'):
            continue
        p = os.path.join(folder, name)
        if not os.path.isfile(p) or os.path.splitext(name)[1].lower() not in ('.xls', '.xlsx', '.xlsm'):
            continue
        rec = {'name': name, 'size': os.path.getsize(p)}
        try:
            rows = read_rows(p)
            t = detect(rows)
            rec['type'] = t
            if t == 'arek':
                rec.update(parse_arek(rows))
            elif t == 'water':
                rec.update(parse_water(rows))
            elif t == 'esf':
                rec.update(parse_esf(rows))
            else:
                rec['error'] = 'не похоже ни на АРЭК, ни на Су-Арнасы, ни на ЭСФ'
        except Exception as e:  # noqa
            rec['error'] = str(e)
        files.append(rec)
    print(json.dumps({'folder': folder, 'files': files}, ensure_ascii=False))


if __name__ == '__main__':
    main()
