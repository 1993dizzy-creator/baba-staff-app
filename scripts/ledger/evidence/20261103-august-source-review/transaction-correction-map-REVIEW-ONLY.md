# APP transaction correction mapping ? REVIEW ONLY

Source: targeted production GET evidence in app-source-rows-READONLY.json. No operational changes. These are source-supported candidates, NOT 75 mapped date/account discrepancies or approved events. All proposed new corrections have amount=0 and P&L effect=0; original source rows/movements are preserved.

## Technical month-end balance adjustments

| Source tx / original movement | Sheet row | Business date | Source amount VND | Existing cash (account: signed VND) | Proposed cash / retained state | P&L delta | Decision |
|---|---|---|---:|---|---|---:|---|
| 1057 | - | 2026-08-31 | 149781532.500 | 526 / acct 1: -149781532.500 | acct 1: 149781532.5 | 0 | Exact v3 source signature; full rebuild pending |
| 1058 | - | 2026-08-31 | 99162485.000 | 527 / acct 2: -99162485.000 | acct 2: 99162485 | 0 | Exact v3 source signature; full rebuild pending |
| 1059 | - | 2026-08-31 | 72602700.000 | 528 / acct 3: -72602700.000 | acct 3: 72602700 | 0 | Exact v3 source signature; full rebuild pending |
| 1060 | - | 2026-08-31 | 1542800.000 | 529 / acct 5: 1542800.000 | acct 5: -1542800 | 0 | Exact v3 source signature; full rebuild pending |
| 1095 | - | 2026-08-31 | 3760000.000 | 536 / acct 1: 3760000.000 | acct 1: -3760000 | 0 | Exact v3 source signature; full rebuild pending |
| 1096 | - | 2026-08-31 | 57810508.000 | 537 / acct 2: 57810508.000 | acct 2: -57810508 | 0 | Exact v3 source signature; full rebuild pending |
| 1305 | - | 2026-08-31 | 2651770.000 | 710 / acct 2: 2651770.000 | acct 2: -2651770 | 0 | Exact v3 source signature; full rebuild pending |
| 1306 | - | 2026-08-31 | 337000.000 | 711 / acct 1: 337000.000 | acct 1: -337000 | 0 | Exact v3 source signature; full rebuild pending |

## Legacy expense cash-restoration candidates

