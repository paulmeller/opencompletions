import { SkillForm } from "@/components/skills/skill-form";

export default function NewSkillPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">New Skill</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create a new skill for agents to use.
        </p>
      </div>
      <SkillForm />
    </div>
  );
}
