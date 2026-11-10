# Data Structure and Reporting Context

This document records the current understanding of the local source files used by
Data Workbench. It is an analysis document, not a transformation specification.
The source files in `source-files/` are local specimens and are ignored by Git.

## 1. Organization and reporting context

The organization operates food-distribution programs and tracks both food supply
and food distribution. Its programs do not all use the same software:

- The main CRM tracks service events connected to client households. A household
  has members, which supports household composition, demographic reporting, and
  food-service weight reporting. The CRM also tracks some non-food programs.
- A separate food-locker system tracks locker orders and locker distributions.
- A rescue program, coordinated by a large food bank, supplies excess grocery
  food from scheduled store pickups. Store pickups are sorted, weighed by
  category, and reported by store.
- A warehouse log tracks sourced food coming in and food going out outside the
  rescue and program-distribution records. Some in-kind donations appear there;
  their classification is accepted as recorded for now.
- Anonymous programs distribute food without tracking individual clients. Staff
  record aggregate household composition and pounds.

The recurring monthly reporting needs currently identified are:

- Rescue pounds by category and location, category totals, and overall total.
- Total food pounds distributed across food programs, including lockers.
- Total households served in food programs, counting each service/order event.
- Total children served, counting children once for every household service/order
  event.
- Total adults served, counting adults once for every household service/order
  event.
- Total seniors served, counting seniors once for every household service/order
  event.

The household and person metrics are intentionally duplicated event metrics. If a
household is served twice, it contributes two households and its members are
counted twice.

## 2. Source files

### 2.1 `database-export.accdb`

This is an export from the main CRM. The CRM is old and has gone through many
changes. Many tables and columns are unused. Some fields change format or stop
being used over time. The CRM does not handle food lockers.

The most relevant tables identified so far are:

#### `tblClientInformation`

Current client/account-level information.

```text
ClientID, Status, Address1, Address2, Apt#, City, State, Zip, County,
Phone1, Phone2, Email, Comments, LastUpdate, MgtList, NoPermShelter,
NoPermShelterSince, HeardAbout, ReasonsforNeed, IncomeLevel, ClientSince,
Proxy, Proxy2, Notifications, NotificationTypes, NotificationMethods,
NotificationLanguage, HomeDeliveryClient, HomeDeliverySite,
EastAfricanProgram, AniMeals, SpecialDietSub, SpecialDietSubNote, NumCats,
NumDogs, NotetoClient, SpanishONLY, FPG<200, FPG>200, DateAdded, DateModified
```

The exported `DateAdded` and `ClientSince` fields are empty in the inspected
records. `DateModified` is populated but cannot be assumed to be account creation.

#### `tblHouseholdMembers`

The current household-member table.

```text
HHID, ClientID, Relationship, FirstName, LastName, Birthdate,
EthnicityRace, Gender, Disability, Veteran, Migrant, SpecialDiet,
LimitedEnglish, Date_Employment, Date_Programs, Date_AdditionalIncome,
Date_Expenses, UnEmploymentAmount, OtherAmount, DateAdded, DateModified
```

This table represents current/member records, not necessarily the household
composition at the time of every historical service event.

#### `tblClientService`

CRM service events.

```text
ServiceID, ClientID, ServiceCategory, DateServed, ServiceType, Activity,
Weight, Quantity, ServiceValue, ServiceNumber, ServiceNote, NumHouseholds,
NumChildren, NumAdults, NumSeniors, DateCreated, DateModified
```

Observed data contains approximately 125,941 data rows. `ServiceCategory` is
primarily `Food`, with a smaller `Other` category. `Other` represents non-food
programs and should not be included in food-program pounds or demographic totals.

All `ServiceCategory=Food` events are to be counted regardless of values such as
no-show or suspended service type, according to the current reporting direction.

The service-level `Weight` field is effectively unused. `DateCreated` is empty in
the inspected export. The food weight is recorded in the related food-details
table.

#### `tblClientService_Food_Details`

Food weights associated with CRM service events.

```text
ServiceDetailsID, ServiceID, ClientID, FoodCategory, Weight,
DateCreated, DateModified
```

Observed data contains approximately 205,750 data rows and approximately 121,934
distinct service IDs. Current food categories include:

```text
DryPounds, Produce, Food, Hygiene, Refrigerated
```

Pre-change records use multiple categories. Post-change records overwhelmingly
use the general `Food` category, which appears to contain the combined weight
that was previously separated among categories. The original category must be
preserved for validation and historical analysis.

`Hygiene` is not automatically food and should remain separate unless reporting
requirements establish that it belongs in an official food-pound total.

#### `tblClientService_History`

Post-change service-level household snapshot.

