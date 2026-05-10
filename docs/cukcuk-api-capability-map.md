# CUKCUK API Capability Map

Last reviewed: 2026-05-07

Scope: BABA 앱에서 CUKCUK Open Platform 기반으로 구현 가능한 POS 매출 조회, 주문/영수증 상세 확인, 상품 코드 기반 재고 자동 차감, 고객/쿠폰 연동 가능성을 정리한다.

Sensitive data policy: `SecretKey`, `AccessToken`, `Authorization` 전체 값, 실제 env 값은 문서와 로그에 남기지 않는다. 테스트 응답에 토큰류가 포함될 경우 앞/뒤 일부만 마스킹한다.

Base URL: `https://graphapi.cukcuk.vn`

## 공통 구조

- 인증 필요 API header: `Authorization: Bearer <AccessToken>`, `CompanyCode: <CompanyCode>`.
- 공통 응답 wrapper: `ServiceResult` 형태로 `Code`, `ErrorType`, `ErrorMessage`, `Success`, `Environment`, `Data`, `Total`을 사용한다.
- pagination 계열은 대체로 `Page`, `Limit`를 사용하며 문서상 `Limit` 최대값은 100이다.
- 동기화 기준 시각은 문서 예시 기준 `2020-05-04T09:28:55.854Z` 같은 ISO 8601 UTC 문자열이다.
- 문서 예시 body는 `BranchId`를 쓰지만 일부 definition은 `BranchID`로 표기한다. API 호출은 각 endpoint 예시의 casing을 우선하고, 응답 파싱은 `BranchId`와 `BranchID`를 모두 방어적으로 처리하는 편이 안전하다.

## 핵심 판단 요약

1. `inventoryitems/paging`은 `Data[].Code`를 실제 응답 예시에 포함한다. BABA `inventory.code`와 매핑할 수 있다.
2. `sainvoices/{refId}`와 `sainvoices/detail/{refId}`의 `SAInvoiceDetails[]`에는 `ItemCode`가 문서 예시와 definition 모두에 있다.
3. `orders/{orderId}`의 `OrderDetails[]`에는 `ItemId`, `ItemName`, `Quantity`, `Price`, `Amount` 등은 있으나 문서상 `ItemCode`가 없다.
4. 결제 완료/취소 판단은 재고 차감 목적이라면 `orders.Status`보다 `sainvoices.PaymentStatus`가 더 안전하다. `PaymentStatus=3`은 결제 완료, `4`는 취소, `5`는 임시 취소로 문서화되어 있다.
5. 재고 차감 기준의 안정적인 고유키는 invoice line 단위로 `SAInvoice.RefId + SAInvoiceDetails[].RefDetailID` 조합이다. 상품 매핑은 `SAInvoiceDetails[].ItemCode`를 `inventory.code`와 연결한다.
6. 중복 차감 방지를 위해 저장해야 할 POS id는 invoice header의 `RefId`와 line의 `RefDetailID`이다. 보조 키로 `OrderId`, `OrderDetailID`, `RefNo`, `BranchId`, `PaymentStatus`를 함께 저장한다.
7. 주문 목록/상세는 운영 상태 확인에는 유용하지만, 상품 코드가 없으므로 자동 재고 차감의 primary source로 쓰지 않는 것이 맞다.
8. 취소/환불/임시취소는 `PaymentStatus`와 `CancelDate`, `CancelBy`, `CancelReason`을 기준으로 차감 취소 또는 보류 로직을 설계해야 한다.
9. 세트/콤보/옵션은 `InventoryItem.ItemType`, `InventoryItem.Children`, `AdditionCategories`, invoice line의 `ParentID`, `InventoryItemAdditionID`, `RefDetailType`를 함께 봐야 한다. 자동 차감은 code가 명확한 line만 적용하고 parent/child 중복 차감 방지가 필요하다.

## 로컬 POS 관련 파일 구조

- `app/api/pos/cukcuk/login-test/route.ts`: CUKCUK 로그인 테스트 route. 응답 토큰 마스킹 처리.
- `lib/pos/cukcuk/auth.ts`: 로그인 서명 생성, env 로딩, 로그인 호출 helper.
- `app/(protected)/sales/page.tsx`: POS 연동 준비 상태를 보여주는 sales placeholder/dashboard 성격의 화면.

현재 로컬에는 주문/영수증/재고 차감용 CUKCUK API route가 아직 없다.

