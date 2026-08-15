/**
 * 地方刊物展的後台資料層 —— public.publications（migration 0015）。
 *
 * 與其他 repo 同一套規矩：service_role、snake_case 原樣回傳、Supabase 的錯一律
 * 往外丟（後台把錯誤吞掉就等於把「壞了」顯示成「沒資料」）。
 *
 * ⚠️ 這個檔案裡唯一會建立商品的路徑是 linkPublicationToInventory()，而它是**呼叫**
 *    src/server/repos/inventory-listing.ts#createInventoryListing()，不是自己寫一份
 *    insert。理由：那支函式裡有兩件事不是它自己看得出來的 ——
 *      · products.stock 必須寫 NULL（0011 的 products_linked_stock_guard 會擋）
 *      · 沒有交易可用，所以 products 建完若 link 建失敗要回捲把商品刪掉
 *    複製一份的話，複製的是今天的版本，而下次修那支函式的人不會知道還有第二份。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { createInventoryListing, removeInventoryListing } from "@/server/repos/inventory-listing";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, slug, sheet, seq, title, publisher, intro, region, issues, external_url, cover_image_key, product_id, is_published, sort_order, created_at, updated_at";

export type PublicationRow = {
  id: string;
  slug: string;
  sheet: "tw" | "jp";
  seq: number;
  title: Localized;
  publisher: Localized;
  intro: Localized;
  region: string;
  issues: string | null;
  external_url: string | null;
  cover_image_key: string | null;
  product_id: string | null;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** 只更新後台編得到的欄位。sheet / seq 是回頭對照原始 Excel 的鍵，不開放改。 */
export type PublicationUpdateInput = {
  id: string;
  title: Localized;
  publisher: Localized;
  intro: Localized;
  region: string;
  issues?: string | null;
  external_url?: string | null;
  cover_image_key?: string | null;
  is_published: boolean;
  sort_order: number;
};

/** 與某一本刊物同名的進銷存品項（0015 的 publication_listing_candidates）。 */
export type PublicationNameMatch = {
  publication_id: string;
  inv_product_id: string;
  name: string;
  selling_price: number;
  stock_quantity: number;
  pack_size: number;
  barcode: string | null;
};

export async function listPublications(): Promise<PublicationRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("publications")
    .select(COLUMNS)
    .order("sheet", { ascending: false }) // tw 先於 jp，與前台同一個順序
    .order("sort_order", { ascending: true })
    .order("seq", { ascending: true })
    .limit(1000);

  if (error) throw new Error(`[repo/publications] list 失敗：${error.message}`);
  return (data ?? []) as unknown as PublicationRow[];
}

export async function getPublicationById(id: string): Promise<PublicationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("publications")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/publications] getById 失敗：${error.message}`);
  return (data as unknown as PublicationRow | null) ?? null;
}

/**
 * 更新一本刊物。刻意不是 upsert：126 本是從原始資料匯入的固定集合，後台的工作是
 * 校正，不是新增 —— 新增一本沒有 sheet/seq 對照的刊物，就再也對不回原始檔了。
 */
export async function updatePublication(input: PublicationUpdateInput): Promise<PublicationRow> {
  const { data, error } = await supabaseAdmin()
    .from("publications")
    .update({
      title: input.title,
      publisher: input.publisher,
      intro: input.intro,
      region: input.region,
      issues: input.issues ?? null,
      external_url: input.external_url ?? null,
      cover_image_key: input.cover_image_key ?? null,
      is_published: input.is_published,
      sort_order: input.sort_order,
    })
    .eq("id", input.id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new Error(`[repo/publications] update 失敗：${error.message}`);
  if (!data) throw new Error(`[repo/publications] update 失敗：找不到刊物 ${input.id}`);
  return data as unknown as PublicationRow;
}

/** 同名的進銷存品項，讓後台的下拉選單能把最可能的那幾個排在最前面。 */
export async function listPublicationNameMatches(): Promise<PublicationNameMatch[]> {
  const { data, error } = await supabaseAdmin()
    .from("publication_listing_candidates")
    .select(
      "publication_id, inv_product_id, name, selling_price, stock_quantity, pack_size, barcode",
    )
    .limit(2000);

  if (error) throw new Error(`[repo/publications] 同名候選讀取失敗：${error.message}`);
  return (data ?? []) as unknown as PublicationNameMatch[];
}

export type PublicationLinkInput = {
  publication_id: string;
  inv_product_id: string;
  price: number;
  units_per_sale: number;
};

/**
 * 把一本刊物接上進銷存的一個品項 —— 「補完定價就能賣」的那個動作。
 *
 * 三語文案不用重打：刊物本身就有 title / publisher / intro，直接對應商品的
 * title / summary / description。封面也一併帶過去。
 *
 * 沒有交易（PostgREST 一次一句），所以順序與 createInventoryListing 同一種思路：
 * 先建可刪的（商品＋連結），最後才寫這張表的 product_id；最後一步失敗就把商品
 * 刪掉回到原狀，不會留下一件「沒有任何刊物指向它」的孤兒商品。
 */
export async function linkPublicationToInventory(
  input: PublicationLinkInput,
): Promise<{ product_id: string }> {
  const pub = await getPublicationById(input.publication_id);
  if (!pub) throw new Error(`[repo/publications] 找不到刊物 ${input.publication_id}`);
  if (pub.product_id) {
    throw new Error("[repo/publications] 這本刊物已經連到商品了，請先解除連結再重新連。");
  }

  const { product_id } = await createInventoryListing({
    inv_product_id: input.inv_product_id,
    slug: `pub-${pub.slug}`,
    title: pub.title,
    summary: pub.publisher,
    description: pub.intro,
    price: input.price,
    units_per_sale: input.units_per_sale,
    product_type: "book",
    status: "active",
    image_key: pub.cover_image_key,
  });

  const { error } = await supabaseAdmin()
    .from("publications")
    .update({ product_id })
    .eq("id", input.publication_id);

  if (error) {
    await removeInventoryListing(product_id);
    throw new Error(`[repo/publications] 連結失敗：${error.message}`);
  }
  return { product_id };
}

/**
 * 解除連結：刪掉型錄商品，publications.product_id 由 0015 的
 * `on delete set null` 自己歸零，product_inventory_links 由 0011 的
 * `on delete cascade` 跟著走。進銷存那一側完全不動。
 */
export async function unlinkPublication(publicationId: string): Promise<void> {
  const pub = await getPublicationById(publicationId);
  if (!pub) throw new Error(`[repo/publications] 找不到刊物 ${publicationId}`);
  if (!pub.product_id) return;
  await removeInventoryListing(pub.product_id);
}
