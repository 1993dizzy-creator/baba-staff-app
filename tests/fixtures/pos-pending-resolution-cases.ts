// Except the supplied 6982 amounts, all amounts are SYNTHETIC test values.
﻿// Representative incident facts, not recovered production payloads.
export const pendingResolutionCases = [
 {refNo:'6974',date:'2026-10-17',duplicate:false,amount:100000},
 {refNo:'6981',date:'2026-10-17',duplicate:true,amount:100000},
 {refNo:'6982',date:'2026-10-17',duplicate:true,amount:1910800,confirmed:1100800},
 {refNo:'7055',date:'2026-10-20',duplicate:false,amount:100000,missingPrint:true},
 {refNo:'7059',date:'2026-10-20',duplicate:false,amount:100000,missingPrint:true},
 {refNo:'7057',date:'2026-10-20',duplicate:true,amount:100000},
 {refNo:'7063',date:'2026-10-20',duplicate:true,amount:100000,confirmed:90000},
 {refNo:'7064',date:'2026-10-20',duplicate:true,amount:100000,confirmed:90000},
] as const;
