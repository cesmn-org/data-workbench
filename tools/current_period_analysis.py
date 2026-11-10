#!/usr/bin/env python3
"""Analyze current-period source data and write reviewable anomaly CSVs.

The analysis cutoff is 2025-01-06 inclusive. Source files are never modified.
Requires mdb-export for the Access database.
"""
import argparse, csv, json, re, subprocess
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

CUTOFF = date(2025, 1, 6)
ACCESS_DATE = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{2})(?:\s|$)')
NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def access_rows(db, table):
    result = subprocess.run(['mdb-export', db, table], check=True, capture_output=True, text=True)
    return list(csv.DictReader(result.stdout.splitlines()))


def parse_date(value):
    value = (value or '').strip()
    if re.fullmatch(r'\d+(?:\.\d+)?', value):
        number = float(value)
        if 20000 <= number <= 80000:
            return date(1899, 12, 30) + timedelta(days=number)
    match = ACCESS_DATE.match(value)
    if match:
        month, day, year = map(int, match.groups())
        year += 1900 if year >= 30 else 2000
        try: return date(year, month, day)
        except ValueError: return None
    for fmt in ('%m/%d/%Y %H:%M:%S', '%Y-%m-%d', '%m-%d-%Y'):
        try: return datetime.strptime(value, fmt).date()
        except ValueError: pass
    return None


def parse_birthdate(value):
    return parse_date(value)


def age_on(value, event_date):
    born = parse_birthdate(value)
    if not born or born > event_date: return None
    age = event_date.year - born.year - ((event_date.month, event_date.day) < (born.month, born.day))
    return age if 0 <= age <= 110 else None


def number(value):
    try: return Decimal((value or '').strip())
    except (InvalidOperation, AttributeError): return Decimal(0)


def xlsx_sheets(path):
    with ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            shared = [''.join(t.text or '' for t in si.findall('.//x:t', NS)) for si in root.findall('x:si', NS)]
        workbook = ET.fromstring(z.read('xl/workbook.xml'))
        relroot = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        rels = {r.attrib['Id']: r.attrib['Target'] for r in relroot}
        result = {}
        for sheet in workbook.findall('x:sheets/x:sheet', NS):
            name = sheet.attrib['name']
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            target = 'xl/' + target.lstrip('/') if not target.startswith('xl/') else target
            root = ET.fromstring(z.read(target)); rows = []
            for row in root.findall('.//x:sheetData/x:row', NS):
                cells = {}
                for cell in row.findall('x:c', NS):
                    ref = cell.attrib.get('r', ''); match = re.match(r'[A-Z]+', ref)
                    if not match: continue
                    value = cell.find('x:v', NS); text = '' if value is None else value.text or ''
                    if cell.attrib.get('t') == 's' and text: text = shared[int(text)]
                    cells[match.group(0)] = text
                if cells: rows.append(cells)
            result[name] = rows
        return result


def sheet_table(rows, header_row):
    if len(rows) <= header_row: return []
    header = rows[header_row]; cols = sorted(header, key=lambda c: (len(c), c)); names = [header[c].strip() for c in cols]
    return [{names[i]: row.get(cols[i], '').strip() for i in range(len(cols)) if names[i]} for row in rows[header_row + 1:]]


