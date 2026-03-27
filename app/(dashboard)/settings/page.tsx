import { getServerStatus } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { LlmKeysCard } from "@/components/settings/llm-keys-card";
import { BackendConfigCard } from "@/components/settings/backend-config-card";
import { ServerConfigCard } from "@/components/settings/server-config-card";

export default async function SettingsPage() {
  let status;
  try {
    status = await getServerStatus();
  } catch {
    status = null;
  }

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">Configure API keys, backends, and server settings</p>
      </div>

      <LlmKeysCard />
      <BackendConfigCard />
      <ServerConfigCard />

      {status && (
        <Card>
          <CardHeader>
            <CardTitle>Current Server Status</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-muted-foreground bg-muted p-4 rounded overflow-auto">
              {JSON.stringify(status, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
