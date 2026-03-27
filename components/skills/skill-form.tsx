"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import type { SkillResource } from "@/lib/db";

interface SkillFormData {
  name: string;
  display_name: string;
  description: string;
  instructions: string;
  tags: string[];
  resources: SkillResource[];
}

interface SkillFormProps {
  initial?: SkillFormData;
}

export function SkillForm({ initial }: SkillFormProps) {
  const router = useRouter();
  const isEdit = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [tagsInput, setTagsInput] = useState((initial?.tags ?? []).join(", "));
  const [resources, setResources] = useState<SkillResource[]>(
    initial?.resources ?? []
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addResource() {
    setResources([...resources, { file_name: "", content: "" }]);
  }

  function removeResource(index: number) {
    setResources(resources.filter((_, i) => i !== index));
  }

  function updateResource(index: number, field: keyof SkillResource, value: string) {
    setResources(
      resources.map((r, i) => (i === index ? { ...r, [field]: value } : r))
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const body = {
      name,
      display_name: displayName,
      description,
      instructions,
      tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
      resources: resources.filter((r) => r.file_name.trim()),
    };

    try {
      const url = isEdit ? `/api/skills/${initial.name}` : "/api/skills";
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || `Error ${res.status}`);
        return;
      }

      router.push("/skills");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="name">Name</FieldLabel>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-skill"
          disabled={isEdit}
          required
          pattern="[a-z0-9][a-z0-9-]*"
        />
        <FieldDescription>
          Lowercase alphanumeric with hyphens. Cannot be changed after creation.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="display_name">Display Name</FieldLabel>
        <Input
          id="display_name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My Skill"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="description">Description</FieldLabel>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A brief description of what this skill does."
          rows={2}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="tags">Tags</FieldLabel>
        <Input
          id="tags"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="legal, contracts, immigration (comma-separated)"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="instructions">Instructions</FieldLabel>
        <Textarea
          id="instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Markdown instructions the agent sees when this skill is activated."
          rows={12}
          className="font-mono text-sm"
        />
        <FieldDescription>
          This is the content the agent receives when it calls activate_skill.
        </FieldDescription>
      </Field>

      <Separator />

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Resources</h3>
          <Button type="button" variant="outline" size="sm" onClick={addResource}>
            Add Resource
          </Button>
        </div>

        {resources.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <Field className="flex-1">
                <FieldLabel htmlFor={`resource-name-${i}`}>File Name</FieldLabel>
                <Input
                  id={`resource-name-${i}`}
                  value={r.file_name}
                  onChange={(e) => updateResource(i, "file_name", e.target.value)}
                  placeholder="references/rubric.md"
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-5"
                onClick={() => removeResource(i)}
              >
                Remove
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor={`resource-content-${i}`}>Content</FieldLabel>
              <Textarea
                id={`resource-content-${i}`}
                value={r.content}
                onChange={(e) => updateResource(i, "content", e.target.value)}
                placeholder="Resource content (markdown, text, etc.)"
                rows={6}
                className="font-mono text-sm"
              />
            </Field>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : isEdit ? "Update Skill" : "Create Skill"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push("/skills")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
