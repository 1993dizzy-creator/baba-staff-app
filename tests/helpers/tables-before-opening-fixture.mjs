import {buildTableOverview} from '../../lib/sales/table-overview.ts';
import {createFallbackBusinessTimeSnapshot,calculateBusinessTimeContext} from '../../lib/store-settings/business-time-adapter-core.ts';
import {babaTableCatalog} from '../../lib/sales/baba-table-catalog.ts';
import {evaluateOpenOrdersCronWindow} from '../../lib/pos/cukcuk/open-orders-cron-policy.ts';

export function beforeOpeningScene(clock='11:53', overrides={}, snapshot=createFallbackBusinessTimeSnapshot('2026-11-17')) {
 const now=new Date(`2026-11-17T${clock}:00+07:00`), context=calculateBusinessTimeContext(now,snapshot);
 const view=buildTableOverview({now,businessDate:context.businessDate,catalog:babaTableCatalog(),enabled:true,
  sync:null,orders:[],receipts:[],cutoff:snapshot.cutoff,businessTime:snapshot,
  collectionExpected:context.isOpen && evaluateOpenOrdersCronWindow(now).allowed,...overrides});
 const table=view.tables.find(t=>t.name==='BAR1');
 const detail={table,businessDate:view.businessDate,snapshotAt:view.snapshotAt,snapshotStatus:view.snapshotStatus,
  current:[],previous:[],latest:null,merges:[],cleaning:{enabled:false,reason:'snapshot_unhealthy'}};
 return {view,table,detail,context};
}
