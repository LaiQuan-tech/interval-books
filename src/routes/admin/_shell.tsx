import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardList,
  FileText,
  Handshake,
  ImageIcon,
  LayoutDashboard,
  LogOut,
  Newspaper,
  Package,
  Package2,
  PackageSearch,
  Phone,
  Receipt,
  ScanLine,
  SlidersHorizontal,
  TruckIcon,
  Settings,
  ShoppingBag,
  Tags,
  Tent,
  TriangleAlert,
  Type,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { signOut } from "@/lib/admin/fns/auth";

/**
 * Pathless layout for the whole /admin back office (except /admin/login and
 * /admin/pending, which live outside this layout on purpose — a signed-out or
 * not-yet-approved visitor has no business seeing a sidebar).
 *
 * beforeLoad is the ROUTE GUARD: it only controls what the UI shows/redirects
 * to. It is not the security boundary — adminFnMiddleware / staffFnMiddleware
 * are (see src/lib/admin/middleware.ts) — but it's still what keeps a
 * signed-out visitor from ever seeing the shell flash before bouncing to
 * /login.
 *
 * ⚠️ 這裡**不做**「這個角色能不能看這個模組」的判斷。理由是 v3 那套踩過的坑：
 *    側欄把模組藏起來、RLS 沒擋，於是手打網址就繞過去了。這一版的規矩是每一支
 *    server fn 自己擋 —— 店員硬打 /admin/products 會看到一頁錯誤（因為它的
 *    loader 會被 adminFnMiddleware 擋下來），而不是一頁資料。側欄只負責不要
 *    給他一個一按就壞掉的連結。
 */
export const Route = createFileRoute("/admin/_shell")({
  beforeLoad: async () => {
    const { getCurrentBackOfficeUser } = await import("@/lib/admin/fns/auth");
    const user = await getCurrentBackOfficeUser();
    if (!user) {
      throw redirect({ to: "/admin/login" });
    }
    if (user.role === "pending") {
      throw redirect({ to: "/admin/pending" });
    }
    // `admin` 這個名字保留給既有的 15 個 route，它們都在讀 context.admin.email。
    return { admin: { userId: user.userId, email: user.email }, user };
  },
  component: AdminShell,
});

/**
 * The sidebar, in four groups.
 *
 * Splitting what used to be one thirteen-item list is not decoration: the
 * groups are different systems with different sources of truth. 內容管理 edits
 * CMS tables, 電商 edits public.products and the orders that come out of it,
 * and 門市／進銷存 edits inv.* — the shop's real inventory, which came from a
 * separate application in migration 0009. Someone looking for "why does the
 * site say sold out" needs to know which of them to open, and a flat list does
 * not tell them.
 *
 * `staff: true` 的項目是店員看得到的。**這只是畫面** —— 每一支 server fn 自己
 * 會再擋一次，見檔頭。
 */
const NAV_GROUPS = [
  {
    label: "門市",
    items: [
      { to: "/admin/pos", label: "櫃檯結帳", icon: ScanLine, staff: true },
      { to: "/admin/sales", label: "銷售紀錄", icon: Receipt, staff: true },
      { to: "/admin/stock-alerts", label: "賣超告警", icon: TriangleAlert, staff: true },
    ],
  },
  {
    label: "內容管理",
    items: [
      { to: "/admin", label: "儀表板", icon: LayoutDashboard, staff: false },
      { to: "/admin/news", label: "最新消息", icon: Newspaper, staff: false },
      { to: "/admin/events", label: "活動", icon: CalendarDays, staff: false },
      { to: "/admin/exhibitions", label: "展覽", icon: ImageIcon, staff: false },
      { to: "/admin/publications", label: "地方刊物展", icon: BookOpen, staff: false },
      // lucide's `Route` icon would collide with this file's `export const Route`.
      { to: "/admin/journeys", label: "策旅", icon: Tent, staff: false },
      { to: "/admin/curated", label: "選品", icon: ShoppingBag, staff: false },
      { to: "/admin/collaborations", label: "合作", icon: Handshake, staff: false },
      { to: "/admin/categories", label: "活動分類", icon: Tags, staff: false },
      { to: "/admin/pages", label: "頁面文案", icon: FileText, staff: false },
    ],
  },
  {
    label: "電商",
    items: [{ to: "/admin/products", label: "商品", icon: Package, staff: false }],
  },
  {
    label: "進銷存",
    items: [
      // 商品主檔是店員每天用得最重的一塊，所以 staff: true。看得到不等於改得動：
      // 審核那幾顆按鈕還要 approve_products / approve_price_changes，而那是
      // lib/admin/fns/inv-products.ts 在 server 端擋的，不是這一行。
      { to: "/admin/inventory-products", label: "商品管理", icon: PackageSearch, staff: true },
      // 進貨、盤點、在庫異動同樣是店員每天的工作，所以 staff: true。看得到不等於
      // 改得動：審核那幾顆按鈕還要 approve_purchases / approve_stock_adjustments，
      // 而那是 lib/admin/fns/inv-purchases.ts 與 inv-adjustments.ts 在 server 端擋的。
      { to: "/admin/inventory-purchases", label: "進貨", icon: TruckIcon, staff: true },
      { to: "/admin/inventory-count", label: "庫存盤點", icon: ClipboardList, staff: true },
      {
        to: "/admin/inventory-adjustments",
        label: "在庫異動",
        icon: SlidersHorizontal,
        staff: true,
      },
      // 套餐同樣是店員每天的工作（櫃檯要賣），所以 staff: true。審核那兩顆按鈕還要
      // approve_combo_sets，而那是 lib/admin/fns/inv-combos.ts 在 server 端擋的。
      { to: "/admin/inventory-combos", label: "套餐", icon: Package2, staff: true },
      // 廠商同樣是店員每天的工作（進貨要選供應商、寄賣要對窗口），所以 staff: true。
      // 看得到不等於看得到全部：完整的身分證字號／統編／匯款帳號要
      // inv.vendor.pii.read，而那是 lib/admin/fns/inv-vendors.ts 在 server 端擋的，
      // 不是這一行。稽核軌跡那一頁再更嚴一級（要 admin）。
      { to: "/admin/inventory-vendors", label: "廠商", icon: Building2, staff: true },
      { to: "/admin/inventory-listing", label: "上架", icon: Boxes, staff: false },
    ],
  },
  {
    label: "站台設定",
    items: [
      { to: "/admin/settings", label: "全站設定", icon: Settings, staff: false },
      { to: "/admin/strings", label: "介面文字", icon: Type, staff: false },
      { to: "/admin/phones", label: "聯絡電話", icon: Phone, staff: false },
    ],
  },
] as const;

const ROLE_LABEL: Record<string, string> = { admin: "管理員", staff: "門市人員" };

function AdminShell() {
  const { admin, user } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isAdmin = user.role === "admin";
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => isAdmin || item.staff),
  })).filter((group) => group.items.length > 0);

  async function handleSignOut() {
    await signOut();
    toast.success("已登出");
    await navigate({ to: "/admin/login" });
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-3 py-3">
          <p className="text-sm font-medium leading-tight">小時光書店</p>
          <p className="text-xs leading-tight text-muted-foreground">管理後台</p>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={pathname === item.to}
                      >
                        <Link to={item.to}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 py-3">
          <p className="truncate text-xs text-muted-foreground">{admin.email}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSignOut}>
            <LogOut className="h-3.5 w-3.5" />
            登出
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <SidebarTrigger />
          <p className="text-sm text-muted-foreground">管理後台</p>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