```text
HistoryID, ClientID, DateServed, City, State, Zip, County, NoPermShelter,
NoPermShelterSince, HeardAbout, ReasonsforNeed, IncomeLevel, DateAdded,
DateModified
```

This table begins around April 1, 2024 and contains approximately 27,398 rows.
It appears to preserve household/account information associated with a service
event.

#### `tblClientService_History_Members`

Members belonging to the post-change service snapshot.

```text
History_MemberID, HistoryID, HHID, ClientID, Relationship, FirstName,
LastName, Birthdate, EthnicityRace, Gender, Disability, Veteran, Migrant,
LimitedEnglish, EmploymentAmount, UnEmploymentAmount, DateAdded, DateModified
```

This table contains approximately 71,891 rows and begins around April 1, 2024.
It is the strongest current candidate for calculating age-group counts for
post-change food service events.

Age rules are:

```text
child:  age < 18
adult:  18 <= age < 65
senior: age >= 65
```

Age should be calculated as of the service date. Invalid or implausible
birthdates need explicit handling and quality flags.

#### `tblClientService_TEFAP`

TEFAP-related records.

```text
ServiceID, ClientID, LastUpdate, FamilySize, IncomeLevel, Programs, Status,
Notes, Signature, PDFLocation, DateCreated, DateModified
```

`FamilySize` is populated. `IncomeLevel` and `Status` are empty in the inspected
export. `Signature` contains the same zero-like value throughout and is not
currently useful as an analytical field. `Programs` is populated but requires
interpretation before being treated as a category.

#### `tblVisits`

A newer visit/appointment-oriented table.

```text
VisitID, VisitDate, VisitTime, VisitDateTime, VisitType, VisitNote,
VisitDetails, VisitDisplay, Status, ClientID, CheckedIn, Served, ServiceID,
Printed, DateCreated, DateModified
```

The inspected table contains approximately 22,243 rows, all with visit dates
from January 2025 onward. It appears to be useful for operational visit metrics,
but it is not necessarily a replacement for all historical service records.

Observed statuses include `Done`, `Checked In`, and `Scheduled`. `VisitType` is
constant (`Regular`) in the inspected data. `VisitNote` is nearly empty.

#### Other potentially relevant CRM tables

The export also contains many reference, audit, and specialized tables. Of
particular interest are:

- `tblClientService_History` and `tblClientService_History_Members`, described
  above.
- `tblClientMergeLog`, which records client merges and may help explain account
  identity changes.
- `tblHouseholdMembers` and its specialized income, employment, expense, and
  additional-income tables.
- `tblClientService_History` is not a general account-creation table; it is a
  service-history snapshot beginning with the newer period.

Most other CRM tables have not yet been assigned a reporting purpose.

### 2.2 `distribution-report-11-4-2026.csv` (`oa-dist`)

This is the food-locker distribution report. The locker program runs on separate
software from all other programs. The file tracks distributed food by date, type,
and weight.

Columns:

```text
OrderType, OrderLocation, Date, ItemLocation, ItemName, Quantity,
UnitPounds, TotalPounds, IsTEFAP
```

This file is the source for locker pounds. `TotalPounds` is the relevant weight
measure. It does not identify individual household composition in the inspected
schema.

The date is date-only and currently appears in `MM-DD-YYYY` form. Timezone
conversion should not be applied to a date-only business date.

### 2.3 `customer-orders-report-11-4-2026.csv` (`oa-orders`)

This is the food-locker order report. It contains no observed pounds, weight, or
product-breakdown columns. Locker pounds must come from `oa-dist`.

It contains customer, household, order, and service fields, including:

```text
ID, FirstName, MiddleName, LastName, Suffix, EmailAddress, PhoneNumber,
AddressLine1, AddressLine2, Zipcode, County, City, Province, PostalCode,
DateOfBirth, HouseholdSize, HouseholdAdultsCount,
HouseholdChildrenCount, HouseholdSeniorsCount, Created, TotalOrderCount,
CancelledOrderCount, OrderID, OrderNumber, OrderStatus, PlaceOfService,
DateOfService, BirthDate, Age, ...
```

The file is exclusively for the locker program. `OrderNumber` is the user-facing
hex-like key and is preferred for business-facing identification. `OrderID` is a
numeric source-system key and is useful for technical linkage.

Observed order statuses include:

```text
Complete
Abandoned
Cancelled
Placed
Delivered To Pickup Location
```

Current reporting rules are:

- `Complete` counts as a served locker household.
- `Abandoned` counts as an abandoned order.
- `Cancelled` orders are excluded.
- A completed order represents one household served.

The correct reporting date (`Created` versus `DateOfService`) may vary over time
and still requires investigation.

### 2.4 `fy-2027-log-rescue.xlsx` (`log-rescue`)

