import { withAuth, signOut } from "@workos-inc/authkit-nextjs";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/components/app-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DashboardBreadcrumb } from "@/components/dashboard-breadcrumb";
import { ensureUserKey, seedSettings } from "@/lib/ensure-user-key";
import { ApiKeyProvider } from "@/lib/api-key-context";

async function handleSignOut() {
  "use server";
  await signOut();
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user } = await withAuth();

  // Seed DB settings from SEED_CONFIG env var if present
  seedSettings();

  // Provision or retrieve the user's default API key
  const userKey = user ? await ensureUserKey(user.id) : null;

  const sidebarUser = user
    ? {
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
        email: user.email,
      }
    : null;

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar user={sidebarUser} signOutAction={handleSignOut} />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ml-1" />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <DashboardBreadcrumb />
            </div>
          </header>
          <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
            <ApiKeyProvider value={userKey}>
              {children}
            </ApiKeyProvider>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
