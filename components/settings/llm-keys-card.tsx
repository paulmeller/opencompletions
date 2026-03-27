"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Save, Trash2 } from "lucide-react";

interface SettingRow {
  key: string;
  value: string;
  type: string;
  updated_at: string;
}

export function LlmKeysCard() {
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [claudeOauthToken, setClaudeOauthToken] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [savedClaudeApi, setSavedClaudeApi] = useState<string | null>(null);
  const [savedClaudeOauth, setSavedClaudeOauth] = useState<string | null>(null);
  const [savedOpenai, setSavedOpenai] = useState<string | null>(null);
  const [savedGemini, setSavedGemini] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings: SettingRow[]) => {
        const claudeApi = settings.find((s) => s.key === "llm_key_claude_api");
        const claudeOauth = settings.find((s) => s.key === "llm_key_claude_oauth");
        const openai = settings.find((s) => s.key === "llm_key_openai");
        const gemini = settings.find((s) => s.key === "llm_key_gemini");
        if (claudeApi) setSavedClaudeApi(claudeApi.value);
        if (claudeOauth) setSavedClaudeOauth(claudeOauth.value);
        if (openai) setSavedOpenai(openai.value);
        if (gemini) setSavedGemini(gemini.value);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const body: Record<string, string> = {};
    if (claudeApiKey.trim()) body.claude_api_key = claudeApiKey.trim();
    if (claudeOauthToken.trim()) body.claude_oauth_token = claudeOauthToken.trim();
    if (openaiKey.trim()) body.openai_key = openaiKey.trim();
    if (geminiKey.trim()) body.gemini_key = geminiKey.trim();

    if (Object.keys(body).length === 0) {
      setError("Enter at least one key to save");
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save");
      const settings: SettingRow[] = await res.json();
      const claudeApi = settings.find((s) => s.key === "llm_key_claude_api");
      const claudeOauth = settings.find((s) => s.key === "llm_key_claude_oauth");
      const openai = settings.find((s) => s.key === "llm_key_openai");
      const gemini = settings.find((s) => s.key === "llm_key_gemini");
      if (claudeApi) setSavedClaudeApi(claudeApi.value);
      if (claudeOauth) setSavedClaudeOauth(claudeOauth.value);
      if (openai) setSavedOpenai(openai.value);
      if (gemini) setSavedGemini(gemini.value);
      setClaudeApiKey("");
      setClaudeOauthToken("");
      setOpenaiKey("");
      setGeminiKey("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(key: string) {
    try {
      await fetch(`/api/settings/${key}`, { method: "DELETE" });
      if (key === "llm_key_claude_api") setSavedClaudeApi(null);
      if (key === "llm_key_claude_oauth") setSavedClaudeOauth(null);
      if (key === "llm_key_openai") setSavedOpenai(null);
      if (key === "llm_key_gemini") setSavedGemini(null);
    } catch {}
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>LLM API Keys</CardTitle>
        <CardDescription>
          Keys used by the playground to authenticate with Claude and OpenAI. Stored encrypted in the dashboard database.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success && (
          <Alert>
            <AlertDescription>Keys saved successfully.</AlertDescription>
          </Alert>
        )}

        <Field>
          <FieldLabel>Anthropic API Key</FieldLabel>
          <div className="flex gap-2">
            <Input
              type="password"
              value={claudeApiKey}
              onChange={(e) => setClaudeApiKey(e.target.value)}
              placeholder={savedClaudeApi ? "Replace existing key" : "sk-ant-api03-..."}
              className="flex-1"
            />
            {savedClaudeApi && (
              <Button variant="ghost" size="sm" onClick={() => handleDelete("llm_key_claude_api")}>
                <Trash2 className="text-destructive" />
              </Button>
            )}
          </div>
          {savedClaudeApi ? (
            <Badge variant="secondary" className="w-fit text-xs font-mono">{savedClaudeApi}</Badge>
          ) : (
            <FieldDescription>Standard API key from console.anthropic.com</FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel>Claude OAuth Token</FieldLabel>
          <div className="flex gap-2">
            <Input
              type="password"
              value={claudeOauthToken}
              onChange={(e) => setClaudeOauthToken(e.target.value)}
              placeholder={savedClaudeOauth ? "Replace existing token" : "sk-ant-oat01--..."}
              className="flex-1"
            />
            {savedClaudeOauth && (
              <Button variant="ghost" size="sm" onClick={() => handleDelete("llm_key_claude_oauth")}>
                <Trash2 className="text-destructive" />
              </Button>
            )}
          </div>
          {savedClaudeOauth ? (
            <Badge variant="secondary" className="w-fit text-xs font-mono">{savedClaudeOauth}</Badge>
          ) : (
            <FieldDescription>OAuth token from Claude Code CLI (sk-ant-oat...)</FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel>OpenAI / Codex API Key</FieldLabel>
          <div className="flex gap-2">
            <Input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder={savedOpenai ? "Replace existing key" : "sk-..."}
              className="flex-1"
            />
            {savedOpenai && (
              <Button variant="ghost" size="sm" onClick={() => handleDelete("llm_key_openai")}>
                <Trash2 className="text-destructive" />
              </Button>
            )}
          </div>
          {savedOpenai ? (
            <Badge variant="secondary" className="w-fit text-xs font-mono">{savedOpenai}</Badge>
          ) : (
            <FieldDescription>Not configured</FieldDescription>
          )}
        </Field>

        <Field>
          <FieldLabel>Gemini API Key</FieldLabel>
          <div className="flex gap-2">
            <Input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder={savedGemini ? "Replace existing key" : "AIza..."}
              className="flex-1"
            />
            {savedGemini && (
              <Button variant="ghost" size="sm" onClick={() => handleDelete("llm_key_gemini")}>
                <Trash2 className="text-destructive" />
              </Button>
            )}
          </div>
          {savedGemini ? (
            <Badge variant="secondary" className="w-fit text-xs font-mono">{savedGemini}</Badge>
          ) : (
            <FieldDescription>Not configured</FieldDescription>
          )}
        </Field>

        <Button onClick={handleSave} disabled={saving || (!claudeApiKey.trim() && !claudeOauthToken.trim() && !openaiKey.trim() && !geminiKey.trim())}>
          <Save data-icon="inline-start" />
          {saving ? "Saving..." : "Save Keys"}
        </Button>
      </CardContent>
    </Card>
  );
}