| Source tx / original movement | Sheet row | Business date | Source amount VND | Existing cash (account: signed VND) | Proposed cash / retained state | P&L delta | Decision |
|---|---|---|---:|---|---|---:|---|
| 1067 | 20 | 2026-08-02 | 1500000.000 | 0 (no own movement) | acct 1: -1500000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1068 | 21 | 2026-08-02 | 2000000.000 | 0 (no own movement) | acct 1: -2000000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1069 | 114 | 2026-08-10 | 159049931.000 | 0 (no own movement) | acct 1: -9282000; acct 2: -148017931; UNASSIGNED 1750000 | 0 | BLOCKED_MIXED_PAYMENT_ACCOUNT_UNRESOLVED |
| 1070 | 129 | 2026-08-11 | 653000.000 | 0 (no own movement) | acct 1: -653000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1071 | 165 | 2026-08-13 | 3000000.000 | 0 (no own movement) | acct 1: -3000000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1072 | 241 | 2026-08-18 | 2500000.000 | 0 (no own movement) | acct 1: -2500000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1073 | 287 | 2026-08-21 | 2000000.000 | 0 (no own movement) | acct 1: -2000000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1074 | 344 | 2026-08-25 | 233000.000 | 0 (no own movement) | acct 3: -233000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1075 | 424 | 2026-08-31 | 2500000.000 | 0 (no own movement) | acct 1: -2500000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1076 | 40 | 2026-08-04 | 1460286.000 | 0 (no own movement) | acct 2: -1460286 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1077 | 41 | 2026-08-04 | 34951407.000 | 0 (no own movement) | acct 2: -34951407 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1078 | 130 | 2026-08-11 | 6540000.000 | 0 (no own movement) | acct 2: -6540000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1079 | 310 | 2026-08-23 | 1512000.000 | 0 (no own movement) | acct 2: -1512000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1080 | 327 | 2026-08-24 | 2040034.000 | 0 (no own movement) | acct 2: -2040034 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1081 | 414 | 2026-08-31 | 1390749.000 | 0 (no own movement) | acct 2: -1390749 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1082 | 92 | 2026-08-07 | 500000.000 | 0 (no own movement) | UNASSIGNED 500000 | 0 | BLOCKED_GENERIC_BANK_ACCOUNT_UNRESOLVED |
| 1083 | 343 | 2026-08-25 | 1900000.000 | 0 (no own movement) | acct 3: -1900000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1084 | 361 | 2026-08-26 | 2500000.000 | 0 (no own movement) | acct 1: -2500000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1098 | 6 | 2026-08-01 | 50000.000 | 0 (no own movement) | acct 1: -50000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1099 | 11 | 2026-08-02 | 60000.000 | 0 (no own movement) | acct 1: -60000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1100 | 26 | 2026-08-03 | 400000.000 | 0 (no own movement) | acct 1: -400000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1101 | 55 | 2026-08-05 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1102 | 85 | 2026-08-07 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1103 | 137 | 2026-08-11 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1104 | 179 | 2026-08-14 | 6210000.000 | 0 (no own movement) | acct 2: -6210000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1105 | 198 | 2026-08-14 | 300000.000 | 0 (no own movement) | acct 3: -300000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1106 | 240 | 2026-08-18 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1107 | 267 | 2026-08-20 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1108 | 283 | 2026-08-21 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1109 | 292 | 2026-08-21 | 310000.000 | 0 (no own movement) | UNASSIGNED 310000 | 0 | BLOCKED_GENERIC_BANK_ACCOUNT_UNRESOLVED |
| 1110 | 296 | 2026-08-22 | 2162800.000 | 0 (no own movement) | acct 2: -2162800 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1111 | 309 | 2026-08-22 | 1700000.000 | 0 (no own movement) | acct 3: -1700000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1112 | 333 | 2026-08-24 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1113 | 342 | 2026-08-25 | 150000.000 | 0 (no own movement) | acct 3: -150000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1114 | 358 | 2026-08-26 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1115 | 395 | 2026-08-29 | 30000.000 | 0 (no own movement) | acct 1: -30000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1116 | 420 | 2026-08-31 | 60000.000 | 0 (no own movement) | acct 1: -60000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1118 | 421 | 2026-08-31 | 20000.000 | 0 (no own movement) | acct 1: -20000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1446 | 52 | 2026-08-05 | 8100000.000 | 0 (no own movement) | acct 2: -8100000 | 0 | Stored-source candidate; raw-cell/dedup review pending |
| 1447 | 115 | 2026-08-10 | 22528000.000 | 0 (no own movement) | acct 2: -22528000 | 0 | Stored-source candidate; raw-cell/dedup review pending |

## Existing payments to preserve

| Source tx / original movement | Sheet row | Business date | Source amount VND | Existing cash (account: signed VND) | Proposed cash / retained state | P&L delta | Decision |
|---|---|---|---:|---|---|---:|---|
| 151 | - | 2026-08-07 | 598000.000 | 67 / acct 2: -598000.000 | Preserve existing movement; no new payment | 0 | BLOCKED_TARGET_ACCOUNT_AND_SHEET_LINK_UNVERIFIED |
| 152 | - | 2026-08-07 | 598000.000 | 68 / acct 3: -598000.000 | Preserve existing movement; no new payment | 0 | BLOCKED_TARGET_ACCOUNT_AND_SHEET_LINK_UNVERIFIED |
| 153 | - | 2026-08-07 | 556000.000 | 69 / acct 2: -556000.000 | Preserve existing movement; no new payment | 0 | BLOCKED_TARGET_ACCOUNT_AND_SHEET_LINK_UNVERIFIED |
| 154 | - | 2026-08-07 | 1112000.000 | 70 / acct 3: -1112000.000 | Preserve existing movement; no new payment | 0 | BLOCKED_TARGET_ACCOUNT_AND_SHEET_LINK_UNVERIFIED |
| 1304 | 132 | 2026-08-11 | 300000000.000 | 709 / acct 2: -300000000.000 | Preserve existing movement; no new payment | 0 | PRESERVE_EXISTING_300M_MOVEMENT_709; DO_NOT_RESTORE_AGAIN |

Do not execute the eight technical reversals or any individual restoration separately. Missing raw sheet/source links and all daily/month-end comparisons block the complete atomic manifest. Generic tai khoan never establishes a fund account.
