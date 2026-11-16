import test from 'node:test';
import assert from 'node:assert/strict';
import {localizedTableMenuName as name} from '../lib/sales/table-menu-display.ts';

test('actual CUKCUK examples keep product codes and choose the requested language',()=>{
 const samples=[['[N1] Rượu Soju Chamisul fresh/ 참이슬','[N1] 참이슬','[N1] Rượu Soju Chamisul fresh'],
  ['[H1] Trái Cây Thập Cẩm / 모듬 과일 안주','[H1] 모듬 과일 안주','[H1] Trái Cây Thập Cẩm']];
 for(const [original,ko,vi] of samples){assert.equal(name(original,'ko'),ko);assert.equal(name(original,'vi'),vi);}
});
test('reversed order, absent code and no spaces around a single slash are supported',()=>{
 for(const [original,ko,vi] of [['[H1] 모듬 과일 안주/Trái Cây Thập Cẩm','[H1] 모듬 과일 안주','[H1] Trái Cây Thập Cẩm'],
  ['참이슬 / Soju','참이슬','Soju'],['[N1]참이슬/Rượu Soju','[N1] 참이슬','[N1] Rượu Soju'],
  ['[N1] Rượu Soju / 참이슬 2병','[N1] 참이슬 2병','[N1] Rượu Soju']]){
  assert.equal(name(original,'ko'),ko);assert.equal(name(original,'vi'),vi);
 }
});
test('single-language names and ordinary slash names retain the exact original',()=>{
 for(const original of ['','   ','[N1] Soju','Trái Cây Thập Cẩm','모듬 과일 안주','Gin/Tonic','Red / White',
  '소주/맥주','[H1] 과일 1/2 접시','[N1] Rượu/Soju','  [H1] Trái Cây Thập Cẩm  ']){
  for(const lang of ['ko','vi'])assert.equal(name(original,lang),original);
 }
});
test('ambiguous scripts, repeated slashes, empty labels and repeated codes fail back to original',()=>{
 for(const original of ['[N1] Gin/Tonic / 진토닉','Rượu / 참이슬 / Soju',' / 참이슬','Soju / ',
  '[N1] Soju / 참이슬 fresh','Soju 한글 / 참이슬','参이슬 / Soju','Soju / チャミスル',
  '[N1] Soju / [N1] 참이슬','[한글] Soju / 참이슬']){
  for(const lang of ['ko','vi'])assert.equal(name(original,lang),original);
 }
});
test('Vietnamese combining marks and Hangul Unicode forms are recognized without rewriting the source',()=>{
 const original='[H1] Trái Cây Thập Cẩm / 모듬 과일 안주',decomposed=original.normalize('NFD');
 assert.equal(name(decomposed,'vi'),'[H1] '+ 'Trái Cây Thập Cẩm'.normalize('NFD'));
 assert.equal(name(decomposed,'ko'),'[H1] '+ '모듬 과일 안주'.normalize('NFD'));
 assert.equal(original,'[H1] Trái Cây Thập Cẩm / 모듬 과일 안주');
});
