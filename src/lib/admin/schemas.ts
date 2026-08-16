/**
 * Zod schemas for the admin back office.
 *
 * localizedSchema mirrors the DB's is_localized() CHECK constraint (see
 * supabase/migrations/0001_init.sql:56-68): zh/en/ja must all be present and
 * non-empty. Validating this client-side means the 23514 constraint violation
 * never happens in practice — the form blocks submission with a field-level
 * message instead of a raw Postgres error code.
 */
import { z } from "zod";

export const localizedSchema = z.object({
  zh: z.string().trim().min(1, "請輸入中文內容"),
  en: z.string().trim().min(1, "請輸入英文內容"),
  ja: z.string().trim().min(1, "請輸入日文內容"),
});

export type LocalizedInput = z.infer<typeof localizedSchema>;

/**
 * Covers both create and update: `id` absent/empty means "create a new row"
 * (src/server/repos/news.ts generates one). Present means "update that row".
 */
export const newsSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字，例如 2026.05.22–05.24"),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});

export type NewsFormValues = z.infer<typeof newsSchema>;

/** Shared by every resource that can be hidden from the public site. */
const publishFields = {
  id: z.string().trim().min(1).optional(),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
};

/**
 * events.registration_type is a CHECK constraint in the DB, so the enum here is
 * not a UI preference — a value outside these two is rejected by Postgres.
 */
const registrationFields = {
  external_url: z.string().trim().url("請輸入完整網址（含 https://）"),
  registration_type: z.enum(["external", "internal"]),
  payment_enabled: z.boolean(),
};

export const eventSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字"),
  // Nullable in the DB and never populated by the original content; kept
  // optional so the form does not invent a date.
  iso_date: z.string().trim().optional().nullable(),
  category: z.string().trim().min(1, "請選擇分類"),
  ...registrationFields,
});
export type EventFormValues = z.infer<typeof eventSchema>;

export const eventCategorySchema = z.object({
  id: z.string().trim().min(1, "請輸入分類代碼"),
  label: localizedSchema,
  sort_order: z.number().int("排序必須是整數"),
});
export type EventCategoryFormValues = z.infer<typeof eventCategorySchema>;

export const exhibitionSchema = z.object({
  ...publishFields,
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  // Plain text, not localized — the source data stores a date range string.
  period: z.string().trim().min(1, "請輸入展期"),
  location: localizedSchema,
  image_key: z.string().trim().optional().nullable(),
});
export type ExhibitionFormValues = z.infer<typeof exhibitionSchema>;

export const journeySchema = z.object({
  ...publishFields,
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  days: localizedSchema,
  theme: localizedSchema,
  ...registrationFields,
});
export type JourneyFormValues = z.infer<typeof journeySchema>;

export const collaborationSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CollaborationFormValues = z.infer<typeof collaborationSchema>;

export const curatedThemeSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CuratedThemeFormValues = z.infer<typeof curatedThemeSchema>;

/** curated_items.id is a bigint identity, so it is a number rather than text. */
export const curatedItemSchema = z.object({
  id: z.number().int().optional(),
  theme_id: z.string().trim().min(1),
  name: localizedSchema,
  note: localizedSchema,
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});
export type CuratedItemFormValues = z.infer<typeof curatedItemSchema>;

/* ------------------------------------------------------------------ *
 * Phase 3 — page copy and site-wide settings
 * ------------------------------------------------------------------ */

/**
 * A localized field that genuinely may be absent. Only for DB columns that are
 * nullable — when the column is NOT NULL, use `localizedSchema`, because
 * is_localized() rejects partial objects.
 */
const optionalLocalizedSchema = localizedSchema.nullable().optional();

/** `pages` is one row per route. Rows are never created or deleted here. */
export const pageMetaSchema = z.object({
  slug: z.string().trim().min(1),
  meta_title: localizedSchema,
  meta_description: localizedSchema,
  og_title: optionalLocalizedSchema,
  og_description: optionalLocalizedSchema,
  og_image_key: z.string().trim().nullable().optional(),
  eyebrow_prefix: z.string().trim().nullable().optional(),
  eyebrow_suffix: optionalLocalizedSchema,
  header_title: optionalLocalizedSchema,
  header_intro: optionalLocalizedSchema,
});
export type PageMetaFormValues = z.infer<typeof pageMetaSchema>;

