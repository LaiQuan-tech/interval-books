import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  CalendarDays,
  Handshake,
  ImageIcon,
  LayoutDashboard,
  LogOut,
  Newspaper,
  ShoppingBag,
  Tags,
  Tent,
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
 * Pathless layout for the whole /admin back office (except /admin/login,
 * which lives outside this layout on purpose — see routes/admin/login.tsx).
 *
 * beforeLoad is the ROUTE GUARD: it only controls what the UI shows/redirects
 * to. It is not the security boundary — adminFnMiddleware is (see
 * src/lib/admin/middleware.ts) — but it's still what keeps a signed-out
 * visitor from ever seeing the shell flash before bouncing to /login.
 */
export const Route = createFileRoute("/admin/_shell")({
  beforeLoad: async () => {
    const { getCurrentAdmin } = await import("@/lib/admin/fns/auth");
    const admin = await getCurrentAdmin();
    if (!admin) {
      throw redirect({ to: "/admin/login" });
    }
    return { admin };
  },
  component: AdminShell,
});

const NAV_ITEMS = [
  { to: "/admin", label: "儀表板", icon: LayoutDashboard },
  { to: "/admin/news", label: "最新消息", icon: Newspaper },
  { to: "/admin/events", label: "活動", icon: CalendarDays },
  { to: "/admin/exhibitions", label: "展覽", icon: ImageIcon },
  // lucide's `Route` icon would collide with this file's `export const Route`.
  { to: "/admin/journeys", label: "策旅", icon: Tent },
  { to: "/admin/curated", label: "選品", icon: ShoppingBag },
  { to: "/admin/collaborations", label: "合作", icon: Handshake },
  { to: "/admin/categories", label: "活動分類", icon: Tags },
] as const;

function AdminShell() {
  const { admin } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

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
          <SidebarGroup>
            <SidebarGroupLabel>內容管理</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label} isActive={pathname === item.to}>
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