This records incoming food-rescue pickups from partner grocery stores. Food is
picked up on scheduled days, sorted, weighed by category, and reported to the
coordinating food bank.

Primary sheet: `Log`

Columns:

```text
Date, Location, Bakery, Dairy, Deli, Dry, Frozen, Nonfood, Produce, Total
```

This is an incoming-food source, not a distribution source. It supports:

- Pounds by date, location, and category.
- Category totals.
- Overall rescue pounds.
- Zero-cost rescue reporting.

The `Total` column should be validated against the sum of category columns and
should not be silently overwritten when discrepancies occur.

### 2.5 `fy-2027-log-warehouse.xlsx` (`log-warehouse`)

This tracks incoming sourced food and outgoing food that is not part of a
program. It does not include rescue. Some in-kind donations appear in the file;
that ambiguity is accepted for now.

Relevant sheets:

- `Log Incoming`
- `Log Outgoing`
- `Dash Incoming`
- `Dash Outgoing`

Dashboard sheets are summaries. The underlying log sheets should be treated as
the source data, with dashboards used for validation when possible.

Warehouse incoming and outgoing pounds are separate from rescue and distributed
food totals. In particular, warehouse outgoing pounds are **never** added to the
official pounds-distributed-through-programs metric.

Source and transaction type should be preserved exactly as recorded. The
transformation should not infer or reclassify in-kind donations.

### 2.6 `fy-2027-log-anonymous-programs.xlsx` (`log-anonymous-programs`)

This records outgoing food programs that do not track individual clients. Staff
ask for household composition and record aggregate totals.

Primary sheet: `Log Anonymous Programs`

Columns:

```text
Date, Program, Households, Children, Adults, Seniors, Pounds, Note
```

If a row has food pounds, it is a food-program record and its pounds and
household-composition counts contribute to the overall food-program totals.
These rows are not joined to CRM clients.

## 3. Reporting source and metric ownership

The current source-to-metric plan is:

| Metric | Source |
|---|---|
| CRM food-program pounds | `tblClientService_Food_Details`, joined to `tblClientService` |
| Pre-change CRM household composition | `tblClientService.NumChildren`, `NumAdults`, `NumSeniors` |
| Post-change CRM household composition | `tblClientService_History_Members`, through service-history snapshots |
| CRM food-program household events | One per `ServiceCategory=Food` service event |
| Locker pounds | `distribution-report` / `oa-dist.TotalPounds` |
| Locker completed households | `oa-orders` rows with `OrderStatus=Complete` |
| Locker abandoned orders | `oa-orders` rows with `OrderStatus=Abandoned` |
| Locker household composition | `oa-orders` household count fields |
| Anonymous-program pounds and composition | `log-anonymous-programs` |
| Rescue incoming pounds | `log-rescue` |
| Warehouse incoming/outgoing pounds | `log-warehouse` |

The official distributed-food-pound total is expected to combine:

```text
CRM food-program pounds
+ locker distribution pounds
+ qualifying anonymous-program pounds
```

It excludes:

- Rescue incoming pounds.
- Warehouse incoming pounds.
- Warehouse outgoing pounds.
- CRM `ServiceCategory=Other` records.

Rescue and warehouse are supply/movement metrics, not program-distribution
metrics.

## 4. Known anomalies and data-quality concerns

### 4.1 April 2024 CRM transition

The CRM contains two distinct operational periods. The major transition occurs
around April 2024.

Before the transition, `tblClientService` commonly records household composition
directly in:

```text
NumChildren, NumAdults, NumSeniors
```

After the transition, those fields are mostly empty and service-history tables
begin recording a household snapshot through:

```text
tblClientService_History
tblClientService_History_Members
```

The service-level `NumHouseholds` field is populated in newer records but is
mostly zero and should not be assumed to be the official household count without
further validation.

The food-detail categories also change. Older records use distinct categories;
newer records overwhelmingly use `Food`, apparently combining the prior
categories into one weight.

The transition includes large timestamp clusters around March 31 and April 1,
2024, suggesting a migration or bulk rewrite. `DateModified` must not be treated
as the event date.

### 4.2 Service-history linkage

`tblClientService_History` and `tblClientService` match approximately 95% of the
time using `ClientID + DateServed`, but this is not a definitive key. Multiple
service events can occur for one client on one date. A reliable event-level
linkage still needs to be established.

### 4.3 Invalid or placeholder birthdates

Household-member birthdates include placeholder, missing, and implausible values,
including dates in the future. Age-group calculations need validation rules and
quality flags.

### 4.4 CRM orphan references

The inspected export contains a small number of references without matching
parent records, including:

- Household members referencing missing clients.
- Service events referencing missing clients.
- TEFAP records referencing missing clients.
- Food details referencing missing service IDs.

