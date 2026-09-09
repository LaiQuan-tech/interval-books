import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { CalendarDays, MapPin, Users, Check } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { salonRsvpFormSchema, submitSalonRsvp, type SalonRsvpValues } from "@/lib/salon-rsvp";

/**
 * 城市思享沙龍 #01 的獨立著陸頁。
 *
 * ═══ 為什麼這一場有自己的路由，而不是走 /events/$slug ═══════════════════════
 *
 * 這個檔名是 `events.city-salon-0922.tsx` —— flat routing 下靜態片段優先於動態
 * 參數，所以 /events/city-salon-0922 會走這裡，而不是通用的 events.$slug.tsx。
 * 網址沒有變，活動列表那張卡片點進來就是這一頁。
 *
 * 通用詳情頁能表達的東西是固定的：封面、說明、相簿、講者、梯次、報名按鈕。這一場
 * 需要的是英雄區、對談陣容、120 分鐘議程、沙龍後續路徑、以及一份七欄的邀請回條 ——
 * 那不是「同一個模板換資料」，是另一種頁面。硬要塞進通用模板，代價是給 events 加
 * 一堆只有一場活動會用到的欄位，那正是這個 repo 一直在避免的事
 * （0020:46-50「欄位要跟讀它的程式碼同一期出」）。
 *
 * ⚠️ **代價要講清楚**：這一頁的內容在下面的 SALON 常數裡，**後台改不到**。
 *    /admin/events 改 city-salon-0922 那一列，只會影響活動列表上那張卡片
 *    （標題、日期、分類、封面），不會影響這一頁。這是刻意的取捨——一次性的
 *    邀請頁不值得為它做一套 CMS；但如果之後 #02、#03 都要，就該把 SALON 這個
 *    形狀變成資料表，而不是複製這個檔案第三次。
 *
 * ⚠️ 內文只有中文。全站有 ZH/EN/JA 切換，這一頁切過去內文不會變——這是刻意的：
 *    對象是台灣的受邀者，把整頁三語化會讓維護成本變三倍而沒有讀者。meta 仍然
 *    是三語（scripts/check-meta.mjs 要求，也是分享出去時的預覽文字）。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "城市思享沙龍 #01｜台東，不只是遠方",
    en: "City Think Salon #01｜Taitung Is Not Just a Distant Place",
    ja: "都市サロン #01｜台東は、遠い場所であるだけではない",
  },
  metaDescription: {
    zh: "2026.9.22 於小時光風土誌書店。藝術、地方創生與一種新的商業生活方式——15 席限定的定向邀請沙龍。",
    en: "22 Sep 2026 at Interval Books. Art, regional regeneration and a new way of living with commerce — an invitation-only salon limited to 15 seats.",
    ja: "2026年9月22日、小時光風土誌書店にて。アート、地域創生、そして新しい商いの暮らし方——15席限定の招待制サロン。",
  },
};

/**
 * 這一場沙龍的全部內容。
 *
 * 集中放在這裡而不是散在 JSX 裡，是為了讓「改內容」與「改版面」是兩件不會互相
 * 弄壞的事——講者確定了、議程調整了，只要動這個物件。
 */