## API별 Capability Map

### 1. Login

- endpoint: `api/Account/Login`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/index.html
- 기능 요약: CUKCUK API 호출에 필요한 `AccessToken`, `CompanyCode`, `Environment`를 발급한다.
- request header: 없음. `Content-Type: application/json`.
- request body/query/path param: `Domain`, `AppID`, `LoginTime`, `SignatureInfo`.
- 주요 response fields: `Data.AppID`, `Data.Domain`, `Data.AccessToken`, `Data.CompanyCode`, `Data.Environment`, `Success`, `ErrorType`.
- BABA 앱에서 구현 가능한 기능: 서버 route에서 POS API 인증 토큰 발급, 토큰 캐시, 만료 시 재로그인.
- 재고 자동 차감과 관련성: 모든 POS 조회 API의 선행 조건.
- 매출 페이지와 관련성: 모든 매출/주문/영수증 조회의 선행 조건.
- 멤버십/쿠폰 기능과 관련성: 고객/프로모션 API 호출의 선행 조건.
- 위험도 또는 주의점: `SecretKey`, `AccessToken`, 전체 `Authorization` 값 노출 금지. 동시 login request는 `ErrorType=102`가 날 수 있다.
- 우선순위: 높음

### 2. Branch List

- endpoint: `api/v1/branchs/all`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/branchs_all.html
- 기능 요약: 레스토랑의 지점 목록을 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `includeInactive` query/uri parameter. 문서 예시는 inactive 포함 여부를 사용한다.
- 주요 response fields: `Data[].Id`, `Code`, `Name`, `IsBaseDepot`, `IsChainBranch`, `Inactive`.
- BABA 앱에서 구현 가능한 기능: 지점 선택, 지점별 매출 필터, 지점별 재고 차감 범위 지정.
- 재고 자동 차감과 관련성: 차감 대상 branch 식별에 필요.
- 매출 페이지와 관련성: 매출 조회 필터의 기본 축.
- 멤버십/쿠폰 기능과 관련성: 프로모션/쿠폰 적용 branch 확인에 필요.
- 위험도 또는 주의점: offline/동기화 지연 환경에서는 지점별 데이터 반영이 늦을 수 있다.
- 우선순위: 높음

### 3. Branch Setting

- endpoint: `api/v1/branchs/setting/{branchId}`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/branchs_setting.html
- 기능 요약: 지점별 세금/서비스료/배송 관련 계산 설정을 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `branchId`.
- 주요 response fields: `Id`, `HasVATRate`, `VATRate`, `VATForDelivery`, `VATForTakeAway`, `HasCalcService`, `ServiceRate`, `AmountService`, `Code`, `Name`.
- BABA 앱에서 구현 가능한 기능: POS와 동일한 주문 금액 계산 검증, 매출 분석 보조 정보.
- 재고 자동 차감과 관련성: 직접 관련은 낮음.
- 매출 페이지와 관련성: 세금/서비스료/총액 설명에 유용.
- 멤버십/쿠폰 기능과 관련성: 쿠폰/프로모션 계산 검증에 보조적으로 사용 가능.
- 위험도 또는 주의점: 계산을 BABA에서 재현할 경우 POS 설정 변경에 민감하다.
- 우선순위: 중간

### 4. Categories List

- endpoint: `api/v1/categories/list?includeInactive={true|false}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/inventoryitemcategories_list.html
- 기능 요약: 메뉴/상품 카테고리 목록을 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: query `includeInactive`.
- 주요 response fields: `Data[].Id`, `Code`, `Name`, `Description`, `IsLeaf`, `Grade`, `Inactive`.
- BABA 앱에서 구현 가능한 기능: POS 상품 카테고리 동기화, 매출 카테고리 필터.
- 재고 자동 차감과 관련성: 차감 대상 상품 분류와 예외 규칙 작성에 보조적.
- 매출 페이지와 관련성: 카테고리별 매출 집계.
- 멤버십/쿠폰 기능과 관련성: 카테고리 기반 프로모션 표시.
- 위험도 또는 주의점: 사용자가 요청한 endpoint는 맞지만 문서 파일명은 `inventoryitemcategories_list.html`이다.
- 우선순위: 중간

### 5. Customers Create

- endpoint: `api/v1/customers/`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/customers_create.html
- 기능 요약: 고객 정보를 CUKCUK에 신규 저장한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Customer` body. 주요 필드 `BranchId`, `Code`, `Name`, `Tel`, `Birthday`, `Address`, `Email`, `Description`, `Inactive`.
- 주요 response fields: `Data[].Id`, `Code`, `Name`, `Tel`, `Birthday`, `Address`, `Inactive`; 중복 시 `ErrorType=200`.
- BABA 앱에서 구현 가능한 기능: BABA 회원을 POS 고객으로 생성.
- 재고 자동 차감과 관련성: 없음.
- 매출 페이지와 관련성: 고객별 매출 연결에 필요.
- 멤버십/쿠폰 기능과 관련성: 회원/고객 통합의 핵심 API.
- 위험도 또는 주의점: 전화번호 또는 고객 코드 중복 시 실패한다. 개인정보 동기화 정책 필요.
- 우선순위: 중간

