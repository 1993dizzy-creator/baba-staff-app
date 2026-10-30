import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {formatReceiptPriceInput,receiptPriceCaret} from '../lib/inventory/receipt-price-input.ts';

test('receipt price groups integer digits without losing decimal edits or precision',()=>{
 for(const [raw,expected] of [['65000','65,000'],['65,000.0500','65,000.0500'],['1234567.123456789','1,234,567.123456789'],['65000.','65,000.'],['.05','.05'],['',''],['1e-7','1e-7'],['65 000.5','65,000.5']])assert.equal(formatReceiptPriceInput(raw),expected);
 for(const raw of ['-65000','65.00.5','NaN','Infinity','abc'])assert.equal(formatReceiptPriceInput(raw),null);
});
test('receipt price caret follows digits and decimal positions when commas move',()=>{
 assert.equal(receiptPriceCaret('65000',2,'65,000'),2);
 assert.equal(receiptPriceCaret('659,000.50',3,'659,000.50'),3);
 assert.equal(receiptPriceCaret('65,000.50',8,'65,000.50'),8);
 assert.equal(receiptPriceCaret(' 65 000.50',10,'65,000.50'),9);
 assert.equal(receiptPriceCaret('',0,''),0);
});
test('formatted decimals retain the existing numeric save contract',()=>{
 for(const value of ['65000','65000.5','0.0000001','65000.00001'])assert.equal(Number(formatReceiptPriceInput(value)!.replace(/[,\s]/g,'')),Number(value));
});
