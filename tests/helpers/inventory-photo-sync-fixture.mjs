export function photoSync622(businessDate='2026-10-19'){
 const root={id:13626,item_id:622,business_date:businessDate,created_at:businessDate+'T03:00:00Z',reason:'purchase',source:'quick_save',change_quantity:3,prev_quantity:0,new_quantity:3,correction_of_inventory_log_id:null,item_name:'인조 화분 장식',item_name_vi:'Chậu hoa giả decor',part:'etc',category:'Decor',category_vi:'Decor',code:'QA622',unit:'Chậu',new_purchase_price:300000,new_supplier:'Shopee',purchase_supplier_partner_id:7};
 const photo={...root,id:13627,source:'photo',reason:'other',created_at:businessDate+'T03:01:00Z',change_quantity:0,prev_quantity:3,new_quantity:3,purchase_supplier_partner_id:null};
 const count={...root,id:13628,source:'quick_save',reason:'stock_check',created_at:businessDate+'T03:02:00Z',change_quantity:1,prev_quantity:3,new_quantity:4};
 const master={id:622,item_name:root.item_name,item_name_vi:root.item_name_vi,part:root.part,category:root.category,category_vi:root.category_vi,code:root.code,unit:root.unit,purchase_price:root.new_purchase_price,supplier:'Shopee',supplier_partner_id:7,quantity:4,is_active:true};
 return {root,photo,count,master,logs:[root,photo,count],businessDate};
}