### 6. Customers Paging

- endpoint: `api/v1/customers/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/customers_paging.html
- 기능 요약: 고객 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `IncludeInactive`, `LastSyncDate`.
- 주요 response fields: `Data[].Id`, `Code`, `Name`, `Tel`, `NormalizedTel`, `Email`, `Birthday`, `TotalAmount`, `CustomerCategoryID`, `CustomerCategoryName`.
- BABA 앱에서 구현 가능한 기능: POS 고객 검색, BABA 회원과 POS 고객 매칭.
- 재고 자동 차감과 관련성: 없음.
- 매출 페이지와 관련성: 고객별 매출 필터/표시.
- 멤버십/쿠폰 기능과 관련성: 고객 등급/전화번호 기반 쿠폰 연동.
- 위험도 또는 주의점: 개인정보 취급, `LastSyncDate` 기반 증분 동기화 상태 저장 필요.
- 우선순위: 중간

### 7. Employees Paging

- endpoint: `api/v1/employees/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/employees_paging.html
- 기능 요약: 직원 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `BranchId`, `LastSyncDate`.
- 주요 response fields: `Data[].Id`, `BranchId`, `Code`, `FirstName`, `LastName`, `FullName`, `Gender`, `Mobile`, `Email`, `RoleCode`.
- BABA 앱에서 구현 가능한 기능: POS 직원과 BABA 직원 매핑, 매출 담당자 표시.
- 재고 자동 차감과 관련성: 차감 실행자/매출 담당자 기록에 보조적.
- 매출 페이지와 관련성: 직원별 매출 조회.
- 멤버십/쿠폰 기능과 관련성: 직접 관련 낮음.
- 위험도 또는 주의점: BABA auth user와 POS employee는 별도 id 체계이므로 명시적 mapping 필요.
- 우선순위: 낮음

### 8. Inventory Items Paging

- endpoint: `api/v1/inventoryitems/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/inventoryitems_paging.html
- 기능 요약: POS 상품/메뉴 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `BranchId`, `CategoryId`/`CategoryID`, `KeySearch`, `IncludeInactive`.
- 주요 response fields: `Data[].Id`, `Code`, `ItemType`, `Name`, `CategoryID`, `CategoryName`, `Price`, `Inactive`, `UnitID`, `UnitName`, `IsSeftPrice`, `AllowAdjustPrice`.
- BABA 앱에서 구현 가능한 기능: POS 상품 코드 동기화, `inventory.code`와 POS `Code` 매핑 점검, 미매칭 상품 리포트.
- 재고 자동 차감과 관련성: 매우 높음. `Code`가 실제 내려오므로 BABA `inventory.code` 매핑 기준으로 사용할 수 있다.
- 매출 페이지와 관련성: 상품명/가격/카테고리 표시.
- 멤버십/쿠폰 기능과 관련성: 쿠폰 대상 상품 표시.
- 위험도 또는 주의점: `ItemType`이 combo/group/material 등으로 다양하다. 모든 상품을 단순 판매품으로 보면 중복 차감 위험이 있다.
- 우선순위: 높음

### 9. Inventory Item Detail

- endpoint: `api/v1/inventoryitems/detail/{inventoryItemId}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/inventoryitems_detail.html
- 기능 요약: 특정 POS 상품/메뉴 상세를 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `inventoryItemId`.
- 주요 response fields: `Id`, `Code`, `ItemType`, `Name`, `Children`, `AdditionCategories[].Additions[]`, `Price`, `UnitID`, `UnitName`, `Inactive`.
- BABA 앱에서 구현 가능한 기능: 세트/콤보/옵션 구조 확인, 상품 상세 매핑 검증.
- 재고 자동 차감과 관련성: 높음. combo/group/option 처리 규칙 설계에 필요하다.
- 매출 페이지와 관련성: 상품 상세 drawer, 상품 옵션 표시.
- 멤버십/쿠폰 기능과 관련성: 프로모션 대상 상품 상세 확인.
- 위험도 또는 주의점: `Children`과 additions가 있을 때 parent line과 child line을 동시에 차감하면 중복 차감 가능.
- 우선순위: 높음

