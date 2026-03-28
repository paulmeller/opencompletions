import Link from "next/link";
import { listSkills } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent } from "@/components/ui/card";
import { DeleteSkillButton } from "@/components/skills/delete-skill-button";

export const dynamic = "force-dynamic";

export default function SkillsPage() {
  const skills = listSkills();

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {skills.length} skill{skills.length !== 1 ? "s" : ""}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Skills give agents domain expertise — compliance rules, analysis frameworks, document templates. Skills marked &apos;Always Active&apos; apply to every request automatically.
          </p>
        </div>
        <Button asChild>
          <Link href="/skills/new">New Skill</Link>
        </Button>
      </div>

      {skills.length === 0 && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No skills yet.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Skills teach agents domain knowledge — compliance rules, analysis playbooks, document templates.
          </p>
          <div className="flex justify-center gap-3 mt-4">
            <Link href="/skills/new">
              <Button>Create a Skill</Button>
            </Link>
          </div>
        </div>
      )}

      <div className="grid gap-4">
        {skills.map((skill) => (
          <Card key={skill.name}>
            <CardHeader>
              <CardTitle>
                {skill.display_name || skill.name}
                {skill.auto_apply ? <Badge variant="secondary" className="text-xs">Always Active</Badge> : null}
              </CardTitle>
              <CardDescription>{skill.description}</CardDescription>
              <CardAction>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">{skill.name}</Badge>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/skills/${skill.name}/edit`}>Edit</Link>
                  </Button>
                  <DeleteSkillButton name={skill.name} />
                </div>
              </CardAction>
            </CardHeader>
            {skill.resources.length > 0 && (
              <CardContent>
                <div className="flex gap-2 flex-wrap">
                  {skill.resources.map((r) => (
                    <Badge key={r.file_name} variant="secondary" className="text-xs">
                      {r.file_name}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