/**
 * Block keys are consumed by hard-coded component code, so the admin edits
 * values only — it never adds or removes a key.
 */
export const pageBlockSchema = z.object({
  id: z.number().int(),
  block_key: z.string(),
  value: localizedSchema,
});
export const pageBlocksBulkSchema = z.object({
  page_slug: z.string().trim().min(1),
  blocks: z.array(pageBlockSchema),
});
export type PageBlocksBulkValues = z.infer<typeof pageBlocksBulkSchema>;

/** Unlike blocks, list rows are genuinely addable — a route can gain a stop. */
export const pageListItemSchema = z.object({
  id: z.number().int().optional(),
  page_slug: z.string().trim().min(1),
  list_key: z.string().trim().min(1),
  label: localizedSchema,
  note: optionalLocalizedSchema,
  image_key: z.string().trim().nullable().optional(),
  sort_order: z.number().int(),
});
export type PageListItemFormValues = z.infer<typeof pageListItemSchema>;

/** Single row, `check (id = 1)` — update only, never insert or delete. */
export const siteSettingsSchema = z.object({
  short_desc: localizedSchema,
  address: localizedSchema,
  city: localizedSchema,
  hours: localizedSchema,
  closed: localizedSchema,
  contact_email: z.string().trim().email("請輸入有效的電子郵件"),
  site_url: z.string().trim().url("請輸入完整網址"),
  // Empty string is meaningful: the footer hides links whose value is blank.
  social_instagram: z.string().trim(),
  social_facebook: z.string().trim(),
  social_line: z.string().trim(),
  map_embed: z.string().trim(),
  map_link: z.string().trim(),
  map_apple: z.string().trim(),
  meta_site_name: z.string().trim(),
  meta_author: z.string().trim(),
  meta_twitter_card: z.string().trim(),
  meta_og_type: z.string().trim(),
  default_meta_title: z.string().trim(),
  default_meta_description: z.string().trim(),
});
export type SiteSettingsFormValues = z.infer<typeof siteSettingsSchema>;

/** Composite PK (group_key, string_key) — both identify the row, not editable. */
export const uiStringSchema = z.object({
  group_key: z.string().trim().min(1),
  string_key: z.string().trim().min(1),
  value: localizedSchema,
  sort_order: z.number().int(),
});
export type UiStringFormValues = z.infer<typeof uiStringSchema>;

/** Plain text throughout — these are phone numbers, not prose. */
export const contactPhoneSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1, "請輸入標籤"),
  display_text: z.string().trim().min(1, "請輸入顯示文字"),
  tel: z.string().trim().min(1, "請輸入撥號用號碼"),
  sort_order: z.number().int(),
});
export type ContactPhoneFormValues = z.infer<typeof contactPhoneSchema>;

/* ------------------------------------------------------------------ *
 * Commerce — products
 * ------------------------------------------------------------------ */

const PRODUCT_TYPES = ["goods", "book", "event", "journey"] as const;
const PRODUCT_SOURCE_TYPES = ["event", "journey", "curated_item"] as const;
const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;

/**
 * products.id is a plain `text primary key` with no DB default (same shape as
 * news.id — see src/server/repos/products.ts), so `id` absent/empty means
 * "create a new row", same convention as newsSchema.
 *
 * The superRefine below reproduces the DB's products_capacity_shape CHECK
 * (supabase/migrations/0004_commerce_products.sql) client-side: event/journey
 * products must have a capacity. Doing it here puts the error on the
 * capacity field itself instead of letting the admin hit a raw Postgres
 * 23514 check-violation message after submit.
 *
 * `seats_taken` is deliberately not a field on this schema at all — see
 * src/server/repos/products.ts for why it must never be part of a form write.
 */