### 10. Tables

- endpoint: `api/v1/tables/{branchID}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/tables.html
- 기능 요약: 지점의 테이블/구역 목록과 사용 가능 여부를 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `branchID`.
- 주요 response fields: `Data.ListTable[].MapObjectID`, `MapObjectName`, `AreaID`, `AreaName`, `IsAvailable`, `Data.AllowMergeTable`.
- BABA 앱에서 구현 가능한 기능: 테이블별 주문 상태 표시.
- 재고 자동 차감과 관련성: 없음.
- 매출 페이지와 관련성: 테이블별 매출/주문 표시 보조.
- 멤버십/쿠폰 기능과 관련성: 없음.
- 위험도 또는 주의점: 문서 note에 따르면 offline 모델에서는 테이블 상태가 실시간이 아닐 수 있다.
- 우선순위: 낮음

### 11. Orders Paging

- endpoint: `api/v1/orders/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/orders_paging.html
- 기능 요약: 주문 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `BranchId` 예시 사용, definition에는 `BranchID`, `LastSyncDate`.
- 주요 response fields: `Data[].Id`, `Type`, `No`, `BranchId`, `Status`, `Date`, `ShippingDate`, `CustomerId`, `CustomerName`, `CustomerTel`, `DeliveryAmount`, `DepositAmount`, `TotalAmount`.
- BABA 앱에서 구현 가능한 기능: 주문 목록, 주문 상태 모니터링.
- 재고 자동 차감과 관련성: 중간. 결제 완료 후보를 찾는 데는 쓸 수 있으나 상품 코드가 없어서 직접 차감 기준으로는 부적합.
- 매출 페이지와 관련성: 주문 탭/운영 상태 표시.
- 멤버십/쿠폰 기능과 관련성: 고객 주문 이력 표시.
- 위험도 또는 주의점: `Status=4`가 결제 완료로 보이지만 invoice의 `PaymentStatus`와 대조해야 한다.
- 우선순위: 중간

### 12. Order Detail

- endpoint: `api/v1/orders/{orderId}` 문서상 detail endpoint
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/orders_detail.html
- 기능 요약: 주문 상세와 `OrderDetails`를 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `orderId`.
- 주요 response fields: `Id`, `Type`, `No`, `BranchId`, `Status`, `Date`, `ShippingDate`, `Customer*`, `TotalAmount`, `TableName`, `OrderDetails[].Id`, `ItemName`, `ItemId`, `AdditionId`, `ParentId`, `UnitName`, `Quantity`, `Status`, `Price`, `Amount`.
- BABA 앱에서 구현 가능한 기능: 주문 상세 보기, 주문 line 확인.
- 재고 자동 차감과 관련성: 낮음. 문서상 `OrderDetails`에 `ItemCode`가 없다.
- 매출 페이지와 관련성: 주문 상세 화면.
- 멤버십/쿠폰 기능과 관련성: 고객 주문 상세 표시.
- 위험도 또는 주의점: 사용자가 적은 `/orders/detail`이 아니라 문서상 `/orders/{orderId}`다. line code가 없어 `ItemId`를 별도 inventory item detail로 보강해야 한다.
- 우선순위: 중간

### 13. Orders Create

