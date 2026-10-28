import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {duplicateInventoryItemMessage,matchDuplicateInventoryItem} from '../lib/inventory/duplicate-item.ts';

// Duplicate policy unchanged (either name equal + same code); the 409 now says which name and which item.
const rows=[
 {id:189,item_name:'해표)고추맛기름 1.8L',item_name_vi:'Dầu ớt',code:'',part:'kitchen',category:'조미료',category_vi:'Gia vị',is_active:true},
 {id:343,item_name:'사테 고추기름',item_name_vi:'Sốt cô gái thái',code:'',part:'kitchen',category:'조미료',category_vi:'Gia vị',is_active:true},
];

test('match: either name (accent/case/space-insensitive) with the same code; blank names never match',()=>{
 assert.deepEqual(matchDuplicateInventoryItem(rows,{itemName:'해표)고추맛기름  1.8l',itemNameVi:'X',code:null}),{item:rows[0],matchedFields:['item_name']});
 assert.deepEqual(matchDuplicateInventoryItem(rows,{itemName:'',itemNameVi:'dau ot',code:''}),{item:rows[0],matchedFields:['item_name_vi']});
 assert.deepEqual(matchDuplicateInventoryItem(rows,{itemName:'사테 고추기름',itemNameVi:'SỐT CÔ GÁI THÁI',code:''}).matchedFields,['item_name','item_name_vi']);
 assert.equal(matchDuplicateInventoryItem(rows,{itemName:'해표)고추맛기름 1.8L',itemNameVi:'',code:'A1'}),null,'different code');
 assert.equal(matchDuplicateInventoryItem(rows,{itemName:'',itemNameVi:'  ',code:''}),null);
 assert.equal(matchDuplicateInventoryItem(rows,{itemName:'고추기름 500ml',itemNameVi:'Dầu ớt cay nóng 500ml',code:''}),null,'#624 with a new Korean name');
});

test('message names the other item (#id, both names, location) in KO and VI; inactive and old responses still read well',()=>{
 assert.equal(duplicateInventoryItemMessage({lang:'ko',duplicateItem:rows[0],matchedFields:['item_name'],location:'주방/조미료'}),
  '다른 품목과 한국어명이 같아 저장할 수 없습니다.\n#189 해표)고추맛기름 1.8L / Dầu ớt (주방/조미료)\n이름을 구분해 입력하거나 기존 품목을 사용해주세요.');
 assert.equal(duplicateInventoryItemMessage({lang:'vi',duplicateItem:rows[0],matchedFields:['item_name_vi'],location:'Bếp/Gia vị'}),
  'Không thể lưu vì tên tiếng Việt trùng với mặt hàng khác.\n#189 해표)고추맛기름 1.8L / Dầu ớt (Bếp/Gia vị)\nVui lòng đặt tên khác hoặc dùng mặt hàng hiện có.');
 assert.match(duplicateInventoryItemMessage({lang:'ko',duplicateItem:{...rows[1],is_active:false},matchedFields:['item_name','item_name_vi'],location:''}),/^한국어명·베트남어명이 같은 품목이 비활성 상태로 등록되어 있습니다\.\n#343 사테 고추기름 \/ Sốt cô gái thái\n/);
 // A response without matched fields (older server) still names the item.
 assert.match(duplicateInventoryItemMessage({lang:'ko',duplicateItem:rows[1],location:'주방/조미료'}),/^다른 품목과 품목명이 같아.*\n#343 /);
 assert.equal(duplicateInventoryItemMessage({lang:'vi',duplicateItem:null,location:''}),'Sản phẩm này đã được đăng ký.');
});

test('both screens use the shared message; the edit flow keeps its draft after a 409',()=>{
 for(const file of ['components/inventory/InventoryItemEditor.tsx','components/inventory/InventoryPageContent.tsx']){
  const source=readFileSync(file,'utf8');
  assert.match(source,/duplicateInventoryItemMessage\(\{ lang, duplicateItem, matchedFields, location \}\)/,file);
  assert.match(source,/getDuplicateItemAlertMessage\(result\.duplicateItem, result\.duplicateMatchedFields\)/,file);
 }
 // On failure the editor only alerts and returns: no field reset, the reason sheet stays open.
 const editor=readFileSync('components/inventory/InventoryItemEditor.tsx','utf8');
 const failure=editor.slice(editor.indexOf('const handleInventoryItemMutationFailure'),editor.indexOf('const closeEditReasonModal'));
 assert.doesNotMatch(failure,/set[A-Z]\w*\(/);
 // After a duplicate the reason sheet closes, so the next 저장 builds the payload from the corrected form.
 assert.match(editor,/handleInventoryItemMutationFailure\(res, result, "edit"\);\n[^\n]*\n[^\n]*\n\s*if \(isDuplicateInventoryItemResult\(res, result\)\) setEditFormPendingSave\(null\);/);
 const route=readFileSync('app/api/inventory/items/route.ts','utf8');
 assert.match(route,/\{ excludeId: Number\(prevItem\.id\), activeOnly: true \}/);
 assert.match(route,/duplicateMatchedFields: duplicate\.matchedFields,/);
});