export const productSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1, "請輸入網址代稱"),
    product_type: z.enum(PRODUCT_TYPES),
    // Optional link back to the CMS row this product is sold from — plain
    // fields, not a picker (see src/routes/admin/_shell.products.tsx).
    source_type: z.enum(PRODUCT_SOURCE_TYPES).nullable().optional(),
    source_id: z.string().trim().nullable().optional(),
    title: localizedSchema,
    summary: localizedSchema,
    description: localizedSchema,
    // TWD, whole dollars — never cents (see migration comment).
    price: z.number().int("價格必須是整數，不接受小數").min(0, "價格不可為負數"),
    compare_at_price: z
      .number()
      .int("原價必須是整數，不接受小數")
      .min(0, "原價不可為負數")
      .nullable()
      .optional(),
    // Physical goods only. NULL means "not stock-managed".
    stock: z
      .number()
      .int("庫存必須是整數，不接受小數")
      .min(0, "庫存不可為負數")
      .nullable()
      .optional(),
    // Bookings only (event/journey) — required-when-applicable enforced below.
    capacity: z
      .number()
      .int("名額必須是整數，不接受小數")
      .min(0, "名額不可為負數")
      .nullable()
      .optional(),
    image_key: z.string().trim().nullable().optional(),
    requires_shipping: z.boolean(),
    status: z.enum(PRODUCT_STATUSES),
    sort_order: z.number().int("排序必須是整數"),
  })
  .superRefine((data, ctx) => {
    if (
      (data.product_type === "event" || data.product_type === "journey") &&
      data.capacity == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "活動／策旅類型的商品必須填寫名額",
        path: ["capacity"],
      });
    }
  });

export type ProductFormValues = z.infer<typeof productSchema>;

/**
 * 上架表單：把一個進銷存品項變成型錄商品。
 *
 * 刻意**沒有** stock 欄位。上架後這件商品的庫存由 inv.products 管，
 * public.products.stock 必須是 NULL —— 0011 有一個 trigger 會擋下任何非 NULL 的值。
 * 表單裡不放這個欄位，是為了讓「這個數字不存在」這件事在 UI 上就成立，
 * 而不是等到送出才被資料庫罵。
 *
 * product_type 只留 goods / book：event 與 journey 是有名額的預約，不走實體庫存。
 */
export const inventoryListingSchema = z.object({
  inv_product_id: z.string().trim().uuid("請從清單選一個進銷存品項"),
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  price: z.number().int("價格必須是整數，不接受小數").min(0, "價格不可為負數"),
  units_per_sale: z.number().int("每件出貨數必須是整數").min(1, "每件出貨數至少是 1"),
  product_type: z.enum(["goods", "book"]),
  status: z.enum(["draft", "active"]),
  /** 上架頁不填；/admin/publications 連結刊物時會把封面帶進來。 */
  image_key: z.string().trim().optional().nullable(),
});

export type InventoryListingFormValues = z.infer<typeof inventoryListingSchema>;

// ---------------------------------------------------------------------------
// 地方刊物展
// ---------------------------------------------------------------------------
/**
 * 一本刊物可編輯的欄位。
 *
 * sheet / seq / slug 不在裡面：它們是回頭對照原始 Excel 的鍵，改了就再也對不回去。
 * region 允許空字串 —— 原始資料裡真的有「日本全國」這種不是地名的寫法，強迫填
 * 一個縣市只會逼人編造。
 */
export const publicationSchema = z.object({
  id: z.string().trim().min(1),
  title: localizedSchema,
  publisher: localizedSchema,
  intro: localizedSchema,
  region: z.string().trim().max(200),
  issues: z.string().trim().max(500).optional().nullable(),
  // 空字串代表「原始資料沒有網址」，所以不能用 z.string().url() 硬擋。
  external_url: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https?:\/\//.test(v), "請輸入完整網址（含 https://）或留空")
    .optional()
    .nullable(),
  cover_image_key: z.string().trim().optional().nullable(),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});

export type PublicationFormValues = z.infer<typeof publicationSchema>;

/**
 * 把一本刊物連到進銷存的一個品項。
 *
 * price 最低 1：0 元商品在結帳、發票與金流三個地方都是特例，而「還沒定價」的
 * 正確表達方式是**不要連結**，不是連了填 0。
 */
export const publicationLinkSchema = z.object({
  publication_id: z.string().trim().min(1),
  inv_product_id: z.string().trim().uuid("請從清單選一個進銷存品項"),
  price: z.number().int("價格必須是整數，不接受小數").min(1, "請填入售價（至少 1 元）"),
  units_per_sale: z.number().int("每件出貨數必須是整數").min(1, "每件出貨數至少是 1"),
});

