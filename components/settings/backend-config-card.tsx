"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save } from "lucide-react";

interface SettingRow {
  key: string;
  value: string;
  type: string;
}

export function BackendConfigCard() {
  const [backend, setBackend] = useState("local");
  const [cli, setCli] = useState("claude");
  const [spriteToken, setSpriteToken] = useState("");
  const [spriteNames, setSpriteNames] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [vercelTeamId, setVercelTeamId] = useState("");
  const [vercelProjectId, setVercelProjectId] = useState("");
  const [vercelSnapshotId, setVercelSnapshotId] = useState("");
  const [cloudflareAccountId, setCloudflareAccountId] = useState("");
  const [cloudflareApiToken, setCloudflareApiToken] = useState("");
  const [cloudflareApiUrl, setCloudflareApiUrl] = useState("");
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings: SettingRow[]) => {
        const map: Record<string, string> = {};
        for (const s of settings) map[s.key] = s.value;
        setSaved(map);
        if (map.backend) setBackend(map.backend);
        if (map.cli) setCli(map.cli);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const body: Record<string, string> = {};
      body.backend = backend;
      body.cli = cli;
      if (spriteToken.trim()) body.sprite_token = spriteToken.trim();
      if (spriteNames.trim()) body.sprite_names = spriteNames.trim();
      if (vercelToken.trim()) body.vercel_token = vercelToken.trim();
      if (vercelTeamId.trim()) body.vercel_team_id = vercelTeamId.trim();
      if (vercelProjectId.trim()) body.vercel_project_id = vercelProjectId.trim();
      if (vercelSnapshotId.trim()) body.vercel_snapshot_id = vercelSnapshotId.trim();
      if (cloudflareAccountId.trim()) body.cloudflare_account_id = cloudflareAccountId.trim();
      if (cloudflareApiToken.trim()) body.cloudflare_api_token = cloudflareApiToken.trim();
      if (cloudflareApiUrl.trim()) body.cloudflare_api_url = cloudflareApiUrl.trim();

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save");
      const settings: SettingRow[] = await res.json();
      const map: Record<string, string> = {};
      for (const s of settings) map[s.key] = s.value;
      setSaved(map);
      setSpriteToken("");
      setSpriteNames("");
      setVercelToken("");
      setVercelTeamId("");
      setVercelProjectId("");
      setVercelSnapshotId("");
      setCloudflareAccountId("");
      setCloudflareApiToken("");
      setCloudflareApiUrl("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backend Configuration</CardTitle>
        <CardDescription>Configure execution backends and CLI providers for the API server.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {success && <Alert><AlertDescription>Saved. Restart the API server to apply.</AlertDescription></Alert>}

        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel>Default Backend</FieldLabel>
            <Select value={backend} onValueChange={setBackend}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="sprite">Sprite</SelectItem>
                <SelectItem value="vercel">Vercel</SelectItem>
                <SelectItem value="cloudflare">Cloudflare</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Default CLI</FieldLabel>
            <Select value={cli} onValueChange={setCli}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="gemini">Gemini</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <h4 className="text-sm font-medium">Sprite Backend</h4>
          <Field>
            <FieldLabel>Sprite Token</FieldLabel>
            <Input type="password" value={spriteToken} onChange={(e) => setSpriteToken(e.target.value)}
              placeholder={saved.sprite_token ? "Replace existing" : "paul-meller/..."} />
            {saved.sprite_token && <Badge variant="secondary" className="w-fit text-xs font-mono">{saved.sprite_token}</Badge>}
          </Field>
          <Field>
            <FieldLabel>Sprite Names</FieldLabel>
            <Input value={spriteNames} onChange={(e) => setSpriteNames(e.target.value)}
              placeholder={saved.sprite_names || "claude-completions (comma-separated)"} />
            {saved.sprite_names && <FieldDescription>Current: {saved.sprite_names}</FieldDescription>}
          </Field>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <h4 className="text-sm font-medium">Vercel Backend</h4>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Vercel Token</FieldLabel>
              <Input type="password" value={vercelToken} onChange={(e) => setVercelToken(e.target.value)}
                placeholder={saved.vercel_token ? "Replace" : "vcp_..."} />
              {saved.vercel_token && <Badge variant="secondary" className="w-fit text-xs font-mono">{saved.vercel_token}</Badge>}
            </Field>
            <Field>
              <FieldLabel>Team ID</FieldLabel>
              <Input value={vercelTeamId} onChange={(e) => setVercelTeamId(e.target.value)}
                placeholder={saved.vercel_team_id || "team_..."} />
              {saved.vercel_team_id && <FieldDescription>Current: {saved.vercel_team_id}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel>Project ID</FieldLabel>
              <Input value={vercelProjectId} onChange={(e) => setVercelProjectId(e.target.value)}
                placeholder={saved.vercel_project_id || "prj_..."} />
            </Field>
            <Field>
              <FieldLabel>Snapshot ID</FieldLabel>
              <Input value={vercelSnapshotId} onChange={(e) => setVercelSnapshotId(e.target.value)}
                placeholder={saved.vercel_snapshot_id || "snap_..."} />
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <h4 className="text-sm font-medium">Cloudflare Backend</h4>
          <FieldDescription>
            Requires a Cloudflare Worker proxy wrapping the Sandbox SDK. See lib/oc/backends/cloudflare.ts for details.
          </FieldDescription>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Account ID</FieldLabel>
              <Input value={cloudflareAccountId} onChange={(e) => setCloudflareAccountId(e.target.value)}
                placeholder={saved.cloudflare_account_id || "your-account-id"} />
              {saved.cloudflare_account_id && <FieldDescription>Current: {saved.cloudflare_account_id}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel>API Token</FieldLabel>
              <Input type="password" value={cloudflareApiToken} onChange={(e) => setCloudflareApiToken(e.target.value)}
                placeholder={saved.cloudflare_api_token ? "Replace" : "your-api-token"} />
              {saved.cloudflare_api_token && <Badge variant="secondary" className="w-fit text-xs font-mono">{saved.cloudflare_api_token}</Badge>}
            </Field>
          </div>
          <Field>
            <FieldLabel>Worker Proxy URL (optional)</FieldLabel>
            <Input value={cloudflareApiUrl} onChange={(e) => setCloudflareApiUrl(e.target.value)}
              placeholder={saved.cloudflare_api_url || "https://your-sandbox-proxy.workers.dev"} />
            {saved.cloudflare_api_url && <FieldDescription>Current: {saved.cloudflare_api_url}</FieldDescription>}
          </Field>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          <Save data-icon="inline-start" />
          {saving ? "Saving..." : "Save Backend Config"}
        </Button>
      </CardContent>
    </Card>
  );
}
