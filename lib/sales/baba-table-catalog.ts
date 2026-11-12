import type { TableCatalog } from "./table-overview.ts";

// Verified provider identities + Owner-confirmed display areas (2026-11-13).
// See docs/tables-overview.md. observedIsAvailable is historical evidence ONLY.
export const BABA_TABLES_EVIDENCE = {
  "fetchedAt": "2026-11-12T18:17:40.919Z",
  "branchId": "c39228ba-a452-4cf9-bf34-424ffb151fb8",
  "sourceSha256": "445c1a96491fcb7e370e8454a9c091aac4c9baefcb833d575dfed7c2fbfa3c60",
  "allowMergeTable": 0
} as const;

export const BABA_TABLES = [
  {"MapObjectID":"5a052b69-a6d9-4861-bc1f-9f63f117fa2f","MapObjectName":"BAR1","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"ce3be370-e5e1-4c34-a586-ad704bfd0fff","MapObjectName":"BAR2","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"3ed3715e-249f-4c3e-9808-46e9b765feb0","MapObjectName":"BAR3","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"330083ed-5363-43c8-a7d8-c0d4059805a6","MapObjectName":"BAR4","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"e12e41dd-e625-4f6f-af78-148915faf0d9","MapObjectName":"BAR5","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"676e0935-f3a2-474b-ae9a-fe426ed032c7","MapObjectName":"BAR6","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"c61a5550-41d5-4ba6-9f47-af8ba3e999bd","MapObjectName":"BAR7","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"7d27a96d-44f4-471f-b736-416bfc4dd8f8","MapObjectName":"BAR8","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"753e2349-be88-42e2-be69-415b1ef35ca2","MapObjectName":"BAR9","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"14f542b2-92d2-488f-8808-cabb0c24db4f","MapObjectName":"BAR10","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"db63d3cc-e61a-42e0-afed-3c7d2d897850","MapObjectName":"BAR11","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"bar","observedIsAvailable":true},
  {"MapObjectID":"78fccd19-eccd-426d-bf47-4ebf69d110ff","MapObjectName":"1","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"6f19cf59-f09f-45c3-9a88-6eb5bf13dd6f","MapObjectName":"2","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"1d36583c-d01c-48bc-8d8b-7937c3bf0033","MapObjectName":"3","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"943d7206-b88e-433d-b73c-87f5f36d063d","MapObjectName":"4","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"296dbc39-5f0a-4ff0-a76e-8a6033ca4d76","MapObjectName":"5","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"2d187fe3-3ed0-4fff-8f3d-53d858477ed2","MapObjectName":"6","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"287c9895-cad0-46ce-8e91-b368c2dc8253","MapObjectName":"7","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"24b63fb9-46c4-4e23-9511-7580fb6e8e50","MapObjectName":"8","AreaID":"ee074f4e-82e3-4bb0-b4c6-dba90289cdf5","AreaName":"A","displayArea":"floor1","observedIsAvailable":true},
  {"MapObjectID":"8e5c68cd-2281-4d9c-9e50-90cfbe090309","MapObjectName":"11","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"78720f8d-38d4-4ebd-a8de-a44c6e0a180b","MapObjectName":"12","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"bae28d67-45ab-42b4-a56c-e91c07617d0b","MapObjectName":"13","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"5917f86e-b860-4d47-8719-28562db4ff06","MapObjectName":"14","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"c353bcf5-7366-42c7-8958-9d1dd0a84560","MapObjectName":"15","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"a1762647-b6a2-403c-9111-e286aa526dc4","MapObjectName":"16","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"4b959b7b-7207-45be-8212-996e1f72588f","MapObjectName":"17","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
  {"MapObjectID":"eb71c7df-22e3-4b39-8bf8-9de5094d45cf","MapObjectName":"18","AreaID":"2c5cfe86-68a2-4aab-9568-88ee309e5905","AreaName":"B","displayArea":"floor2","observedIsAvailable":true},
] as const;

/** Identity catalog: no live availability claim, network, credentials or feature flag. */
export function babaTableCatalog(): TableCatalog {
  return { status: "ok", kind: "verified_static", collectedAt: BABA_TABLES_EVIDENCE.fetchedAt,
    tables: BABA_TABLES.map(table => ({ id: table.MapObjectID, name: table.MapObjectName,
      areaId: table.AreaID, areaName: table.AreaName, displayArea: table.displayArea, available: null })) };
}
