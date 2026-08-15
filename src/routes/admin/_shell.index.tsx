import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Newspaper } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/admin/_shell/")({
  /**
   * 店員不落在這一頁。
   *
   * 這**不是**授權 —— 下面 loader 的 listNews() 掛著 adminFnMiddleware，店員硬打
   * /admin 本來就拿不到資料。這裡導開是為了不要在店員的 router 裡留下一個**永遠
   * 載不起來的 match**：留著的話，他之後在 POS 結完帳呼叫 router.invalidate()，
   * 這個 match 會跟著重跑、丟出 401，然後 error boundary 會把已經結完帳的畫面
   * 換成一頁「Something went wrong」。錢收了、庫存扣了，畫面卻在報錯。
   */
  beforeLoad: ({ context }) => {
    if (context.user?.role === "staff") {
      throw redirect({ to: "/admin/pos" });
    }
  },
  loader: async () => {
    const { listNews } = await import("@/lib/admin/fns/news");
    const news = await listNews();
    return { newsCount: news.length };
  },
  head: () => ({
    meta: [{ title: "儀表板｜小時光書店後台" }],
  }),
  component: AdminDashboard,
});

function AdminDashboard() {
  const { admin } = Route.useRouteContext();
  const { newsCount } = Route.useLoaderData();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">歡迎回來</h1>
        <p className="mt-1 text-sm text-muted-foreground">{admin.email}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link to="/admin/news" className="block">
          <Card className="transition-colors hover:border-foreground/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">最新消息</CardTitle>
              <Newspaper className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{newsCount}</div>
              <CardDescription>則消息，點擊前往管理</CardDescription>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
