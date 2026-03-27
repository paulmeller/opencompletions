"use client";

import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const routeNames: Record<string, string> = {
  "/": "Overview",
  "/playground": "Playground",
  "/runs": "Runs",
  "/skills": "Skills",
  "/skills/new": "New Skill",
  "/keys": "Keys",
  "/settings": "Settings",
};

export function DashboardBreadcrumb() {
  const pathname = usePathname();

  // Build breadcrumb segments
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Overview</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const crumbs: { label: string; href?: string }[] = [];
  let path = "";
  for (let i = 0; i < segments.length; i++) {
    path += "/" + segments[i];
    const isLast = i === segments.length - 1;
    const label = routeNames[path] || segments[i];
    crumbs.push({ label, href: isLast ? undefined : path });
  }

  // Handle edit pages: /skills/[name]/edit
  if (segments.length === 3 && segments[0] === "skills" && segments[2] === "edit") {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem className="hidden md:block">
            <BreadcrumbLink href="/skills">Skills</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="hidden md:block" />
          <BreadcrumbItem>
            <BreadcrumbPage>Edit {segments[1]}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <BreadcrumbItem key={i}>
            {i > 0 && <BreadcrumbSeparator className="hidden md:block" />}
            {crumb.href ? (
              <BreadcrumbLink href={crumb.href} className="hidden md:block">
                {crumb.label}
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