export type PublicationLinkFormValues = z.infer<typeof publicationLinkSchema>;

// ---------------------------------------------------------------------------
// 門市 POS
// ---------------------------------------------------------------------------
/**
 * 結帳一車。
 *
 * ⚠️ 這裡的每一條規則都是 DB 端 CHECK 或 pos_checkout() 的鏡射，不是新發明的：
 *    quantity > 0        ← inv.sales 的 positive_quantity CHECK
 *    unit_price >= 0     ← inv.sales 的 non_negative_unit_price CHECK
 *    items 非空          ← pos_checkout() 的 POS_EMPTY_CART
 *
 * 鏡射的意義是「錯誤在按鈕旁邊，而不是在 500 頁面上」。資料庫那一份仍然是真正
 * 的守門 —— 來源系統就是因為前端 `parseFloat('')` 沒擋，讓 NaN 寫進了 unit_price。
 */
export const posCheckoutSchema = z.object({
  items: z
    .array(
      z.object({
        inv_product_id: z.string().trim().uuid(),
        quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
        unit_price: z
          .number({ invalid_type_error: "單價必須是數字" })
          .min(0, "單價不可為負數")
          .finite("單價必須是數字"),
      }),
    )
    .min(1, "購物車是空的"),
  payment_method_id: z.string().trim().uuid().nullable(),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  notes: z.string().trim().max(500, "備註最多 500 字").nullable(),
  /** 逃生門。true 會略過可售量下限並在 stock_oversold_alerts 留一列。 */
  override_reservation: z.boolean(),
});

export type PosCheckoutValues = z.infer<typeof posCheckoutSchema>;

/** 銷售紀錄的篩選條件。全部下推到資料庫，不在前端 filter。 */
export const salesFilterSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  channel: z.enum(["all", "pos", "online"]),
  keyword: z.string().trim().max(100).nullable(),
  reconciled: z.enum(["all", "yes", "no"]),
  paymentMethodId: z.string().trim().uuid().nullable(),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type SalesFilterValues = z.infer<typeof salesFilterSchema>;

/** 標記賣超告警已處理。說明是必填 —— 「已處理」但沒說怎麼處理等於沒處理。 */
export const resolveAlertSchema = z.object({
  alert_id: z.number().int().positive(),
  note: z.string().trim().min(1, "請寫下你怎麼處理的").max(500, "最多 500 字"),
});

export type ResolveAlertValues = z.infer<typeof resolveAlertSchema>;

// ---------------------------------------------------------------------------
// 進銷存商品主檔
// ---------------------------------------------------------------------------
/**
 * 商品類型。**三個值，不是六個**。
 *
 * 來源系統的 productTypes.ts 列了六種（outright / consignment / commission /
 * own_brand / rental / secondhand），但 inv.products 的 CHECK 只認得三種：
 *
 *   CONSTRAINT products_product_type_check
 *     CHECK (product_type = ANY (ARRAY['outright', 'consignment', 'rental']))
 *
 * 鏡射的是**資料庫**，不是來源的下拉選單。多送另外三個進去會拿到 23514，
 * 而 23514 出現在使用者眼前的樣子是一頁 500。
 */
export const INV_PRODUCT_TYPES = ["outright", "consignment", "rental"] as const;
export const INV_PRODUCT_TYPE_LABELS: Record<(typeof INV_PRODUCT_TYPES)[number], string> = {
  outright: "買斷",
  consignment: "寄賣",
  rental: "租借（展示用）",
};

/**
 * 商品表單。
 *
 * ⚠️ 這裡**沒有** approval_status、stock_quantity、user_id。不是漏了：
 *    · approval_status 由 inv.initial_approval_status() 在資料庫算（fail-closed）
 *    · stock_quantity 只能由進貨／盤點改
 *    · user_id 取自 middleware 的 context
 *    三者都不從 request body 拿。inv_save_product() 逐欄具名取值，所以就算有人
 *    把這些 key 塞進 payload 也不會有任何一行程式去讀它。
 *
 * 價格的下限鏡射 inv.products 的 positive_cost_price / positive_selling_price。
 */
