import { Link, useLocation, Outlet } from "@tanstack/react-router";
import { Clapperboard, Home as HomeIcon, Film, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

function NavLink({
  to,
  label,
  icon,
  exact,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
}) {
  const location = useLocation();
  const active = exact ? location.pathname === to : location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-accent/10 hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Link to="/" className="flex items-center gap-2 font-display">
          <Clapperboard className="size-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">Swift Screen</span>
        </Link>
        <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
          internal
        </span>
        <nav className="ml-auto flex items-center gap-1">
          <NavLink to="/" label="Dashboard" icon={<HomeIcon className="size-4" />} exact />
          <NavLink to="/record" label="Record" icon={<Circle className="size-4" />} exact />
          <NavLink to="/library" label="Library" icon={<Film className="size-4" />} exact />
        </nav>
      </div>
    </header>
  );
}

export function AppFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 py-6">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:flex-row">
        <p className="flex items-center gap-1.5">
          <Clapperboard className="size-3.5" /> Swift Screen — async screen recording &amp; sharing
        </p>
        <p>Record once. Share anywhere.</p>
      </div>
    </footer>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1">{children}</main>
      <AppFooter />
    </div>
  );
}

export { Outlet };