- endpoint: `api/v1/orders/create`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/orders_create.html
- 기능 요약: CUKCUK에 주문을 생성한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Id`, `BranchId`, `Type`, `No`, `CustomerId`, `CustomerName`, `CustomerTel`, `EmployeeId`, `ShippingAddress`, `Date`, `ShippingDate`, `RequestDescription`, `OrderDetails[]`, `ListTableID`.
- 주요 response fields: created order `Id`, `No`, `BranchId`, `Status`, `Date`, `ShippingDate`, `Customer*`, `TotalAmount`, `TableName`, `OrderDetails[]`.
- BABA 앱에서 구현 가능한 기능: BABA에서 POS 주문 생성.
- 재고 자동 차감과 관련성: 직접 차감보다는 주문 생성 기능. 판매 확정 후 invoice와 연결해야 안전하다.
- 매출 페이지와 관련성: 향후 BABA 주문 입력 기능.
- 멤버십/쿠폰 기능과 관련성: 회원 주문 생성 가능.
- 위험도 또는 주의점: 금액/세금/서비스료 계산 책임이 클 수 있고, 주문 상태 오류가 발생할 수 있다. 현재 BABA 목표인 POS 매출 조회에는 후순위.
- 우선순위: 낮음

### 14. Orders Update Item

- endpoint: `api/v1/orders/update-item`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/orders_update-item.html
- 기능 요약: 생성된 주문의 상품 목록을 변경한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Id`, `Type`, `No`, `BranchId`, `Status`, `Date`, `ShippingDate`, `Customer*`, `EmployeeId`, `OrderDetails[]`, `Version`.
- 주요 response fields: updated order `Id`, `Status`, `OrderDetails[]`, `TotalAmount`.
- BABA 앱에서 구현 가능한 기능: BABA에서 POS 주문 item 수정.
- 재고 자동 차감과 관련성: 낮음. 확정 매출 차감은 invoice 기준으로 별도 처리.
- 매출 페이지와 관련성: 주문 편집 기능이 생길 때 관련.
- 멤버십/쿠폰 기능과 관련성: 직접 관련 낮음.
- 위험도 또는 주의점: 결제/주방 전송 이후 수정 가능 여부와 상태 제약이 크다. `ErrorType=258` 주문 상태 불가 가능.
- 우선순위: 낮음

### 15. Order Onlines Create

- endpoint: `api/v1/order-onlines/create`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/orderonlines_create.html
- 기능 요약: 웹/앱에서 온라인 주문을 생성해 CUKCUK PC 판매 프로그램으로 동기화한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `BranchId`, `OrderId`, `OrderCode`, `OrderType`, `CustomerId`, `CustomerName`, `CustomerTel`, `ShippingAddress`, `ShippingDueDate`, `ShippingTimeType`, `TotalAmount`, `Amount`, `TaxAmount`, `DiscountAmount`, `DeliveryAmount`, `DepositAmount`, `PaymentStatus`, `OrderSource`, `OrderItems[]`.
- 주요 response fields: `Data`에 생성된 `OrderCode`, `Success`.
- BABA 앱에서 구현 가능한 기능: BABA 앱 주문을 POS로 내려보내기.
- 재고 자동 차감과 관련성: 낮음. 온라인 주문 생성은 재고 차감 trigger가 아니라 판매 확정 invoice와 결합해야 한다.
- 매출 페이지와 관련성: 향후 온라인 주문 접수 기능.
- 멤버십/쿠폰 기능과 관련성: 회원 주문/쿠폰 주문 생성 가능.
- 위험도 또는 주의점: 문서 파일명은 `orderonlines_create.html`이다. 문서 note에 따르면 그룹 상품은 item 분리, 재료형/콤보는 `Children` 사용, API promotion 적용은 지원하지 않는다고 명시되어 있다.
- 우선순위: 낮음

### 16. SAInvoices Paging

