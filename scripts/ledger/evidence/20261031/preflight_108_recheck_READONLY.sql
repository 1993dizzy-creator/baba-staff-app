-- BABA October 2026 · Confirmed APP movements vs Google Sheet daily movement snapshot.
-- READ ONLY. 27 days * 4 fund accounts=108 comparisons.
-- Google Sheet (2026)BABA - Sổ dự án / 10월 tab (sheetId=1631724291)
-- Spreadsheet ID 1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4
-- G = store_cash (fund 1), K = corporate bank (fund 2), I = Cho (fund 3), H = Vuong (fund 5).
-- Sheet values are fixed snapshot from 2026-10-31. Refresh source values if Sheet changes.
WITH sheet(day,store_cash,corporate_bank,cho_personal,vuong_personal) AS (VALUES
  (DATE '2026-10-01', 6057200, -13269294, 2823200, -50000),
  (DATE '2026-10-02', 8336900, -28779219, 6034600, 0),
  (DATE '2026-10-03', 2853400, -11144600, -32650000, 0),
  (DATE '2026-10-04', 6972200, 7978200, 620500, 0),
  (DATE '2026-10-05', -1453400, 19489118, 1618200, 0),
  (DATE '2026-10-06', 6985700, 6661912, 2605600, 0),
  (DATE '2026-10-07', 3877200, 15300814, 0, 0),
  (DATE '2026-10-08', -5575000, 15676708, 1294800, 0),
  (DATE '2026-10-09', 2443400, 14782114, 4906920, 0),
  (DATE '2026-10-10', -22090500, -122972609, 286800, -3000000),
  (DATE '2026-10-11', 2588000, 10035900, 0, 0),
  (DATE '2026-10-12', -297600, 13000906, 2205600, 0),
  (DATE '2026-10-13', 2535400, 5238818, 1855800, 0),
  (DATE '2026-10-14', 511600, 21273034, 3100800, 0),
  (DATE '2026-10-15', 5067000, 20132061, 2500000, 0),
  (DATE '2026-10-16', -21816800, 25256416, 1407400, 0),
  (DATE '2026-10-17', 7659300, -90461042, 1254000, 0),
  (DATE '2026-10-18', 1243900, 3292400, 0, 0),
  (DATE '2026-10-19', -3539200, 30087597, 1030000, 0),
  (DATE '2026-10-20', 2681800, -18136536, 4338600, 280000),
  (DATE '2026-10-21', -713000, -81357588, 3406600, 2195000),
  (DATE '2026-10-22', 4614000, 14091637, 0, 0),
  (DATE '2026-10-23', -5561000, 19710325, 2061000, 3000000),
  (DATE '2026-10-24', 5491800, 17348800, 2034000, 0),
  (DATE '2026-10-25', 753600, 12920320, 3551400, 0),
  (DATE '2026-10-26', -21000, 25171540, 1953600, 0),
  (DATE '2026-10-27', 4471700, 5963072, 2314900, -8600000)
), expected AS (
 SELECT s.day,v.fund_account_id,v.sheet_delta
 FROM sheet s CROSS JOIN LATERAL (VALUES
  (1,s.store_cash),(2,s.corporate_bank),(3,s.cho_personal),(5,s.vuong_personal)
 ) AS v(fund_account_id,sheet_delta)
), app AS (
 SELECT t.business_date AS day,m.fund_account_id,sum(m.amount)::numeric AS app_delta
 FROM public.ledger_movements m
 JOIN public.ledger_transactions t ON t.id=m.transaction_id
 WHERE t.status='confirmed'
 AND t.business_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-27'
 AND m.fund_account_id IN (1,2,3,5)
 GROUP BY t.business_date,m.fund_account_id
), checked AS (
 SELECT e.day,e.fund_account_id,e.sheet_delta,
 COALESCE(a.app_delta,0)::numeric AS app_delta,
 COALESCE(a.app_delta,0)::numeric-e.sheet_delta AS difference
 FROM expected e LEFT JOIN app a USING(day,fund_account_id)
)
SELECT count(*) AS checks,
 count(*) FILTER(WHERE difference=0) AS passed,
 count(*) FILTER(WHERE difference<>0) AS failed,
 COALESCE(jsonb_agg(jsonb_build_object(
  'day',day,'fundAccountId',fund_account_id,'sheet',sheet_delta,
  'app',app_delta,'difference',difference
 ) ORDER BY day,fund_account_id) FILTER(WHERE difference<>0),'[]'::jsonb) AS mismatches
FROM checked;
