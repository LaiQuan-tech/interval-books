#!/usr/bin/env node
/**
 * image-pipeline-selftest.mjs —— 上傳圖片壓縮參數的自檢（2026-09 前台載入速度
 * 優化）
 *
 * ── 背景 ──────────────────────────────────────────────────────────────────
 * 活動頁四張圖實測共 932KB（封面 412KB、相簿 269KB+161KB、講者 90KB），原圖直接
 * 從 Supabase Storage 送出。查了 src/lib/admin/image-compress.ts 才發現這不是
 * 「漏了壓縮」——這是全站唯一一份壓縮管線（ImageField 與 GalleryField 共用），
 * 上限本來就是長邊 2000px、WebP quality .82，412KB 那張封面本身剛好是
 * 2000×1500，正是這組設定會產出的大小。
 *
 * 新數字（1600px / .80）不是憑感覺定的：抓了正式站這四張圖，跑過
 * compressImage() 本身的演算法在瀏覽器裡量出真實輸出大小，並排比對放大細節，
 * 詳細數字與理由都寫在 image-compress.ts 的 IMAGE_MAX_EDGE_PX/IMAGE_WEBP_QUALITY
 * 檔頭注釋——這支測試只釘「數字真的是新的」與「兩個上傳欄位真的共用同一組」，
 * 不重複那段實測敘述。
 *
 * ⚠️ 這支測試**不會、也不能**重壓 Storage 裡現有的圖片——那需要碰 Storage，
 *    是這次交付範圍明確排除的工作（"現有圖片的重壓與替換不用你做"）。這裡守的
 *    只是「這次之後的新上傳」用什麼參數。
 *
 * image-compress.ts 零 import（純瀏覽器 canvas API，模組本身不碰任何
 * "@/..." 別名），所以這支可以直接 import 真正的常數值，不必用正則猜——見
 * cache-policy-selftest.mjs 檔頭同一套理由。
 *
 * 這支測試不碰資料庫、不讀環境變數、不發網路請求。
 *
 * 執行：node scripts/image-pipeline-selftest.mjs（或 npm test）
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  IMAGE_MAX_EDGE_PX,
  IMAGE_WEBP_QUALITY,
  OCR_MAX_EDGE_PX,
  OCR_WEBP_QUALITY,
} from "../src/lib/admin/image-compress.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/image-pipeline-selftest.mjs";

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

const checkTrue = (label, value, hint) => check(label, value === true, true, hint);

const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(`selftest 讀不到檔案：${p} —— 路徑打錯或檔案被搬走了，不是「檔案是空的」。`);
  }
  return readFileSync(p, "utf8");
};

// =============================================================================
// [0] 反空殼
// =============================================================================
console.log("\n[0] 反空殼");
checkTrue(
  "src/lib/admin/image-compress.ts 讀得到",
  readFile(join(ROOT, "src/lib/admin/image-compress.ts")).length > 500,
);
checkTrue("IMAGE_MAX_EDGE_PX 是數字", typeof IMAGE_MAX_EDGE_PX === "number");
checkTrue("IMAGE_WEBP_QUALITY 是數字", typeof IMAGE_WEBP_QUALITY === "number");

// =============================================================================
// [1] 新參數——2026-09 從 2000px/.82 收緊到 1600px/.80（實測數字見該檔案檔頭）
// =============================================================================
console.log("\n[1] 型錄／商品照／活動封面／講者照／相簿共用的常數");
check("IMAGE_MAX_EDGE_PX 收緊到 1600", IMAGE_MAX_EDGE_PX, 1600);
check("IMAGE_WEBP_QUALITY 收緊到 .80", IMAGE_WEBP_QUALITY, 0.8);
checkTrue("長邊真的比舊值（2000）小——不是換了個名字但沒收緊", IMAGE_MAX_EDGE_PX < 2000);
checkTrue("quality 真的比舊值（.82）低", IMAGE_WEBP_QUALITY < 0.82);
// 別太激進：quality 低於 .6 或長邊低於 1000 對這個尺寸的圖片視覺風險已經偏高，
// 這條不是精確值而是「沒有手滑改到離譜數字」的粗防線。
checkTrue("quality 沒有低到離譜（>= 0.6）", IMAGE_WEBP_QUALITY >= 0.6);
checkTrue("長邊沒有小到離譜（>= 1000）", IMAGE_MAX_EDGE_PX >= 1000);

// =============================================================================
// [2] OCR 掃描圖的常數維持不動——那組是給文字辨識用的，跟這次的展示圖片無關
// =============================================================================
console.log("\n[2] OCR_MAX_EDGE_PX／OCR_WEBP_QUALITY——沒有被這次調整影響");
check("OCR_MAX_EDGE_PX 維持 1600（本來就是；不是這次改的）", OCR_MAX_EDGE_PX, 1600);
check(
  "OCR_WEBP_QUALITY 維持 .9（辨識用，壓縮瑕疵會變成讀錯字，跟展示圖片標準不同）",
  OCR_WEBP_QUALITY,
  0.9,
);

// =============================================================================
// [3] 兩個上傳欄位（ImageField／GalleryField）真的共用同一組常數，不是各自硬編
// =============================================================================
console.log("\n[3] ImageField／GalleryField 共用同一份常數，不是各自寫死數字");
const imageField = readFile(join(ROOT, "src/components/admin/ImageField.tsx"));
const galleryField = readFile(join(ROOT, "src/components/admin/GalleryField.tsx"));

checkTrue(
  "ImageField.tsx 從 image-compress.ts import IMAGE_MAX_EDGE_PX/IMAGE_WEBP_QUALITY",
  /import \{[^}]*\bIMAGE_MAX_EDGE_PX\b[^}]*\bIMAGE_WEBP_QUALITY\b[^}]*\} from "@\/lib\/admin\/image-compress";|import \{[^}]*\bIMAGE_WEBP_QUALITY\b[^}]*\bIMAGE_MAX_EDGE_PX\b[^}]*\} from "@\/lib\/admin\/image-compress";/.test(
    imageField,
  ),
);
checkTrue(
  "GalleryField.tsx 從 image-compress.ts import 同一組常數",
  /import \{[^}]*\bIMAGE_MAX_EDGE_PX\b[^}]*\bIMAGE_WEBP_QUALITY\b[^}]*\} from "@\/lib\/admin\/image-compress";|import \{[^}]*\bIMAGE_WEBP_QUALITY\b[^}]*\bIMAGE_MAX_EDGE_PX\b[^}]*\} from "@\/lib\/admin\/image-compress";/.test(
    galleryField,
  ),
);
checkTrue(
  "ImageField.tsx 真的把常數傳進 compressImage()",
  /compressImage\(file, \{ maxEdge: IMAGE_MAX_EDGE_PX, quality: IMAGE_WEBP_QUALITY \}\)/.test(
    imageField,
  ),
);
checkTrue(
  "GalleryField.tsx 真的把常數傳進 compressImage()",
  /compressImage\(file, \{ maxEdge: IMAGE_MAX_EDGE_PX, quality: IMAGE_WEBP_QUALITY \}\)/.test(
    galleryField,
  ),
);
checkTrue(
  "GalleryField.tsx 的說明文字用的是同一個常數插值，不是寫死 2000",
  /最長邊 \{IMAGE_MAX_EDGE_PX\}px/.test(galleryField),
);

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
