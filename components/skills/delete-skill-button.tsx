"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DeleteSkillButton({ name }: { name: string }) {
  const router = useRouter();

  async function handleDelete() {
    if (!confirm(`Delete skill "${name}"?`)) return;

    const res = await fetch(`/api/skills/${name}`, { method: "DELETE" });
    if (res.ok) {
      router.refresh();
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleDelete}>
      Delete
    </Button>
  );
}
