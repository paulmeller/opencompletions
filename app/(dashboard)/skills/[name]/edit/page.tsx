import { notFound } from "next/navigation";
import { getSkill } from "@/lib/db";
import { SkillForm } from "@/components/skills/skill-form";

export const dynamic = "force-dynamic";

export default async function EditSkillPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const skill = getSkill(name);

  if (!skill) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Edit Skill</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Editing <span className="font-mono">{skill.name}</span>
        </p>
      </div>
      <SkillForm initial={{ ...skill, tags: JSON.parse(skill.tags || "[]") }} />
    </div>
  );
}
