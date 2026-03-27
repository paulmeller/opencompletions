"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Save } from "lucide-react";

interface SettingRow {
  key: string;
  value: string;
}

export function ServerConfigCard() {
  const [concurrency, setConcurrency] = useState("3");
  const [timeout, setTimeout_] = useState("120000");
  const [queueDepth, setQueueDepth] = useState("100");
  const [agentMaxTurns, setAgentMaxTurns] = useState("10");
  const [agentTimeout, setAgentTimeout] = useState("600000");
  const [apiKey, setApiKey] = useState("");
  const [savedApiKey, setSavedApiKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((settings: SettingRow[]) => {
        const map: Record<string, string> = {};
        for (const s of settings) map[s.key] = s.value;
        if (map.concurrency) setConcurrency(map.concurrency);
        if (map.timeout) setTimeout_(map.timeout);
        if (map.queue_depth) setQueueDepth(map.queue_depth);
        if (map.agent_max_turns) setAgentMaxTurns(map.agent_max_turns);
        if (map.agent_timeout) setAgentTimeout(map.agent_timeout);
        if (map.api_key) setSavedApiKey(map.api_key);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const body: Record<string, string> = {
        concurrency,
        timeout: timeout,
        queue_depth: queueDepth,
        agent_max_turns: agentMaxTurns,
        agent_timeout: agentTimeout,
      };
      if (apiKey.trim()) body.api_key = apiKey.trim();

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to save");
      setApiKey("");
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
        <CardTitle>Server Configuration</CardTitle>
        <CardDescription>Concurrency, timeouts, and auth settings. Changes apply on API server restart.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {success && <Alert><AlertDescription>Saved. Restart the API server to apply.</AlertDescription></Alert>}

        <Field>
          <FieldLabel>Server API Key</FieldLabel>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={savedApiKey ? "Replace existing" : "Bearer token for API auth"} />
          {savedApiKey && <FieldDescription>Configured</FieldDescription>}
        </Field>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Field>
            <FieldLabel>Concurrency</FieldLabel>
            <Input type="number" min={1} max={20} value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)} />
            <FieldDescription>Max simultaneous requests</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Timeout (ms)</FieldLabel>
            <Input type="number" min={1000} value={timeout}
              onChange={(e) => setTimeout_(e.target.value)} />
            <FieldDescription>Completion timeout</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Queue Depth</FieldLabel>
            <Input type="number" min={1} value={queueDepth}
              onChange={(e) => setQueueDepth(e.target.value)} />
            <FieldDescription>Max queued requests</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Agent Max Turns</FieldLabel>
            <Input type="number" min={1} max={50} value={agentMaxTurns}
              onChange={(e) => setAgentMaxTurns(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Agent Timeout (ms)</FieldLabel>
            <Input type="number" min={1000} value={agentTimeout}
              onChange={(e) => setAgentTimeout(e.target.value)} />
            <FieldDescription>Default: 600000 (10 min)</FieldDescription>
          </Field>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          <Save data-icon="inline-start" />
          {saving ? "Saving..." : "Save Server Config"}
        </Button>
      </CardContent>
    </Card>
  );
}