- endpoint: `api/v1/sainvoices/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html
- 기능 요약: 매출 전표/영수증 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `BranchId` 예시 사용, definition에는 `BranchID`, `HaveCustomer`, `LastSyncDate`.
- 주요 response fields: `Data[].RefId`, `RefType`, `RefNo`, `RefDate`, `BranchId`, `OrderType`, `CustomerId`, `CustomerName`, `EmployeeId`, `EmployeeName`, `TotalAmount`, `SaleAmount`, `PaymentStatus`, `AvailablePoint`, `UsedPoint`, `AddPoint`.
- BABA 앱에서 구현 가능한 기능: POS 매출 목록, 결제 상태별 매출 필터, 고객/직원별 매출.
- 재고 자동 차감과 관련성: 높음. 차감 대상 invoice 후보를 찾는 primary list API.
- 매출 페이지와 관련성: 매우 높음. 매출 페이지의 기본 목록 API.
- 멤버십/쿠폰 기능과 관련성: 포인트/고객/결제 상태 조회에 유용.
- 위험도 또는 주의점: 목록에는 상세 line이 없을 수 있으므로 차감 전 `sainvoices/{refId}` 또는 `sainvoices/detail/{refId}` 호출 필요.
- 우선순위: 높음

### 17. SAInvoice By RefId

- endpoint: `api/v1/sainvoices/{refId}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/sainvoices.html
- 기능 요약: invoice header와 detail/payments/coupons/VAT 정보를 함께 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `refId`.
- 주요 response fields: `RefId`, `RefNo`, `RefDate`, `BranchId`, `OrderId`, `PaymentStatus`, `CancelDate`, `CancelBy`, `CancelReason`, `TotalAmount`, `SaleAmount`, `SAInvoiceDetails[]`, `SAInvoicePayments[]`, `SAInvoiceCoupons[]`.
- BABA 앱에서 구현 가능한 기능: 매출 상세, 결제수단 표시, 쿠폰 사용 내역, 재고 차감 line 추출.
- 재고 자동 차감과 관련성: 매우 높음. `SAInvoiceDetails[].ItemCode`, `RefDetailID`, `Quantity`, `UnitPrice`, `Amount`, `ParentID`, `InventoryItemType`, `OrderDetailID`가 있어 차감에 가장 적합하다.
- 매출 페이지와 관련성: 매우 높음.
- 멤버십/쿠폰 기능과 관련성: `SAInvoiceCoupons[]`, `AvailablePoint`, `UsedPoint`, `AddPoint`, `MembershipCardId` 활용 가능.
- 위험도 또는 주의점: `PaymentStatus=3`만 차감 대상으로 보고 `4/5`는 차감 금지 또는 reverse candidate로 처리해야 한다.
- 우선순위: 높음

### 18. SAInvoice Detail

- endpoint: `api/v1/sainvoices/detail/{refId}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html
- 기능 요약: invoice 상세 line 중심 정보를 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `refId`.
- 주요 response fields: `SAInvoiceDetails[].RefDetailID`, `RefID`, `ItemID`, `ItemCode`, `ItemName`, `Quantity`, `UnitPrice`, `UnitID`, `UnitName`, `Amount`, `ParentID`, `InventoryItemAdditionID`, `InventoryItemType`, `OrderDetailID`, `PromotionAmount`, `TaxAmount`.
- BABA 앱에서 구현 가능한 기능: 재고 차감 전용 line 조회, 상세 line 검증.
- 재고 자동 차감과 관련성: 매우 높음. line의 `ItemCode`가 직접 내려온다.
- 매출 페이지와 관련성: 매출 상세 line 표시.
- 멤버십/쿠폰 기능과 관련성: line-level promotion 표시.
- 위험도 또는 주의점: header 결제 상태 판단은 `sainvoices/{refId}` 또는 paging 결과의 `PaymentStatus`와 함께 써야 한다.
- 우선순위: 높음

### 19. Promotions Paging

- endpoint: `api/v1/promotions/paging`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/promotions_paging.html
- 기능 요약: 프로모션 목록을 페이지 단위로 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Page`, `Limit`, `BranchId` 예시 사용, definition에는 `BranchID`, `LastSyncDate`.
- 주요 response fields: `Data[].Id`, `Name`, `Description`, `Type`, `FromDate`, `ToDate`, 요일 flags, `DiscountRate`, `DiscountAmount`, `Object`, `Condition`, `ApplyType`, `IsAutoApply`, `IsCreated`, `IsPublish`.
- BABA 앱에서 구현 가능한 기능: 진행 중인 POS 프로모션 표시, 쿠폰 생성/발행 대상 조회.
- 재고 자동 차감과 관련성: 낮음. promotion line은 차감 수량/금액 조정 설명에 보조적.
- 매출 페이지와 관련성: 할인/프로모션 설명.
- 멤버십/쿠폰 기능과 관련성: 높음.
- 위험도 또는 주의점: 할인 계산을 BABA가 직접 재현하면 POS 정책과 불일치 위험.
- 우선순위: 중간

### 20. Promotion Detail

