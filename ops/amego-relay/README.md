# Amego 發票中繼

Amego（光貿）用 **IP 白名單**控管，而 Vercel 的出口 IP 是浮動的——正式站實際被記錄到
`54.90.68.139`、`3.92.182.125`、`44.212.38.92`、`100.58.234.199` 四個不同的 IP，全部回
`code=14 IP 錯誤`。這支中繼跑在 Railway 的固定出口 IP 上，光貿放行的是那組 IP。

它只做一件事：**原封不動轉送**。body 逐位元組不動（`sign` 是 Vercel 端用
`AMEGO_APP_KEY` 算好的，中繼不參與簽章、也拿不到 AppKey），只換掉目的地 host。

## 部署

```bash
export RAILWAY_API_TOKEN=<帳號層級的 token>
cd ops/amego-relay
railway link -p 29d065d0-402d-4e9e-a1cc-c56ac5732946 -e production -s amego-relay
railway up --detach
```

| | |
|---|---|
| project | `29d065d0-402d-4e9e-a1cc-c56ac5732946`（interval-books） |
| service | `10989696-8b2e-4e42-b41d-eb008944402f`（amego-relay） |
| environment | `26bb720e-b134-401a-8da5-05734c6e90e3`（production） |
| 對外網址 | `https://amego-relay-production.up.railway.app` |

## 環境變數

| Railway（中繼這端） | Vercel（app 那端） | 說明 |
|---|---|---|
| `RELAY_SECRET` | `AMEGO_RELAY_SECRET` | 兩邊必須是同一個值。**名字不一樣是刻意的**，各自在各自的系統裡才讀得懂 |
| — | `AMEGO_RELAY_URL` | 沒設或不是 https 時 app 會走直連（然後被 IP 白名單擋掉） |
| `AMEGO_BASE`（可不設） | — | 預設 `https://invoice-api.amego.tw` |

header 固定是 `x-relay-secret`（app 那端的常數在 `src/server/amego.ts` 的
`AMEGO_RELAY_SECRET_HEADER`）。

## 部署後怎麼確認它真的好了

```bash
# 應該回 200 + Amego 的業務錯誤碼（不是 404，也不是 code=14）
curl -s -X POST "$AMEGO_RELAY_URL/json/f0401" \
  -H "x-relay-secret: $AMEGO_RELAY_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "invoice=00000000&data=%5B%5D&time=1&sign=deadbeef"
```

送假簽章開不出任何東西，但足以證明路徑通了。

## ⚠️ 這裡踩過的坑

**白名單的錯字只會弄壞其中一個端點。** 2026-09 這裡把 `/json/f0401` 打成
`/json/c0401`：作廢與查詢都正常、健康檢查是綠的，**只有開發票**回 404。而 app 那端
把「解得開的 JSON」當成 Amego 的回應，讀不到 `code` 就變成一句空訊息
`amego code=transport msg=`，還被判成永久失敗不再重試。5 張發票卡了三天。

`scripts/amego-relay-selftest.mjs` 現在會交叉比對這份白名單與 `src/server/amego.ts`
實際會打的路徑，改一邊沒改另一邊就會紅。

**原始碼一定要留在 repo 裡。** 這個檔案曾經只存在於某次 session 的暫存目錄，暫存
清掉之後就只剩跑在 Railway 上的那一份——連改都改不了。
