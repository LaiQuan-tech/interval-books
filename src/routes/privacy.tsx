import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "隱私權聲明｜小時光書店" },
      { name: "description", content: "小時光書店個人資料處理與隱私權聲明。" },
    ],
  }),
  component: Privacy,
});

function Privacy() {
  return (
    <PageShell>
      <PageHeader eyebrow="Privacy  ／  隱私權" title="隱私權聲明" />
      <section className="container-editorial pb-32 max-w-3xl text-sm leading-loose text-foreground/80 space-y-6">
        <p>感謝您造訪小時光書店網站。為保障您的權益，請您詳閱以下隱私權聲明。</p>
        <div>
          <h2 className="font-serif text-xl text-foreground">一、蒐集資料</h2>
          <p className="mt-2">當您透過聯絡表單與我們聯繫時，我們可能蒐集您的姓名、Email 與訊息內容，僅作為回覆與後續聯繫之用。</p>
        </div>
        <div>
          <h2 className="font-serif text-xl text-foreground">二、資料使用</h2>
          <p className="mt-2">我們不會將您的個人資料提供、交換、出租或出售給任何第三方。</p>
        </div>
        <div>
          <h2 className="font-serif text-xl text-foreground">三、Cookie 使用</h2>
          <p className="mt-2">本網站可能使用 Cookie 記錄您的瀏覽偏好，您可於瀏覽器設定中關閉。</p>
        </div>
        <div>
          <h2 className="font-serif text-xl text-foreground">四、聯繫我們</h2>
          <p className="mt-2">若對本聲明有任何疑問，歡迎來信 hello@xiaoshiguang.tw。</p>
        </div>
        <p className="text-muted-foreground text-xs pt-8">本聲明最後更新：2025.04</p>
      </section>
    </PageShell>
  );
}
