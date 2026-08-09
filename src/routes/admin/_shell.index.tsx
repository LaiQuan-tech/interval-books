import { createFileRoute, Link } from "@tanstack/react-router";
import { Newspaper } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/admin/_shell/")({
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