These should be retained or explicitly flagged rather than silently dropped.

### 4.5 CRM dates and timestamps

Access timestamps have no timezone offset, for example:

```text
03/31/24 17:24:33
10/22/26 21:48:15
01/06/25 18:53:07
```

They appear to be local wall-clock timestamps, but the source timezone has not
been established. `America/Chicago` is only a working hypothesis and must not be
hard-coded as fact yet.

Date-only business fields such as `DateServed`, `VisitDate`, locker `Date`, and
WebDAV log `Date` should remain dates until reporting requirements establish a
need for timestamp conversion.

Click & Collect `Created` values contain explicit `+00:00` offsets and can be
parsed as timezone-aware timestamps. This does not prove that other fields or
other systems use UTC.

### 4.6 Locker status and date changes

The locker order file has changed column usage over time. The correct field for
monthly reporting may vary between `Created` and `DateOfService`. Statuses include
intermediate and final-looking values, so completed and abandoned denominators
need explicit rules.

### 4.7 Source-specific scope

- The CRM does not handle lockers.
- `oa-orders` has no pounds.
- `oa-dist` has pounds but does not provide the same household demographic
  structure as the order file.
- Rescue is incoming, not distributed.
- Warehouse outgoing is outside all program distributions and is never part of
  total distributed pounds.
- Anonymous-program rows are aggregate records and must not be joined to client
  records.

## 5. Remaining questions

1. **Post-change event linkage:** What is the reliable relationship between
   `tblClientService.ServiceID` and `tblClientService_History.HistoryID`? Is there
   an unseen key, or must the relationship be resolved using client/date and
   duplicate-handling rules?

2. **Post-change household snapshot selection:** If multiple history snapshots
   exist for one client and service date, which one belongs to each service
   event?

3. **Pre-change scope:** Should pre-April service rows be retained only for
   account-age/first-observed analysis and legacy comparison, or should they also
   contribute to official historical monthly metrics using the old stored counts?

4. **Account age:** Is there a trustworthy account-creation field elsewhere in
   the CRM, or should the metric use earliest observed service/history activity
   and label it `first_observed_date` rather than account creation?

5. **Food event inclusion:** Should every `ServiceCategory=Food` row count as one
   food household event even when it has no food-detail weight, or only rows with
   a related weight record?

6. **Food-detail units:** Are all `tblClientService_Food_Details.Weight` values
   pounds, including historical categories such as `Hygiene`?

7. **Food category transition:** Does post-change `Food` definitively represent
   the sum of the old food categories, and should historical category totals be
   combined into one official measure or reported by era/category?

8. **Hygiene treatment:** Should `Hygiene` be excluded from official food pounds,
   reported separately, or included in a broader distributed-weight metric?

9. **Age-quality handling:** When a service snapshot contains missing or invalid
   birthdates, should the event still count as one household while only valid
   members contribute to age-group totals?

10. **Locker reporting date:** For each historical OA period, should monthly
    order metrics use `Created`, `DateOfService`, or another field?

11. **Locker status denominator:** Should abandoned-order rate be calculated as
    `Abandoned / (Complete + Abandoned)`, excluding cancelled, placed, and
    delivered-to-pickup statuses?

12. **Locker intermediate statuses:** Are `Placed` and `Delivered To Pickup
    Location` intermediate states that later become `Complete`, or should they be
    reported as separate statuses?

13. **Locker household composition:** Should the household composition fields in
    `oa-orders` be used as recorded for completed orders, and do they represent
    the household at order time or the latest customer profile?

14. **Anonymous rows without pounds:** If an anonymous-program row has household
    counts but no pounds, is it a non-food program, an incomplete food record, or
    excluded from official food-program metrics?

15. **Rescue total validation:** Should discrepancies between the rescue `Total`
    column and category sum be reported as data-quality exceptions while keeping
    both values?

16. **Warehouse log authority:** What are the exact columns and row grain of the
    `Log Incoming` and `Log Outgoing` sheets, and do their dashboard totals
    reconcile to the detailed logs?

17. **Timezone:** What timezone does each source system use for timestamps? In
    particular, should Access timestamps be interpreted as local Minnesota time,
    and should they be converted to UTC or retained as local source timestamps?

18. **Monthly boundaries:** Are all monthly reports based on local business dates
    in calendar months, with no fiscal-year metadata required?

19. **Direct identifiers:** Which direct identifiers, if any, are needed for
    operational investigation? Analytical outputs should otherwise avoid names,
    addresses, phone numbers, and email addresses.

20. **Official report reconciliation:** Is there an existing monthly report or
    known month whose official totals can be used to validate the proposed
    formulas before transformations are finalized?
