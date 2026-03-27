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
        </div>
        <Button asChild>
          <Link href="/skills/new">New Skill</Link>
        </Button>
      </div>

      {skills.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No skills yet. Create one to get started.
        </p>
      )}

      <div className="grid gap-4">
        {skills.map((skill) => (
          <Card key={skill.name}>
            <CardHeader>
              <CardTitle>{skill.display_name || skill.name}</CardTitle>
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