const SALON = {
  cohosts: "小時光書店 Interval Books ✕ 中華民國購物中心暨商業地產協會",
  badge: "城市思享沙龍 CITY THINK SALON #01｜10月台東參訪前導沙龍",
  headline: "台東，不只是遠方",
  subheadline: "藝術、地方創生與一種新的商業生活方式",
  quote: "如果一座城市，不再只追求更大、更快、更多，我們還可以如何生活？",
  meta: [
    { icon: CalendarDays, label: "2026.09.22（週二）13:30 – 15:30", sub: "13:00 入場交流" },
    { icon: MapPin, label: "小時光風土誌書店", sub: "華山1914文化創意產業園區" },
    { icon: Users, label: "15 席限定", sub: "定向審核邀請制" },
  ],

  curationEyebrow: "策展緣起",
  curationTitle: "商道之藝",
  curationEssay: [
    "我們透過選書、選品、茶飲與人物策訪，讓讀者靠近土地，也讓創作者的生命被看見。",
    "當文化策展遇上商業地產，商業運作不再只是坪效的計算，而是一場承載土地與理想的「商道之藝」——把藝術家帶到人們面前，也把人們帶進地方真正的生活之中。",
  ],
  themes: [
    "為什麼這幾年，大家重新嚮往台東？",
    "一個地方真正的資產是土地、建築，還是生活方式？",
    "藝術與創生如何走出補助，走向永續商模？",
    "地方小品牌如何對接台北商場與地產通路？",
  ],

  speakers: [
    {
      role: "主持人",
      name: "Jeff 蔡明璋",
      title: "中華民國購物中心暨商業地產協會 理事長",
      view: "從城市、商業地產、通路生態與蚊子館活化看地方創生",
      pending: false,
    },
    {
      role: "主持人",
      name: "Alice",
      title: "小時光風土誌書店 主理人 / 策展人",
      view: "從藝術、土地、生活方式看台東——藝術如何進入生活",
      pending: false,
    },
    {
      role: "嘉賓",
      name: "賴純純",
      title: "跨界藝術家 / 生活美學推廣者",
      view: "藝術為什麼可以改變一個地方的生命力？",
      pending: false,
    },
    {
      role: "嘉賓",
      name: "敬請期待",
      title: "台東在地品牌 / 旅宿推手",
      view: "住在台東、做一件事情，真實的樣貌是什麼？",
      pending: true,
    },
  ],

  agenda: [
    { time: "13:00 – 13:30", title: "風土迎賓", detail: "茶飲、自由交流與微型台東書展體驗" },
    { time: "13:30 – 13:40", title: "策展引言", detail: "為什麼今天在小時光談台東？（Alice）" },
    { time: "13:40 – 13:55", title: "商道新局", detail: "從商業地產走向地方創生（Jeff）" },
    { time: "13:55 – 14:15", title: "土地視角", detail: "我看見的台東——藝術如何進入生活（Alice）" },
    { time: "14:15 – 14:40", title: "在地實踐", detail: "特邀嘉賓觀點分享（每人 12 分鐘）" },
    { time: "14:40 – 15:10", title: "跨界思享", detail: "四人對談「台東能給城市什麼啟示？」" },
    { time: "15:10 – 15:25", title: "圓桌共創", detail: "15 人每人一句「我想到的一個可能」" },
    {
      time: "15:25 – 15:30",
      title: "結語展望",
      detail: "Jeff 結語 ＆ 10/22-23 協會台東深度參訪團前導",
    },
  ],

  paths: [
    {
      label: "深入在地現場",
      body: "10/22-23 協會台東參訪團——拜會縣府、Gaya Hotel、江賢二藝術園區、小村遠遠等。",
    },
    { label: "城市持續思享", body: "預約城市思享沙龍第二場前排席次。" },
    { label: "商業資源對接", body: "現場交換「我能提供什麼 / 我正在尋找什麼」資源卡。" },
  ],

  rsvpNote: "本場次僅保留 15 席 VIP 席位，收到回覆後將寄發行前專屬入場通知。",
  address: "台北市中正區八德路一段1號（華山1914文化創意產業園區）",
  phone: "02-23416800",
};

const EVENT_SLUG = "city-salon-0922";

export const Route = createFileRoute("/events/city-salon-0922")({
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.metaTitle.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
    ],
  }),
  component: CitySalon,
});

/** 章節標題。整頁只有一種，讓節奏一致。 */
function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="max-w-3xl">
      <p className="eyebrow text-2xl text-clay">{eyebrow}</p>
      <h2 className="display mt-4 text-3xl md:text-4xl leading-snug">{title}</h2>
    </div>
  );
}

function CitySalon() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.metaTitle,
    ogDescription: PAGE.metaDescription,
  });

  return (
    <PageShell>
      {/* 鼠尾草綠只有徽章與少數重點用得到，不值得進全站 token；用一個頁面層級的
          變數帶著走，這樣整頁只有這裡定義一次顏色。 */}
      <div style={{ ["--salon-sage" as string]: "oklch(0.55 0.032 155)" }}>
        <CohostBar />
        <Hero />
        <Curation />
        <Speakers />
        <Agenda />
        <Paths />
        <Rsvp />
        <Venue />
      </div>
    </PageShell>
  );
}

// ── 共同主辦條 ────────────────────────────────────────────────────────────────

function CohostBar() {
  return (
    <div className="border-b border-border bg-oat/60">
      <div className="container-editorial flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="text-xs tracking-widest text-muted-foreground">{SALON.cohosts}</p>
        <a
          href="#rsvp"
          className="text-xs tracking-widest border border-foreground px-4 py-2 hover:bg-foreground hover:text-primary-foreground transition-colors"
        >
          專屬邀請席位確認
        </a>
      </div>
    </div>
  );
}

