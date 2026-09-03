export type VmmsProductMappingSeed = {
  colNo: string;
  rawProduct: string;
  actualProduct: string;
};

// VMMS returns the configured machine slot name in `product`, not always the
// item actually sold. The slot (`col_no`) is the stable identifier.
export const VMMS_PRODUCT_MAPPING_SEED: VmmsProductMappingSeed[] = [
  { colNo: "1", rawProduct: "연한 아메리카노(카페만월경 서현점)", actualProduct: "연한 아메리카노" },
  { colNo: "2", rawProduct: "진한 아메리카노(카페만월경 서현점)", actualProduct: "진한 아메리카노" },
  { colNo: "3", rawProduct: "아이스아메리카노(카페만월경 서현점)", actualProduct: "아이스아메리카노" },
  { colNo: "4", rawProduct: "카페라떼(카페만월경 서현점)", actualProduct: "카페라떼" },
  { colNo: "5", rawProduct: "아이스카페라떼(카페만월경 서현점)", actualProduct: "아이스카페라떼" },
  { colNo: "6", rawProduct: "카페모카(카페만월경 서현점)", actualProduct: "복숭아아메리카노" },
  { colNo: "7", rawProduct: "아이스카페모카(카페만월경 서현점)", actualProduct: "아이스초코" },
  { colNo: "8", rawProduct: "핫초코(카페만월경 서현점)", actualProduct: "초코밀크" },
  { colNo: "9", rawProduct: "아이스초코(카페만월경 서현점)", actualProduct: "청포도에이드" },
  { colNo: "10", rawProduct: "바닐라라떼(카페만월경 서현점)", actualProduct: "자몽에이드" },
  { colNo: "14", rawProduct: "수박에이드(카페만월경 서현점)", actualProduct: "복숭아아이스티" },
  { colNo: "15", rawProduct: "자몽에이드(카페만월경 서현점)", actualProduct: "카페모카" },
  { colNo: "16", rawProduct: "장바구니(카페만월경 서현점)", actualProduct: "아이스카페모카" },
  { colNo: "17", rawProduct: "미등록 상품[17]", actualProduct: "얼음컵" },
  { colNo: "18", rawProduct: "미등록 상품[18]", actualProduct: "뜨거운물" },
  { colNo: "99", rawProduct: "미등록 상품[99]", actualProduct: "일괄 구매" },
];
