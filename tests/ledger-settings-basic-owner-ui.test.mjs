import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { ledgerSettingsText } from '../lib/ledger/settings-text.ts';

const read = path => readFileSync(path, 'utf8');
const page = read('app/(protected)/admin/ledger/settings/page.tsx');
const css = read('app/(protected)/admin/ledger/ledger-settings.module.css');
const panel = read('components/partners/PartnerSettingsPanel.tsx');
const candidatePage = read('app/(protected)/admin/partners/candidates/[id]/page.tsx');
const basicTab = page.slice(page.indexOf('{activeTab === "basic" ?'), page.indexOf('{activeTab === "partners" ?'));

// Runs the page's own helpers (not copies) against Production-shaped data.
function pageHelpers() {
  // Arrow functions with a block body end at "\n};\n"; one-liners end at ";\n".
  const pick = name => { const match = page.match(new RegExp(`const ${name} = (?:[^\\n]*=> \\{\\n[\\s\\S]*?\\n\\};\\n|[^\\n]*;\\n)`)); assert.ok(match, name); return match[0]; };
  const source = ['toRate', 'rateMicros', 'isUserFundAccount'].map(pick).join('');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${code}; return { toRate, rateMicros, isUserFundAccount };`)();
}

const productionAccounts = [
  { id: 1, code: 'store_cash', type: 'cash', display_name: '매장 현금', is_active: true, is_business_fund: true },
  { id: 2, code: 'vuong_personal_custody', type: 'personal_custody', display_name: 'Vương 개인계좌 (BABA 소유분)', is_active: true, is_business_fund: true },
  { id: 3, code: 'cho_personal_custody', type: 'personal_custody', display_name: 'Cho 개인계좌 (BABA 소유분)', is_active: true, is_business_fund: true },
  { id: 4, code: 'card_clearing', type: 'card_clearing', display_name: '카드 정산대기', is_active: true, is_business_fund: false },
  { id: 5, code: 'baba_corporate_bank', type: 'bank', display_name: 'BABA 법인계좌', is_active: true, is_business_fund: true },
];

test('A: 등록대기 lists pending candidates only and there is no 등록 제외/ignored UI left', () => {
  assert.match(panel, /const pendingAliases = aliases\.filter\(row => row\.status === "pending"\);/);
  // The Alias type still names every DB status; no rendered/derived UI uses ignored ones.
  const panelLogic = panel.replace(/^type Alias = .*$/m, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(panelLogic, /ignored|showResolved|resolvedToggle|처리완료/);
  assert.match(panel, /inactive: partners\.filter\(row => !row\.isActive\)\.length/);
  assert.doesNotMatch(read('lib/partners/settings-view.ts'), /showResolved|hideResolved|처리완료|đã xử lý/i);
  assert.doesNotMatch(read('app/(protected)/admin/partners/partners.module.css'), /\.resolvedToggle/);
  // Candidate review keeps create/link (and the zero-usage delete) only.
  assert.match(candidatePage, /type Action = "create_partner" \| "link_existing";/);
  assert.match(candidatePage, /review\(\{ action: "create_partner", partner \}\)/);
  assert.match(candidatePage, /review\(\{ action: "link_existing", existingPartnerId: Number\(existingPartnerId\) \}\)/);
  assert.doesNotMatch(candidatePage, /action: "ignore"|action: "reopen"|labels\.ignore|reviewAgain|등록하지 않음|Không đăng ký/);
  // Backend contract for legacy ignored/reopen candidates is untouched.
  assert.match(read('app/api/admin/partners/aliases/[id]/route.ts'), /ignore/);
});

test('B: both 기본설정 cards start open, toggle independently and carry the emoji titles', () => {
  assert.match(page, /const \[fundAccountsOpen, setFundAccountsOpen\] = useState\(true\);/);
  assert.match(page, /const \[ownerSettlementOpen, setOwnerSettlementOpen\] = useState\(true\);/);
  assert.match(basicTab, /<h2>🏦 \{tabText\.fundAccounts\}<\/h2>/);
  assert.match(basicTab, /<h2>🤝 \{tabText\.ownerSettlement\}<\/h2>/);
  assert.match(css, /\.accordionHeader>h2\{[^}]*white-space:nowrap/);
});

test('C: 자금계정 shows the 4 user-facing business fund accounts; card_clearing stays in the backend', () => {
  const { isUserFundAccount } = pageHelpers();
  const visible = productionAccounts.filter(isUserFundAccount);
  assert.deepEqual(visible.map(row => row.code), ['store_cash', 'vuong_personal_custody', 'cho_personal_custody', 'baba_corporate_bank']);
  assert.equal(visible.length, 4);
  assert.match(page, /const userFundAccounts = \(ledger\?\.accounts \?\? \[\]\)\.filter\(isUserFundAccount\);/);
  assert.match(page, /const activeAccountCount = userFundAccounts\.filter\(row => row\.is_active\)\.length;/);
  assert.match(page, /tabText\.accountCount\(activeAccountCount\)/);
  assert.doesNotMatch(page, /card_clearing: \{ order/);
  assert.doesNotMatch(page, /id === 4|id: 4/);
  // 2×2 grid on every width.
  assert.match(basicTab, /className=\{`\$\{styles\.accountGrid\} \$\{styles\.accountGridTwo\}`\}/);
  assert.match(css, /\.accountGridTwo\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  // Ledger and card logic still know card_clearing.
  assert.match(read('app/api/admin/ledger/route.ts'), /account\.type !== "card_clearing" && account\.code !== "card_clearing"/);
  assert.ok(existsSync('lib/ledger/card-settlements.ts'));
});

test('D: 사장 정산 keeps the 4 KPIs and replaces nested accordions with view/edit setting rows', () => {
  const owner = basicTab.slice(basicTab.indexOf('settings-owner-settlement'));
  assert.equal((owner.match(/<div><span>/g) ?? []).length, 4);
  assert.doesNotMatch(owner, /<details|detailPanel|participantSummary|investorSummary/);
  assert.equal((owner.match(/className=\{styles\.settingRow\}/g) ?? []).length, 2);
  // 투자자 구성: names + 적용 시작, [변경] opens the editor right below the row.
  assert.match(owner, /owners\.participants\.map\(row => ownerUserName\(row\.user_id\)\)\.join\(" · "\)/);
  assert.match(owner, /copy\.appliedFrom\(compositionStartMonth\)/);
  assert.match(owner, /onClick=\{\(\) => setParticipantEditorOpen\(value => !value\)\}>\{participantEditorOpen \? copy\.close : copy\.change\}/);
  assert.match(owner, /\{participantEditorVisible \? <div id="owner-participant-editor">\{participantForm\}<\/div> : null\}/);
  // Participant editor: effective month, chip selection with count, single save with the unchanged contract.
  const form = page.slice(page.indexOf('const participantForm'), page.indexOf('return <Container'));
  assert.match(form, /value=\{participantEffectiveMonth\}/);
  assert.match(form, /<span>\{copy\.selectInvestors\}<\/span><small>\{copy\.selectedOfThree\(selectedUsers\.length\)\}<\/small>/);
  assert.match(form, /styles\.ownerChip\} \$\{selected \? styles\.ownerChipActive : ""\}/);
  assert.match(form, /<input className=\{styles\.visuallyHidden\} type="checkbox" checked=\{selected\}/);
  assert.equal((form.match(/<button /g) ?? []).length, 1);
  assert.match(form, /disabled=\{working \|\| selectedUsers\.length !== 3 \|\| !participantEffectiveMonth\}/);
  assert.match(form, /mutate\("\/api\/admin\/ledger\/owners", \{ action: "participants", effectiveMonth: `\$\{participantEffectiveMonth\}-01`, rows: selectedUsers\.map\(\(userId, index\) => \(\{ userId: Number\(userId\), isEligible: true, sortOrder: index \+ 1 \}\)\) \}\)/);
  // 이익 배분 비율: summary/미설정, [설정|변경], per-person % inputs, thin total row, save only at exactly 100%.
  assert.match(owner, /<strong>\{policySummary \?\? copy\.notSet\}<\/strong>/);
  assert.match(owner, /\{policyEditorOpen \? copy\.close : owners\.policy \? copy\.change : copy\.setup\}/);
  assert.match(owner, /owners\.participants\.map\(row => <label className=\{styles\.ownerRateRow\} key=\{row\.id\}><span>\{ownerUserName\(row\.user_id\)\}<\/span><span className=\{styles\.rateInput\}><input/);
  assert.match(owner, /copy\.rateTotalOf\(percentFormat\.format\(ownerRateTotal\)\)/);
  assert.match(owner, /disabled=\{working \|\| !policyEffectiveMonth \|\| !ownerRateTotalValid\}/);
  assert.match(owner, /lines: owners\.participants\.map\(row => \(\{ participantId: row\.id, rate: toRate\(rates\[row\.id\] \?\? "0"\) \}\)\), note: "Owner settlement policy"/);
  assert.match(owner, /<p className=\{styles\.mutedHelp\}>\{copy\.profitShareHelp\}<\/p>/);
  assert.match(css, /\.settingEditor \.rateInput \.input\{width:84px;/);
  assert.match(css, /\.settingEditor \.rateTotal\{[^}]*background:transparent/);
});

test('D: the 100% check uses the exact rates the save sends (server requires sum = 1.000000)', () => {
  const { toRate, rateMicros } = pageHelpers();
  const sum = values => values.reduce((total, value) => total + rateMicros(value), 0);
  assert.equal(toRate('40'), '0.400000');
  assert.equal(sum(['40', '30', '30']), 1_000_000);
  assert.equal(sum(['33.3333', '33.3333', '33.3334']), 1_000_000);
  assert.notEqual(sum(['40', '30', '20']), 1_000_000);
  assert.notEqual(sum(['33.33333', '33.33333', '33.33333']), 1_000_000);
  assert.match(page, /owners!\.participants\.reduce\(\(total, participant\) => total \+ rateMicros\(rates\[participant\.id\] \?\? "0"\), 0\) === 1_000_000/);
  assert.match(read('supabase/migrations/202608210009_add_owner_settlements.sql'), /if v_sum<>1\.000000 then return jsonb_build_object\('status','rates_must_equal_100'\)/);
});

test('E: new owner-row copy is translated for both languages', () => {
  for (const key of ['change', 'setup', 'close', 'selectInvestors', 'applyMonth', 'rateMustBe100']) {
    assert.ok(ledgerSettingsText.ko[key] && ledgerSettingsText.vi[key], key);
  }
  assert.equal(ledgerSettingsText.vi.change, 'Thay đổi');
  assert.equal(ledgerSettingsText.vi.setup, 'Thiết lập');
  assert.equal(ledgerSettingsText.ko.appliedFrom('2025-05'), '2025-05부터 적용');
  assert.equal(ledgerSettingsText.vi.rateTotalOf('100'), '100 / 100%');
  assert.doesNotMatch(ledgerSettingsText.vi.appliedFrom('2025-05'), /[가-힣]/);
});