- endpoint: `api/v1/promotions/{id}`
- method: `GET`
- source: https://graphapi.cukcuk.vn/document/api/promotions_detail.html
- 기능 요약: 프로모션 상세 조건과 적용 branch/상품을 조회한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `promotionId` 또는 `id`.
- 주요 response fields: `Id`, `Name`, `Type`, `FromDate`, `ToDate`, `Details[].ItemCode`, `ItemName`, `Quantity`, `DiscountRate`, `DiscountAmount`, `Amount`, `ItemType`, `BranchApply[]`, `Conditions[]`.
- BABA 앱에서 구현 가능한 기능: 쿠폰/프로모션 상세 표시, 적용 상품/지점 확인.
- 재고 자동 차감과 관련성: 낮음. 단, 증정/할인 상품을 line 처리할 때 참고 가능.
- 매출 페이지와 관련성: 할인 원인 표시.
- 멤버십/쿠폰 기능과 관련성: 높음.
- 위험도 또는 주의점: 문서 예시 URL에 `promnotions` 오타가 보이나 endpoint 제목은 `api/v1/promotions/{id}`이다.
- 우선순위: 중간

### 21. Promotions Created Coupon

- endpoint: `api/v1/promotions/created-coupon`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/promotions_created-coupon.html
- 기능 요약: 프로모션별 branch의 쿠폰 코드 생성 완료 상태를 갱신한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: `Id`, `BranchApplies[].Id`, `BranchApplies[].Created`.
- 주요 response fields: `Success`, `Code`, `ErrorType`.
- BABA 앱에서 구현 가능한 기능: BABA에서 쿠폰 생성 작업 완료 상태를 POS에 반영.
- 재고 자동 차감과 관련성: 없음.
- 매출 페이지와 관련성: 없음.
- 멤버십/쿠폰 기능과 관련성: 중간.
- 위험도 또는 주의점: 쿠폰 코드 자체 생성 API가 아니라 생성 상태 update API다. `ErrorType=302` 프로모션 없음 가능.
- 우선순위: 낮음

### 22. Promotions Publish Coupon

- endpoint: `api/v1/promotions/publish-coupon/{id}`
- method: `POST`
- source: https://graphapi.cukcuk.vn/document/api/promotions_publish-coupon.html
- 기능 요약: 프로모션 쿠폰 발행 완료 상태를 갱신한다.
- request header: `Authorization`, `CompanyCode`.
- request body/query/path param: path `id`. 문서상 body parameter도 표기되어 있으나 예시는 path만 사용한다.
- 주요 response fields: `Success`, `Code`, `ErrorType`.
- BABA 앱에서 구현 가능한 기능: 쿠폰 발행 완료 상태 반영.
- 재고 자동 차감과 관련성: 없음.
- 매출 페이지와 관련성: 없음.
- 멤버십/쿠폰 기능과 관련성: 중간.
- 위험도 또는 주의점: 발행 상태 update일 뿐 쿠폰 배포/검증 전체 기능으로 오해하면 안 된다.
- 우선순위: 낮음

## 재고 자동 차감 설계 기준

### 권장 데이터 흐름

1. `api/Account/Login`으로 서버에서 토큰 발급 또는 캐시 확인.
2. `api/v1/branchs/all`로 branch id 확보.
3. `api/v1/inventoryitems/paging`으로 POS 상품 `Code`와 BABA `inventory.code` 매핑 테이블 구축.
4. `api/v1/sainvoices/paging`을 `BranchId`, `LastSyncDate`로 조회해 변경 invoice 후보 확보.
5. `PaymentStatus=3`인 invoice만 차감 후보로 처리한다.
6. 각 후보에 대해 `api/v1/sainvoices/{refId}` 또는 `api/v1/sainvoices/detail/{refId}`로 line 상세 조회.
7. `SAInvoiceDetails[].ItemCode`가 BABA `inventory.code`와 일치하는 line만 차감한다.
8. `pos_source`, `branch_id`, `invoice_ref_id`, `invoice_ref_no`, `invoice_ref_date`, `invoice_payment_status`, `invoice_detail_id`, `order_id`, `order_detail_id`, `item_code`, `quantity`를 저장한다.
9. `(source, invoice_ref_id, invoice_detail_id)` unique constraint로 중복 차감을 차단한다.
10. 이후 같은 invoice가 `PaymentStatus=4` 또는 `5`로 재조회되면 기존 차감 내역을 찾아 reverse 또는 보류 상태로 전환한다.

### 차감 제외 또는 수동 확인 대상

- `PaymentStatus`가 `0`, `1`, `2`, `4`, `5`인 invoice.
- `ItemCode`가 없거나 BABA `inventory.code`와 매칭되지 않는 line.
- `RefDetailType=2` 추가 옵션, `InventoryItemAdditionID`가 있는 line.
- `ParentID`가 있는 child line과 parent combo line이 동시에 있는 경우.
- `InventoryItemType=4` combo, `12` optional combo, `2` ingredient item, `3` group item 등 line 구조가 중복 차감 가능성을 만드는 경우.

