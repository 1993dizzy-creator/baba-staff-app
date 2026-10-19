"use client";
import type { PurchaseRoot } from "@/lib/inventory/purchase-correction-policy";
import { ui } from "@/lib/styles/ui";
export default function PurchaseCorrectionPicker({lang,roots,selectedId,onSelect,onConfirm,disabled}:{lang:"ko"|"vi";roots:PurchaseRoot[];selectedId:number|null;onSelect:(id:number|null)=>void;onConfirm:()=>void;disabled:boolean}) {
  const vi=lang==="vi";
  return <section aria-label={vi?"Sửa lô nhập gốc":"원입고 수량 정정"}>
    <p>{vi?"Đây là sửa số lượng lô nhập, không phải mua mới. Chọn lô gốc và xác nhận. Không thay đổi tồn sau khi đã kiểm kho.":"신규 구매가 아닌 원입고 수량 정정입니다. 추천 또는 선택한 원입고를 확인한 뒤 저장해주세요. 후속 재고확인이 있으면 실재고를 변경하지 않습니다."}</p>
    <label>{vi?"Chọn lô nhập gốc":"원입고 선택"}
      <select value={selectedId??""} disabled={disabled} onChange={event=>onSelect(Number(event.target.value)||null)} style={ui.input}>
        <option value="">{vi?"Chọn lô nhập":"원입고를 선택해 주세요"}</option>
        {roots.map(root=><option key={root.id} value={root.id}>#{root.id} · {root.business_date} · {vi?"Còn hiệu lực":"남은 유효량"}: {root.effectiveQuantity??root.change_quantity}{root.unit??""} · {root.new_supplier} · {root.new_purchase_price}₫</option>)}
      </select>
    </label>
    <button type="button" disabled={disabled||selectedId===null} onClick={onConfirm} style={ui.button}>{vi?"Liên kết lô gốc và lưu sửa đổi":"원입고에 연결하고 정정 저장"}</button>
  </section>;
}