// ── 英雄區 ────────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="container-editorial pt-16 md:pt-24 pb-16">
      <p className="inline-block border border-[var(--salon-sage)] px-3 py-1.5 text-[0.7rem] tracking-widest text-[var(--salon-sage)]">
        {SALON.badge}
      </p>

      <h1 className="display mt-8 text-5xl md:text-7xl leading-[1.1]">{SALON.headline}</h1>
      <p className="mt-6 text-lg md:text-xl text-muted-foreground">{SALON.subheadline}</p>

      <blockquote className="mt-12 border-l-2 border-clay pl-6 md:pl-8 max-w-2xl">
        <p className="font-serif text-2xl md:text-3xl leading-relaxed text-foreground/85">
          「{SALON.quote}」
        </p>
      </blockquote>

      {/* 三個關鍵資訊。細線格線是全站列表共用的語彙，這裡沿用讓它不像外掛的一頁。 */}
      <div className="mt-14 grid gap-px bg-border border border-border sm:grid-cols-3">
        {SALON.meta.map((m) => (
          <div key={m.label} className="bg-background p-6 md:p-7">
            <m.icon className="h-4 w-4 text-clay" strokeWidth={1.5} aria-hidden />
            <p className="mt-4 text-base leading-snug">{m.label}</p>
            <p className="mt-1.5 text-sm text-muted-foreground">{m.sub}</p>
          </div>
        ))}
      </div>

      <div className="mt-10">
        <a
          href="#rsvp"
          className="inline-block border border-foreground px-7 py-4 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
        >
          確認出席 / 預約席位
        </a>
      </div>
    </section>
  );
}

// ── 策展緣起 ──────────────────────────────────────────────────────────────────