export const invProductSchema = z.object({
  id: z.string().trim().uuid().nullable().optional(),
  name: z.string().trim().min(1, "請輸入商品名稱").max(200, "商品名稱最多 200 字"),
  issue_number: z.string().trim().max(50).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  category_id: z.string().trim().uuid().nullable().optional(),
  product_type: z.enum(INV_PRODUCT_TYPES),
  series: z.string().trim().max(200).nullable().optional(),
  publisher: z.string().trim().max(200).nullable().optional(),
  vendor_id: z.string().trim().uuid().nullable().optional(),
  selling_price: z
    .number({ invalid_type_error: "售價必須是數字" })
    .min(0, "售價不可為負數")
    .finite("售價必須是數字"),
  cost_price: z
    .number({ invalid_type_error: "成本必須是數字" })
    .min(0, "成本不可為負數")
    .finite("成本必須是數字")
    .nullable()
    .optional(),
  low_stock_alert: z.number().int("低庫存警示必須是整數").min(0, "不可為負數"),
  pack_size: z.number().int("每組數量必須是整數").min(1, "每組數量至少是 1"),
  base_product_id: z.string().trim().uuid().nullable().optional(),
  image_key: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** 只在新增時看。來源新增商品預設會一起建一筆進貨，庫存靠它的 trigger 加上去。 */
  purchase: z
    .object({
      quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
      cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
      vendor: z.string().trim().max(200).nullable(),
      purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
    })
    .nullable()
    .optional(),
});

export type InvProductFormValues = z.infer<typeof invProductSchema>;

/**
 * 審核的七個模組。
 *
 * ⚠️ 這是一份**代號**清單，不是表名清單。哪一個代號對到哪一張表、哪一個狀態
 *    欄位，只寫在 0016 的 public.inv_approve_record() 裡面（寫死的 CASE 分支，
 *    沒有動態 SQL）。這一層的責任只是「不在這七個裡面的字串連 server fn 都進不去」。
 *
 * 來源的 useApprovalMutation({ table, statusField }) 是讓呼叫端自己傳表名與欄位名。
 * 在來源那個單體前端裡它只是難維護；搬到 client/server 之後那個 table 會**從
 * 瀏覽器送進來**，等於把 `update <任意表> set <任意欄位>` 開給任何拿得到 cookie
 * 的人。就算今天用參數化查詢擋得住，下一個人加一段字串拼接就破了 —— 所以修法
 * 不是「小心一點」，是讓表名根本不會出現在網路上。
 *
 * price_changes 不是一張表（它是 inv.products 上的另一組欄位），
 * stock_adjustments 的狀態欄位叫 status 而不是 approval_status，通過的值是
 * 'confirmed' 而不是 'approved'。這兩件事本身就說明了「module = 表名」行不通。
 */
export const APPROVAL_MODULES = [
  "products",
  "purchases",
  "stock_adjustments",
  "inventory_adjustments",
  "combo_sets",
  "vendors",
  "price_changes",
] as const;

export type ApprovalModule = (typeof APPROVAL_MODULES)[number];

export const APPROVAL_MODULE_LABELS: Record<ApprovalModule, string> = {
  products: "商品新增",
  purchases: "進貨",
  stock_adjustments: "盤點",
  inventory_adjustments: "庫存異動",
  combo_sets: "套餐組合",
  vendors: "供應商",
  price_changes: "商品價格變更",
};

export const approveRecordSchema = z.object({
  module: z.enum(APPROVAL_MODULES),
  id: z.string().trim().uuid("請指定一筆有效的資料"),
  approved: z.boolean(),
});

export type ApproveRecordValues = z.infer<typeof approveRecordSchema>;

/** 送出調價。成本可以留空（代表不動它），售價必填。 */
export const priceChangeSchema = z.object({
  id: z.string().trim().uuid(),
  cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
  selling_price: z.number().min(0, "售價不可為負數").finite("售價必須是數字"),
});

export type PriceChangeValues = z.infer<typeof priceChangeSchema>;