## 구현 가능한 기능 전체

- POS 연결 상태 확인: login API.
- 지점 동기화: branch list/settings.
- POS 상품 동기화: categories, inventoryitems paging/detail.
- POS 매출 목록: sainvoices paging.
- POS 매출 상세: sainvoices by id/detail.
- 재고 자동 차감: paid invoice line의 `ItemCode`와 `RefDetailID` 기반.
- 취소/임시취소 반영: `PaymentStatus`, `CancelDate`, `CancelBy`, `CancelReason` 기반 reverse/hold.
- 주문 모니터링: orders paging/detail.
- 온라인 주문 생성: order-onlines create.
- POS 주문 생성/수정: orders create/update-item.
- 고객 동기화: customers paging/create.
- 직원 동기화: employees paging.
- 프로모션 조회: promotions paging/detail.
- 쿠폰 생성/발행 상태 반영: promotions created-coupon/publish-coupon.

## 추천 API route 구현 순서

1. `GET /api/pos/cukcuk/branches`: login helper 재사용, branch 목록 조회.
2. `POST /api/pos/cukcuk/inventory-items/sync-preview`: POS `Code`와 BABA `inventory.code` 매칭/미매칭 미리보기.
3. `POST /api/pos/cukcuk/sales/invoices`: `sainvoices/paging` 기반 매출 목록 조회.
4. `GET /api/pos/cukcuk/sales/invoices/[refId]`: invoice detail 조회와 token masking/logging 정책 적용.
5. `POST /api/pos/cukcuk/inventory-deductions/preview`: 차감 대상 line 산출, 제외 사유 리포트.
6. `POST /api/pos/cukcuk/inventory-deductions/apply`: idempotent 차감 적용. unique key로 중복 방지.
7. `POST /api/pos/cukcuk/inventory-deductions/reconcile`: 취소/임시취소/수정 invoice 재조회 후 reverse 또는 보류 처리.
8. `POST /api/pos/cukcuk/orders`: 주문 목록/상세 조회는 매출 화면 보조 기능으로 후순위.
9. `POST /api/pos/cukcuk/customers/sync`: 멤버십 연동이 확정된 후 고객 동기화.
10. `POST /api/pos/cukcuk/promotions/sync`: 쿠폰/프로모션 화면이 확정된 후 구현.

## Source Links

- Account login: https://graphapi.cukcuk.vn/document/api/index.html
- Branchs all: https://graphapi.cukcuk.vn/document/api/branchs_all.html
- Branchs setting: https://graphapi.cukcuk.vn/document/api/branchs_setting.html
- Categories list: https://graphapi.cukcuk.vn/document/api/inventoryitemcategories_list.html
- Customers create: https://graphapi.cukcuk.vn/document/api/customers_create.html
- Customers paging: https://graphapi.cukcuk.vn/document/api/customers_paging.html
- Employees paging: https://graphapi.cukcuk.vn/document/api/employees_paging.html
- Inventory items paging: https://graphapi.cukcuk.vn/document/api/inventoryitems_paging.html
- Inventory item detail: https://graphapi.cukcuk.vn/document/api/inventoryitems_detail.html
- Tables: https://graphapi.cukcuk.vn/document/api/tables.html
- Orders paging: https://graphapi.cukcuk.vn/document/api/orders_paging.html
- Order detail: https://graphapi.cukcuk.vn/document/api/orders_detail.html
- Orders create: https://graphapi.cukcuk.vn/document/api/orders_create.html
- Orders update item: https://graphapi.cukcuk.vn/document/api/orders_update-item.html
- Order onlines create: https://graphapi.cukcuk.vn/document/api/orderonlines_create.html
- SAInvoices paging: https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html
- SAInvoice by id: https://graphapi.cukcuk.vn/document/api/sainvoices.html
- SAInvoice detail: https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html
- Promotions paging: https://graphapi.cukcuk.vn/document/api/promotions_paging.html
- Promotion detail: https://graphapi.cukcuk.vn/document/api/promotions_detail.html
- Promotions created coupon: https://graphapi.cukcuk.vn/document/api/promotions_created-coupon.html
- Promotions publish coupon: https://graphapi.cukcuk.vn/document/api/promotions_publish-coupon.html