function Curation() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <div className="grid gap-12 md:grid-cols-12 md:gap-16">
        <div className="md:col-span-5">
          <SectionHead eyebrow={SALON.curationEyebrow} title={SALON.curationTitle} />
          <div className="mt-8 space-y-5">
            {SALON.curationEssay.map((p) => (
              <p key={p} className="text-base leading-loose text-foreground/75">
                {p}
              </p>
            ))}
          </div>
        </div>

        <div className="md:col-span-7">
          <p className="eyebrow text-2xl text-muted-foreground">本場思享題目</p>
          <ol className="mt-6 grid gap-px bg-border border border-border">
            {SALON.themes.map((t, i) => (
              <li key={t} className="bg-background flex gap-5 p-6 md:p-7">
                <span className="font-serif text-xl text-clay tabular-nums shrink-0">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-base leading-relaxed">{t}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

// ── 對談陣容 ──────────────────────────────────────────────────────────────────

function Speakers() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="對談陣容" title="四種看台東的方式" />

      <div className="mt-12 grid gap-px bg-border border border-border sm:grid-cols-2">
        {SALON.speakers.map((s) => (
          <article key={s.title} className="bg-background p-7 md:p-9 flex flex-col">
            <p className="text-[0.7rem] tracking-widest text-[var(--salon-sage)]">{s.role}</p>
            <h3 className={`display mt-3 text-2xl ${s.pending ? "text-muted-foreground" : ""}`}>
              {s.name}
            </h3>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{s.title}</p>
            <div className="rule my-6" />
            <p className="text-sm leading-relaxed text-foreground/75 flex-1">{s.view}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── 議程 ──────────────────────────────────────────────────────────────────────

function Agenda() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="沙龍流程" title="120 分鐘" />

      <ol className="mt-12 max-w-4xl">
        {SALON.agenda.map((row) => (
          <li
            key={row.time}
            className="grid gap-2 border-t border-border py-6 sm:grid-cols-[10rem_1fr] sm:gap-8 last:border-b"
          >
            <p className="text-sm tabular-nums tracking-wide text-clay pt-0.5">{row.time}</p>
            <div>
              <p className="font-serif text-lg leading-snug">{row.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── 沙龍後續路徑 ──────────────────────────────────────────────────────────────

function Paths() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="沙龍之後" title="三條可以繼續走的路" />

      <div className="mt-12 grid gap-px bg-border border border-border md:grid-cols-3">
        {SALON.paths.map((p, i) => (
          <article key={p.label} className="bg-background p-7 md:p-8">
            <p className="font-serif text-xl text-clay tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-4 text-base tracking-wide">{p.label}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── 受邀出席回覆 ──────────────────────────────────────────────────────────────

function Rsvp() {
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<SalonRsvpValues>({
    resolver: zodResolver(salonRsvpFormSchema),
    defaultValues: {
      eventSlug: EVENT_SLUG,
      name: "",
      organisation: "",
      jobTitle: "",
      phone: "",
      email: "",
      attending: "yes",
      message: "",
    },
  });

  async function onSubmit(values: SalonRsvpValues) {
    setSubmitting(true);
    try {
      const res = await submitSalonRsvp({ data: values });
      if (res.ok) setSent(true);
      else toast.error("送出失敗，請稍後再試，或直接來電 " + SALON.phone);
    } catch {
      toast.error("送出失敗，請稍後再試，或直接來電 " + SALON.phone);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section id="rsvp" className="border-t border-border bg-oat/50">
      <div className="container-editorial py-16 md:py-24">
        <SectionHead eyebrow="受邀出席回覆" title="確認您的席位" />
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {SALON.rsvpNote}
        </p>

        {sent ? (
          // 送出成功之後**不要**再把表單留在畫面上——留著只會讓人不確定到底送出去
          // 了沒有，然後再按一次。
          <div className="mt-10 max-w-2xl border border-border bg-background p-8 md:p-10">
            <Check className="h-5 w-5 text-[var(--salon-sage)]" strokeWidth={1.5} aria-hidden />
            <p className="mt-4 font-serif text-xl">已收到您的回覆</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              我們會在確認席位後寄出行前專屬入場通知。若需修改回覆，歡迎直接來電 {SALON.phone}。
            </p>
          </div>
        ) : (
          <div className="mt-10 max-w-2xl border border-border bg-background p-8 md:p-10">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="grid gap-6 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>姓名</FormLabel>
                        <FormControl>
                          <Input {...field} autoComplete="name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="organisation"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          服務單位 / 品牌
                          <span className="ml-2 text-xs text-muted-foreground">選填</span>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} autoComplete="organization" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="jobTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          職稱
                          <span className="ml-2 text-xs text-muted-foreground">選填</span>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} autoComplete="organization-title" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          聯絡電話
                          <span className="ml-2 text-xs text-muted-foreground">選填</span>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} autoComplete="tel" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input {...field} type="email" autoComplete="email" />
                      </FormControl>
                      {/* 行前通知只從這裡寄，所以它是必填——說清楚比事後解釋好。 */}
                      <p className="text-xs text-muted-foreground">
                        行前專屬入場通知將寄至此信箱。
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="attending"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>出席意願</FormLabel>
                      {/* 用原生 radio 而不是 RadioGroup：這裡只有兩個選項、要能被
                          鍵盤與螢幕閱讀器原生處理，多包一層沒有換到任何東西。 */}
                      <div className="flex flex-wrap gap-6 pt-1">
                        {[
                          { value: "yes", label: "確認出席" },
                          { value: "no", label: "遺憾不克前往" },
                        ].map((opt) => (
                          <label
                            key={opt.value}
                            className="flex items-center gap-2.5 text-sm cursor-pointer"
                          >
                            <input
                              type="radio"
                              className="accent-foreground"
                              value={opt.value}
                              checked={field.value === opt.value}
                              onChange={() => field.onChange(opt.value)}
                            />
                            {opt.label}
                          </label>
                        ))}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        最期待探討的題目，或可提供的合作資源
                        <span className="ml-2 text-xs text-muted-foreground">選填</span>
                      </FormLabel>
                      <FormControl>
                        <Textarea {...field} rows={4} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button type="submit" disabled={submitting} className="tracking-widest">
                  {submitting ? "送出中…" : "送出回覆"}
                </Button>
              </form>
            </Form>
          </div>
        )}
      </div>
    </section>
  );
}

// ── 地點與聯絡 ────────────────────────────────────────────────────────────────

function Venue() {
  return (
    <section className="container-editorial py-16 md:py-20 border-t border-border">
      <div className="grid gap-10 md:grid-cols-3">
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">主辦</p>
          <p className="mt-4 text-sm leading-relaxed">{SALON.cohosts}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">地點</p>
          <p className="mt-4 text-sm leading-relaxed">小時光風土誌書店</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{SALON.address}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">洽詢</p>
          <a
            href={`tel:${SALON.phone.replace(/-/g, "")}`}
            className="mt-4 block text-sm hover-underline"
          >
            {SALON.phone}
          </a>
        </div>
      </div>
    </section>
  );
}