def write_csv(path, rows, fields):
    with path.open('w', newline='') as f:
        out = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore'); out.writeheader(); out.writerows(rows)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--source-dir', default='source-files'); ap.add_argument('--database'); ap.add_argument('--output-dir', default='/tmp/current-period-analysis'); args = ap.parse_args()
    src = Path(args.source_dir); out = Path(args.output_dir); out.mkdir(parents=True, exist_ok=True); db = args.database or str(src / 'database-export.accdb')
    services = access_rows(db, 'tblClientService'); details = access_rows(db, 'tblClientService_Food_Details'); histories = access_rows(db, 'tblClientService_History'); members = access_rows(db, 'tblClientService_History_Members'); visits = access_rows(db, 'tblVisits')
    current_services = [r for r in services if (d := parse_date(r['DateServed'])) and d >= CUTOFF]
    food_services = [r for r in current_services if r['ServiceCategory'] == 'Food']; service_ids = {r['ServiceID'] for r in food_services}; service_by_id = {r['ServiceID']: r for r in services}
    food_details = [r for r in details if r['ServiceID'] in service_ids]
    weights = defaultdict(Decimal); categories = defaultdict(Counter)
    for r in food_details: weights[r['ServiceID']] += number(r['Weight']); categories[r['ServiceID']][r['FoodCategory']] += number(r['Weight'])
    current_histories = [r for r in histories if (d := parse_date(r['DateServed'])) and d >= CUTOFF]; history_by_key = defaultdict(list)
    for r in current_histories: history_by_key[(r['ClientID'], parse_date(r['DateServed']))].append(r)
    members_by_history = defaultdict(list)
    for r in members: members_by_history[r['HistoryID']].append(r)
    visits_by_service = defaultdict(list)
    for r in visits:
        if parse_date(r['VisitDate']) and parse_date(r['VisitDate']) >= CUTOFF and r['ServiceID']: visits_by_service[r['ServiceID']].append(r)

    unmatched = []; ambiguous = []; incomplete = []; age_counts = {}; matched = 0
    for service in food_services:
        event_date = parse_date(service['DateServed']); candidates = history_by_key[(service['ClientID'], event_date)]
        if len(candidates) == 0: unmatched.append({'ServiceID': service['ServiceID'], 'ClientID': service['ClientID'], 'DateServed': service['DateServed'], 'ServiceType': service['ServiceType'], 'FoodPounds': str(weights[service['ServiceID']])}); continue
        if len(candidates) > 1: ambiguous.append({'ServiceID': service['ServiceID'], 'ClientID': service['ClientID'], 'DateServed': service['DateServed'], 'HistoryIDs': '|'.join(x['HistoryID'] for x in candidates)}); continue
        matched += 1; history = candidates[0]; member_rows = members_by_history[history['HistoryID']]; counts = Counter(); invalid = 0
        for member in member_rows:
            age = age_on(member['Birthdate'], event_date)
            if age is None: invalid += 1
            elif age < 18: counts['children'] += 1
            elif age < 65: counts['adults'] += 1
            else: counts['seniors'] += 1
        age_counts[service['ServiceID']] = dict(counts)
        if invalid or not member_rows: incomplete.append({'ServiceID': service['ServiceID'], 'ClientID': service['ClientID'], 'DateServed': service['DateServed'], 'HistoryID': history['HistoryID'], 'MemberRows': len(member_rows), 'InvalidBirthdates': invalid})
    write_csv(out / 'unmatched_food_services.csv', unmatched, ['ServiceID','ClientID','DateServed','ServiceType','FoodPounds'])
    write_csv(out / 'ambiguous_food_service_history.csv', ambiguous, ['ServiceID','ClientID','DateServed','HistoryIDs'])
    write_csv(out / 'incomplete_household_snapshots.csv', incomplete, ['ServiceID','ClientID','DateServed','HistoryID','MemberRows','InvalidBirthdates'])

    anomalies = []
    for r in services:
        d = parse_date(r['DateServed'])
        if not d: anomalies.append({'source':'tblClientService','key':r['ServiceID'],'field':'DateServed','value':r['DateServed'],'reason':'missing_or_unparseable'})
        elif d > date.today(): anomalies.append({'source':'tblClientService','key':r['ServiceID'],'field':'DateServed','value':r['DateServed'],'reason':'future_date'})
        elif d == date(1999,12,30): anomalies.append({'source':'tblClientService','key':r['ServiceID'],'field':'DateServed','value':r['DateServed'],'reason':'placeholder_date'})
    for r in members:
        b = parse_birthdate(r['Birthdate'])
        if r['Birthdate'] and (not b or b > date.today()): anomalies.append({'source':'tblClientService_History_Members','key':r['History_MemberID'],'field':'Birthdate','value':r['Birthdate'],'reason':'invalid_or_future_birthdate'})
    for r in details:
        if r['ServiceID'] not in service_by_id: anomalies.append({'source':'tblClientService_Food_Details','key':r['ServiceDetailsID'],'field':'ServiceID','value':r['ServiceID'],'reason':'orphan_service_id'})
        if r['Weight'] and number(r['Weight']) < 0: anomalies.append({'source':'tblClientService_Food_Details','key':r['ServiceDetailsID'],'field':'Weight','value':r['Weight'],'reason':'negative_weight'})
    for r in visits:
        if parse_date(r['VisitDate']) and parse_date(r['VisitDate']) >= CUTOFF and not r['ServiceID']: anomalies.append({'source':'tblVisits','key':r['VisitID'],'field':'ServiceID','value':'','reason':'visit_without_service_id'})
        elif r['ServiceID'] and r['ServiceID'] not in service_by_id: anomalies.append({'source':'tblVisits','key':r['VisitID'],'field':'ServiceID','value':r['ServiceID'],'reason':'visit_service_id_not_found'})
    write_csv(out / 'anomalies.csv', anomalies, ['source','key','field','value','reason'])

    monthly = defaultdict(Counter)
    for r in food_services:
        d = parse_date(r['DateServed']); c = age_counts.get(r['ServiceID'], {}); m = d.strftime('%Y-%m'); monthly[m]['food_service_events'] += 1; monthly[m]['food_pounds'] += float(weights[r['ServiceID']]); monthly[m]['households_served'] += 1; monthly[m]['children_served'] += c.get('children',0); monthly[m]['adults_served'] += c.get('adults',0); monthly[m]['seniors_served'] += c.get('seniors',0); monthly[m]['services_with_visit'] += bool(visits_by_service.get(r['ServiceID']))
    result = {'cutoff':CUTOFF.isoformat(),'crm':{'service_rows_current':len(current_services),'food_service_rows':len(food_services),'food_detail_rows_for_food_services':len(food_details),'food_services_with_weight':sum(bool(weights[x]) for x in service_ids),'history_rows_current':len(current_histories),'history_match_unique':matched,'history_match_ambiguous':len(ambiguous),'history_unmatched':len(unmatched),'food_service_rows_with_visit':sum(bool(visits_by_service.get(x)) for x in service_ids),'food_detail_weight_by_category':dict(Counter()),'monthly':{k:dict(v) for k,v in sorted(monthly.items())}},'review_files':{p.name:sum(1 for _ in p.open())-1 for p in out.glob('*.csv')}}
    result['comparison_month'] = '2026-10'
    result['october_2026'] = dict(monthly.get('2026-10', {}))
    category_totals = defaultdict(Decimal)
    for r in food_details: category_totals[r['FoodCategory']] += number(r['Weight'])
    result['crm']['food_detail_weight_by_category'] = {k:float(v) for k,v in sorted(category_totals.items())}

    oa_path = next(src.glob('customer-orders-report-*.csv'), None)
    if oa_path:
        with oa_path.open(newline='') as f: oa=list(csv.DictReader(f))
        current=[r for r in oa if parse_date(r['DateOfService']) and parse_date(r['DateOfService']) >= CUTOFF]; october=[r for r in current if parse_date(r['DateOfService']).strftime('%Y-%m') == '2026-10']; result['locker_orders']={'rows_current':len(current),'status_counts':dict(Counter(r['OrderStatus'] for r in current)),'october_2026':{'rows':len(october),'status_counts':dict(Counter(r['OrderStatus'] for r in october))}}
    dist_path = next(src.glob('distribution-report-*.csv'), None)
    if dist_path:
        with dist_path.open(newline='') as f: dist=list(csv.DictReader(f))
        current=[r for r in dist if parse_date(r['Date']) and parse_date(r['Date']) >= CUTOFF]; october=[r for r in current if parse_date(r['Date']).strftime('%Y-%m') == '2026-10']; result['locker_distribution']={'rows_current':len(current),'total_pounds':float(sum(number(r['TotalPounds']) for r in current)),'october_2026':{'rows':len(october),'total_pounds':float(sum(number(r['TotalPounds']) for r in october))}}
    for path, sheet_name, header in [(next(src.glob('fy-2027-log-anonymous-programs.xlsx'),None),'Log Anonymous Programs',2),(next(src.glob('fy-2027-log-rescue.xlsx'),None),'Log',2),(next(src.glob('fy-2027-log-warehouse.xlsx'),None),None,None)]:
        if not path: continue
        sheets=xlsx_sheets(path); info={'sheets':{k:len(v) for k,v in sheets.items()}}
        if sheet_name in sheets:
            table=sheet_table(sheets[sheet_name],header); info['primary_columns']=list(table[0]) if table else []; info['primary_rows_current']=sum(bool(parse_date(r.get('Date',''))) and parse_date(r['Date'])>=CUTOFF for r in table); info['numeric_totals']={c:float(sum(number(r.get(c,'')) for r in table if r.get(c,''))) for c in (list(table[0]) if table else []) if c not in ('Date','Program','Location','Note')}
        result.setdefault('workbooks',{})[path.name]=info
    (out/'summary.json').write_text(json.dumps(result,indent=2,default=str)+'\n'); print(json.dumps(result,indent=2,default=str)); print(f'\nReview files written to {out}')

if __name__ == '__main__': main()