/** 商品清單的篩選條件。全部下推到資料庫，不在前端 filter。 */
export const productFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  categoryId: z.string().trim().uuid().nullable(),
  productType: z.enum(INV_PRODUCT_TYPES).nullable(),
  vendorId: z.string().trim().uuid().nullable(),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  activeStatus: z.enum(["all", "active", "inactive"]),
  priceChange: z.enum(["all", "pending"]),
  sort: z.enum([
    "created_at",
    "name_asc",
    "name_desc",
    "issue_asc",
    "issue_desc",
    "stock_asc",
    "stock_desc",
  ]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type ProductFilterValues = z.infer<typeof productFilterSchema>;

/**
 * Excel 匯入的一列。
 *
 * xlsx 的解析留在瀏覽器（純檔案處理），但解析完的資料一律走這個 schema 進
 * server fn。瀏覽器沒有任何一條路徑碰得到資料庫。
 */
export const importRowSchema = z.object({
  name: z.string().trim().min(1, "商品名稱不可為空").max(200),
  issue_number: z.string().trim().max(50).nullable(),
  barcode: z.string().trim().max(64).nullable(),
  series: z.string().trim().max(200).nullable(),
  publisher: z.string().trim().max(200).nullable(),
  notes: z.string().trim().max(2000).nullable(),
  selling_price: z.number().min(0, "售價不可為負數").finite(),
  cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
  quantity: z.number().int().min(0),
  /** 前端比對出來的既有商品。server 會再查一次它存不存在，不存在就當成新增。 */
  existing_product_id: z.string().trim().uuid().nullable(),
});

export const importProductsSchema = z.object({
  // 上限與 inv_import_products() 的 IMPORT_TOO_MANY 對齊。
  rows: z.array(importRowSchema).min(1, "沒有要匯入的資料").max(2000, "一次最多 2000 列，請分批"),
  options: z.object({
    create_purchase_record: z.boolean(),
    category_id: z.string().trim().uuid().nullable(),
    product_type: z.enum(INV_PRODUCT_TYPES),
    vendor: z.string().trim().max(200).nullable(),
    purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  }),
});

export type ImportProductsValues = z.infer<typeof importProductsSchema>;
export type ImportRowValues = z.infer<typeof importRowSchema>;

/** 批次調價的三種算法。與 inv.apply_price_op() 的三個 mode 逐字對齊。 */
const priceOpSchema = z.object({
  mode: z.enum(["set", "percent", "amount"]),
  value: z.number().finite("請輸入數字"),
});

export const batchUpdateSchema = z.object({
  ids: z.array(z.string().trim().uuid()).min(1, "沒有選取任何商品").max(500, "一次最多 500 件"),
  patch: z
    .object({
      category_id: z.string().trim().nullable().optional(),
      product_type: z.enum(INV_PRODUCT_TYPES).optional(),
      vendor_id: z.string().trim().nullable().optional(),
      selling_price: priceOpSchema.optional(),
      cost_price: priceOpSchema.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "請至少選一個要更新的欄位"),
});

export type BatchUpdateValues = z.infer<typeof batchUpdateSchema>;

// ---------------------------------------------------------------------------
// 進貨、庫存盤點、在庫異動（0017）
// ---------------------------------------------------------------------------

/**
 * 在庫異動的六類。與 0017 加的 stock_adjustments_category_check 逐字對齊。
 *
 * ⚠️ 「盤點」不是另一張表，是這裡的 ADJ。0009 搬進來的 inv.inventory_adjustments
 *    是**已凍結的舊表**（30 筆，最後一筆 2026-03-02），新的寫入一筆都不進去。
 *    理由寫在 0017 的檔頭。
 */
export const INV_ADJUSTMENT_CATEGORIES = ["EXP", "PR", "SMP", "INT", "ADJ", "CMB"] as const;
export type InvAdjustmentCategory = (typeof INV_ADJUSTMENT_CATEGORIES)[number];

/** 異動單的四個狀態。與 0017 加的 stock_adjustments_status_check 逐字對齊。 */
export const INV_ADJUSTMENT_STATUSES = ["draft", "pending_approval", "confirmed", "rejected"] as const;
export type InvAdjustmentStatus = (typeof INV_ADJUSTMENT_STATUSES)[number];

/**
 * 盤點差異的六個原因。與 0017 加的 stock_adjustments_reason_check 逐字對齊。
 *
 * 來源把這六個值**串成中文字串塞進 notes**（`盤點調整（盤點誤差）：…`），所以
 * 一年之後沒有人能回答「因為破損少掉幾本」。0017 把它做成真的欄位。
 */
export const INV_ADJUSTMENT_REASONS = [
  "loss",
  "damage",
  "count_error",
  "return",
  "sample",
  "other",
] as const;
export type InvAdjustmentReason = (typeof INV_ADJUSTMENT_REASONS)[number];

/**
 * 一筆進貨。
 *
 * ⚠️ 沒有 approval_status、remaining_quantity、user_id：
 *    · approval_status 由 inv.initial_approval_status('purchases') 在資料庫算
 *    · remaining_quantity 是 FIFO 的消耗欄位，只有 trigger 碰得到
 *    · user_id 取自 middleware 的 context
 *
 * ⚠️ 也沒有折扣／運費／稅金／總額。inv.purchases **沒有這些欄位** —— 小計就是
 *    `quantity × unit_cost`，而且是算出來給人看的，不寫回資料庫。
 */
export const invPurchaseSchema = z.object({
  id: z.string().trim().uuid().nullable().optional(),
  /** 編輯時忽略：換商品等於整批貨搬家，FIFO 批次也要跟著搬。要換就刪掉重開。 */
  product_id: z.string().trim().uuid("請選擇要進貨的商品"),
  item_name: z.string().trim().max(200, "進貨品名最多 200 字").nullable(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  quantity: z
    .number({ invalid_type_error: "數量必須是數字" })
    .int("數量必須是整數")
    .min(1, "數量至少是 1")
    .max(1_000_000, "數量太大了，請確認"),
  unit_cost: z
    .number({ invalid_type_error: "成本必須是數字" })
    .min(0, "成本不可為負數")
    .finite("成本必須是數字")
    .nullable(),
  vendor_id: z.string().trim().uuid().nullable(),
  vendor: z.string().trim().max(200, "供應商名稱最多 200 字").nullable(),
  publisher: z.string().trim().max(200, "出版社最多 200 字").nullable(),
  notes: z.string().trim().max(2000, "備註最多 2000 字").nullable(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD").nullable(),
  expiry_alert_days: z
    .number({ invalid_type_error: "警示天數必須是數字" })
    .int("警示天數必須是整數")
    .min(1, "警示天數至少是 1")
    .max(365, "警示天數最多 365")
    .nullable(),
});

export type InvPurchaseValues = z.infer<typeof invPurchaseSchema>;

export const purchaseFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  categoryId: z.string().trim().uuid().nullable(),
  vendorId: z.string().trim().uuid().nullable(),
  productType: z.enum(INV_PRODUCT_TYPES).nullable(),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  /** 效期狀態。與來源的 ?expiry= 五個值逐字一致（Dashboard 的到期提醒會帶進來）。 */
  expiryStatus: z.enum(["all", "expiring", "expired", "warning", "no_expiry"]),
  stockStatus: z.enum(["all", "in_stock", "used_up"]),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sort: z.enum(["purchase_date_desc", "purchase_date_asc", "created_at", "quantity_desc", "remaining_asc"]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type PurchaseFilterValues = z.infer<typeof purchaseFilterSchema>;

/** 批次改供應商／效期。patch 的兩個 key 與 inv_batch_update_purchases 逐字對齊。 */
export const purchaseBatchUpdateSchema = z.object({
  ids: z.array(z.string().trim().uuid()).min(1, "沒有選取任何進貨").max(500, "一次最多 500 筆"),
  patch: z
    .object({
      vendor: z
        .object({
          vendor_id: z.string().trim().uuid().nullable(),
          vendor: z.string().trim().max(200).nullable(),
        })
        .optional(),
      expiry: z
        .object({
          expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
          expiry_alert_days: z.number().int().min(1).max(365).nullable(),
        })
        .optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "請至少選一組要更新的欄位"),
});

export type PurchaseBatchUpdateValues = z.infer<typeof purchaseBatchUpdateSchema>;

const purchaseImportRowSchema = z.object({
  product_id: z.string().trim().uuid().nullable(),
  name: z.string().trim().min(1, "商品名稱不可空白").max(200),
  issue_number: z.string().trim().max(50).nullable(),
  series: z.string().trim().max(200).nullable(),
  barcode: z.string().trim().max(100).nullable(),
  quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
  unit_cost: z.number().min(0, "成本不可為負數").finite().nullable(),
  vendor_id: z.string().trim().uuid().nullable(),
  vendor: z.string().trim().max(200).nullable(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  notes: z.string().trim().max(2000).nullable(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expiry_alert_days: z.number().int().min(1).max(365).nullable(),
  product_type: z.enum(INV_PRODUCT_TYPES).nullable(),
  category_id: z.string().trim().uuid().nullable(),
});

export const importPurchasesSchema = z.object({
  // 上限與 inv_import_purchases() 的 IMPORT_TOO_MANY 對齊。
  rows: z.array(purchaseImportRowSchema).min(1, "沒有要匯入的資料").max(2000, "一次最多 2000 列，請分批"),
  options: z.object({
    default_vendor_id: z.string().trim().uuid().nullable(),
    default_category_id: z.string().trim().uuid().nullable(),
    default_purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    default_expiry_alert_days: z.number().int().min(1).max(365).nullable(),
  }),
});

export type ImportPurchasesValues = z.infer<typeof importPurchasesSchema>;

/**
 * 一張在庫異動單。
 *
 * ⚠️ 沒有 status：那是 inv.stock_adjustment_initial_status() 在資料庫算的。來源
 *    的兩支盤點對話框把它硬寫成 'confirmed'，等於審核開關對盤點完全無效 ——
 *    這個 schema 少掉 status 這個欄位，就是那個 bug 在型別上被關起來。
 * ⚠️ 也沒有 unit_cost / total_cost：出庫的成本由 FIFO trigger 算，進庫的用商品
 *    成本。從瀏覽器送成本進來就等於讓人自己填毛利。
 */
export const invAdjustmentSchema = z.object({
  product_id: z.string().trim().uuid("請選擇商品"),
  adjustment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  category: z.enum(INV_ADJUSTMENT_CATEGORIES, { errorMap: () => ({ message: "請選擇異動類別" }) }),
  quantity: z
    .number({ invalid_type_error: "數量必須是數字" })
    .int("數量必須是整數")
    .refine((v) => v !== 0, "異動數量不可為 0") // 鏡射 inv.stock_adjustments 的 non_zero_quantity
    .refine((v) => Math.abs(v) <= 1_000_000, "數量太大了，請確認"),
  reason: z.enum(INV_ADJUSTMENT_REASONS).nullable(),
  notes: z.string().trim().max(2000, "備註最多 2000 字").nullable(),
  /** false = 存成草稿。true = 送出（要不要進待審由資料庫決定）。 */
  submit: z.boolean(),
});

export type InvAdjustmentValues = z.infer<typeof invAdjustmentSchema>;

/**
 * 盤點。
 *
 * ⚠️ 送的是**實盤數量**，不是差異。差異由 inv_record_stock_count() 用當下的
 *    stock_quantity 算 —— 來源在瀏覽器算，店員開著畫面十分鐘、櫃檯中間賣掉三本，
 *    送出的差異就會多扣三本。
 */
export const stockCountSchema = z.object({
  rows: z
    .array(
      z.object({
        product_id: z.string().trim().uuid(),
        actual_quantity: z
          .number({ invalid_type_error: "實際盤點數量必須是數字" })
          .int("數量必須是整數")
          .min(0, "實際盤點數量不可為負數"),
      }),
    )
    .min(1, "沒有要盤點的商品")
    .max(500, "一次最多盤 500 件，請分批"),
  options: z.object({
    reason: z.enum(INV_ADJUSTMENT_REASONS, { errorMap: () => ({ message: "請選擇調整原因" }) }),
    notes: z.string().trim().max(2000).nullable(),
    adjustment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export type StockCountValues = z.infer<typeof stockCountSchema>;

export const adjustmentFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  category: z.enum(INV_ADJUSTMENT_CATEGORIES).nullable(),
  status: z.enum(["all", ...INV_ADJUSTMENT_STATUSES]),
  productId: z.string().trim().uuid().nullable(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sort: z.enum(["date_desc", "date_asc", "created_at", "quantity_desc"]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type AdjustmentFilterValues = z.infer<typeof adjustmentFilterSchema>;
