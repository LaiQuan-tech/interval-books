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
